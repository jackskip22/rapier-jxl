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

export function profileTransform(icc) {
  try {
    if (icc.length < 132) return null;
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
      return k && {gray: true, tables: [table(k)], lms: Float64Array.from(OPSIN)};
    }
    const columns = ['rXYZ', 'gXYZ', 'bXYZ'].map(name => {
      const tag = tags.get(name);
      if (!tag || tag.length < 20 || text(tag.offset) !== 'XYZ ') return null;
      return [s15(view, tag.offset + 8), s15(view, tag.offset + 12), s15(view, tag.offset + 16)];
    });
    const curves = ['rTRC', 'gTRC', 'bTRC'].map(curve);
    if (columns.includes(null) || curves.includes(null)) return null;
    const profile = [columns[0][0], columns[1][0], columns[2][0], columns[0][1], columns[1][1], columns[2][1], columns[0][2], columns[1][2], columns[2][2]];
    const lms = times(OPSIN, times(SRGB_FROM_D50, profile));
    return lms.every(Number.isFinite) ? {gray: false, tables: curves.map(table), lms: Float64Array.from(lms)} : null;
  } catch (_) { return null; }
}

export function spaceTransform(space) {
  if (space.transform === undefined) space.transform = profileTransform(space.icc);
  return space.transform;
}
