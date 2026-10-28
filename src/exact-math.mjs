// SPDX-License-Identifier: MIT
const emView = new DataView(new ArrayBuffer(8));
const EM_LN2 = 0.6931471805599453, EM_LN2_HI = 0.6931471803691238, EM_LN2_LO = 1.9082149292705877e-10, EM_SQRT2 = 1.4142135623730951;
const EXACT_PI = 3.141592653589793, EM_TWO_PI = 6.283185307179586;

function emPow2(k) { emView.setUint32(0, (k + 1023) << 20); emView.setUint32(4, 0); return emView.getFloat64(0); }

export function exactLog(x) {
  if (!(x > 0)) return x === 0 ? -Infinity : NaN;
  if (x === Infinity) return Infinity;
  let scale = 0;
  if (x < 2.2250738585072014e-308) { x *= 18014398509481984; scale = -54; }
  emView.setFloat64(0, x);
  const hi = emView.getUint32(0);
  let e = (hi >>> 20) - 1023 + scale;
  emView.setUint32(0, (hi & 0x000fffff) | 0x3ff00000);
  let m = emView.getFloat64(0);
  if (m > EM_SQRT2) { m /= 2; e++; }
  const s = (m - 1) / (m + 1), s2 = s * s;
  let term = s, sum = s;
  for (let n = 3; n < 40; n += 2) { term *= s2; const add = term / n; sum += add; if (Math.abs(add) < 1e-18 * Math.abs(sum)) break; }
  return e * EM_LN2_HI + (e * EM_LN2_LO + 2 * sum);
}

export function exactLog2(x) { return exactLog(x) / EM_LN2; }

export function exactExp(x) {
  if (x !== x) return NaN;
  if (x > 709.782712893384) return Infinity;
  if (x < -745.1332191019411) return 0;
  const k = Math.round(x / EM_LN2), r = (x - k * EM_LN2_HI) - k * EM_LN2_LO;
  let term = 1, sum = 1;
  for (let n = 1; n < 30; n++) { term *= r / n; sum += term; if (Math.abs(term) < 1e-17 * sum) break; }
  if (k > 1023) return sum * emPow2(1023) * emPow2(k - 1023);
  if (k < -1022) return sum * emPow2(-1022) * emPow2(k + 1022);
  return sum * emPow2(k);
}

export function exactPow(x, y) {
  if (y === 0) return 1;
  if (Number.isInteger(y) && Math.abs(y) <= 64) {
    let result = 1, base = x, n = Math.abs(y);
    while (n) { if (n & 1) result *= base; base *= base; n >>= 1; }
    return y < 0 ? 1 / result : result;
  }
  if (x === 0) return y > 0 ? 0 : Infinity;
  if (x < 0) return NaN;
  return exactExp(y * exactLog(x));
}

export function exactCbrt(x) {
  if (x === 0 || x !== x || Math.abs(x) === Infinity) return x;
  const a = Math.abs(x);
  let r = exactExp(exactLog(a) / 3);
  for (let i = 0; i < 2; i++) r = (2 * r + a / (r * r)) / 3;
  return x < 0 ? -r : r;
}

function emReduce(x) { return x - Math.round(x / EM_TWO_PI) * EM_TWO_PI; }
export function exactCos(x) {
  const r = emReduce(x), r2 = r * r;
  let term = 1, sum = 1;
  for (let n = 1; n < 30; n++) { term *= -r2 / ((2 * n - 1) * (2 * n)); sum += term; if (Math.abs(term) < 1e-18) break; }
  return sum;
}
export function exactSin(x) {
  const r = emReduce(x), r2 = r * r;
  let term = r, sum = r;
  for (let n = 1; n < 30; n++) { term *= -r2 / ((2 * n) * (2 * n + 1)); sum += term; if (Math.abs(term) < 1e-18) break; }
  return sum;
}
export function exactTan(x) { return exactSin(x) / exactCos(x); }
export {EXACT_PI};
