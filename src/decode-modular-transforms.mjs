// SPDX-License-Identifier: MIT
import {DELTA_IMPLICIT} from './implicit-palette.mjs';
import {RECIPROCAL} from './decode-modular-weights.mjs';
import {streamKernels} from './decode-kernels.mjs';

const BEGIN = [[3, 0], [6, 8], [10, 72], [13, 1096]];
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

const CHUNK = 1048576;
const view = (kernels, at, n) => new Int32Array(kernels.buffer, at, n);

function inverseRCT(channels, transform) {
  const {begin, rct} = transform, permutation = Math.floor(rct / 7), mode = rct % 7;
  const order = [permutation % 3, (permutation + 1 + Math.floor(permutation / 3)) % 3, (permutation + 2 - Math.floor(permutation / 3)) % 3];
  const planes = [0, 1, 2].map(k => channels[begin + k].data);
  if (!mode) { order.forEach((to, k) => { channels[begin + to].data = planes[k]; }); return; }
  const kernels = streamKernels(), count = planes[0].length, chunk = Math.min(count, CHUNK), at = kernels.reserve([chunk * 4, chunk * 4, chunk * 4]);
  for (let i = 0; i < count; i += chunk) {
    const n = Math.min(chunk, count - i);
    planes.forEach((d, k) => view(kernels, at[k], n).set(d.subarray(i, i + n)));
    kernels.rct(n, at[0], at[1], at[2], mode, at[order[0]], at[order[1]], at[order[2]]);
    planes.forEach((d, k) => d.set(view(kernels, at[k], n), i));
  }
}

function inversePalette(channels, t, bitDepth) {
  const table = channels.shift(), index = channels[t.begin];
  const result = t.original.map(c => ({width: c.width, height: c.height, hshift: c.hshift, vshift: c.vshift, data: new Int32Array(c.width * c.height), decoded: c.width * c.height, regions: null}));
  const depth = Math.min(bitDepth, 24), codes = index.data, n = codes.length, tw = table.width, kernels = streamKernels();
  const tables = (at) => { view(kernels, at[0], table.data.length).set(table.data); view(kernels, at[1], DELTA_IMPLICIT.length * 3).set(DELTA_IMPLICIT.flat()); };
  const fixed = [table.data.length * 4, DELTA_IMPLICIT.length * 12];
  if (t.predictor === 0) {
    const clamp = t.components === 1 && !t.deltas ? 1 : 0, chunk = Math.min(n, CHUNK), at = kernels.reserve([...fixed, chunk * 4, chunk * 4]);
    tables(at);
    for (let i = 0; i < n; i += chunk) {
      const m = Math.min(chunk, n - i);
      view(kernels, at[2], m).set(codes.subarray(i, i + m));
      for (let c = 0; c < t.components; c++) { kernels.palette(m, at[2], at[3], at[0], tw, c, depth, clamp, at[1]); result[c].data.set(view(kernels, at[3], m), i); }
    }
  } else {
    const width = index.width, height = index.height, stride = width + 2;
    const at = kernels.reserve([...fixed, n * 4, n * 4, n * 4, 5 * stride * 8, 44, 65 * 4, 128, 32, 128]);
    const [, , codesAt, entriesAt, outAt, weightedAt, parametersAt, reciprocalsAt, io, nodeAt, blockAt] = at, i32 = kernels.i32;
    tables(at);
    view(kernels, codesAt, n).set(codes);
    i32.set(RECIPROCAL, reciprocalsAt / 4);
    i32.set([-1, 0, 0, 0, 0, t.predictor, 0, 1], nodeAt / 4);
    if (t.predictor === 6) i32.set(t.parameters, parametersAt / 4);
    i32.fill(0, blockAt / 4, blockAt / 4 + 32);
    for (let c = 0; c < t.components; c++) {
      kernels.palette(n, codesAt, entriesAt, at[0], tw, c, depth, 0, at[1]);
      i32.fill(0, weightedAt / 4, weightedAt / 4 + 10 * stride);
      i32.fill(0, io / 4, io / 4 + 32);
      i32.set([outAt, width, height, nodeAt, 0, 0, 0, 0, 0, 0, t.predictor === 6 ? parametersAt : 0, weightedAt, 0, 0, 0, blockAt, 0, 0], io / 4);
      i32[io / 4 + 23] = reciprocalsAt; kernels.f64[io / 8 + 12] = Number.MAX_SAFE_INTEGER;
      i32.set([entriesAt, codesAt, t.deltas], io / 4 + 26);
      kernels.modular(io);
      result[c].data.set(view(kernels, outAt, n));
    }
  }
  channels.splice(t.begin, 1, ...result);
}

function inverseSqueeze(channels, t) {
  const kernels = streamKernels();
  for (let pIndex = t.params.length - 1; pIndex >= 0; pIndex--) {
    const p = t.params[pIndex], offset = p.inPlace ? p.begin + p.count : channels.length - p.count;
    const residuals = channels.splice(offset, p.count);
    for (let k = 0; k < p.count; k++) {
      const low = channels[p.begin + k], high = residuals[k], original = p.original[k];
      const ow = original.width, oh = original.height, output = new Int32Array(ow * oh);
      const ld = low.data, hd = high.data, lw = low.width, hw = high.width;
      if (p.horizontal) {
        const rows = Math.max(1, Math.min(oh, Math.floor(CHUNK / Math.max(1, ow)))), at = kernels.reserve([rows * lw * 4, rows * hw * 4, rows * ow * 4]);
        for (let y = 0; y < oh; y += rows) {
          const m = Math.min(rows, oh - y);
          view(kernels, at[0], m * lw).set(ld.subarray(y * lw, (y + m) * lw)); view(kernels, at[1], m * hw).set(hd.subarray(y * hw, (y + m) * hw));
          kernels.squeezeAcross(at[0], lw, at[1], hw, at[2], ow, m);
          output.set(view(kernels, at[2], m * ow), y * ow);
        }
      } else {
        const inner = low.height, pairs = high.height, per = Math.max(1, Math.min(pairs, Math.floor(CHUNK / Math.max(1, ow))));
        const at = kernels.reserve([(per + 1) * ow * 4, per * ow * 4, 2 * per * ow * 4, ow * 4]);
        for (let a = 0; a < pairs; a += per) {
          const b = Math.min(pairs, a + per), lowRows = Math.min(inner, b + 1) - a;
          view(kernels, at[0], lowRows * ow).set(ld.subarray(a * lw, (a + lowRows) * lw));
          view(kernels, at[1], (b - a) * ow).set(hd.subarray(a * hw, b * hw));
          view(kernels, at[3], ow).set(a ? output.subarray((2 * a - 1) * ow, 2 * a * ow) : ld.subarray(0, ow));
          kernels.squeezeDown(at[0], lowRows, at[1], at[2], ow, b - a, at[3]);
          output.set(view(kernels, at[2], 2 * (b - a) * ow), 2 * a * ow);
        }
        if (pairs < inner) output.set(ld.subarray(pairs * lw, pairs * lw + ow), pairs * 2 * ow);
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
