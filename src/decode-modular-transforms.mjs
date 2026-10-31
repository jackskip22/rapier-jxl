// SPDX-License-Identifier: MIT
import {DELTA_IMPLICIT} from './implicit-palette.mjs';
import {smoothTendency} from './decode-tables.mjs';
import {ModularPrediction} from './decode-modular-predict.mjs';

const BEGIN = [[3, 0], [6, 8], [10, 72], [13, 1096]];
const POWERS = [1]; for (let i = 1; i <= 32; i++) POWERS.push(POWERS[i - 1] * 2);
const EMPTY_I32 = new Int32Array(0);
const invalid = message => { throw Object.assign(new Error(message), {code: 'JXL_DECODE'}); };
const shape = c => ({width: c.width, height: c.height, hshift: c.hshift, vshift: c.vshift, data: EMPTY_I32, decoded: 0, regions: null});

function range(channels, begin, count, meta, mixed = false) {
  if (!count || begin + count > channels.length || !mixed && begin < meta && begin + count > meta) invalid('Invalid Modular transform channels.');
  return channels.slice(begin, begin + count);
}
function equalShapes(channels) {
  const first = channels[0];
  if (channels.some(c => c.width !== first.width || c.height !== first.height)) invalid('Modular transform channels have different dimensions.');
}
function defaultSqueezes(channels, meta) {
  if (channels.length === meta) return [];
  let {width: w, height: h} = channels[meta];
  const n = channels.length - meta, params = [];
  if (n >= 3 && channels[meta + 1].width === w && channels[meta + 1].height === h) {
    params.push({horizontal: true, inPlace: false, begin: meta + 1, count: 2}, {horizontal: false, inPlace: false, begin: meta + 1, count: 2});
  }
  const add = horizontal => params.push({horizontal, inPlace: true, begin: meta, count: n});
  if (h >= w && h > 8) { add(false); h = Math.ceil(h / 2); }
  while (w > 8 || h > 8) {
    if (w > 8) { add(true); w = Math.ceil(w / 2); }
    if (h > 8) { add(false); h = Math.ceil(h / 2); }
  }
  return params;
}

export function readModularTransforms(r, channels, count, parameters, checkSize, chargeWork) {
  const transforms = [];
  let meta = 0;
  for (let i = 0; i < count; i++) {
    const type = r.read(2);
    if (type === 0) {
      const begin = r.u32(BEGIN), rct = r.u32([[0, 6], [2, 0], [4, 2], [6, 10]]);
      if (rct > 41) invalid('Invalid reversible color transform.');
      const selected = range(channels, begin, 3, meta, true); equalShapes(selected);
      chargeWork(3 * selected[0].width * selected[0].height);
      transforms.push({type, begin, rct});
    } else if (type === 1) {
      const begin = r.u32(BEGIN), components = r.u32([[0, 1], [0, 3], [0, 4], [13, 1]]);
      const colors = r.u32([[8, 0], [10, 256], [12, 1280], [16, 5376]]);
      const deltas = r.u32([[0, 0], [8, 1], [10, 257], [16, 1281]]), predictor = r.read(4);
      if (predictor > 13) invalid('Invalid palette predictor.');
      const selected = range(channels, begin, components, meta); equalShapes(selected);
      chargeWork(components * selected[0].width * selected[0].height);
      if (channels.length + 2 - components > 65536) invalid('Too many transformed channels.');
      chargeWork(2 * channels.length);
      transforms.push({type, begin, components, colors, deltas, predictor, parameters, original: selected.map(shape)});
      channels.splice(begin, components, shape(selected[0]));
      channels.unshift({width: colors + deltas, height: components, hshift: -1, vshift: -1, data: EMPTY_I32, decoded: 0, regions: null});
      meta += begin < meta ? 2 - components : 1;
    } else if (type === 2) {
      const n = r.u32([[0, 0], [4, 1], [6, 9], [8, 41]]), params = [];
      for (let j = 0; j < n; j++) params.push({horizontal: !!r.read(1), inPlace: !!r.read(1), begin: r.u32(BEGIN), count: r.u32([[0, 1], [0, 2], [0, 3], [4, 4]])});
      if (!n) params.push(...defaultSqueezes(channels, meta));
      for (const p of params) {
        const selected = range(channels, p.begin, p.count, meta);
        if (p.begin < meta) {
          if (!p.inPlace) invalid('A meta channel squeeze must be in place.');
          meta += p.count;
        }
        p.original = selected.map(shape);
        chargeWork(selected.reduce((sum, channel) => sum + channel.width * channel.height, 0));
        if (channels.length + p.count > 65536) invalid('Too many transformed channels.');
        chargeWork(channels.length + p.count);
        const residuals = [];
        for (let k = 0; k < p.count; k++) {
          const before = selected[k], low = shape(before), high = shape(before);
          if (!before.width || !before.height || before.hshift > 30 || before.vshift > 30) invalid('Invalid squeeze dimensions.');
          const dimension = p.horizontal ? 'width' : 'height', shift = p.horizontal ? 'hshift' : 'vshift';
          low[dimension] = Math.ceil(before[dimension] / 2); high[dimension] = Math.floor(before[dimension] / 2);
          if (low[shift] >= 0) { low[shift]++; high[shift]++; }
          channels[p.begin + k] = low; residuals.push(high);
        }
        channels.splice(p.inPlace ? p.begin + p.count : channels.length, 0, ...residuals);
      }
      transforms.push({type, params});
    } else invalid('Reserved Modular transform.');
    if (channels.length > 65536) invalid('Too many transformed channels.');
    checkSize(channels);
  }
  return {transforms, meta};
}

function inverseRCT(channels, transform) {
  const {begin, rct} = transform, permutation = Math.floor(rct / 7), mode = rct % 7;
  const o0 = permutation % 3, o1 = (permutation + 1 + Math.floor(permutation / 3)) % 3, o2 = (permutation + 2 - Math.floor(permutation / 3)) % 3;
  const p0 = channels[begin].data, p1 = channels[begin + 1].data, p2 = channels[begin + 2].data;
  const d0 = o0 === 0 ? p0 : o0 === 1 ? p1 : p2;
  const d1 = o1 === 0 ? p0 : o1 === 1 ? p1 : p2;
  const d2 = o2 === 0 ? p0 : o2 === 1 ? p1 : p2;
  const count = p0.length;
  if (!mode) { channels[begin + o0].data = p0; channels[begin + o1].data = p1; channels[begin + o2].data = p2; return; }
  if (mode === 6) {
    for (let i = 0; i < count; i++) {
      const y = p0[i], co = p1[i], cg = p2[i];
      const middle = (y - (cg >> 1)) | 0;
      const b = (cg + middle) | 0, c = (middle - (co >> 1)) | 0, a = (c + co) | 0;
      d0[i] = a; d1[i] = b; d2[i] = c;
    }
  } else {
    const m0 = mode & 1, m1 = mode >> 1;
    for (let i = 0; i < count; i++) {
      const a = p0[i]; let b = p1[i], c = p2[i];
      if (m0) c = (c + a) | 0;
      if (m1 === 1) b = (b + a) | 0;
      else if (m1 === 2) b = (b + (((a + c) | 0) >> 1)) | 0;
      d0[i] = a; d1[i] = b; d2[i] = c;
    }
  }
}

function paletteEntry(table, index, component, depth) {
  if (index >= 0 && index < table.width) return table.data[Math.imul(component, table.width) + index];
  if (component >= 3) return 0;
  if (index < 0) {
    const n = (-(index + 1)) % 143;
    return DELTA_IMPLICIT[(n + 1) >> 1][component] * (n & 1 ? 1 : -1) * POWERS[Math.max(0, depth - 8)];
  }
  index -= table.width;
  const maximum = POWERS[depth] - 1;
  if (index < 64) return Math.floor((Math.floor(index / [1, 4, 16][component]) % 4) * maximum / 4) + POWERS[Math.max(0, depth - 3)];
  return Math.floor((Math.floor((index - 64) / [1, 5, 25][component]) % 5) * maximum / 4);
}
function inversePalette(channels, t, bitDepth) {
  const table = channels.shift(), index = channels[t.begin];
  const result = t.original.map(c => ({width: c.width, height: c.height, hshift: c.hshift, vshift: c.vshift, data: new Int32Array(c.width * c.height), decoded: c.width * c.height, regions: null}));
  const depth = Math.min(bitDepth, 24), idx = index.data, n = idx.length, tw = table.width, td = table.data;
  if (t.predictor === 0) {
    const clampSingle = t.components === 1 && !t.deltas;
    for (let c = 0; c < t.components; c++) {
      const out = result[c].data, row = Math.imul(c, tw);
      for (let i = 0; i < n; i++) {
        let code = idx[i];
        if (clampSingle) code = Math.min(Math.max(code, 0), tw - 1);
        out[i] = code >= 0 && code < tw ? td[row + code] : paletteEntry(table, code, c, depth);
      }
    }
    channels.splice(t.begin, 1, ...result);
    return;
  }
  for (let c = 0; c < t.components; c++) {
    const prediction = new ModularPrediction(result[c], {weighted: t.predictor === 6, parameters: t.parameters});
    const row = Math.imul(c, tw);
    for (let i = 0; i < n; i++) {
      const code = idx[i], delta = code < t.deltas;
      prediction.prepare();
      const entry = code >= 0 && code < tw ? td[row + code] : paletteEntry(table, code, c, depth);
      const value = (entry + (delta ? prediction.predict(t.predictor) : 0)) | 0;
      prediction.record(value);
    }
  }
  channels.splice(t.begin, 1, ...result);
}

function wideTendency(a, b, c) {
  if (a === b && b === c) return 0;
  if (Math.max(Math.abs(a), Math.abs(b), Math.abs(c)) < 134217728) return smoothTendency(a, b, c);
  let value;
  if (a >= b && b >= c) {
    value = Math.trunc(((Math.imul(4, a) - Math.imul(3, c) - b + 6) | 0) / 12);
    if (((value - (value & 1)) | 0) > Math.imul(2, (a - b) | 0)) value = (Math.imul(2, (a - b) | 0) + 1) | 0;
    if (((value + (value & 1)) | 0) > Math.imul(2, (b - c) | 0)) value = Math.imul(2, (b - c) | 0);
  } else if (a <= b && b <= c) {
    value = Math.trunc(((Math.imul(4, a) - Math.imul(3, c) - b - 6) | 0) / 12);
    if (((value + (value & 1)) | 0) < Math.imul(2, (a - b) | 0)) value = (Math.imul(2, (a - b) | 0) - 1) | 0;
    if (((value - (value & 1)) | 0) < Math.imul(2, (b - c) | 0)) value = Math.imul(2, (b - c) | 0);
  } else value = 0;
  return value;
}
function inverseSqueeze(channels, t) {
  for (let pIndex = t.params.length - 1; pIndex >= 0; pIndex--) {
    const p = t.params[pIndex], offset = p.inPlace ? p.begin + p.count : channels.length - p.count;
    const residuals = channels.splice(offset, p.count);
    for (let k = 0; k < p.count; k++) {
      const low = channels[p.begin + k], high = residuals[k], original = p.original[k];
      const ow = original.width, oh = original.height, output = new Int32Array(ow * oh);
      const ld = low.data, hd = high.data, lw = low.width, hw = high.width;
      if (p.horizontal) {
        const inner = lw, pairs = hw;
        for (let line = 0; line < oh; line++) {
          const lRow = line * lw, hRow = line * hw, oRow = line * ow;
          let previous = ld[lRow];
          for (let at = 0; at < pairs; at++) {
            const average = ld[lRow + at], next = at + 1 < inner ? ld[lRow + at + 1] : average;
            const difference = (hd[hRow + at] + wideTendency(previous, average, next)) | 0;
            const first = (average + ((difference + (difference < 0 ? 1 : 0)) >> 1)) | 0, second = (first - difference) | 0;
            const oi = oRow + at * 2;
            output[oi] = first; output[oi + 1] = second; previous = second;
          }
          if (pairs < inner) output[oRow + pairs * 2] = ld[lRow + pairs];
        }
      } else {
        const inner = low.height, pairs = high.height;
        for (let line = 0; line < ow; line++) {
          let previous = ld[line];
          for (let at = 0; at < pairs; at++) {
            const li = at * lw + line, average = ld[li], next = at + 1 < inner ? ld[li + lw] : average;
            const difference = (hd[at * hw + line] + wideTendency(previous, average, next)) | 0;
            const first = (average + ((difference + (difference < 0 ? 1 : 0)) >> 1)) | 0, second = (first - difference) | 0;
            const oi = at * 2 * ow + line;
            output[oi] = first; output[oi + ow] = second; previous = second;
          }
          if (pairs < inner) output[pairs * 2 * ow + line] = ld[pairs * lw + line];
        }
      }
      channels[p.begin + k] = {width: ow, height: oh, hshift: original.hshift, vshift: original.vshift, data: output, decoded: ow * oh, regions: null};
    }
  }
}

export function inverseModularTransforms(channels, transforms, bitDepth) {
  for (let i = transforms.length - 1; i >= 0; i--) {
    const t = transforms[i];
    if (t.type === 0) inverseRCT(channels, t);
    else if (t.type === 1) inversePalette(channels, t, bitDepth);
    else inverseSqueeze(channels, t);
  }
  return channels;
}
