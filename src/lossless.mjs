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

const MAX_PALETTE = 2048, PROBE_BITS = 13, PROBE_SIZE = 1 << PROBE_BITS;

export const shapeFloors = new WeakMap();

export const paletteKey = (rgba, i, grey, alpha) => grey
  ? (alpha ? rgba[i] + rgba[i + 3] * 256 : rgba[i])
  : rgba[i] + rgba[i + 1] * 256 + rgba[i + 2] * 65536 + (alpha ? rgba[i + 3] * 16777216 : 0);


export function inspectPixels(rgba, width, height, {palette: wantPalette = true, samples, ...options} = {}) {
  if (!samples && (rgba instanceof Uint16Array || rgba instanceof Float32Array)) samples = admitSampleFormat(rgba, options);
  if (samples) return inspectNativePixels(rgba, width, height, samples, wantPalette);
  const pixels = width * height, floor = shapeFloors.get(rgba);
  let opaque = !floor?.alpha, grey = floor?.colour !== 3, p = 0;
  for (let i = 0; p < pixels; p++, i += 4) {
    if (rgba[i + 3] !== 255) { opaque = false; if (!grey) break; }
    if (rgba[i] !== rgba[i + 1] || rgba[i] !== rgba[i + 2]) { grey = false; p++; break; }
  }
  if (!grey && opaque && p < pixels) {
    if (LITTLE_ENDIAN && rgba.byteOffset % 4 === 0) {
      const words = new Uint32Array(rgba.buffer, rgba.byteOffset, pixels);
      for (; p < pixels; p++) if (words[p] < 0xff000000) { opaque = false; break; }
    } else for (let i = p * 4 + 3; p < pixels; p++, i += 4) if (rgba[i] !== 255) { opaque = false; break; }
  }
  const colour = grey ? 1 : 3, alpha = !opaque, channels = colour + (alpha ? 1 : 0);
  const table = wantPalette ? new Uint32Array(PROBE_SIZE) : null, entries = [];
  let palette = null, tooMany = false;
  if (wantPalette && pixels >= 16384) {
    const step = ((pixels / 4096) | 0) || 1;
    let count = 0;
    for (let p = 0; p < pixels; p += step) {
      const k = paletteKey(rgba, p * 4, grey, alpha);
      if (k === 0) continue;
      let slot = Math.imul(k, 0x9e3779b1) >>> (32 - PROBE_BITS);
      while (table[slot] !== 0 && table[slot] !== k) slot = (slot + 1) & (PROBE_SIZE - 1);
      if (table[slot] === k) continue;
      table[slot] = k;
      if (++count >= MAX_PALETTE) { tooMany = true; break; }
    }
    if (!tooMany) table.fill(0);
  }
  for (let i = 0, p = 0; wantPalette && !tooMany && p < pixels; p++, i += 4) {
    const k = paletteKey(rgba, i, grey, alpha);
    if (k === 0) continue;
    let slot = Math.imul(k, 0x9e3779b1) >>> (32 - PROBE_BITS);
    while (table[slot] !== 0 && table[slot] !== k) slot = (slot + 1) & (PROBE_SIZE - 1);
    if (table[slot] === k) continue;
    table[slot] = k; entries.push(k);
    if (entries.length >= MAX_PALETTE) { tooMany = true; break; }
  }
  if (wantPalette && !tooMany && entries.length < MAX_PALETTE) {
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
      const bytes = yield* part(planSteps(rgba, width, height, candidates[i], colorSpace, rct, samples, analysis, options.fast), i, candidates.length);
      if (!best || bytes.length < best.length) best = bytes;
    } catch (error) { if (error.code !== 'JXL_SIZE') throw error; oversized = error; }
  }
  if (!best) throw oversized;
  return best;
}

function* planSteps(rgba, width, height, shape, colorSpace, rct, samples, analysis, fast) {
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
  const fill = planeFill(setup, rct), planes = Array.from({length: channels}, () => new Plane(32 * 32));
  const rect = g => groupRect(layout, width, height, g);

  let paletteRows = null;
  if (palette) {
    const n = palette.colours.length;
    paletteRows = new Plane(n * channels);
    palette.colours.forEach((k, at) => { for (let c = 0; c < channels; c++) paletteRows[c * n + at] = palette.byte(k, c); });
  }

  if (!palette && !fast) {
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
    for (const fraction of [0, 0.5, 1]) {
      fill(planes, rgba, width, Math.floor((width - sw) * fraction), Math.floor((height - sh) * fraction), sw, sh);
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
  }
  const transforms = palette
    ? [{type: 'palette', beginC: 0, numC: channels, nbColors: palette.colours.length}]
    : channels >= 3 && !samples?.exponentBits && rct?.type !== 0 ? [{type: 'rct', beginC: 0, rctType: rct?.type ?? 6}] : [];

  let freqs = leaves.map(() => new Uint32Array(samples ? ALPHABET : (palette ? 4096 : 1024) + 33));
  if (paletteRows) codeChannel(null, freqs[0], paletteRows, palette.colours.length, channels, leaves[0], !samples);
  const count = planGroup(setup, rct);
  yield* groupPass({at: g => (g + 1) / (2 * groups), stop: () => false}, groups, g => count(rgba, width, ...rect(g), freqs));

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
    yield* groupPass({at: g => (groups + g + 1) / (2 * groups), stop: () => false}, groups, g => place(g, write(rgba, width, ...rect(g))));
  }
  return assembleCodestream(header, sections, samples && (samples.level === 10 || samples.bitDepth > 12 || samples.exponentBits) ? 10 : 5);
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
      const steps = part(losslessSteps(data, width, height, choices[i]), i, choices.length);
      let step, reply;
      while (!(step = steps.next(reply)).done) {
        reply = yield step.value;
        hurried ||= !!reply;
      }
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

function inspectNativePixels(data, width, height, samples, wantPalette) {
  const words = nativeWords(data, samples), quantize = nativeQuantizer(samples);
  const opaqueValue = samples.exponentBits ? samples.bitDepth === 32 ? 0x3f800000 : 0x3c00 : (1 << samples.bitDepth) - 1;
  const floor = shapeFloors.get(data);
  let opaque = !floor?.alpha, grey = (samples.colorChannels === 1 || (samples.colorChannels === undefined && samples.colorSpace === 'srgb')) && floor?.colour !== 3;
  for (let i = 0; i < words.length; i += 4) {
    if (words[i + 3] !== opaqueValue) opaque = false;
    if (quantize(words[i]) !== quantize(words[i + 1]) || quantize(words[i]) !== quantize(words[i + 2])) grey = false;
    if (!opaque && !grey) break;
  }
  const colour = grey ? 1 : 3, alpha = !opaque, channels = colour + (alpha ? 1 : 0);
  let palette = null;
  if (wantPalette) {
    const zero = Array(channels).fill(0).join(','), seen = new Set();
    for (let i = 0; i < words.length; i += 4) {
      const key = nativePaletteKey(words, i, grey, alpha, quantize);
      if (key !== zero) seen.add(key);
      if (seen.size >= MAX_PALETTE) break;
    }
    if (seen.size < MAX_PALETTE) {
      const rows = [...seen].map(key => ({key, values: key.split(',').map(Number)}));
      rows.sort((a, b) => { for (let c = 0; c < channels; c++) if (a.values[c] !== b.values[c]) return a.values[c] - b.values[c]; return 0; });
      palette = {colours: [zero, ...rows.map(row => row.key)], byte: (key, c) => Number(key.split(',')[c])};
    }
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
