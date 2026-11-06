// SPDX-License-Identifier: MIT
import {kernelHooks} from './kernel-hooks.mjs';
import {calibration} from './quality-calibration.mjs';
import {float16Bits} from './bits.mjs';
import {exactLog, exactExp} from './exact-math.mjs';

const COSINES = Float64Array.of(0.3535533905932738, 0.3535533905932738, 0.3535533905932738, 0.3535533905932738,
  0.3535533905932738, 0.3535533905932738, 0.3535533905932738, 0.3535533905932738, 0.4903926402016152,
  0.4157348061512726, 0.27778511650980114, 0.09754516100806417, -0.0975451610080641, -0.277785116509801,
  -0.4157348061512727, -0.4903926402016152, 0.46193976625564337, 0.19134171618254492, -0.19134171618254486,
  -0.46193976625564337, -0.4619397662556434, -0.19134171618254517, 0.191341716182545, 0.46193976625564326,
  0.4157348061512726, -0.0975451610080641, -0.4903926402016152, -0.2777851165098011, 0.2777851165098009,
  0.4903926402016152, 0.09754516100806439, -0.41573480615127256, 0.3535533905932738, -0.35355339059327373,
  -0.35355339059327384, 0.3535533905932737, 0.35355339059327384, -0.35355339059327334, -0.35355339059327356,
  0.3535533905932733, 0.27778511650980114, -0.4903926402016152, 0.09754516100806415, 0.4157348061512728,
  -0.41573480615127256, -0.09754516100806401, 0.4903926402016153, -0.27778511650980076, 0.19134171618254492,
  -0.4619397662556434, 0.46193976625564326, -0.19134171618254495, -0.19134171618254528, 0.46193976625564337,
  -0.4619397662556432, 0.19134171618254478, 0.09754516100806417, -0.2777851165098011, 0.4157348061512728,
  -0.4903926402016153, 0.4903926402016152, -0.4157348061512725, 0.27778511650980076, -0.09754516100806429);
export {COSINES as dct8Basis};
const radial = (position, rate) => Float64Array.from({length: 64}, (_, k) => {
  const y = Math.max(0, position(Math.sqrt((k & 7) * (k & 7) + (k >> 3) * (k >> 3))) - 1) * rate;
  let term = 1, sum = 1;
  for (let n = 1; n < 30; n++) sum += term = term * y / n;
  return sum;
});
export const QUANT_SHAPE = radial(r => r * 5 / Math.sqrt(98), 0.26236426446749106);

function dctChannel(src, o, mid, dst, d) {
  for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) {
    let sum = 0;
    for (let k = 0; k < 8; k++) sum += src[o + i * 8 + k] * COSINES[j * 8 + k];
    mid[i * 8 + j] = sum;
  }
  for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) {
    let sum = 0;
    for (let k = 0; k < 8; k++) sum += mid[k * 8 + i] * COSINES[j * 8 + k];
    dst[d + j * 8 + i] = sum;
  }
}

export function transformDCT8(block, intermediate, sums, offset = 0) {
  for (let c = 0; c < 3; c++) dctChannel(block, offset + c * 64, intermediate, sums, c * 64);
  return sums;
}

export function transformDCT8Blocks(blocks, count, intermediate) {
  if (kernelHooks.dct?.(blocks, count, COSINES)) return;
  for (let n = 0; n < count * 3; n++) dctChannel(blocks, n * 64, intermediate, blocks, n * 64);
}

const B = COSINES, BUT = {b00: B[0], b40: B[32], b20: B[16], b21: B[17], b60: B[48], b61: B[49],
  o: [1, 3, 5, 7].map(u => [0, 1, 2, 3].map(x => B[u * 8 + x]))};
function butterfly(v, at, step) {
  const x = [0, 1, 2, 3, 4, 5, 6, 7].map(i => v[at + i * step]);
  const s0 = x[0] + x[7], d0 = x[0] - x[7], s1 = x[1] + x[6], d1 = x[1] - x[6], s2 = x[2] + x[5], d2 = x[2] - x[5], s3 = x[3] + x[4], d3 = x[3] - x[4];
  const e0 = s0 + s3, e1 = s1 + s2, f0 = s0 - s3, f1 = s1 - s2, {o} = BUT;
  v[at] = BUT.b00 * (e0 + e1);
  v[at + 4 * step] = BUT.b40 * (e0 - e1);
  v[at + 2 * step] = BUT.b20 * f0 + BUT.b21 * f1;
  v[at + 6 * step] = BUT.b60 * f0 + BUT.b61 * f1;
  for (let u = 0; u < 4; u++) v[at + (2 * u + 1) * step] = ((o[u][0] * d0 + o[u][1] * d1) + o[u][2] * d2) + o[u][3] * d3;
}
export function dct8Butterfly(blocks, count) {
  for (let p = 0; p < count * 192; p += 64) {
    for (let col = 0; col < 8; col++) butterfly(blocks, p + col, 8);
    for (let row = 0; row < 8; row++) butterfly(blocks, p + row * 8, 1);
  }
}

const FAST_S = Float64Array.of(1, 0.7209598223816907, 0.7653668647301796, 0.8504300941521988, 1, 1.2727585826345942, 1.8477590650225744, 3.6245097377961106);
export const FAST_SCALE = Float64Array.from({length: 64}, (_, k) => FAST_S[k & 7] * FAST_S[k >> 3] / 8);
export function transformDCT8BlocksFast(blocks, count) {
  const x = blocks;
  for (let n = 0; n < count; n++) {
    let o = n * 192;
    for (let c = 0; c < 3; c++, o += 64) {
      for (let pass = 0; pass < 2; pass++) {
        const stride = pass ? 8 : 1, step = pass ? 1 : 8;
        for (let i = 0; i < 8; i++) {
          const p = o + i * step;
          const x0 = x[p], x1 = x[p + stride], x2 = x[p + 2 * stride], x3 = x[p + 3 * stride];
          const x4 = x[p + 4 * stride], x5 = x[p + 5 * stride], x6 = x[p + 6 * stride], x7 = x[p + 7 * stride];
          const tmp0 = x0 + x7, tmp7 = x0 - x7, tmp1 = x1 + x6, tmp6 = x1 - x6;
          const tmp2 = x2 + x5, tmp5 = x2 - x5, tmp3 = x3 + x4, tmp4 = x3 - x4;
          const tmp10 = tmp0 + tmp3, tmp13 = tmp0 - tmp3, tmp11 = tmp1 + tmp2, tmp12 = tmp1 - tmp2;
          x[p] = tmp10 + tmp11; x[p + 4 * stride] = tmp10 - tmp11;
          const z1 = (tmp12 + tmp13) * 0.7071067811865476;
          x[p + 2 * stride] = tmp13 + z1; x[p + 6 * stride] = tmp13 - z1;
          const t10 = tmp4 + tmp5, t11 = tmp5 + tmp6, t12 = tmp6 + tmp7;
          const z5 = (t10 - t12) * 0.3826834333650898;
          const z2 = 0.5411961001461969 * t10 + z5, z4 = 1.3065629648763766 * t12 + z5, z3 = t11 * 0.7071067811865476;
          const z11 = tmp7 + z3, z13 = tmp7 - z3;
          x[p + 5 * stride] = z13 + z2; x[p + 3 * stride] = z13 - z2;
          x[p + stride] = z11 + z4; x[p + 7 * stride] = z11 - z4;
        }
      }
      for (let k = 0; k < 64; k++) x[o + k] *= FAST_SCALE[k];
    }
  }
}

const TABLE_FIELD = 2, AREA_FIELD = 8;
const half = b => (b & 0x8000 ? -1 : 1) * (b & 0x7c00 ? (1024 + (b & 1023)) * 2 ** (((b >> 10) & 31) - 25) : (b & 1023) * 2 ** -24);
const regionTable = rows => rows.map(([first, falls, dc]) => {
    const bits = falls.map(float16Bits), rate = bits.map(b => { const v = half(b); return v < 0 ? exactLog(1 - v) : -exactLog(1 + v); });
    const shape = Float64Array.from({length: 64}, (_, k) => {
      const at = Math.sqrt((k & 7) * (k & 7) + (k >> 3) * (k >> 3)) / 7 * 5 / (Math.SQRT2 + 1e-6), i = Math.min(4, Math.floor(at));
      let sum = 0;
      for (let j = 0; j < i; j++) sum += rate[j];
      return exactExp(sum + (at - i) * rate[i]);
    });
    return {first, bits, shape, dc};
  });
const REGION_TABLE = regionTable([[10, [0, -0.3, -0.3, -0.3, -0.3], 2.5], [18, [0, -0.3, -0.3, -0.3, -0.3], 4.5], [18, [0, -0.3, -0.3, -0.3, -0.3], 4.5]]);
const RGB_TABLE = regionTable([[30, [0, -0.3, -0.3, -0.3, -0.3], 4.5], [10, [0, -0.3, -0.3, -0.3, -0.3], 2.5], [30, [0, -0.3, -0.3, -0.3, -0.3], 4.5]]);
const strengthOf = quality => Math.max(0, Math.min(1, (90 - quality) / 15));
const distanceOf = (quality, kind) => Math.max(0.1, calibration(quality, kind) * (quality >= 30 ? 0.1 + (100 - quality) * 0.09 : 53 / 3000 * quality * quality - 23 / 20 * quality + 25));
export const photoQualityStep = (quality, kind) => distanceOf(quality, kind) * (1 - 0.1 * strengthOf(quality));
export const areaFieldValue = (base, quality, kind, FIELD) => Math.max(1, Math.round(FIELD * base / photoQualityStep(quality, kind)));
export function applyAreaField(fields, stride, rows, a, value, from = 0, to = fields.length) {
  for (let by = Math.max(0, Math.ceil((a.y - 4) / 8), Math.floor(from / stride)); by < rows && by * 8 + 4 < a.y + a.height && by * stride < to; by++)
    for (let bx = Math.max(0, Math.ceil((a.x - 4) / 8), from - by * stride); bx < stride && bx * 8 + 4 < a.x + a.width && by * stride + bx < to; bx++)
      if (value > fields[by * stride + bx]) fields[by * stride + bx] = value;
}
export function finishAreaFields(fields, FIELD, from = 0, to = fields.length) {
  for (let i = from; i < to; i++) if (!fields[i]) fields[i] = FIELD;
  return fields;
}
function areaFields(areas, quality, kind, stride, rows, FIELD) {
  const fields = new Uint16Array(stride * rows), qualities = new Map();
  if (areas) {
    const base = photoQualityStep(quality, kind);
    for (const a of areas) {
      const value = areaFieldValue(base, a.quality, kind, FIELD);
      if (value !== FIELD && !qualities.has(value)) qualities.set(value, a.quality);
      applyAreaField(fields, stride, rows, a, value);
    }
  }
  finishAreaFields(fields, FIELD);
  return {fields, qualities};
}
export function* photoCoefficientSteps(data, width, height, quality, colorSpace, gray = false, table = false, areas = null, options = {}) {
  const stride = Math.ceil(width / 8), rows = Math.ceil(height / 8), quantScale = 16, kind = table && !gray ? 'regions' : 'ycbcr';
  const distance = distanceOf(quality, kind), strength = strengthOf(quality), stepScale = 1 - 0.1 * strength;
  const perBlock = options.fieldPlan ? options.fieldPlan.perBlock : table && !gray && areas?.some(a => a.quality !== quality), FIELD = perBlock ? AREA_FIELD : TABLE_FIELD;
  const {fields, qualities} = options.fieldPlan ?? areaFields(perBlock ? areas : null, quality, kind, stride, rows, FIELD);
  const components = (gray ? [0] : [0, 1, 2]).map(c => ({h: 1, v: 1, stride, rows,
    quant: Int32Array.from(QUANT_SHAPE, (shape, k) => Math.max(1, Math.round(quantScale * distance * stepScale * (c ? 18 : 10) * (k ? shape : 0.25)))),
    coeffs: new Int16Array(stride * rows * 64)}));
  let quantTable = null;
  if (table && !gray) quantTable = components.map((component, c) => {
    const {first: ratio, bits, shape, dc} = REGION_TABLE[c], base = quantScale * distance * stepScale, first = float16Bits(8 * 255 * quantScale / (FIELD * base * ratio) / 64);
    const quant = component.quant = shape.map(value => 8 * 255 * quantScale / (FIELD * half(first) * 64) * value);
    quant[0] = Math.max(1, Math.round(base * dc));
    return [first, ...bits];
  });
  const tile = new Float64Array(64 * 192), intermediate = new Float64Array(64), rowAt = new Int32Array(8);
  const zonesOf = strength => Float64Array.from({length: 192}, (_, i) => (i & 63) && i < 64 ? 0.5 + strength * ((i & 7) >= 4 || (i >> 3) >= 4 ? 0.14 : 0.08) : (i & 63) && quantTable ? 0.65 : 0.5);
  const zones = zonesOf(strength);
  const tables = Float64Array.from({length: 396}, (_, i) => i < 192 ? components[i >> 6]?.quant[i & 63] ?? 1 : i < 384 ? zones[i - 192]
    : (gray ? [1, 0, 0, -128] : [0.299, 0.587, 0.114, -128, -0.168735892, -0.331264108, 0.5, 0, 0.5, -0.418687589, -0.081312411, 0])[i - 384] ?? 0);
  const scaled = new Map([[FIELD, tables]]);
  const tablesFor = v => {
    let t = scaled.get(v);
    if (!t) {
      t = tables.slice(); t.set(zonesOf(strengthOf(qualities.get(v) ?? quality)), 192);
      for (let i = 0; i < 192; i++) if (i & 63) t[i] = tables[i] * FIELD / v;
      scaled.set(v, t);
    }
    return t;
  };
  const coeffs = components.map(c => c.coeffs);
  const run = (by, x0, count, t) => {
    if (kernelHooks.ycbcrTile?.(data, width, rowAt, x0, count, t, coeffs, (by * stride + x0) * 64, COSINES)) return;
    for (let n = 0; n < count; n++) for (let y = 0, o = n * 192; y < 8; y++) for (let x = 0; x < 8; x++) {
      const at = rowAt[y] + Math.min(width - 1, (x0 + n) * 8 + x) * 4;
      const r = data[at], g = data[at + 1], b = data[at + 2], k = o + y * 8 + x;
      if (gray) { tile[k] = r - 128; tile[64 + k] = tile[128 + k] = 0; continue; }
      tile[k] = 0.299 * r + 0.587 * g + 0.114 * b - 128;
      tile[64 + k] = -0.168735892 * r - 0.331264108 * g + 0.5 * b;
      tile[128 + k] = 0.5 * r - 0.418687589 * g - 0.081312411 * b;
    }
    transformDCT8Blocks(tile, count, intermediate);
    for (let n = 0; n < count; n++) for (let c = 0; c < components.length; c++) {
      const {coeffs} = components[c], offset = (by * stride + x0 + n) * 64, at = n * 192 + c * 64;
      for (let k = 0; k < 64; k++) {
        const value = tile[at + k] * quantScale / t[c * 64 + k];
        coeffs[offset + k] = Math.abs(value) < t[192 + c * 64 + k] ? 0 : Math.round(value);
      }
    }
  };
  const band = (from, to) => {
    for (let by = from; by < to; by++) {
      for (let y = 0; y < 8; y++) rowAt[y] = Math.min(height - 1, by * 8 + y) * width * 4;
      for (let x0 = 0; x0 < stride; x0 += 64) {
        const count = Math.min(64, stride - x0);
        for (let n = 0; n < count;) {
          const v = fields[by * stride + x0 + n];
          let end = n + 1;
          while (end < count && fields[by * stride + x0 + end] === v) end++;
          run(by, x0 + n, end - n, tablesFor(v)); n = end;
        }
      }
    }
  };
  for (let by = 0; by < rows; by += 32) { band(by, Math.min(rows, by + 32)); yield Math.min(rows, by + 32) / rows; }
  let alpha = null;
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) { alpha = data; break; }
  return {width, height, components, quantScale, ycbcr: true, orientation: 1, alpha, colorSpace, ...quantTable && {quantTable, quantFieldBase: FIELD}, ...perBlock && {quantFields: fields}};
}

const GRAY_EDGE = 32;
function grayTiles(data, width, height, tilesX) {
  const out = new Uint8Array(tilesX * Math.ceil(height / 64));
  for (let by = 0; by * 8 < height; by++) for (let bx = 0; bx * 8 < width; bx++) {
    const t = (by >> 3) * tilesX + (bx >> 3);
    if (out[t]) continue;
    let lo = 255, hi = 0, gray = true;
    for (let y = by * 8; gray && y < Math.min(height, by * 8 + 8); y++) for (let x = bx * 8, at = (y * width + x) * 4; x < Math.min(width, bx * 8 + 8); x++, at += 4) {
      const g = data[at + 1];
      if (Math.abs(data[at] - g) > 1 || Math.abs(data[at + 2] - g) > 1) { gray = false; break; }
      if (g < lo) lo = g; if (g > hi) hi = g;
    }
    if (gray && hi - lo >= GRAY_EDGE) out[t] = 1;
  }
  return out;
}

export function* rgbCoefficientSteps(data, width, height, quality, colorSpace, areas = null, options = {}) {
  const stride = Math.ceil(width / 8), rows = Math.ceil(height / 8), quantScale = 16, kind = 'regions';
  const distance = distanceOf(quality, kind), strength = strengthOf(quality), stepScale = 1 - 0.1 * strength;
  const perBlock = options.fieldPlan ? options.fieldPlan.perBlock : areas?.some(a => a.quality !== quality), FIELD = perBlock ? AREA_FIELD : TABLE_FIELD;
  const {fields, qualities} = options.fieldPlan ?? areaFields(perBlock ? areas : null, quality, kind, stride, rows, FIELD);
  const components = [0, 1, 2].map(() => ({h: 1, v: 1, stride, rows, quant: null, coeffs: options.packed && kernelHooks.rgbBand ? null : new Int16Array(stride * rows * 64)}));
  const quantTable = components.map((component, c) => {
    const {first: ratio, bits, shape, dc} = RGB_TABLE[c], base = quantScale * distance * stepScale, first = float16Bits(8 * 255 * quantScale / (FIELD * base * ratio) / 64);
    const quant = component.quant = shape.map(value => 8 * 255 * quantScale / (FIELD * half(first) * 64) * value);
    quant[0] = Math.max(1, Math.round(base * dc));
    return [first, ...bits];
  });
  const zonesOf = strength => Float64Array.from({length: 192}, (_, i) => !(i & 63) ? 0.5 : i >= 64 && i < 128 ? 0.5 + strength * ((i & 7) >= 4 || ((i & 63) >> 3) >= 4 ? 0.14 : 0.08) : 0.65);
  const steps = Float64Array.from({length: 192}, (_, i) => components[i >> 6].quant[i & 63]);
  const scaled = new Map();
  const tablesFor = v => {
    let t = scaled.get(v);
    if (!t) {
      t = new Float64Array(384); t.set(steps); t.set(zonesOf(strengthOf(qualities.get(v) ?? quality)), 192);
      for (let i = 0; i < 192; i++) if (i & 63) t[i] = steps[i] * FIELD / v;
      scaled.set(v, t);
    }
    return t;
  };
  const tilesX = Math.ceil(stride / 8);
  const cfl = {width: tilesX, x: new Int16Array(tilesX * Math.ceil(rows / 8)), b: new Int16Array(tilesX * Math.ceil(rows / 8))};
  let tile, held;
  const gray = grayTiles(data, width, height, tilesX);
  const cflOf = (index, rg, bg, gg) => {
    const off = gray[index] === 1;
    const fx = off ? 0 : Math.max(-128, Math.min(127, Math.round(84 * rg / (gg + 1)))), fb = off ? 0 : Math.max(-128, Math.min(127, Math.round(84 * bg / (gg + 1))));
    cfl.x[index] = fx; cfl.b[index] = fb;
    return [1 + fx / 84, 1 + fb / 84];
  };
  const tableOf = (by, bx) => tablesFor(fields[by * stride + bx]);
  const result = () => ({width, height, components, quantScale, ycbcr: false, cflBase: 1, cfl, orientation: 1, alpha: null, colorSpace, quantTable, quantFieldBase: FIELD, ...perBlock && {quantFields: fields}});
  if (options.packed && kernelHooks.rgbBand?.(data, width, height, {components, tableOf, cflOf, basis: COSINES, quantScale})) {
    yield 1; return result();
  }
  for (const component of components) component.coeffs ??= new Int16Array(stride * rows * 64);
  const [R, G, B] = components.map(c => c.coeffs);
  for (let from = 0; from < rows; from += 32) {
    const to = Math.min(rows, from + 32);
    let kernel = !!kernelHooks.rgbTiles;
    for (let ty = from >> 3; kernel && ty * 8 < to; ty++) for (let tx = 0; kernel && tx < tilesX; tx++)
      kernel = kernelHooks.rgbTiles(data, width, height, tx * 8, ty * 8, Math.min(stride, tx * 8 + 8) - tx * 8, Math.min(to, ty * 8 + 8) - ty * 8,
        tableOf, (rg, bg, gg) => cflOf(ty * tilesX + tx, rg, bg, gg), components.map(c => c.coeffs), stride, COSINES, quantScale);
    if (kernel) { yield to / rows; continue; }
    tile ??= new Float64Array(64 * 192); held ??= new Float64Array(32 * stride * 192);
    for (let by = from; by < to; by++) for (let x0 = 0; x0 < stride; x0 += 64) {
      const count = Math.min(64, stride - x0);
      for (let n = 0; n < count; n++) for (let y = 0, o = n * 192; y < 8; y++) {
        const row = Math.min(height - 1, by * 8 + y) * width * 4;
        for (let x = 0; x < 8; x++) {
          const at = row + Math.min(width - 1, (x0 + n) * 8 + x) * 4, k = o + y * 8 + x;
          tile[k] = data[at]; tile[64 + k] = data[at + 1]; tile[128 + k] = data[at + 2];
        }
      }
      dct8Butterfly(tile, count);
      for (let n = 0; n < count; n++) {
        const t = tablesFor(fields[by * stride + x0 + n]), offset = (by * stride + x0 + n) * 64, at = n * 192, h = ((by - from) * stride + x0 + n) * 192;
        for (let k = 0; k < 64; k++) {
          const v = tile[at + 64 + k] * quantScale / t[64 + k], g = Math.abs(v) < t[256 + k] ? 0 : Math.round(v);
          G[offset + k] = g; held[h + k] = tile[at + k]; held[h + 64 + k] = g * t[64 + k] / quantScale; held[h + 128 + k] = tile[at + 128 + k];
        }
      }
    }
    for (let ty = from >> 3; ty * 8 < to; ty++) for (let tx = 0; tx < tilesX; tx++) {
      const y1 = Math.min(to, ty * 8 + 8), x1 = Math.min(stride, tx * 8 + 8);
      let rg = 0, bg = 0, gg = 0;
      for (let by = ty * 8; by < y1; by++) for (let bx = tx * 8; bx < x1; bx++) {
        const h = ((by - from) * stride + bx) * 192;
        for (let k = 1; k < 64; k++) { const g = held[h + 64 + k]; rg += (held[h + k] - g) * g; bg += (held[h + 128 + k] - g) * g; gg += g * g; }
      }
      const [ax, ab] = cflOf(ty * tilesX + tx, rg, bg, gg);
      for (let by = ty * 8; by < y1; by++) for (let bx = tx * 8; bx < x1; bx++) {
        const t = tablesFor(fields[by * stride + bx]), offset = (by * stride + bx) * 64, h = ((by - from) * stride + bx) * 192;
        for (let k = 0; k < 64; k++) {
          const g = held[h + 64 + k], r = (held[h + k] - (k ? ax : 1) * g) * quantScale / t[k], b = (held[h + 128 + k] - (k ? ab : 1) * g) * quantScale / t[128 + k];
          R[offset + k] = Math.abs(r) < t[192 + k] ? 0 : Math.round(r); B[offset + k] = Math.abs(b) < t[320 + k] ? 0 : Math.round(b);
        }
      }
    }
    yield to / rows;
  }
  return result();
}
