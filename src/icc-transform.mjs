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

const s15 = (view, at) => view.getInt32(at) / 65536;

function curveOf(view, offset, length) {
  const type = String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
  if (type === 'curv') {
    const n = view.getUint32(offset + 8);
    if (12 + n * 2 > length) return null;
    if (n === 0) return x => x;
    if (n === 1) { const g = view.getUint16(offset + 12) / 256; return x => power(x, g); }
    const table = Float64Array.from({length: n}, (_, i) => view.getUint16(offset + 12 + i * 2) / 65535);
    return x => { const p = x * (n - 1), i = Math.min(n - 2, Math.floor(p)); return table[i] + (table[i + 1] - table[i]) * (p - i); };
  }
  if (type === 'para') {
    const form = view.getUint16(offset + 8), count = [1, 3, 4, 5, 7][form];
    if (count === undefined || 12 + count * 4 > length) return null;
    const [g, a = 1, b = 0, c = 0, d = 0, e = 0, f = 0] = Array.from({length: count}, (_, i) => s15(view, offset + 12 + i * 4));
    if (form === 0) return x => power(x, g);
    if (form === 1) return x => x >= -b / a ? power(a * x + b, g) : 0;
    if (form === 2) return x => x >= -b / a ? power(a * x + b, g) + c : c;
    if (form === 3) return x => x >= d ? power(a * x + b, g) : c * x;
    return x => x >= d ? power(a * x + b, g) + e : c * x + f;
  }
  return null;
}

const SRGB_D50 = [0.4360747, 0.3850649, 0.1430804, 0.2225045, 0.7168786, 0.0606169, 0.0139322, 0.0971045, 0.7141733];
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
const SRGB_FROM_D50 = inverse(SRGB_D50);

const LCMS_SRGB_D50 = [0.436041251616, 0.385112910798, 0.143045837586, 0.222484540229, 0.716905078608, 0.060610381162, 0.013920187471, 0.097067238697, 0.713912573832];
const LCMS_SRGB_FROM_D50 = inverse(LCMS_SRGB_D50);

function readMatrixShaper(icc) {
  try {
    if (!icc || icc.length < 132) return null;
    const view = new DataView(icc.buffer, icc.byteOffset, icc.byteLength), text = at => String.fromCharCode(icc[at], icc[at + 1], icc[at + 2], icc[at + 3]);
    const space = text(16);
    if ((space !== 'RGB ' && space !== 'GRAY') || text(20) !== 'XYZ ') return null;
    const tags = new Map();
    for (let i = 0, count = view.getUint32(128); i < count; i++) {
      const at = 132 + i * 12;
      tags.set(text(at), {offset: view.getUint32(at + 4), length: view.getUint32(at + 8)});
    }
    if (tags.has('A2B0') || tags.has('A2B1') || tags.has('A2B2')) return null;
    const curve = name => {
      const tag = tags.get(name);
      return tag && curveOf(view, tag.offset, tag.length);
    };
    const table = fn => Float64Array.from({length: 256}, (_, v) => Math.max(0, Math.min(1, fn(v / 255))));
    if (space === 'GRAY') {
      const k = curve('kTRC');
      return k && {gray: true, tables: [table(k)], curves: [k]};
    }
    const columns = ['rXYZ', 'gXYZ', 'bXYZ'].map(name => {
      const tag = tags.get(name);
      if (!tag || tag.length < 20 || text(tag.offset) !== 'XYZ ') return null;
      return [s15(view, tag.offset + 8), s15(view, tag.offset + 12), s15(view, tag.offset + 16)];
    });
    const curves = ['rTRC', 'gTRC', 'bTRC'].map(curve);
    if (columns.includes(null) || curves.includes(null)) return null;
    return {gray: false, tables: curves.map(table), curves, xyz: [columns[0][0], columns[1][0], columns[2][0], columns[0][1], columns[1][1], columns[2][1], columns[0][2], columns[1][2], columns[2][2]]};
  } catch (_) { return null; }
}

export function profileTransform(icc) {
  const profile = readMatrixShaper(icc);
  if (!profile) return null;
  if (profile.gray) return {gray: true, tables: profile.tables, lms: Float64Array.from(OPSIN)};
  const lms = times(OPSIN, times(SRGB_FROM_D50, profile.xyz));
  return lms.every(Number.isFinite) ? {gray: false, tables: profile.tables, lms: Float64Array.from(lms)} : null;
}

export function linearSrgbProfile(icc) {
  const profile = readMatrixShaper(icc);
  if (!profile) return null;
  if (profile.gray) return {gray: true, tables: profile.tables, curves: profile.curves, matrix: Float64Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1)};
  const matrix = times(LCMS_SRGB_FROM_D50, profile.xyz);
  return matrix.every(Number.isFinite) ? {gray: false, tables: profile.tables, curves: profile.curves, matrix: Float64Array.from(matrix)} : null;
}

export function linearFromTransform(rgba, pixels, {tables, lms}) {
  const m = times(inverse(OPSIN), lms), planes = [new Float64Array(pixels), new Float64Array(pixels), new Float64Array(pixels)];
  for (let i = 0; i < pixels; i++) {
    const r = tables[0][rgba[i * 4]], g = tables[1][rgba[i * 4 + 1]], b = tables[2][rgba[i * 4 + 2]];
    for (let c = 0; c < 3; c++) planes[c][i] = m[c * 3] * r + m[c * 3 + 1] * g + m[c * 3 + 2] * b;
  }
  return planes;
}
const SRGB_D65 = [0.4124564, 0.3575761, 0.1804375, 0.2126729, 0.7151522, 0.072175, 0.0193339, 0.119192, 0.9503041];
const P3_D65 = [0.4865709, 0.2656677, 0.1982173, 0.2289746, 0.6917385, 0.0792869, 0, 0.0451134, 1.0439444];
const SRGB_CURVE = Float64Array.from({length: 256}, (_, i) => { const v = i / 255; return v <= 0.04045 ? v / 12.92 : power((v + 0.055) / 1.055, 2.4); });
export const P3_TRANSFORM = {gray: false, tables: [SRGB_CURVE, SRGB_CURVE, SRGB_CURVE], lms: Float64Array.from(times(OPSIN, times(inverse(SRGB_D65), P3_D65)))};

export function spaceTransform(space) {
  if (space.transform === undefined) space.transform = profileTransform(space.icc);
  return space.transform;
}

const D50 = [0.9642, 1, 0.8249];
const BRADFORD = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296];
const apply = (m, [x, y, z]) => [m[0] * x + m[1] * y + m[2] * z, m[3] * x + m[4] * y + m[5] * z, m[6] * x + m[7] * y + m[8] * z];
const xyOf = ([x, y, z]) => [x / (x + y + z), y / (x + y + z)];
const XYZof = ([x, y]) => [x / y, 1, (1 - x - y) / y];
function adaptation(from, to) {
  const a = apply(BRADFORD, from), b = apply(BRADFORD, to);
  return times(inverse(BRADFORD), times([b[0] / a[0], 0, 0, 0, b[1] / a[1], 0, 0, 0, b[2] / a[2]], BRADFORD));
}
function primaryMatrix(primaries, white) {
  const m = [0, 1, 2].map(c => XYZof(primaries[c])), p = [m[0][0], m[1][0], m[2][0], m[0][1], m[1][1], m[2][1], m[0][2], m[1][2], m[2][2]];
  const s = apply(inverse(p), XYZof(white));
  return p.map((v, i) => v * s[i % 3]);
}
const WHITES = [[1, [0.3127, 0.329]], [10, [1 / 3, 1 / 3]], [11, [0.314, 0.351]]];
const PRIMARY_SETS = [[1, [[0.64, 0.33], [0.3, 0.6], [0.15, 0.06]]], [9, [[0.708, 0.292], [0.17, 0.797], [0.131, 0.046]]], [11, [[0.68, 0.32], [0.265, 0.69], [0.15, 0.06]]]];
const near = (a, b) => Math.abs(a[0] - b[0]) < 1e-3 && Math.abs(a[1] - b[1]) < 1e-3;
const millionths = xy => xy.map(v => Math.round(v * 1e6) / 1e6);
const bt709 = v => v < 0.081 ? v / 4.5 : power((v + 0.099) / 1.099, 1 / 0.45);
const TRANSFERS = [[1, bt709], [8, v => v], [13, v => v <= 0.04045 ? v / 12.92 : power((v + 0.055) / 1.055, 2.4)], [17, v => power(v, 2.6)]];
const sameCurve = (a, b) => {
  for (let i = 0; i <= 255; i++) {
    const v = i / 255, light = a(v);
    let lo = 0, hi = 1;
    for (let k = 0; k < 24; k++) { const mid = (lo + hi) / 2; if (b(mid) < light) lo = mid; else hi = mid; }
    if (Math.abs(lo - v) * 255 > 0.5) return false;
  }
  return true;
};

export function profileFields(icc) {
  const profile = readMatrixShaper(icc);
  if (!profile) return null;
  const view = new DataView(icc.buffer, icc.byteOffset, icc.byteLength), intent = view.getUint32(64);
  if (intent > 3) return null;
  const curves = profile.gray ? [profile.curves[0]] : profile.curves;
  if (!curves.every(c => { for (let i = 0; i <= 255; i++) { const v = c(i / 255); if (!(v >= 0 && v <= 1)) return false; } return true; })) return null;
  for (let i = 0, count = view.getUint32(128); i < count; i++) {
    const at = 132 + i * 12, name = String.fromCharCode(icc[at], icc[at + 1], icc[at + 2]);
    if (name === 'B2A' || name === 'B2D' || name === 'D2B') return null;
  }
  let transfer, gamma;
  const probe = curves[0](0.5);
  if (!(probe >= 0 && probe <= 1)) return null;
  const g = ln(Math.max(1e-9, probe)) / ln(0.5);
  if (g > 0.05 && curves.every(c => sameCurve(c, v => power(v, g)))) {
    if (Math.abs(g - 1) < 1e-3) transfer = 8;
    else if (Math.round(1e7 / g) * 8192 >= 1e7 && g > 1) gamma = Math.round(1e7 / g) / 1e7;
  }
  if (transfer === undefined && gamma === undefined) {
    const found = TRANSFERS.find(([, fn]) => curves.every(c => sameCurve(c, fn)));
    if (!found) return null;
    transfer = found[0];
  }
  const tags = new Map();
  for (let i = 0, count = view.getUint32(128); i < count; i++) {
    const at = 132 + i * 12, name = String.fromCharCode(icc[at], icc[at + 1], icc[at + 2], icc[at + 3]);
    tags.set(name, {offset: view.getUint32(at + 4), length: view.getUint32(at + 8)});
  }
  const chad = tags.get('chad'), wtpt = tags.get('wtpt');
  let whiteXYZ = D50;
  if (chad && chad.length >= 44) whiteXYZ = apply(inverse(Array.from({length: 9}, (_, i) => s15(view, chad.offset + 8 + i * 4))), D50);
  else if (wtpt && wtpt.length >= 20) whiteXYZ = [0, 1, 2].map(i => s15(view, wtpt.offset + 8 + i * 4));
  const whiteXY = xyOf(whiteXYZ);
  if (![...whiteXY].every(Number.isFinite)) return null;
  const whiteEnum = WHITES.find(([, xy]) => near(xy, whiteXY));
  const white = whiteEnum ? {enum: whiteEnum[0], xy: whiteEnum[1]} : {enum: 2, xy: millionths(whiteXY)};
  const fields = {gray: profile.gray, white, transfer, gamma, intent};
  if (profile.gray) return fields;
  const unadapted = times(adaptation(D50, XYZof(white.xy)), profile.xyz), found = [0, 1, 2].map(c => xyOf([unadapted[c], unadapted[3 + c], unadapted[6 + c]]));
  if (!found.flat().every(Number.isFinite)) return null;
  const set = PRIMARY_SETS.find(([, xys]) => xys.every((xy, c) => near(xy, found[c])));
  fields.primaries = set ? {enum: set[0], xy: set[1]} : {enum: 2, xy: found.map(millionths)};
  const rebuilt = times(adaptation(XYZof(white.xy), D50), primaryMatrix(fields.primaries.xy, white.xy));
  return rebuilt.every((v, i) => Math.abs(v - profile.xyz[i]) < 2e-3) ? fields : null;
}
