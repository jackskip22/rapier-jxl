// SPDX-License-Identifier: MIT
import {DELTA_IMPLICIT} from './implicit-palette.mjs';
import {smoothTendency} from './decode-tables.mjs';
import {ModularPrediction} from './decode-modular-predict.mjs';

const BEGIN = [[3, 0], [6, 8], [10, 72], [13, 1096]];
const POWERS = [1]; for (let i = 1; i <= 32; i++) POWERS.push(POWERS[i - 1] * 2);
const invalid = message => { throw Object.assign(new Error(message), {code: 'JXL_INVALID'}); };
const shape = c => { const {data, decoded, regions, ...rest} = c; return rest; };

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

export function readModularTransforms(r, channels, count, parameters, checkSize) {
  const transforms = [];
  let meta = 0;
  for (let i = 0; i < count; i++) {
    const type = r.read(2);
    if (type === 0) {
      const begin = r.u32(BEGIN), rct = r.u32([[0, 6], [2, 0], [4, 2], [6, 10]]);
      if (rct > 41) invalid('Invalid reversible color transform.');
      equalShapes(range(channels, begin, 3, meta, true));
      transforms.push({type, begin, rct});
    } else if (type === 1) {
      const begin = r.u32(BEGIN), components = r.u32([[0, 1], [0, 3], [0, 4], [13, 1]]);
      const colors = r.u32([[8, 0], [10, 256], [12, 1280], [16, 5376]]);
      const deltas = r.u32([[0, 0], [8, 1], [10, 257], [16, 1281]]), predictor = r.read(4);
      if (predictor > 13) invalid('Invalid palette predictor.');
      const selected = range(channels, begin, components, meta); equalShapes(selected);
      transforms.push({type, begin, components, colors, deltas, predictor, parameters, original: selected.map(shape)});
      channels.splice(begin, components, {...shape(selected[0])});
      channels.unshift({width: colors + deltas, height: components, hshift: -1, vshift: -1});
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
        const residuals = [];
        for (let k = 0; k < p.count; k++) {
          const before = selected[k], low = {...shape(before)}, high = {...shape(before)};
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
  const order = [permutation % 3, (permutation + 1 + Math.floor(permutation / 3)) % 3, (permutation + 2 - Math.floor(permutation / 3)) % 3];
  const p = channels.slice(begin, begin + 3).map(c => c.data), count = p[0].length;
  for (let i = 0; i < count; i++) {
    let a = p[0][i], b = p[1][i], c = p[2][i];
    if (mode === 6) {
      const middle = (a - (c >> 1)) | 0;
      b = (c + middle) | 0; c = (middle - (p[1][i] >> 1)) | 0; a = (c + p[1][i]) | 0;
    } else {
      if (mode & 1) c = (c + a) | 0;
      if ((mode >> 1) === 1) b = (b + a) | 0;
      else if ((mode >> 1) === 2) b = (b + (((a + c) | 0) >> 1)) | 0;
    }
    p[order[0]][i] = a; p[order[1]][i] = b; p[order[2]][i] = c;
  }
}

function paletteEntry(table, index, component, depth) {
  if (index >= 0 && index < table.width) return table.data[component * table.width + index];
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
  const table = channels.shift(), index = channels[t.begin], result = t.original.map(c => ({...c, data: new Int32Array(c.width * c.height)}));
  const depth = Math.min(bitDepth, 24);
  for (let c = 0; c < t.components; c++) {
    const prediction = new ModularPrediction(result[c], {weighted: t.predictor === 6, parameters: t.parameters});
    for (let i = 0; i < index.data.length; i++) {
      let code = index.data[i];
      if (t.components === 1 && !t.deltas && t.predictor === 0) code = Math.min(Math.max(code, 0), table.width - 1);
      const delta = code < t.deltas;
      prediction.prepare();
      const value = (paletteEntry(table, code, c, depth) + (delta ? prediction.predict(t.predictor) : 0)) | 0;
      prediction.record(value);
    }
  }
  channels.splice(t.begin, 1, ...result);
}

function wideTendency(a, b, c) {
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
      const output = new Int32Array(original.width * original.height);
      const outer = p.horizontal ? original.height : original.width, inner = p.horizontal ? low.width : low.height;
      const pairs = p.horizontal ? high.width : high.height;
      for (let line = 0; line < outer; line++) {
        let previous = p.horizontal ? low.data[line * low.width] : low.data[line];
        for (let at = 0; at < inner; at++) {
          const li = p.horizontal ? line * low.width + at : at * low.width + line;
          const average = low.data[li], oi = p.horizontal ? line * original.width + at * 2 : at * 2 * original.width + line;
          if (at === pairs) { output[oi] = average; continue; }
          const next = at + 1 < inner ? low.data[li + (p.horizontal ? 1 : low.width)] : average;
          const hi = p.horizontal ? line * high.width + at : at * high.width + line;
          const difference = (high.data[hi] + wideTendency(previous, average, next)) | 0;
          const first = (average + Math.trunc(difference / 2)) | 0, second = (first - difference) | 0;
          output[oi] = first; output[oi + (p.horizontal ? 1 : original.width)] = second; previous = second;
        }
      }
      channels[p.begin + k] = {...original, data: output};
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
