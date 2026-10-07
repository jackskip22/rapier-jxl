// Rapier's JPEG XL encoder: lossless pictures. MIT (LICENSE).
// The design of libjxl's fast lossless path, written for Rapier: 8-bit grey, grey+alpha, RGB or RGBA; an opaque
// alpha is dropped and a grey picture keeps one channel; up to 2048 colours try a palette against direct encoded
// cost. YCoCg decorrelates colour by default; samples choose gradient/average prediction; each channel takes one prefix
// code whose hybrid-integer configuration is chosen by exact price, zero runs as LZ77 copies; groups of 256x256 pixels,
// each an independent section. The effort door's colour-transform search supplies another reversible transform
// through the private `rct` planner input.
import {kernelHooks} from './kernel-hooks.mjs';
import {BitWriter, complete, part} from './bits.mjs';
import {writeImageHeader, writeModularFrameHeader, groupLayout, groupRect, groupPass, addCounts, assembleCodestream, GROUP_DIM} from './frame.mjs';
import {buildCode, writePrefixCode} from './prefix.mjs';
import {AVERAGE_PREDICTOR, GRADIENT_PREDICTOR, ALPHABET, RESIDUAL_CONFIG, leaf, channelTree, writeTree, writeModularHeader, writeChannelHistograms, codeChannel} from './modular.mjs';
import {losslessCoding} from './lossless-coding.mjs';
import {admitSampleFormat} from './admit.mjs';

const MAX_PALETTE = 2048;

// A pixel's packed colour, channel c in byte c, as the palette rows are laid out.
export const paletteKey = (rgba, i, grey, alpha) => grey
  ? (alpha ? rgba[i] + rgba[i + 3] * 256 : rgba[i])
  : rgba[i] + rgba[i + 1] * 256 + rgba[i + 2] * 65536 + (alpha ? rgba[i + 3] * 16777216 : 0);

// What the picture is: which channels it needs and, when few colours, its palette.
export function inspectPixels(rgba, width, height, {palette: wantPalette = true, samples, ...options} = {}) {
  if (!samples && (rgba instanceof Uint16Array || rgba instanceof Float32Array)) samples = admitSampleFormat(rgba, options);
  if (samples) return inspectNativePixels(rgba, width, height, samples, wantPalette);
  const pixels = width * height;
  let opaque = true, grey = true;
  for (let i = 0, p = 0; p < pixels; p++, i += 4) {
    if (rgba[i + 3] !== 255) { opaque = false; if (!grey) break; }
    if (rgba[i] !== rgba[i + 1] || rgba[i] !== rgba[i + 2]) { grey = false; if (!opaque) break; }
  }
  const colour = grey ? 1 : 3, alpha = !opaque, channels = colour + (alpha ? 1 : 0);
  const key = i => paletteKey(rgba, i, grey, alpha);
  const seen = new Map();
  let palette = null;
  for (let i = 0, p = 0; wantPalette && p < pixels; p++, i += 4) {
    const k = key(i);
    if (k === 0 || seen.has(k)) continue;
    seen.set(k, 1);
    if (seen.size >= MAX_PALETTE) break;
  }
  if (wantPalette && seen.size < MAX_PALETTE) {
    const entries = [...seen.keys()];
    const byte = (k, c) => (k >>> 8 * c) & 255;
    const weight = k => (0.299 * byte(k, 0) + 0.587 * byte(k, 1) + 0.114 * byte(k, 2) + 0.01) * (channels === 4 ? byte(k, 3) : 1);
    entries.sort((a, b) => weight(a) - weight(b));
    palette = {colours: [0, ...entries], byte};
  }
  return {colour, alpha, channels, palette};
}

// Channel planes of a group rectangle, straight from the pixels (rows `stride` pixels apart, so the picture or one
// group's own copy): a palette's indices, the planner's reversible colour transform, YCoCg, or grey and alpha as they
// are. `palette` is the colours in index order.
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

// A group of a plan, here or in a pool's worker: `picture` names each picture channel's leaf. Without codes it counts
// the group into `target` (a raw histogram per leaf); with them it writes the group into `target`, or, when none, as
// its own section, whose bytes it returns.
export function planGroup(setup, rct) {
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

export function encodeLossless(rgba, width, height, options) { return complete(losslessSteps(rgba, width, height, options)); }

// The same, a group of one pass per step; `pooled`, each pass of groups is one step for a pool (pool.mjs).
export function* losslessSteps(rgba, width, height, options = {}) {
  const {colorSpace, rct, pooled} = options;
  let {samples} = options;
  if (!samples) { const format = admitSampleFormat(rgba, options); if (!format.native8) samples = format; }
  const shape = options.shape || inspectPixels(rgba, width, height, {samples});
  // The complete stream cost includes the palette, tree, histograms and group headers. A candidate that reaches
  // the stream limit must not hide a smaller valid representation of the same pixels.
  let best, oversized;
  const candidates = shape.palette ? [shape, {...shape, palette: null}] : [shape];
  for (let i = 0; i < candidates.length; i++) {
    try {
      const bytes = yield* part(planSteps(rgba, width, height, candidates[i], colorSpace, rct, pooled, samples), i, candidates.length);
      if (!best || bytes.length < best.length) best = bytes;
    } catch (error) { if (error.code !== 'JXL_SIZE') throw error; oversized = error; }
  }
  if (!best) throw oversized;
  return best;
}

function* planSteps(rgba, width, height, shape, colorSpace, rct, pooled, samples) {
  const {channels, alpha, palette} = shape;
  const layout = groupLayout(width, height), groups = layout.groupsX * layout.groupsY;
  const streamChannels = palette ? 2 : channels;  // the palette's meta channel and the index channel
  const leaves = Array.from({length: streamChannels}, () => leaf(GRADIENT_PREDICTOR));
  const tree = channelTree(leaves);
  // What a group of this plan needs, wherever it is coded: the image channels' leaves (in the global section they
  // follow the palette's meta channel; in a group they start at 0).
  const setup = {channels, alpha, palette: palette && palette.colours, rct: rct?.type, samples, leaves, picture: palette ? [layout.single ? 1 : 0] : leaves.map((_, c) => c)};
  const Plane = samples ? Int32Array : Int16Array;
  const fill = planeFill(setup, rct), planes = Array.from({length: channels}, () => new Plane(32 * 32));
  const rect = g => groupRect(layout, width, height, g);

  // The palette meta channel: one row per channel, one column per colour.
  let paletteRows = null;
  if (palette) {
    const n = palette.colours.length;
    paletteRows = new Plane(n * channels);
    palette.colours.forEach((k, at) => { for (let c = 0; c < channels; c++) paletteRows[c * n + at] = palette.byte(k, c); });
  }

  // Three small spatial samples choose gradient/average per channel. The same token code prices
  // both the prefix header and raw residual bits. Fixed YCoCg avoids choosing RGB from a sparse corner
  // that misrepresents a drawing; the measured corpus favours this smaller rule, including tiny pictures. The
  // higher-effort sampler (rct-search.mjs) ranks other transforms, but a complete alternate stream must be smaller.
  if (!palette) {
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
      for (const candidate of candidates) for (let c = 0; c < channels; c++) codeChannel(null, candidate.freqs[c], planes[c], sw, sh, leaf(candidate.predictor));
    }
    leaves.forEach((l, c) => {
      const costs = candidates.map(candidate => cost(candidate.freqs[c]));
      let choice = 0;
      for (let p = 1; p < costs.length; p++) if (costs[p] < costs[choice]) choice = p;
      l.predictor = candidates[choice].predictor;
    });
  }
  const transforms = palette
    ? [{type: 'palette', beginC: 0, numC: channels, nbColors: palette.colours.length}]
    : channels >= 3 && !samples?.exponentBits && rct?.type !== 0 ? [{type: 'rct', beginC: 0, rctType: rct?.type ?? 6}] : [];

  // Pass one: token histograms per leaf, a group a step.
  let freqs = leaves.map(() => new Uint32Array(samples ? ALPHABET : (palette ? 4096 : 1024) + 33));
  if (paletteRows) codeChannel(null, freqs[0], paletteRows, palette.colours.length, channels, leaves[0], !samples);
  const count = planGroup(setup, rct);
  yield* groupPass({pooled, kind: 'plan', setup: {...setup, sizes: freqs.map(f => f.length)}, at: g => (g + 1) / (2 * groups), stop: () => false},
    groups, g => count(rgba, width, ...rect(g), freqs), (g, counts) => addCounts(freqs, counts));

  if (!samples) {
  const pairs = freqs.map(losslessCoding);
  const saving = pairs.reduce((n, pair) => n + pair[0].bits - pair[1].bits, 0);
  // Seven padding bits per section and at most twenty extra TOC bits: a smaller payload alone need not
  // be a smaller complete stream. Inside that uncertainty interval keep the original representation.
  const choice = saving > 27 * (layout.single ? 1 : groups + 1) + 8 ? 1 : 0;
  leaves.forEach((l, i) => { l.config = pairs[i][choice].config; });
  freqs = pairs.map(pair => pair[choice].freqs);
  }

  // Pass two: the sections.
  const header = new BitWriter(256);
  writeImageHeader(header, width, height, shape.colour, shape.alpha, samples || {colorSpace});
  writeModularFrameHeader(header, {alpha: shape.alpha});
  const global = new BitWriter(4096);
  global.write(1, 1);  // default DC quantisation
  global.write(1, 1);  // a global tree
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
    yield* groupPass({pooled, kind: 'plan', setup: written, at: g => (groups + g + 1) / (2 * groups), stop: () => false},
      groups, g => place(g, write(rgba, width, ...rect(g))), place);
  }
  return assembleCodestream(header, sections);
}

// Native precision uses the same group planner and entropy writer as bytes. Quantisation is a source-domain
// policy before reversible coding; alpha is never quantised. A smaller completed exact stream always stands.
export function* nativeSteps(data, width, height, {samples, quality = 100, effort = 1, pooled} = {}) {
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
      const steps = part(losslessSteps(data, width, height, {...choices[i], pooled}), i, choices.length);
      let step, reply;
      while (!(step = steps.next(reply)).done) {
        reply = yield step.value;
        hurried ||= reply === null || (typeof reply === 'object' ? reply.hurried : !!reply);
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
    const maximum = (1 << samples.bitDepth) - 1;
    return value => Math.min(maximum, Math.round(value / step) * step);
  }
  const sign = samples.bitDepth === 32 ? 0x80000000 : 0x8000;
  const exponent = samples.bitDepth === 32 ? 0x7f800000 : 0x7c00;
  return value => {
    const magnitude = value & (sign - 1);
    if (magnitude >= exponent) return value;
    const low = magnitude & mask, base = magnitude - low;
    const rounded = base + (low > step / 2 || low === step / 2 && (base / step & 1) ? step : 0);
    // Rounding a largest finite sample must not manufacture infinity.
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
  let opaque = true, grey = samples.colorSpace === 'srgb';
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
