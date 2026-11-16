// SPDX-License-Identifier: MIT
const D65 = [0.3127, 0.3290];
const NAMED = {srgb: [[0.64, 0.33], [0.30, 0.60], [0.15, 0.06]], 'display-p3': [[0.68, 0.32], [0.265, 0.69], [0.15, 0.06]], rec2020: [[0.708, 0.292], [0.170, 0.797], [0.131, 0.046]]};
const BRADFORD = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296];
const mul = (a, b) => { const o = new Array(9); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j]; return o; };
const apply = (m, v) => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
function inverse(m) {
  const [a, b, c, d, e, f, g, h, i] = m, det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  return [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det, (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det, (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det];
}
const xyz = ([x, y]) => [x / y, 1, (1 - x - y) / y];
function rgbToXyz(primaries, white) {
  const p = primaries.map(xyz), m = [p[0][0], p[1][0], p[2][0], p[0][1], p[1][1], p[2][1], p[0][2], p[1][2], p[2][2]];
  const s = apply(inverse(m), xyz(white));
  return [m[0] * s[0], m[1] * s[1], m[2] * s[2], m[3] * s[0], m[4] * s[1], m[5] * s[2], m[6] * s[0], m[7] * s[1], m[8] * s[2]];
}
const SRGB_INVERSE = inverse(rgbToXyz(NAMED.srgb, D65));

export function toLinearSrgb(space) {
  const encoding = typeof space === 'object' && space !== null;
  const primaries = encoding ? space.primaries : NAMED[space ?? 'srgb'];
  const white = !encoding || space.whitePoint === undefined || space.whitePoint === 'd65' ? D65 : space.whitePoint === 'e' ? [1 / 3, 1 / 3] : space.whitePoint;
  let m = rgbToXyz(primaries ?? NAMED.srgb, white);
  if (white[0] !== D65[0] || white[1] !== D65[1]) {
    const from = apply(BRADFORD, xyz(white)), to = apply(BRADFORD, xyz(D65));
    m = mul(mul(mul(inverse(BRADFORD), [to[0] / from[0], 0, 0, 0, to[1] / from[1], 0, 0, 0, to[2] / from[2]]), BRADFORD), m);
  }
  return mul(SRGB_INVERSE, m);
}
export const matrixTimes = mul;
