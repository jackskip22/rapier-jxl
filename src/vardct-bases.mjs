// SPDX-License-Identifier: MIT
import {exactCos, EXACT_PI} from './exact-math.mjs';

export const NAMES = ['dct8', 'identity', 'dct2', 'dct4', 'dct16', 'dct32', 'dct16x8', 'dct8x16',
  'dct32x8', 'dct8x32', 'dct32x16', 'dct16x32', 'dct4x8', 'dct8x4', 'afv0', 'afv1', 'afv2', 'afv3',
  'dct64', 'dct64x32', 'dct32x64', 'dct128', 'dct128x64', 'dct64x128', 'dct256', 'dct256x128', 'dct128x256'];
export const WIDTHS = [1, 1, 1, 1, 2, 4, 1, 2, 1, 4, 2, 4, 1, 1, 1, 1, 1, 1, 8, 4, 8, 16, 8, 16, 32, 16, 32];
export const HEIGHTS = [1, 1, 1, 1, 2, 4, 2, 1, 4, 1, 4, 2, 1, 1, 1, 1, 1, 1, 8, 8, 4, 16, 16, 8, 32, 32, 16];
export const TABLES = [0, 1, 2, 3, 4, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 10, 10, 11, 12, 12, 13, 14, 14, 15, 16, 16];
export const TRANSFORMS = Object.freeze(NAMES.map((name, id) => Object.freeze({name, id, width: WIDTHS[id] * 8,
  height: HEIGHTS[id] * 8, table: TABLES[id]})));
const dctBases = new Map();
export function cosine(numerator, denominator) {
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
export function fillScaledDCTBasis(size, out, from = 0, to = size) {
  for (let k = from; k < to; k++) for (let x = 0; x < size; x++) out[k * size + x] =
    k ? 1.4142135623730951 * cosine((2 * x + 1) * k, 2 * size) / size : 1 / size;
  return out;
}
export function transposeScaledDCTBasis(size, input, out, from = 0, to = size) {
  for (let k = from; k < to; k++) for (let x = 0; x < size; x++) out[x * size + k] = input[k * size + x];
  return out;
}
export function basis(size) {
  let b = dctBases.get(size);
  if (!b) dctBases.set(size, b = fillScaledDCTBasis(size, new Float64Array(size * size)));
  return b;
}
const dctBasesT = new Map();
export function basisT(size) {
  let t = dctBasesT.get(size);
  if (!t) {
    dctBasesT.set(size, t = transposeScaledDCTBasis(size, basis(size), new Float64Array(size * size)));
  }
  return t;
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

const RC_COS = (n, d) => exactCos(EXACT_PI * n / d);
const RC_LLF_DIVISORS = new Map();
export function llfDivisors(w, h) {
  let d = RC_LLF_DIVISORS.get(w * 64 + h);
  if (!d) {
    const scale = (k, size) => RC_COS(k, 2 * size) * RC_COS(k, size) * RC_COS(2 * k, size);
    d = new Float64Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d[y * w + x] = scale(x, w * 8) * scale(y, h * 8);
    RC_LLF_DIVISORS.set(w * 64 + h, d);
  }
  return d;
}
