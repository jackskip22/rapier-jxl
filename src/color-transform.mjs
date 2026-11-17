// SPDX-License-Identifier: MIT

const ln = Math.log;
const power = (x, g) => x <= 0 ? 0 : g === 1 ? x : Math.pow(x, g);

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

const REC2020_D65 = [0.636958, 0.1446169, 0.168881, 0.2627002, 0.6779981, 0.0593017, 0, 0.0280727, 1.0609851];
export const REC2020_TRANSFORM = /* @__PURE__ */ (() => ({gray: false, tables: [SRGB_CURVE, SRGB_CURVE, SRGB_CURVE], lms: Float64Array.from(times(OPSIN, times(inverse(SRGB_D65), REC2020_D65)))}))();

const BRADFORD = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296];
const NAMED_PRIMARIES = {srgb: [[0.64, 0.33], [0.3, 0.6], [0.15, 0.06]], 'display-p3': [[0.68, 0.32], [0.265, 0.69], [0.15, 0.06]],
  rec2020: [[0.708, 0.292], [0.17, 0.797], [0.131, 0.046]]};
const NAMED_WHITES = {d65: [0.3127, 0.329], e: [1 / 3, 1 / 3], dci: [0.314, 0.351], d50: [0.345669, 0.358496]};
const xyz = ([x, y]) => [x / y, 1, (1 - x - y) / y];
const apply = (m, v) => [0, 1, 2].map(r => m[r * 3] * v[0] + m[r * 3 + 1] * v[1] + m[r * 3 + 2] * v[2]);
function rgbToXYZ(primaries, white) {
  const [r, g, b] = primaries.map(xyz), m = [r[0], g[0], b[0], r[1], g[1], b[1], r[2], g[2], b[2]];
  const scale = apply(inverse(m), xyz(white));
  return [0, 1, 2].flatMap(row => [0, 1, 2].map(c => m[row * 3 + c] * scale[c]));
}
const ADAPTED = new Map();
export function adaptedTransform(primaries, whitePoint) {
  const key = JSON.stringify([primaries, whitePoint]);
  let t = ADAPTED.get(key);
  if (t) return t;
  const chroma = typeof primaries === 'string' ? NAMED_PRIMARIES[primaries] : primaries, white = typeof whitePoint === 'string' ? NAMED_WHITES[whitePoint] : whitePoint;
  const forward = rgbToXYZ(chroma, white);
  const from = apply(BRADFORD, xyz(white)), to = apply(BRADFORD, xyz(NAMED_WHITES.d65));
  const scale = [0, 1, 2].flatMap(r => [0, 1, 2].map(c => r === c ? to[r] / from[r] : 0));
  const adapt = times(inverse(BRADFORD), times(scale, BRADFORD));
  t = {gray: false, tables: [SRGB_CURVE, SRGB_CURVE, SRGB_CURVE], lms: Float64Array.from(times(OPSIN, times(inverse(SRGB_D65), times(adapt, forward))))};
  ADAPTED.set(key, t);
  return t;
}

export {ln, power, OPSIN, inverse, times, SRGB_CURVE};
