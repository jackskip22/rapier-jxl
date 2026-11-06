// SPDX-License-Identifier: MIT

const LN2 = 0.6931471805599453;
function ln(x) {
  let k = 0;
  while (x > 1.5) { x /= 2; k++; }
  while (x < 0.75) { x *= 2; k--; }
  const t = (x - 1) / (x + 1), t2 = t * t;
  let term = t, sum = 0;
  for (let n = 1; n < 80; n += 2) { sum += term / n; term *= t2; }
  return 2 * sum + k * LN2;
}
function exp(y) {
  const k = Math.round(y / LN2), r = y - k * LN2;
  let term = 1, sum = 1;
  for (let n = 1; n < 24; n++) sum += term = term * r / n;
  for (let i = 0; i < k; i++) sum *= 2;
  for (let i = 0; i > k; i--) sum /= 2;
  return sum;
}
const power = (x, g) => x <= 0 ? 0 : g === 1 ? x : exp(g * ln(x));

const OPSIN = [0.3, 0.622, 0.078, 0.23, 0.692, 0.078, 0.24342268924547819, 0.20476744424496821, 0.5518098665095536];

function inverse(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g, det = a * A + b * B + c * C;
  return [A, c * h - b * i, b * f - c * e, B, a * i - c * g, c * d - a * f, C, b * g - a * h, a * e - b * d].map(v => v / det);
}
function times(x, y) {
  const out = new Array(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out[r * 3 + c] = x[r * 3] * y[c] + x[r * 3 + 1] * y[3 + c] + x[r * 3 + 2] * y[6 + c];
  return out;
}
export function linearFromTransform(rgba, pixels, {tables, lms}) {
  const m = times(inverse(OPSIN), lms), planes = [new Float64Array(pixels), new Float64Array(pixels), new Float64Array(pixels)];
  for (let i = 0; i < pixels; i++) {
    const r = tables[0][rgba[i * 4]], g = tables[1][rgba[i * 4 + 1]], b = tables[2][rgba[i * 4 + 2]];
    for (let c = 0; c < 3; c++) planes[c][i] = m[c * 3] * r + m[c * 3 + 1] * g + m[c * 3 + 2] * b;
  }
  return planes;
}
export function linearFromTransformPlanes(encoded, pixels, {lms}) {
  const m = times(inverse(OPSIN), lms), planes = [new Float64Array(pixels), new Float64Array(pixels), new Float64Array(pixels)];
  const linear = value => {
    const v = Math.abs(value);
    return v <= 0.04045 ? value / 12.92 : (value < 0 ? -1 : 1) * power((v + 0.055) / 1.055, 2.4);
  };
  for (let i = 0; i < pixels; i++) {
    const r = linear(encoded[0][i]), g = linear(encoded[1][i]), b = linear(encoded[2][i]);
    for (let c = 0; c < 3; c++) planes[c][i] = m[c * 3] * r + m[c * 3 + 1] * g + m[c * 3 + 2] * b;
  }
  return planes;
}
const SRGB_D65 = [0.4124564, 0.3575761, 0.1804375, 0.2126729, 0.7151522, 0.072175, 0.0193339, 0.119192, 0.9503041];
const P3_D65 = [0.4865709, 0.2656677, 0.1982173, 0.2289746, 0.6917385, 0.0792869, 0, 0.0451134, 1.0439444];
const SRGB_CURVE = /* @__PURE__ */ Float64Array.from({length: 256}, (_, i) => { const v = i / 255; return v <= 0.04045 ? v / 12.92 : power((v + 0.055) / 1.055, 2.4); });
export const P3_TRANSFORM = /* @__PURE__ */ (() => ({gray: false, tables: [SRGB_CURVE, SRGB_CURVE, SRGB_CURVE], lms: Float64Array.from(times(OPSIN, times(inverse(SRGB_D65), P3_D65)))}))();

export {ln, power, OPSIN, inverse, times};
