// Rapier's JPEG XL encoder: lossless pictures. MIT (images/jxl/LICENSE).
import {outOfMemory} from './fault.mjs';
import {kernelHooks, ensured, missing, declined} from './kernel-hooks.mjs';
import {wasmRequired} from './capture-wasm-error.mjs';
import {BitWriter, complete, part} from './bits.mjs';
import {writeModularFrameHeader, groupLayout, groupRect, groupPass, assembleCodestream, writeTOC, addCounts, GROUP_DIM} from './frame.mjs';
import {writeImageHeader} from './icc-write.mjs';
import {buildCode, writePrefixCode} from './prefix.mjs';
import {AVERAGE_PREDICTOR, GRADIENT_PREDICTOR, ALPHABET, RESIDUAL_CONFIG, leaf, channelTree, streamTree, writeTree, writeModularHeader, writeChannelHistograms} from './modular.mjs';
import {codeChannel} from './modular-channel.mjs';
import {captureNativeFill, captureDistinctWords, captureNativeShape, captureWordsOr, INTEGER_WORDS} from './capture-kernels.mjs';
import {losslessCoding, losslessPayloadBits} from './lossless-coding.mjs';
import {admitSampleFormat} from './admit-samples.mjs';
import {halfWords} from './half-samples.mjs';
import {unit, carried, stage, journaling, journalRequest, readAll, readEach, journalJoin, journalFact, JOIN, FACTS, PASSED} from './step-journal.mjs';

const MAX_PALETTE = 2048, PROBE_BITS = 13, PROBE_SIZE = 1 << PROBE_BITS;

export const shapeFloors = /* @__PURE__ */ new WeakMap();

export const paletteKey = (rgba, i, grey, alpha) => grey
  ? (alpha ? rgba[i] + rgba[i + 3] * 256 : rgba[i])
  : rgba[i] + rgba[i + 1] * 256 + rgba[i + 2] * 65536 + (alpha ? rgba[i + 3] * 16777216 : 0);

export function opaquePixels(rgba, from = 0, to = rgba.length) {
  if (rgba instanceof Uint8Array || rgba instanceof Uint8ClampedArray) {
    if (!kernelHooks.opaque) kernelHooks.ensure?.();
    const native = kernelHooks.opaque?.(rgba.subarray(from, to));
    if (native === undefined) throw wasmRequired();
    return native;
  }
  for (let i = from + 3; i < to; i += 4) if (rgba[i] !== 255) return false;
  return true;
}


export function inspectPixels(rgba, width, height, {palette: wantPalette = true, opacity = true, samples, ...options} = {}) {
  if (!(typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true)) {
    if (!samples && (rgba instanceof Uint16Array || rgba instanceof Float32Array)) samples = admitSampleFormat(rgba, options);
    if (samples) return inspectNativePixels(rgba, width, height, samples, wantPalette);
  }
  const pixels = width * height, scan = shapeScan(pixels, {palette: wantPalette, opacity}, shapeFloors.get(rgba));
  shapeScanPixels(scan, rgba, 0, pixels);
  return shapeResult(scan);
}

const SHAPE_BAND_BYTES = 2 << 20;
export function* inspectPixelsSteps(rgba, width, height) {
  if (!journaling() || rgba instanceof Uint16Array || rgba instanceof Float32Array) return inspectPixels(rgba, width, height);
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
      if (!opaquePixels(rgba, (p - base) * 4, (end - base) * 4)) scan.opaque = false;
      p = end;
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

export function planeFill({channels, alpha, palette, samples, chan, lattice}, rct) {
  const grey = channels - (alpha ? 1 : 0) === 1;
  if (samples) return nativePlaneFill(channels, alpha, palette, samples, rct, chan, lattice);
  return (planes, rgba, stride, x0, y0, w, h) => {
    if (rct && !palette && channels >= 3) { rct.fill(planes, rgba, stride, x0, y0, w, h); return; }
    if (palette) (kernelHooks.palette ?? ensured().palette ?? missing())(rgba, stride, x0, y0, w, h, palette, grey, alpha, planes[0]);
    else (kernelHooks.fill ?? ensured().fill ?? missing())(rgba, stride, x0, y0, w, h, channels, planes);
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
    const own = l => setup.lattice ? {...l, multiplier: 1} : l;
    if (!codes) { picture.forEach((l, c) => codeChannel(null, target[l], planes[c], w, h, own(leaves[l]), !setup.samples || setup.raw?.[l])); return; }
    const section = target || new BitWriter(w * h * picture.length + 64);
    if (!target) writeModularHeader(section, {useGlobalTree: true, transforms: []});
    picture.forEach((l, c) => codeChannel(section, codes[l], planes[c], w, h, own(leaves[l])));
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
  if (!samples && !(colorSpace && typeof colorSpace === 'object') && !(typeof colorSpace === 'string' && colorSpace.includes(';'))) { const format = admitSampleFormat(rgba, options); if (!format.native8) samples = format; }
  const shape = options.shape || inspectPixels(rgba, width, height, {samples});
  let best, oversized;
  const chan = samples && !shape.palette && !samples.drop ? channelTables(rgba, width, height, shape, samples) : null;
  const candidates = shape.palette ? [shape, {...shape, palette: null}] : chan ? options.effort >= 2 ? [{...shape, chan}, shape] : [{...shape, chan}] : [shape];
  const lattice = samples && !shape.palette && !samples.drop ? nativeLattice(rgba, width, height, shape.channels, shape.alpha, samples, rct?.type) : null;
  if (lattice && (lattice.rctType !== 0 && samples.exponentBits || lattice.shifts.some(Boolean))) candidates.push({...shape, lattice});
  for (let i = 0; i < candidates.length; i++) {
    try {
      const bytes = yield* part(planSteps(rgba, width, height, candidates[i], colorSpace, rct, samples, analysis, options.units && journaling()), i, candidates.length);
      if (!best || bytes.length < best.length) best = bytes;
    } catch (error) { if (error.code !== 'JXL_SIZE') throw error; oversized = error; }
  }
  if (chan && best && options.deep && options.effort >= 3) {
    for (const rung of options.effort >= 6 ? [4, 6] : [4]) {
      const candidate = yield* options.deep.nativeLocalSteps(rgba, width, height, {...shape, chan}, samples, rung, best.length);
      if (candidate && candidate.length < best.length) best = candidate;
    }
  }
  if (!best) throw oversized;
  return best;
}

const UNIT_GROUPS = 2;
function* planSteps(rgba, width, height, shape, colorSpace, rct, samples, analysis, units = false) {
  const {channels, alpha, palette, chan, lattice} = shape;
  const layout = groupLayout(width, height), groups = layout.groupsX * layout.groupsY;
  const tabled = chan ? chan.flatMap((table, c) => table ? [c] : []) : [], metaCount = tabled.length;
  const streamChannels = palette ? 2 : chan ? metaCount + channels : channels;
  const step = samples?.drop && !samples.exponentBits ? 1 << samples.drop : 1;
  const leaves = Array.from({length: streamChannels}, (_, c) => {
    let multiplier = lattice ? 1 << lattice.shifts[c] : 1;
    if (!lattice && !palette && step > 1 && c < channels - Number(alpha)) {
      multiplier = channels >= 3 && rct?.type !== 0
        ? [Math.max(1, step >> 2), step, Math.max(1, step >> 1)][c] : step >> 1;
    }
    return leaf(GRADIENT_PREDICTOR, 0, multiplier);
  });
  const treeOf = leaves => chan && !layout.single
    ? streamTree([{streamId: 0, tree: channelTree(leaves.slice(0, metaCount))}, {streamId: 1, tree: channelTree(leaves.slice(metaCount))}])
    : channelTree(leaves);
  const raw = chan ? leaves.map((_, i) => i >= metaCount && !!chan[i - metaCount]) : null;
  const setup = {channels, alpha, palette: palette && palette.colours, rct: lattice ? lattice.rctType : rct?.type, lattice, samples, leaves, chan, raw,
    picture: palette ? [layout.single ? 1 : 0] : chan ? Array.from({length: channels}, (_, c) => metaCount + c) : leaves.map((_, c) => c)};
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

  const metaPlanes = tabled.map(c => Int32Array.from(chan[c])).reverse();
  let spatialLeaves;
  if (!palette) {
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
      const predictors = samples ? [GRADIENT_PREDICTOR, AVERAGE_PREDICTOR, 1, 2, 0] : [GRADIENT_PREDICTOR, AVERAGE_PREDICTOR, 0];
      const candidates = predictors.map(predictor => ({predictor, freqs: leaves.map(() => new Uint32Array(ALPHABET))}));
      const at = [0, 0.5, 1].map(fraction => [Math.floor((width - sw) * fraction), Math.floor((height - sh) * fraction)]);
      const squares = journalFact(rgba, JOIN) ? readEach(at.map(([x, y]) => () => [rgba.rect(x, y, sw, sh), sw, 0])) : at.map(([x, y]) => [rgba.subarray(y * width * 4, (y + sh) * width * 4), width, x]);
      for (const [pixels, stride, x] of squares) {
        fill(planes, pixels, stride, x, 0, sw, sh);
        for (const candidate of candidates) for (let c = 0; c < channels; c++) {
          const multiplier = leaves[metaCount + c].multiplier;
          if (multiplier > 1 && candidate.predictor === AVERAGE_PREDICTOR) continue;
          codeChannel(null, candidate.freqs[metaCount + c], planes[c], sw, sh, leaf(candidate.predictor, 0, lattice ? 1 : multiplier));
        }
      }
      return leaves.map((l, i) => {
        if (i < metaCount) return [l.predictor, l.predictor];
        const costs = candidates.map(candidate => l.multiplier > 1 && candidate.predictor === AVERAGE_PREDICTOR ? Infinity : cost(candidate.freqs[i]));
        const select = count => {
          let choice = 0;
          for (let p = 1; p < count; p++) if (costs[p] < costs[choice]) choice = p;
          return candidates[choice].predictor;
        };
        return [select(samples ? costs.length : 2), select(costs.length)];
      });
    };
    const chosen = units ? yield* unit('predictors', choose) : choose();
    if (!samples) spatialLeaves = leaves.map((l, c) => ({...l, predictor: chosen[c][0]}));
    leaves.forEach((l, c) => { l.predictor = chosen[c][1]; });
  }
  const transforms = palette
    ? [{type: 'palette', beginC: 0, numC: channels, nbColors: palette.colours.length}]
    : chan ? tabled.map((c, at) => ({type: 'palette', beginC: at + c, numC: 1, nbColors: chan[c].length}))
    : channels >= 3 && (lattice ? lattice.rctType !== 0 : !samples?.exponentBits && rct?.type !== 0)
      ? [{type: 'rct', beginC: 0, rctType: lattice ? lattice.rctType : (rct?.type ?? 6)}] : [];

  const emptyCounts = () => leaves.map((_, i) => new Uint32Array(raw?.[i] ? 2 * chan[i - metaCount].length + 34 : samples ? ALPHABET : (palette ? 4096 : 1024) + 33));
  let freqs = emptyCounts();
  if (paletteRows) codeChannel(null, freqs[0], paletteRows, palette.colours.length, channels, leaves[0], !samples);
  metaPlanes.forEach((plane, j) => codeChannel(null, freqs[j], plane, plane.length, 1, leaves[j]));
  const count = planGroup(setup, rct);
  const proposals = spatialLeaves ? [leaves.map(l => ({...l, predictor: GRADIENT_PREDICTOR})), spatialLeaves, leaves] : [leaves];
  const models = proposals.filter((model, i) => !proposals.slice(0, i).some(previous => previous.every((l, c) => l.predictor === model[c].predictor)));
  const compare = models.length > 1;
  const counters = compare && models.map(leaves => planGroup({...setup, leaves}, rct));
  const grouped = compare && models.map(() => []), modelFreqs = compare && models.map(() => emptyCounts());
  const counted = g => {
    const pixels = units ? rows(g) : [rgba, width, ...rect(g)];
    return counters.map(counter => { const freqs = emptyCounts(); counter(...pixels, freqs); return freqs; });
  };
  const keepCounts = (g, counts) => counts.forEach((freqs, i) => {
    grouped[i][g] = freqs; addCounts(modelFreqs[i], freqs);
  });
  let chunks;
  if (units) {
    chunks = [];
    for (let g = 0; g < groups;) {
      const to = g + Math.min(UNIT_GROUPS, layout.groupsX - g % layout.groupsX);
      chunks.push([g, to]); g = to;
    }
  }
  if (compare && units) {
    const countedChunks = [];
    for (const [from, to] of chunks) {
      countedChunks.push(yield* unit('predictor-counts', () => Array.from({length: to - from}, (_, i) => counted(from + i))));
      yield to / (2 * groups);
    }
    readAll(countedChunks);
    readEach(countedChunks.map(list => () => readAll(list.flat(2))));
    countedChunks.forEach((list, i) => list.forEach((counts, j) => keepCounts(chunks[i][0] + j, counts)));
  } else if (compare) yield* groupPass({at: g => (g + 1) / (2 * groups), stop: () => false}, groups, g => keepCounts(g, counted(g)));
  else if (units) freqs = yield* stage('counts', function* () {
    for (const [from, to] of chunks) {
      const total = yield* carried('counts', () => { for (let g = from; g < to; g++) count(...rows(g), freqs); return freqs.map(f => f.slice()); });
      if (total !== PASSED) freqs = total;
      yield to / (2 * groups);
    }
    return freqs;
  });
  else yield* groupPass({at: g => (g + 1) / (2 * groups), stop: () => false}, groups, g => count(rgba, width, ...rect(g), freqs));

  const prepare = (freqs, leaves) => {
    let direct = null;
    if (chan) {
      const rawLeaves = leaves.flatMap((_, i) => raw[i] ? [i] : []), pairs = rawLeaves.map(i => losslessCoding(freqs[i]));
      const saving = pairs.reduce((n, pair) => n + pair[0].bits - pair[1].bits, 0), choice = saving > 27 * (layout.single ? 1 : groups + 1) + 8 ? 1 : 0;
      rawLeaves.forEach((i, k) => { leaves[i].config = pairs[k][choice].config; freqs[i] = pairs[k][choice].freqs; });
    }
    if (!samples) {
      const pairs = freqs.map(losslessCoding);
      if (analysis && !palette && !rct) direct = {first: leaves.map(l => l.predictor), freqs: pairs.map(pair => pair[0].freqs)};
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
    const ordered = writeTree(global, treeOf(leaves));
    const histograms = writeChannelHistograms(global, ordered, freqs, l => leaves.indexOf(l), i => leaves[i].config || RESIDUAL_CONFIG);
    const written = {...setup, leaves, codes: leaves.map((_, i) => histograms[i + 1]?.code)};
    writeModularHeader(global, {useGlobalTree: true, transforms});
    if (paletteRows) codeChannel(global, written.codes[0], paletteRows, palette.colours.length, channels, leaves[0]);
    metaPlanes.forEach((plane, j) => codeChannel(global, written.codes[j], plane, plane.length, 1, leaves[j]));
    return {header, global, written, direct};
  };
  let plan;
  if (compare) {
    const size = (plan, counts) => {
      const groupHeader = new BitWriter(1);
      writeModularHeader(groupHeader, {useGlobalTree: true, transforms: []});
      const sizes = counts.map(counts => {
        let bits = layout.single ? plan.global.bitLength : groupHeader.bitLength;
        counts.forEach((raw, c) => { bits += losslessPayloadBits(raw, plan.written.leaves[c].config, plan.written.codes[c]); });
        return Math.ceil(bits / 8);
      });
      if (!layout.single) sizes.unshift(Math.ceil(plan.global.bitLength / 8), ...Array(layout.dcGroupsX * layout.dcGroupsY + 1).fill(0));
      const header = new BitWriter(256);
      header.append(plan.header); writeTOC(header, sizes);
      return header.at + sizes.reduce((sum, bytes) => sum + bytes, 0);
    };
    let least = Infinity;
    models.forEach((leaves, i) => {
      const candidate = prepare(modelFreqs[i], leaves), bytes = size(candidate, grouped[i]);
      if (bytes < least) { plan = candidate; least = bytes; }
    });
  } else plan = prepare(freqs, leaves);
  const {header, global, written} = plan, write = planGroup(written, rct);
  if (analysis && plan.direct) analysis.direct = plan.direct;
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
      for (const [from, to] of chunks) { written.push(yield* unit('sections', () => { const out = []; for (let g = from; g < to; g++) out.push(write(...rows(g))); return out; }, undefined, false, true)); yield (groups + to) / (2 * groups); }
      readAll(written);
      written.forEach((list, i) => list.forEach((section, j) => place(chunks[i][0] + j, section)));
    }
    else yield* groupPass({at: g => (groups + g + 1) / (2 * groups), stop: () => false}, groups, g => place(g, write(rgba, width, ...rect(g))));
  }
  return assembleCodestream(header, sections, samples && (samples.level === 10 || samples.bitDepth > 12 || samples.exponentBits) ? 10 : 5, units && !layout.single && journalJoin);
}

export function* nativeSteps(data, width, height, {samples, quality = 100, effort = 1, deep, report} = {}) {
  const floor = shapeFloors.get(data), half = samples.sampleFormat === 'float32' && !samples.iccSpace && !floor?.float32 ? halfWords(data) : null;
  if (half) { if (floor) shapeFloors.set(half, floor); data = half; samples = {...samples, sampleFormat: 'float16', bitDepth: 16, exponentBits: 5}; }
  const choices = [{samples, effort, deep}];
  if (effort >= 2 && !samples.exponentBits) choices.push({samples, effort, deep, rct: {type: 0}});
  if (quality < 100) {
    const precision = samples.exponentBits ? samples.bitDepth - samples.exponentBits - 1 : samples.bitDepth - 1;
    const drop = Math.floor((100 - quality) * precision / 100);
    if (drop) {
      const quantized = {...samples, drop};
      choices.push({samples: quantized, effort, deep});
      if (effort >= 2 && !samples.exponentBits) choices.push({samples: quantized, effort, deep, rct: {type: 0}});
    }
  }
  let best, failure, hurried = false, winner = -1;
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
      if (!best || step.value.length < best.length) { best = step.value; winner = i; }
      if (hurried) { if (quality < 100) report?.({kept: choices[winner].samples.drop ? 'lossy' : 'pixels', measurements: []}); return best; }
    } catch (error) {
      if (error.code !== 'JXL_SIZE' && !outOfMemory(error)) throw error;
      failure = error;
    }
  }
  if (!best) throw failure;
  if (quality < 100) report?.({kept: choices[winner].samples.drop ? 'lossy' : 'pixels', measurements: []});
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
  const qmode = !samples.drop ? 0 : !samples.exponentBits ? 1 : samples.bitDepth === 32 ? 2 : 3;
  const passes = function* () {
    let state = {opaque: !floor?.alpha, grey: (samples.colorChannels === 1 || (samples.colorChannels === undefined && samples.colorSpace === 'srgb')) && floor?.colour !== 3,
      keys: [], known: !!journalFact(data, FACTS)?.opaque};
    for (const pass of [0, 1]) for (let top = 0; top < height && (pass ? wantPalette && state.keys.length < MAX_PALETTE : state.known ? state.grey : state.opaque || state.grey); top += rows) {
      const from = state, run = () => {
        const bottom = Math.min(height, top + rows), words = nativeWords(data.subarray(top * width * 4, bottom * width * 4), samples), next = {...from};
        if (!pass) {
          if (INTEGER_WORDS.some(kind => words instanceof kind)) Object.assign(next, captureNativeShape(words, opaqueValue, next.known, next.opaque, next.grey, qmode, samples.drop ?? 0));
          else for (let i = 0; i < words.length; i += 4) {
            if (!next.known && words[i + 3] !== opaqueValue) next.opaque = false;
            if (quantize(words[i]) !== quantize(words[i + 1]) || quantize(words[i]) !== quantize(words[i + 2])) next.grey = false;
            if (!next.grey && (next.known || !next.opaque)) break;
          }
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

function nativePlaneFill(channels, alpha, palette, samples, rct, chan, lattice = null) {
  const grey = channels - (alpha ? 1 : 0) === 1;
  const rctMode = grey || chan ? 0 : lattice ? lattice.rctType : (!samples.exponentBits && rct?.type !== 0 ? 6 : 0);
  const [s0, s1, s2] = lattice ? lattice.shifts : [0, 0, 0], sa = lattice && alpha ? lattice.shifts[channels - 1] : 0;
  const qmode = !samples.drop ? 0 : !samples.exponentBits ? 1 : samples.bitDepth === 32 ? 2 : 3;
  const kernel = palette ? {channels, alpha, grey, rct: 0, shifts: [0, 0, 0, 0], tables: null, drop: samples.drop ?? 0, qmode}
    : {channels, alpha, grey, rct: rctMode, shifts: [s0, s1, s2, sa], tables: chan ?? null, drop: samples.drop ?? 0, qmode};
  const keys = palette && palette.map(key => key.split(',').map(Number)), raw = palette && Array.from({length: channels}, () => new Int32Array(GROUP_DIM * GROUP_DIM));
  return (planes, data, stride, x0, y0, w, h) => {
    const words = nativeWords(data, samples), n = w * h;
    if (keys) for (let c = 0; c < channels; c++) if (raw[c].length < n) raw[c] = new Int32Array(n);
    if (!captureNativeFill(keys ? raw : planes, words, stride, x0, y0, w, h, kernel)) throw declined('nativeFill');
    if (keys) (kernelHooks.tuple ?? ensured().tuple ?? missing())(raw.map(p => p.subarray(0, n)), n, keys, planes[0]);
  };
}

export function nativeLattice(data, width, height, channels, alpha, samples, rctType) {
  if (!samples || samples.drop) return null;
  const words = nativeWords(data, samples), colour = channels - Number(alpha), orCh = new Int32Array(channels), float = !!samples.exponentBits;
  let nonNegative = true;
  if (INTEGER_WORDS.some(kind => words instanceof kind)) {
    const scan = captureWordsOr(words, width * height * 4, colour, alpha, channels, float ? samples.bitDepth : 0);
    nonNegative = scan.nonNegative; orCh.set(scan.or);
  } else for (let i = 0, end = width * height * 4; i < end; i += 4) {
    for (let c = 0; c < colour; c++) {
      const w = words[i + c]; orCh[c] |= w;
      if (float && (samples.bitDepth === 32 ? w < 0 : (w & 0x8000) !== 0)) nonNegative = false;
    }
    if (alpha) orCh[channels - 1] |= words[i + 3];
  }
  const zeros = m => m ? Math.min(30, 31 - Math.clz32(m & -m)) : 0, bitLength = v => 32 - Math.clz32((v < 0 ? -v : v) | 1);
  let subtractGreen = colour === 3 && float && rctType !== 0 && nonNegative;
  if (subtractGreen && width >= 4) {
    const [t0, t1, t2] = [0, 1, 2].map(c => zeros(orCh[c])), common = Math.min(t0, t1, t2), rows = Math.min(height, 16), columns = Math.min(width - 1, 16);
    let plain = 0, green = 0;
    for (let ry = 0; ry < rows; ry++) {
      const y = Math.floor(ry * (height - 1) / Math.max(1, rows - 1));
      for (let rx = 0; rx < columns; rx++) {
        const i = (y * width + 1 + Math.floor(rx * (width - 2) / Math.max(1, columns - 1))) * 4, j = i - 4;
        const r0 = words[j], g0 = words[j + 1], b0 = words[j + 2], r1 = words[i], g1 = words[i + 1], b1 = words[i + 2];
        plain += bitLength((r1 - r0) >> t0) + bitLength((g1 - g0) >> t1) + bitLength((b1 - b0) >> t2);
        green += bitLength((g1 - g0) >> common) + bitLength(((b1 - g1) - (b0 - g0)) >> common) + bitLength(((r1 - g1) - (r0 - g0)) >> common);
      }
    }
    if (green >= plain) subtractGreen = false;
  }
  const chosen = colour === 3 ? (float ? (subtractGreen ? 10 : 0) : (rctType ?? 6)) : 0;
  const common = colour === 3 && chosen !== 0 ? Math.min(zeros(orCh[0]), zeros(orCh[1]), zeros(orCh[2])) : 0;
  const signed = alpha && float && (samples.bitDepth === 32 ? orCh[channels - 1] < 0 : (orCh[channels - 1] & 0x8000) !== 0);
  const shifts = Array.from({length: channels}, (_, c) => {
    if (alpha && c === channels - 1) return signed ? 0 : zeros(orCh[c]);
    if (chosen === 6 || (float && !nonNegative && samples.bitDepth === 16)) return 0;
    return chosen !== 0 ? common : zeros(orCh[c]);
  });
  return {rctType: chosen, shifts};
}

function channelTables(data, width, height, shape, samples) {
  const words = nativeWords(data, samples), stripRows = Math.max(1, Math.min(height, Math.floor(16384 / width)));
  const strips = [0, 0.5, 1].map(fraction => Math.floor((height - stripRows) * fraction));
  const cost = (plane, rows, size, bins) => {
    if (bins) {
      const counts = new Uint32Array(bins + 34);
      codeChannel(null, counts, plane, size, rows, leaf(GRADIENT_PREDICTOR), true);
      return losslessCoding(counts)[1].bits;
    }
    const counts = new Uint32Array(ALPHABET);
    codeChannel(null, counts, plane, size, rows, leaf(GRADIENT_PREDICTOR));
    const code = buildCode(counts);
    let bits = 0;
    for (let s = 0; s < ALPHABET; s++) if (counts[s]) bits += counts[s] * (code.lengths[s] + Math.max(0, s < 224 ? s - 1 : s - 236));
    return bits;
  };
  const scale = height * width / (3 * stripRows * width), info = [], planes = [];
  for (let c = 0; c < shape.channels; c++) {
    const from = c < shape.colour ? c : 3;
    let distinct;
    if (INTEGER_WORDS.some(kind => words instanceof kind)) distinct = captureDistinctWords(words, from, 65536);
    else {
      const seen = new Set();
      for (let i = from; i < words.length; i += 4) { seen.add(words[i]); if (seen.size > 65536) break; }
      distinct = seen.size > 65536 ? null : Int32Array.from(seen).sort();
    }
    const strip = strips.map(top => { const plane = new Int32Array(stripRows * width); for (let i = 0; i < plane.length; i++) plane[i] = words[(top * width + i) * 4 + from]; return plane; });
    planes.push(strip);
    const direct = strip.reduce((n, plane) => n + cost(plane, stripRows, width, 0), 0) * scale;
    if (!distinct) { info.push({direct}); continue; }
    const table = distinct, rank = new Map();
    table.forEach((value, at) => rank.set(value, at));
    const indexed = strip.reduce((n, plane) => n + cost(plane.map(value => rank.get(value)), stripRows, width, 2 * table.length), 0) * scale + cost(table, 1, table.length, 0);
    info.push({table, direct, indexed});
  }
  const joint = !samples.exponentBits && shape.colour === 3;
  let useColour = null;
  if (joint) {
    const colourStrips = strips.map((_, k) => {
      const out = [0, 1, 2].map(() => new Int32Array(stripRows * width));
      for (let i = 0; i < out[0].length; i++) { const r = planes[0][k][i], g = planes[1][k][i], b = planes[2][k][i], co = r - b, tmp = b + (co >> 1), cg = g - tmp; out[0][i] = tmp + (cg >> 1); out[1][i] = co; out[2][i] = cg; }
      return out;
    });
    const rct = colourStrips.reduce((n, planes3) => n + planes3.reduce((m, plane) => m + cost(plane, stripRows, width, 0), 0), 0) * scale;
    const tabled = info.slice(0, 3).reduce((n, entry) => n + (entry.table ? Math.min(entry.indexed, entry.direct) : entry.direct), 0);
    useColour = info.slice(0, 3).every(entry => entry.table) && tabled < 0.97 * rct;
  }
  const tables = info.map((entry, c) => entry.table && (joint ? (c < 3 ? useColour : useColour) : entry.indexed < entry.direct) ? entry.table : null);
  return tables.some(Boolean) ? tables : null;
}
