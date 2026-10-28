// SPDX-License-Identifier: MIT
import {fault} from './fault.mjs';
import {exactCos, EXACT_PI} from './exact-math.mjs';
import {QUANT_PARAM_LIBRARY} from './quantization-defaults.mjs';
import {float16Bits, entropyLog2} from './decode-tables.mjs';

const NAMES = ['dct8', 'identity', 'dct2', 'dct4', 'dct16', 'dct32', 'dct16x8', 'dct8x16',
  'dct32x8', 'dct8x32', 'dct32x16', 'dct16x32', 'dct4x8', 'dct8x4', 'afv0', 'afv1', 'afv2', 'afv3',
  'dct64', 'dct64x32', 'dct32x64', 'dct128', 'dct128x64', 'dct64x128', 'dct256', 'dct256x128', 'dct128x256'];
const WIDTHS = [1, 1, 1, 1, 2, 4, 1, 2, 1, 4, 2, 4, 1, 1, 1, 1, 1, 1, 8, 4, 8, 16, 8, 16, 32, 16, 32];
const HEIGHTS = [1, 1, 1, 1, 2, 4, 2, 1, 4, 1, 4, 2, 1, 1, 1, 1, 1, 1, 8, 8, 4, 16, 16, 8, 32, 32, 16];
const TABLES = [0, 1, 2, 3, 4, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 10, 10, 11, 12, 12, 13, 14, 14, 15, 16, 16];
export const TRANSFORMS = Object.freeze(NAMES.map((name, id) => Object.freeze({name, id, width: WIDTHS[id] * 8,
  height: HEIGHTS[id] * 8, table: TABLES[id]})));
const dctBases = new Map(), dctScans = new Map();
function cosine(numerator, denominator) {
  let n = numerator % (denominator * 2);
  if (n > denominator) n -= denominator * 2;
  if (n < -denominator) n += denominator * 2;
  let sign = 1;
  if (n > denominator / 2) { n = denominator - n; sign = -1; }
  if (n < -denominator / 2) { n = -denominator - n; sign = -1; }
  const x = n * 3.141592653589793 / denominator, square = x * x;
  let term = 1, sum = 1;
  for (let i = 1; i < 15; i++) sum += term *= -square / ((2 * i - 1) * (2 * i));
  return sign * sum;
}
function basis(size) {
  let b = dctBases.get(size);
  if (!b) {
    b = new Float64Array(size * size);
    for (let k = 0; k < size; k++) for (let x = 0; x < size; x++) b[k * size + x] =
      k ? 1.4142135623730951 * cosine((2 * x + 1) * k, 2 * size) / size : 1 / size;
    dctBases.set(size, b);
  }
  return b;
}
const dctRows = new Map();
export function scaledDCT(pixels, width, height) {
  const size = width * height, bx = basis(width), by = basis(height), out = new Float64Array(size);
  let tmp = dctRows.get(size);
  if (!tmp) dctRows.set(size, tmp = new Float64Array(size));
  for (let y = 0; y < height; y++) for (let u = 0, row = y * width; u < width; u += 8) {
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, s5 = 0, s6 = 0, s7 = 0;
    for (let x = 0, b = u * width; x < width; x++, b++) {
      const v = pixels[row + x];
      s0 += v * bx[b]; s1 += v * bx[b + width]; s2 += v * bx[b + 2 * width]; s3 += v * bx[b + 3 * width];
      s4 += v * bx[b + 4 * width]; s5 += v * bx[b + 5 * width]; s6 += v * bx[b + 6 * width]; s7 += v * bx[b + 7 * width];
    }
    const o = row + u;
    tmp[o] = s0; tmp[o + 1] = s1; tmp[o + 2] = s2; tmp[o + 3] = s3; tmp[o + 4] = s4; tmp[o + 5] = s5; tmp[o + 6] = s6; tmp[o + 7] = s7;
  }
  const tall = height >= width;
  for (let v = 0; v < height; v++) for (let u = 0, b = v * height; u < width; u += 8) {
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, s5 = 0, s6 = 0, s7 = 0;
    for (let y = 0, at = u; y < height; y++, at += width) {
      const c = by[b + y];
      s0 += tmp[at] * c; s1 += tmp[at + 1] * c; s2 += tmp[at + 2] * c; s3 += tmp[at + 3] * c;
      s4 += tmp[at + 4] * c; s5 += tmp[at + 5] * c; s6 += tmp[at + 6] * c; s7 += tmp[at + 7] * c;
    }
    if (tall) {
      const o = u * height + v;
      out[o] = s0; out[o + height] = s1; out[o + 2 * height] = s2; out[o + 3 * height] = s3;
      out[o + 4 * height] = s4; out[o + 5 * height] = s5; out[o + 6 * height] = s6; out[o + 7 * height] = s7;
    } else {
      const o = v * width + u;
      out[o] = s0; out[o + 1] = s1; out[o + 2] = s2; out[o + 3] = s3; out[o + 4] = s4; out[o + 5] = s5; out[o + 6] = s6; out[o + 7] = s7;
    }
  }
  return out;
}
export function inverseScaledDCT(coeffs, width, height) {
  const bx = basis(width), by = basis(height), tmp = new Float64Array(width * height), out = new Float64Array(tmp.length);
  for (let v = 0; v < height; v++) for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let u = 0; u < width; u++) sum += coeffs[height >= width ? u * height + v : v * width + u] * bx[u * width + x] * width;
    tmp[v * width + x] = sum;
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let v = 0; v < height; v++) sum += tmp[v * width + x] * by[v * height + y] * height;
    out[y * width + x] = sum;
  }
  return out;
}
export function naturalOrder(widthBlocks, heightBlocks) {
  const cx = Math.max(widthBlocks, heightBlocks), cy = Math.min(widthBlocks, heightBlocks), key = cx * 64 + cy;
  if (dctScans.has(key)) return dctScans.get(key);
  const width = cx * 8, ratio = cx / cy, order = new Uint32Array(cx * cy * 64);
  let next = cx * cy;
  for (let i = 0; i < width; i++) for (let j = 0; j <= i; j++) {
    let x = j, y = i - j;
    if (i & 1) [x, y] = [y, x];
    if (y % ratio) continue;
    y /= ratio;
    order[x < cx && y < cy ? y * cx + x : next++] = y * width + x;
  }
  for (let ip = width - 1; ip > 0; ip--) for (let j = 0; j < ip; j++) {
    let x = width - ip + j, y = width - 1 - j;
    if ((ip - 1) & 1) [x, y] = [y, x];
    if (y % ratio) continue;
    order[next++] = y / ratio * width + x;
  }
  dctScans.set(key, order);
  return order;
}

const RC_COS = (n, d) => exactCos(EXACT_PI * n / d);
const RC_LLF_DIVISORS = new Map();
function rcLlfDivisors(w, h) {
  let d = RC_LLF_DIVISORS.get(w * 64 + h);
  if (!d) {
    const scale = (k, size) => RC_COS(k, 2 * size) * RC_COS(k, size) * RC_COS(2 * k, size);
    d = new Float64Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d[y * w + x] = scale(x, w * 8) * scale(y, h * 8);
    RC_LLF_DIVISORS.set(w * 64 + h, d);
  }
  return d;
}
export function rcLlfFromDC(means, bw, bh) {
  const w = Math.max(bw, bh), h = Math.min(bw, bh), low = scaledDCT(means, bw, bh), divisors = rcLlfDivisors(w, h);
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = low[y * w + x] / divisors[y * w + x];
  return out;
}

const QUANT_PARAM_MODES = ['library', 'identity', 'dct2', 'dct4', 'dct4x8', 'afv', 'dct'];
const QUANT_PARAM_AFV_FREQS = [0, 0, .8517778890324296, 5.37778436506804, 0, 0, 4.734747904497923,
  5.449245381693219, 1.6598270267479331, 4, 7.275749096817861, 10.423227632456525,
  2.662932286148962, 7.630657783650829, 8.962388608184032, 12.97166202570235];
function quantParamHalfValue(bits) {
  const sign = bits & 32768 ? -1 : 1, exponent = (bits >>> 10) & 31, mantissa = bits & 1023;
  let value = exponent ? 1024 + mantissa : mantissa, shift = exponent ? exponent - 25 : -24;
  while (shift < 0) { value /= 2; shift++; }
  while (shift > 0) { value *= 2; shift--; }
  return sign * value;
}
function quantParamNumber(value, divisor, positive, library) {
  if (typeof value !== 'number' || !Number.isFinite(value) || positive && value <= 0)
    throw fault('JXL_INPUT', 'Quantization parameters are finite; weights and multipliers are positive.');
  if (library) return value;
  if (Math.abs(value / divisor) >= 65520) throw fault('JXL_INPUT', 'Quantization parameter exceeds its binary16 field.');
  const decoded = quantParamHalfValue(float16Bits(value / divisor)) * divisor;
  if (positive && decoded <= 0) throw fault('JXL_INPUT', 'Quantization parameter rounds to zero in its binary16 field.');
  return decoded;
}
function quantParamVector(value, count, convert) {
  if ((!Array.isArray(value) && !ArrayBuffer.isView(value)) || value.length !== count)
    throw fault('JXL_INPUT', 'Quantization parameter vectors have their mode-defined length.');
  return Array.from(value, convert);
}
function quantParamTriplet(value, count, convert) {
  if (!Array.isArray(value) || value.length !== 3)
    throw fault('JXL_INPUT', 'Quantization parameters give three channel vectors in Y/Cb/Cr order.');
  return value.map(vector => quantParamVector(vector, count, convert));
}
function quantParamBands(value, library) {
  const count = value?.[0]?.length;
  if (!Number.isInteger(count) || count < 1 || count > 16)
    throw fault('JXL_INPUT', 'DCT distance bands have one through sixteen values per channel.');
  return quantParamTriplet(value, count, (v, i) => quantParamNumber(v, i ? 1 : 64, !i, library));
}
function quantParamAdmit(input, width, height, family) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ArrayBuffer.isView(input))
    throw fault('JXL_INPUT', 'A compact quantization table is a descriptor with a mode.');
  const mode = QUANT_PARAM_MODES.indexOf(input.mode), library = mode === 0;
  if (mode < 0) throw fault('JXL_INPUT', 'Quantization mode is library, identity, dct2, dct4, dct4x8, afv or dct.');
  if (mode > 0 && mode < 6 && width * height !== 64)
    throw fault('JXL_INPUT', 'Special compact quantization modes require an 8 by 8 table family.');
  const source = library ? QUANT_PARAM_LIBRARY[family] : input;
  if (!source) throw fault('JXL_INPUT', 'Unknown quantization-table family.');
  const kind = QUANT_PARAM_MODES.indexOf(source.mode), table = {mode, kind, library};
  const positive = (v, divisor = 1) => quantParamNumber(v, divisor, true, library);
  if (kind === 1 || kind === 2) table.weights = quantParamTriplet(source.weights, kind === 1 ? 3 : 6, v => positive(v, 64));
  else if (kind === 3) {
    table.multipliers = quantParamTriplet(source.multipliers, 2, v => positive(v));
    table.bands = quantParamBands(source.bands, library);
  } else if (kind === 4) {
    table.multipliers = quantParamVector(source.multipliers, 3, v => positive(v));
    table.bands = quantParamBands(source.bands, library);
  } else if (kind === 5) {
    table.weights = quantParamTriplet(source.weights, 9, (v, i) => quantParamNumber(v, i < 6 ? 64 : 1, i < 6, library));
    table.bands4x8 = quantParamBands(source.bands4x8, library);
    table.bands4x4 = quantParamBands(source.bands4x4, library);
  } else table.bands = quantParamBands(source.bands, library);
  return table;
}
function quantParamWeight(value) {
  if (!Number.isFinite(value) || value < 1e-8 || value >= 1e8)
    throw fault('JXL_INPUT', 'Expanded quantization weights are at least 1e-8 and below 1e8.');
  return value;
}
function quantParamExpandBands(parameters) {
  const bands = [quantParamWeight(parameters[0])];
  for (let i = 1; i < parameters.length; i++) {
    const delta = parameters[i];
    bands.push(quantParamWeight(bands.at(-1) * (delta > 0 ? 1 + delta : 1 / (1 - delta))));
  }
  return bands;
}
function quantParamPower(base, exponent) {
  const log = entropyLog2(base) * exponent, whole = Math.round(log), reduced = (log - whole) * .6931471805599453;
  let term = 1, sum = 1, factor = 1;
  for (let i = 1; i < 24; i++) sum += term *= reduced / i;
  for (let i = 0; i < whole; i++) factor *= 2;
  for (let i = 0; i > whole; i--) factor /= 2;
  return sum * factor;
}
function quantParamInterpolate(bands, position) {
  if (bands.length === 1) return bands[0];
  const index = Math.min(bands.length - 2, Math.floor(position)), a = bands[index], b = bands[index + 1];
  return a * quantParamPower(b / a, position - index);
}
function quantParamDCT(parameters, width, height) {
  const bands = quantParamExpandBands(parameters), scale = (bands.length - 1) / (1.4142135623730951 + .000001);
  return Float64Array.from({length: width * height}, (_, i) => {
    const x = (i % width) / (width - 1), y = Math.floor(i / width) / (height - 1);
    return quantParamInterpolate(bands, Math.sqrt(x * x + y * y) * scale);
  });
}
function quantParamMatrix(table, channel, width, height) {
  const {kind} = table;
  if (kind === 6) return quantParamDCT(table.bands[channel], width, height);
  const plane = new Float64Array(64), weights = table.weights?.[channel];
  if (kind === 1) {
    plane.fill(weights[0]); plane[1] = plane[8] = weights[1]; plane[9] = weights[2];
  } else if (kind === 2) {
    plane[0] = 1;
    for (let i = 0; i < 6; i++) {
      const size = 1 << Math.floor(i / 2);
      for (let y = i & 1 ? size : 0; y < (i & 1 ? 2 * size : size); y++) for (let x = size; x < 2 * size; x++) {
        plane[y * 8 + x] = weights[i];
        if (!(i & 1)) plane[x * 8 + y] = weights[i];
      }
    }
  } else if (kind === 3) {
    const small = quantParamDCT(table.bands[channel], 4, 4);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) plane[y * 8 + x] = small[Math.floor(y / 2) * 4 + Math.floor(x / 2)];
    plane[1] /= table.multipliers[channel][0]; plane[8] /= table.multipliers[channel][0]; plane[9] /= table.multipliers[channel][1];
  } else if (kind === 4) {
    const small = quantParamDCT(table.bands[channel], 8, 4);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) plane[y * 8 + x] = small[Math.floor(y / 2) * 8 + x];
    plane[8] /= table.multipliers[channel];
  } else {
    const bands = quantParamExpandBands(weights.slice(5)), low = QUANT_PARAM_AFV_FREQS[2], span = QUANT_PARAM_AFV_FREQS[15] - low + .000001;
    const half = quantParamDCT(table.bands4x8[channel], 8, 4), quarter = quantParamDCT(table.bands4x4[channel], 4, 4);
    plane[0] = 1; plane[8] = weights[0]; plane[1] = weights[1]; plane[16] = weights[2]; plane[2] = weights[3]; plane[18] = weights[4];
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) if (x >= 2 || y >= 2)
      plane[y * 16 + x * 2] = quantParamInterpolate(bands, (QUANT_PARAM_AFV_FREQS[y * 4 + x] - low) * 3 / span);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 8; x++) if (x || y) plane[(y * 2 + 1) * 8 + x] = half[y * 8 + x];
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) if (x || y) plane[y * 16 + x * 2 + 1] = quarter[y * 4 + x];
  }
  for (const weight of plane) quantParamWeight(weight);
  return plane;
}
export function prepareQuantParams(input, width, height, family) {
  const table = quantParamAdmit(input, width, height, family);
  return {mode: table.mode, weights: [0, 1, 2].map(channel => quantParamMatrix(table, channel, width, height)), library: table.library};
}
