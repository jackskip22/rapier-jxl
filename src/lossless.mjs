// Rapier's JPEG XL encoder: lossless pictures. MIT (images/jxl/LICENSE).
import {kernelHooks} from './kernel-hooks.mjs';
import {BitWriter, complete, part, LITTLE_ENDIAN} from './bits.mjs';
import {writeModularFrameHeader, groupLayout, groupRect, groupPass, assembleCodestream, GROUP_DIM} from './frame.mjs';
import {writeImageHeader} from './icc-write.mjs';
import {buildCode, writePrefixCode} from './prefix.mjs';
import {AVERAGE_PREDICTOR, GRADIENT_PREDICTOR, ALPHABET, RESIDUAL_CONFIG, leaf, channelTree, writeTree, writeModularHeader, writeChannelHistograms} from './modular.mjs';
import {codeChannel} from './modular-channel.mjs';
import {losslessCoding} from './lossless-coding.mjs';
import {admitSampleFormat} from './admit-samples.mjs';
import {unit, carried, stage, journaling, journalRequest, readAll, readEach, journalJoin, journalFact, JOIN, FACTS, PASSED} from './step-journal.mjs';

const MAX_PALETTE = 2048, PROBE_BITS = 13, PROBE_SIZE = 1 << PROBE_BITS;

export const shapeFloors = new WeakMap();

export const paletteKey = (rgba, i, grey, alpha) => grey
  ? (alpha ? rgba[i] + rgba[i + 3] * 256 : rgba[i])
  : rgba[i] + rgba[i + 1] * 256 + rgba[i + 2] * 65536 + (alpha ? rgba[i + 3] * 16777216 : 0);


export function inspectPixels(rgba, width, height, {palette: wantPalette = true, opacity = true, samples, ...options} = {}) {
  if (!samples && (rgba instanceof Uint16Array || rgba instanceof Float32Array)) samples = admitSampleFormat(rgba, options);
  if (samples) return inspectNativePixels(rgba, width, height, samples, wantPalette);
  const pixels = width * height, scan = shapeScan(pixels, {palette: wantPalette, opacity}, shapeFloors.get(rgba));
  shapeScanPixels(scan, rgba, 0, pixels);
  return shapeResult(scan);
}

const SHAPE_BAND_BYTES = 2 << 20;
export function* inspectPixelsSteps(rgba, width, height) {
  if (!journaling() || rgba instanceof Uint16Array || rgba instanceof Float32Array) return inspectPixels(rgba, width, height);
  if (!journalFact(rgba, JOIN)) {
    const saved = yield* unit('shape', () => { const shape = inspectPixels(rgba, width, height); return shape.palette ? {palette: true} : shape; });
    return saved.palette ? inspectPixels(rgba, width, height) : saved;
  }
  const pixels = width * height, rows = Math.max(1, Math.floor(SHAPE_BAND_BYTES / (width * 4)));
  const scan = yield* stage('shape', function* () {
    const floor = shapeFloors.get(rgba), facts = journalFact(rgba, FACTS), scanned = facts?.scans;
    let scan = scanned && !floor?.alpha ? scanned[floor?.colour === 3 ? 1 : 0] : shapeScan(pixels, {opacity: !facts?.opaque}, floor);
    while (shapeScanNext(scan) < pixels) {
      const top = Math.floor(shapeScanNext(scan) / width / rows) * rows, bottom = Math.min(height, top + rows), from = scan;
      scan = yield* unit('shape-band', () => { shapeScanPixels(from, rgba.subarray(top * width * 4, bottom * width * 4), top * width, (bottom - top) * width); return from; });
    }
    return scan;
  });
  return shapeResult(scan);
}

export function shapeScan(pixels, {palette: wantPalette = true, opacity = true} = {}, floor = null) {
  return {pass: 0, p: 0, pixels, wantPalette, opacity, opaque: !floor?.alpha, grey: floor?.colour !== 3,
    table: null, entries: [], count: 0, step: 0, tooMany: false};
}
export const shapeScanNext = scan => scan.pass === 5 ? scan.pixels : scan.p;
export function shapeScanPixels(scan, rgba, base, count) {
  const end = Math.min(scan.pixels, base + count), {pixels} = scan;
  const inside = p => p >= base && p < end;
  for (;;) {
    if (scan.pass === 0) {
      if (scan.p < pixels && !inside(scan.p)) return false;
      const done = colourPass(scan, rgba, base, end), p = scan.p;
      if (!done && p < pixels) return false;
      scan.pass = scan.opacity && !scan.grey && scan.opaque && p < pixels ? 1 : 2;
    } else if (scan.pass === 1) {
      let p = scan.p;
      if (!inside(p)) return false;
      const at = rgba.byteOffset + (p - base) * 4;
      if (LITTLE_ENDIAN && at % 4 === 0) {
        const words = new Uint32Array(rgba.buffer, at, end - p), n = words.length;
        let w = 0;
        while (w < n && words[w] >= 0xff000000) w++;
        if (w < n) scan.opaque = false;
        p += w;
      } else for (let i = (p - base) * 4 + 3; p < end; p++, i += 4) if (rgba[i] !== 255) { scan.opaque = false; break; }
      scan.p = p;
      if (scan.opaque && p < pixels) return false;
      scan.pass = 2;
    } else if (scan.pass === 2) {
      scan.table = scan.wantPalette ? new Uint32Array(PROBE_SIZE) : null;
      if (scan.wantPalette && pixels >= 16384) { scan.step = ((pixels / 4096) | 0) || 1; scan.p = 0; scan.pass = 3; }
      else { scan.p = 0; scan.pass = 4; }
    } else if (scan.pass === 3) {
      const {table, step} = scan, grey = scan.grey, alpha = !scan.opaque;
      let p = scan.p;
      for (; p < pixels; p += step) {
        if (!inside(p)) { scan.p = p; return false; }
        const k = paletteKey(rgba, (p - base) * 4, grey, alpha);
        if (k === 0) continue;
        let slot = Math.imul(k, 0x9e3779b1) >>> (32 - PROBE_BITS);
        while (table[slot] !== 0 && table[slot] !== k) slot = (slot + 1) & (PROBE_SIZE - 1);
        if (table[slot] === k) continue;
        table[slot] = k;
        if (++scan.count >= MAX_PALETTE) { scan.tooMany = true; break; }
      }
      if (!scan.tooMany) table.fill(0);
      scan.p = 0; scan.pass = 4;
    } else if (scan.pass === 4) {
      if (!scan.wantPalette || scan.tooMany) { scan.pass = 5; continue; }
      const {table, entries} = scan, grey = scan.grey, alpha = !scan.opaque;
      let p = scan.p;
      if (p < pixels && !inside(p)) return false;
      p = firstSeen(table, entries, rgba, base, p, end, grey, alpha);
      if (p < 0) scan.tooMany = true;
      else if (p < pixels) { scan.p = p; return false; }
      scan.p = pixels; scan.pass = 5;
    } else return true;
  }
}
function colourPass(scan, rgba, base, end) {
  let p = scan.p, done = false, opaque = scan.opaque, grey = scan.grey;
  for (let i = (p - base) * 4; p < end; p++, i += 4) {
    if (rgba[i + 3] !== 255) { opaque = false; if (!grey) { done = true; break; } }
    if (rgba[i] !== rgba[i + 1] || rgba[i] !== rgba[i + 2]) { grey = false; p++; done = true; break; }
  }
  scan.opaque = opaque; scan.grey = grey; scan.p = p;
  return done;
}
function firstSeen(table, entries, rgba, base, p, end, grey, alpha) {
  for (let i = (p - base) * 4; p < end; p++, i += 4) {
    const k = paletteKey(rgba, i, grey, alpha);
    if (k === 0) continue;
    let slot = Math.imul(k, 0x9e3779b1) >>> (32 - PROBE_BITS);
    while (table[slot] !== 0 && table[slot] !== k) slot = (slot + 1) & (PROBE_SIZE - 1);
    if (table[slot] === k) continue;
    table[slot] = k; entries.push(k);
    if (entries.length >= MAX_PALETTE) return -1;
  }
  return p;
}
export function shapeResult(scan) {
  const colour = scan.grey ? 1 : 3, alpha = !scan.opaque, channels = colour + (alpha ? 1 : 0), {entries} = scan;
  let palette = null;
  if (scan.wantPalette && !scan.tooMany && entries.length < MAX_PALETTE) {
    const byte = (k, c) => (k >>> 8 * c) & 255;
    const weight = k => (0.299 * byte(k, 0) + 0.587 * byte(k, 1) + 0.114 * byte(k, 2) + 0.01) * (channels === 4 ? byte(k, 3) : 1);
    entries.sort((a, b) => weight(a) - weight(b));
    palette = {colours: [0, ...entries], byte};
  }
  return {colour, alpha, channels, palette};
}

export function planeFill({channels, alpha, palette, samples}, rct) {
  const grey = channels - (alpha ? 1 : 0) === 1, index = palette && new Map(palette.map((k, at) => [k, at]));
  if (samples) return nativePlaneFill(channels, alpha, index, samples, rct);
  return (planes, rgba, stride, x0, y0, w, h) => {
    if (rct && !palette && channels >= 3) { rct.fill(planes, rgba, stride, x0, y0, w, h); return; }
    if (!palette && kernelHooks.fill?.(rgba, stride, x0, y0, w, h, channels, planes)) return;
    for (let y = 0; y < h; y++) {
      let i = ((y0 + y) * stride + x0) * 4, at = y * w;
      for (let x = 0; x < w; x++, i += 4, at++) {
        if (palette) { planes[0][at] = index.get(paletteKey(rgba, i, grey, alpha)); continue; }
        if (channels >= 3) {
          const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
          const co = r - b, tmp = b + (co >> 1), cg = g - tmp;
          planes[0][at] = tmp + (cg >> 1); planes[1][at] = co; planes[2][at] = cg;
          if (channels === 4) planes[3][at] = rgba[i + 3];
        } else { planes[0][at] = rgba[i]; if (channels === 2) planes[1][at] = rgba[i + 3]; }
      }
    }
  };
}

export function planGroup(setup, rct) {
  if (setup.palette || setup.samples || rct || setup.rct !== undefined) return fallbackPlanGroup(setup, rct);
  const {picture, codes} = setup;
  let fallback;
  return (rgba, stride, x0, y0, w, h, target) => {
    const group = kernelHooks.group;
    if (group) {
      const section = codes ? target || new BitWriter(w * h * picture.length + 64) : null;
      if (codes && !target) writeModularHeader(section, {useGlobalTree: true, transforms: []});
      if (group(section, codes || target, rgba, stride, x0, y0, w, h, setup))
        return codes && !target ? section.finish() : undefined;
    }
    fallback ||= fallbackPlanGroup(setup, rct);
    return fallback(rgba, stride, x0, y0, w, h, target);
  };
}

function fallbackPlanGroup(setup, rct) {
  const {leaves, picture, codes} = setup, fill = planeFill(setup, rct), Plane = setup.samples && !setup.palette ? Int32Array : Int16Array;
  const planes = picture.map(() => new Plane(GROUP_DIM * GROUP_DIM));
  return (rgba, stride, x0, y0, w, h, target) => {
    fill(planes, rgba, stride, x0, y0, w, h);
    if (!codes) { picture.forEach((l, c) => codeChannel(null, target[l], planes[c], w, h, leaves[l], !setup.samples)); return; }
    const section = target || new BitWriter(w * h * picture.length + 64);
    if (!target) writeModularHeader(section, {useGlobalTree: true, transforms: []});
    picture.forEach((l, c) => codeChannel(section, codes[l], planes[c], w, h, leaves[l]));
    return target ? undefined : section.finish();
  };
}

export function* iccShape(data, space, steps) {
  const had = shapeFloors.get(data);
  if (space.colorChannels === 3) shapeFloors.set(data, {...had, colour: 3});
  try { return yield* steps; } finally { if (had) shapeFloors.set(data, had); else shapeFloors.delete(data); }
}

export function encodeLossless(rgba, width, height, options) { return complete(losslessSteps(rgba, width, height, options)); }

export function* losslessSteps(rgba, width, height, options = {}) {
  const {colorSpace, rct, analysis} = options;
  let {samples} = options;
  if (!samples && !(colorSpace && typeof colorSpace === 'object')) { const format = admitSampleFormat(rgba, options); if (!format.native8) samples = format; }
  const shape = options.shape || inspectPixels(rgba, width, height, {samples});
  let best, oversized;
  const candidates = shape.palette ? [shape, {...shape, palette: null}] : [shape];
  for (let i = 0; i < candidates.length; i++) {
    try {
      const bytes = yield* part(planSteps(rgba, width, height, candidates[i], colorSpace, rct, samples, analysis, options.fast, options.units && journaling()), i, candidates.length);
      if (!best || bytes.length < best.length) best = bytes;
    } catch (error) { if (error.code !== 'JXL_SIZE') throw error; oversized = error; }
  }
  if (!best) throw oversized;
  return best;
}

const UNIT_GROUPS = 2;
function* planSteps(rgba, width, height, shape, colorSpace, rct, samples, analysis, fast, units = false) {
  const {channels, alpha, palette} = shape;
  const layout = groupLayout(width, height), groups = layout.groupsX * layout.groupsY;
  const streamChannels = palette ? 2 : channels;
  const step = samples?.drop && !samples.exponentBits ? 1 << samples.drop : 1;
  const leaves = Array.from({length: streamChannels}, (_, c) => {
    let multiplier = 1;
    if (!palette && step > 1 && c < channels - Number(alpha)) {
      multiplier = channels >= 3 && rct?.type !== 0
        ? [Math.max(1, step >> 2), step, Math.max(1, step >> 1)][c] : step >> 1;
    }
    return leaf(GRADIENT_PREDICTOR, 0, multiplier);
  });
  const tree = channelTree(leaves);
  const setup = {channels, alpha, palette: palette && palette.colours, rct: rct?.type, samples, leaves, picture: palette ? [layout.single ? 1 : 0] : leaves.map((_, c) => c)};
  const Plane = samples ? Int32Array : Int16Array;
  const rect = g => groupRect(layout, width, height, g);
  const rows = g => {
    const [x, y, w, h] = rect(g);
    if (journalFact(rgba, JOIN)) {
      if (g + 1 < groups) { const [x2, y2, , h2] = rect(g + 1); rgba.ahead(y2 * width * 4, (y2 + h2) * width * 4, x2, Math.min(UNIT_GROUPS * GROUP_DIM, width - x2)); }
      return [rgba.rect(x, y, w, h), w, 0, 0, w, h];
    }
    return [rgba.subarray(y * width * 4, (y + h) * width * 4), width, x, 0, w, h];
  };

  let paletteRows = null;
  if (palette) {
    const n = palette.colours.length;
    paletteRows = new Plane(n * channels);
    palette.colours.forEach((k, at) => { for (let c = 0; c < channels; c++) paletteRows[c * n + at] = palette.byte(k, c); });
  }

  if (!palette && !fast) {
    const choose = () => {
      const fill = planeFill(setup, rct), planes = Array.from({length: channels}, () => new Plane(32 * 32));
      const cost = freqs => {
        const code = buildCode(freqs), writer = new BitWriter(128);
        writePrefixCode(writer, code);
        let bits = writer.bitLength;
        for (let s = 0; s < freqs.length; s++) if (freqs[s]) bits += freqs[s] * (code.lengths[s] + Math.max(0, s < 224 ? s - 1 : s - 236));
        return bits;
      };
      const sw = Math.min(width, 32), sh = Math.min(height, 32);
      const predictors = samples ? [GRADIENT_PREDICTOR, AVERAGE_PREDICTOR, 1, 2, 0] : [GRADIENT_PREDICTOR, AVERAGE_PREDICTOR];
      const candidates = predictors.map(predictor => ({predictor, freqs: leaves.map(() => new Uint32Array(ALPHABET))}));
      const at = [0, 0.5, 1].map(fraction => [Math.floor((width - sw) * fraction), Math.floor((height - sh) * fraction)]);
      const squares = journalFact(rgba, JOIN) ? readEach(at.map(([x, y]) => () => [rgba.rect(x, y, sw, sh), sw, 0])) : at.map(([x, y]) => [rgba.subarray(y * width * 4, (y + sh) * width * 4), width, x]);
      for (const [pixels, stride, x] of squares) {
        fill(planes, pixels, stride, x, 0, sw, sh);
        for (const candidate of candidates) for (let c = 0; c < channels; c++) {
          const multiplier = leaves[c].multiplier;
          if (multiplier > 1 && candidate.predictor === AVERAGE_PREDICTOR) continue;
          codeChannel(null, candidate.freqs[c], planes[c], sw, sh, leaf(candidate.predictor, 0, multiplier));
        }
      }
      leaves.forEach((l, c) => {
        const costs = candidates.map(candidate => l.multiplier > 1 && candidate.predictor === AVERAGE_PREDICTOR ? Infinity : cost(candidate.freqs[c]));
        let choice = 0;
        for (let p = 1; p < costs.length; p++) if (costs[p] < costs[choice]) choice = p;
        l.predictor = candidates[choice].predictor;
      });
      return leaves.map(l => l.predictor);
    };
    const chosen = units ? yield* unit('predictors', choose) : choose();
    leaves.forEach((l, c) => { l.predictor = chosen[c]; });
  }
  const transforms = palette
    ? [{type: 'palette', beginC: 0, numC: channels, nbColors: palette.colours.length}]
    : channels >= 3 && !samples?.exponentBits && rct?.type !== 0 ? [{type: 'rct', beginC: 0, rctType: rct?.type ?? 6}] : [];

  let freqs = leaves.map(() => new Uint32Array(samples ? ALPHABET : (palette ? 4096 : 1024) + 33));
  if (paletteRows) codeChannel(null, freqs[0], paletteRows, palette.colours.length, channels, leaves[0], !samples);
  const count = planGroup(setup, rct);
  let chunks;
  if (units) {
    chunks = [];
    for (let g = 0; g < groups;) {
      const to = g + Math.min(UNIT_GROUPS, layout.groupsX - g % layout.groupsX);
      chunks.push([g, to]); g = to;
    }
  }
  if (units) freqs = yield* stage('counts', function* () {
    for (const [from, to] of chunks) {
      const total = yield* carried('counts', () => { for (let g = from; g < to; g++) count(...rows(g), freqs); return freqs.map(f => f.slice()); });
      if (total !== PASSED) freqs = total;
      yield to / (2 * groups);
    }
    return freqs;
  });
  else yield* groupPass({at: g => (g + 1) / (2 * groups), stop: () => false}, groups, g => count(rgba, width, ...rect(g), freqs));

  if (!samples) {
  const pairs = freqs.map(losslessCoding);
  if (analysis && !palette && !rct) analysis.direct = {first: leaves.map(l => l.predictor), freqs: pairs.map(pair => pair[0].freqs)};
  const saving = pairs.reduce((n, pair) => n + pair[0].bits - pair[1].bits, 0);
  const choice = saving > 27 * (layout.single ? 1 : groups + 1) + 8 ? 1 : 0;
  leaves.forEach((l, i) => { l.config = pairs[i][choice].config; });
  freqs = pairs.map(pair => pair[choice].freqs);
  }

  const header = new BitWriter(256);
  writeImageHeader(header, width, height, shape.colour, shape.alpha, samples || {colorSpace});
  writeModularFrameHeader(header, {alpha: shape.alpha});
  const global = new BitWriter(4096);
  global.write(1, 1);
  global.write(1, 1);
  const ordered = writeTree(global, tree);
  const histograms = writeChannelHistograms(global, ordered, freqs, l => leaves.indexOf(l), i => leaves[i].config || RESIDUAL_CONFIG);
  const written = {...setup, codes: leaves.map((_, i) => histograms[i + 1]?.code)}, write = planGroup(written, rct);
  writeModularHeader(global, {useGlobalTree: true, transforms});
  if (paletteRows) codeChannel(global, written.codes[0], paletteRows, palette.colours.length, channels, leaves[0]);
  const sections = [];
  if (layout.single) {
    write(rgba, width, 0, 0, width, height, global);
    yield 1;
    sections.push(global.finish());
  } else {
    sections.push(global.finish());
    for (let i = 0; i < layout.dcGroupsX * layout.dcGroupsY + 1; i++) sections.push(new Uint8Array(0));
    const first = sections.length, place = (g, section) => { sections[first + g] = section; };
    if (units) {
      const written = [];
      for (const [from, to] of chunks) { written.push(yield* unit('sections', () => { const out = []; for (let g = from; g < to; g++) out.push(write(...rows(g))); return out; })); yield (groups + to) / (2 * groups); }
      readAll(written);
      written.forEach((list, i) => list.forEach((section, j) => place(chunks[i][0] + j, section)));
    }
    else yield* groupPass({at: g => (groups + g + 1) / (2 * groups), stop: () => false}, groups, g => place(g, write(rgba, width, ...rect(g))));
  }
  return assembleCodestream(header, sections, samples && (samples.level === 10 || samples.bitDepth > 12 || samples.exponentBits) ? 10 : 5, units && !layout.single && journalJoin);
}

export function* nativeSteps(data, width, height, {samples, quality = 100, effort = 1} = {}) {
  const choices = [{samples}];
  if (effort >= 2 && !samples.exponentBits) choices.push({samples, rct: {type: 0}});
  if (quality < 100) {
    const precision = samples.exponentBits ? samples.bitDepth - samples.exponentBits - 1 : samples.bitDepth - 1;
    const drop = Math.floor((100 - quality) * precision / 100);
    if (drop) {
      const quantized = {...samples, drop};
      choices.push({samples: quantized});
      if (effort >= 2 && !samples.exponentBits) choices.push({samples: quantized, rct: {type: 0}});
    }
  }
  let best, failure, hurried = false;
  for (let i = 0; i < choices.length; i++) {
    try {
      const steps = part(journaling() && data instanceof Uint8Array ? stage('native', function* () {
        return yield* losslessSteps(data, width, height, {...choices[i], units: true, shape: yield* inspectNativeSteps(data, width, height, choices[i].samples)});
      }) : losslessSteps(data, width, height, choices[i]), i, choices.length);
      let step, reply;
      try { while (!(step = steps.next(reply)).done) {
        reply = yield step.value;
        hurried ||= !!reply && !journalRequest(step.value);
      } } finally { if (!step?.done) steps.return?.(); }
      if (!best || step.value.length < best.length) best = step.value;
      if (hurried) return best;
    } catch (error) {
      if (error.code !== 'JXL_SIZE' && (!(error instanceof RangeError) || error.code)) throw error;
      failure = error;
    }
  }
  if (!best) throw failure;
  return best;
}

function nativeWords(data, samples) {
  return samples.sampleFormat === 'float32' && data instanceof Float32Array ? new Int32Array(data.buffer, data.byteOffset, data.length) : data;
}

function nativeQuantizer(samples) {
  if (!samples.drop) return value => value;
  const step = 1 << samples.drop, mask = step - 1;
  if (!samples.exponentBits) {
    return value => (value & ~mask) + step / 2;
  }
  const sign = samples.bitDepth === 32 ? 0x80000000 : 0x8000;
  const exponent = samples.bitDepth === 32 ? 0x7f800000 : 0x7c00;
  return value => {
    const magnitude = value & (sign - 1);
    if (magnitude >= exponent) return value;
    const low = magnitude & mask, base = magnitude - low;
    const rounded = base + (low > step / 2 || low === step / 2 && (base / step & 1) ? step : 0);
    return rounded >= exponent ? value : (value & sign) | rounded;
  };
}

function nativePaletteKey(data, i, grey, alpha, quantize) {
  let key = '' + quantize(data[i]);
  if (!grey) key += ',' + quantize(data[i + 1]) + ',' + quantize(data[i + 2]);
  return alpha ? key + ',' + data[i + 3] : key;
}

const inspectNativePixels = (data, width, height, samples, wantPalette) => complete(inspectNativeSteps(data, width, height, samples, wantPalette));
function* inspectNativeSteps(data, width, height, samples, wantPalette = true) {
  const banded = journaling() && journalFact(data, JOIN), rows = banded ? Math.max(1, Math.floor(SHAPE_BAND_BYTES / 2 / (width * 4))) : height;
  const quantize = nativeQuantizer(samples), floor = shapeFloors.get(data);
  const opaqueValue = samples.exponentBits ? samples.bitDepth === 32 ? 0x3f800000 : 0x3c00 : (1 << samples.bitDepth) - 1;
  const passes = function* () {
    let state = {opaque: !floor?.alpha, grey: (samples.colorChannels === 1 || (samples.colorChannels === undefined && samples.colorSpace === 'srgb')) && floor?.colour !== 3,
      keys: [], known: !!journalFact(data, FACTS)?.opaque};
    for (const pass of [0, 1]) for (let top = 0; top < height && (pass ? wantPalette && state.keys.length < MAX_PALETTE : state.known ? state.grey : state.opaque || state.grey); top += rows) {
      const from = state, run = () => {
        const bottom = Math.min(height, top + rows), words = nativeWords(data.subarray(top * width * 4, bottom * width * 4), samples), next = {...from};
        if (!pass) for (let i = 0; i < words.length; i += 4) {
          if (!next.known && words[i + 3] !== opaqueValue) next.opaque = false;
          if (quantize(words[i]) !== quantize(words[i + 1]) || quantize(words[i]) !== quantize(words[i + 2])) next.grey = false;
          if (!next.grey && (next.known || !next.opaque)) break;
        } else {
          const seen = new Set(from.keys), alpha = !next.opaque, zero = Array(next.grey ? 1 + alpha : 3 + alpha).fill(0).join(',');
          for (let i = 0; i < words.length && seen.size < MAX_PALETTE; i += 4) { const key = nativePaletteKey(words, i, next.grey, alpha, quantize); if (key !== zero) seen.add(key); }
          next.keys = [...seen];
        }
        return next;
      };
      state = banded ? yield* unit('native-band', run) : run();
    }
    return state;
  };
  const {opaque, grey, keys} = banded ? yield* stage('native-shape', passes) : yield* passes(), colour = grey ? 1 : 3, alpha = !opaque, channels = colour + (alpha ? 1 : 0);
  let palette = null;
  if (wantPalette && keys.length < MAX_PALETTE) {
    const zero = Array(channels).fill(0).join(','), entries = keys.map(key => ({key, values: key.split(',').map(Number)}));
    entries.sort((a, b) => { for (let c = 0; c < channels; c++) if (a.values[c] !== b.values[c]) return a.values[c] - b.values[c]; return 0; });
    palette = {colours: [zero, ...entries.map(row => row.key)], byte: (key, c) => Number(key.split(',')[c])};
  }
  return {colour, alpha, channels, palette};
}

function nativePlaneFill(channels, alpha, index, samples, rct) {
  const grey = channels - (alpha ? 1 : 0) === 1, quantize = nativeQuantizer(samples);
  const transform = !samples.exponentBits && !grey && rct?.type !== 0;
  return (planes, data, stride, x0, y0, w, h) => {
    const words = nativeWords(data, samples);
    for (let y = 0; y < h; y++) {
      let i = ((y0 + y) * stride + x0) * 4, at = y * w;
      for (let x = 0; x < w; x++, i += 4, at++) {
        if (index) { planes[0][at] = index.get(nativePaletteKey(words, i, grey, alpha, quantize)); continue; }
        const r = quantize(words[i]);
        if (grey) planes[0][at] = r;
        else {
          const g = quantize(words[i + 1]), b = quantize(words[i + 2]);
          if (transform) {
            const co = r - b, tmp = b + (co >> 1), cg = g - tmp;
            planes[0][at] = tmp + (cg >> 1); planes[1][at] = co; planes[2][at] = cg;
          } else { planes[0][at] = r; planes[1][at] = g; planes[2][at] = b; }
        }
        if (alpha) planes[channels - 1][at] = words[i + 3];
      }
    }
  };
}
