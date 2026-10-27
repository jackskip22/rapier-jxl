// SPDX-License-Identifier: MIT

import {exactCbrt, exactPow, exactTan, exactSin, exactCos, exactExp, EXACT_PI} from './exact-math.mjs';
const SIGMA = 1.5, C2 = 0.0009, SCALES = 6;
const S2_WEIGHTS = Float64Array.of(0.0, 0.0007376606707406586, 0.0, 0.0, 0.0007793481682867309, 0.0, 0.0, 0.0004371155730107379,
  0.0, 1.1041726426657346, 0.00066284834129271, 0.00015231632783718752, 0.0, 0.0016406437456599754, 0.0, 1.8422455520539298,
  11.441172603757666, 0.0, 0.0007989109436015163, 0.000176816438078653, 0.0, 1.8787594979546387, 10.94906990605142, 0.0,
  0.0007289346991508072, 0.9677937080626833, 0.0, 0.00014003424285435884, 0.9981766977854967, 0.00031949755934435053,
  0.0004550992113792063, 0.0, 0.0, 0.0013648766163243398, 0.0, 0.0, 0.0, 0.0, 0.0, 7.466890328078848, 0.0,
  17.445833984131262, 0.0006235601634041466, 0.0, 0.0, 6.683678146179332, 0.00037724407979611296, 1.027889937768264,
  225.20515300849274, 0.0, 0.0, 19.213238186143016, 0.0011401524586618361, 0.001237755635509985, 176.39317598450694, 0.0,
  0.0, 24.43300999870476, 0.28520802612117757, 0.0004485436923833408, 0.0, 0.0, 0.0, 34.77906344483772, 44.835625328877896,
  0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0008680556573291698, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0005313191874358747, 0.0,
  0.00016533814161379112, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0004179171803251336, 0.0017290828234722833, 0.0, 0.0020827005846636437,
  0.0, 0.0, 8.826982764996862, 23.19243343998926, 0.0, 95.1080498811086, 0.9863978034400682, 0.9834382792465353,
  0.0012286405048278493, 171.2667255897307, 0.9807858872435379, 0.0, 0.0, 0.0, 0.0005130064588990679, 0.0,
  0.00010854057858411537);
export {S2_WEIGHTS as SSIMULACRA2_WEIGHTS};

const S2_OPSIN = [0.30, 0.622, 0.078, 0.23, 0.692, 0.078, 0.24342268924547819, 0.20476744424496821, 0.55180986650955360];
const S2_BIAS = 0.0037930732552754493, BIAS_ROOT = exactCbrt(S2_BIAS);

export const SRGB_TO_LINEAR = Float64Array.from({length: 256}, (_, i) => {
  const v = i / 255; return v <= 0.04045 ? v / 12.92 : exactPow((v + 0.055) / 1.055, 2.4);
});
export function srgbToLinear(v) {
  const a = Math.abs(v), l = a <= 0.04045 ? a / 12.92 : exactPow((a + 0.055) / 1.055, 2.4);
  return v < 0 ? -l : l;
}

export function recursiveGaussian(sigma) {
  const radius = Math.round(3.2795 * sigma + 0.2546), p = EXACT_PI / (2 * radius), omega = [p, 3 * p, 5 * p];
  const p1 = 1 / exactTan(0.5 * omega[0]), p3 = -1 / exactTan(0.5 * omega[1]), p5 = 1 / exactTan(0.5 * omega[2]);
  const r1 = p1 * p1 / exactSin(omega[0]), r3 = -p3 * p3 / exactSin(omega[1]), r5 = p5 * p5 / exactSin(omega[2]);
  const rho = omega.map(w => exactExp(-0.5 * sigma * sigma * w * w) / radius);
  const d13 = p1 * r3 - r1 * p3, d35 = p3 * r5 - r3 * p5, d51 = p5 * r1 - r5 * p1;
  const z15 = d35 / d13, z35 = d51 / d13;
  const A = [p1, p3, p5, r1, r3, r5, z15, z35, 1], gamma = [1, radius * radius - sigma * sigma, z15 * rho[0] + z35 * rho[1] + rho[2]];
  const inv = invert3(A), beta = [0, 1, 2].map(i => inv[i * 3] * gamma[0] + inv[i * 3 + 1] * gamma[1] + inv[i * 3 + 2] * gamma[2]);
  return {radius, n2: omega.map((w, i) => -beta[i] * exactCos(w * (radius + 1))), d1: omega.map(w => -2 * exactCos(w))};
}

function invert3(m) {
  const [a, b, c, d, e, f, g, h, i] = m, A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

const GAUSS = recursiveGaussian(SIGMA);

export function gaussianTaps(g = GAUSS) {
  const size = 4 * g.radius + 1, line = new Float64Array(size), out = new Float64Array(size);
  line[2 * g.radius] = 1;
  blurLine(line, out, 0, size, 1, g);
  const taps = [];
  for (let k = -(g.radius - 1); k <= g.radius - 1; k++) taps.push(out[2 * g.radius + k]);
  return Float64Array.from(taps);
}

function blurLine(input, out, at, count, stride, g = GAUSS) {
  const N = g.radius, [n1, n3, n5] = g.n2, [d1, d3, d5] = g.d1;
  let a1 = 0, b1 = 0, a3 = 0, b3 = 0, a5 = 0, b5 = 0;
  for (let n = -N + 1; n < count; n++) {
    const left = n - N - 1, right = n + N - 1;
    const sum = (left >= 0 ? input[at + left * stride] : 0) + (right < count ? input[at + right * stride] : 0);
    const o1 = n1 * sum - d1 * a1 - b1, o3 = n3 * sum - d3 * a3 - b3, o5 = n5 * sum - d5 * a5 - b5;
    b1 = a1; a1 = o1; b3 = a3; a3 = o3; b5 = a5; a5 = o5;
    if (n >= 0) out[at + n * stride] = o1 + o3 + o5;
  }
}

const f32 = Math.fround, GAUSS32 = {radius: GAUSS.radius, n2: GAUSS.n2.map(f32), d1: GAUSS.d1.map(f32)};
function blurLine32(input, out, at, count, stride) {
  const N = GAUSS32.radius, [n1, n3, n5] = GAUSS32.n2, [d1, d3, d5] = GAUSS32.d1;
  let a1 = 0, b1 = 0, a3 = 0, b3 = 0, a5 = 0, b5 = 0;
  for (let n = -N + 1; n < count; n++) {
    const left = n - N - 1, right = n + N - 1;
    const sum = f32((left >= 0 ? input[at + left * stride] : 0) + (right < count ? input[at + right * stride] : 0));
    const o1 = f32(n1 * sum - f32(d1 * a1 + b1)), o3 = f32(n3 * sum - f32(d3 * a3 + b3)), o5 = f32(n5 * sum - f32(d5 * a5 + b5));
    b1 = a1; a1 = o1; b3 = a3; a3 = o3; b5 = a5; a5 = o5;
    if (n >= 0) out[at + n * stride] = f32(f32(o1 + o3) + o5);
  }
}
export function s2Blur(plane, width, height, out = new Float64Array(plane.length), temp = new Float64Array(plane.length)) {
  for (let y = 0; y < height; y++) blurLine(plane, temp, y * width, width, 1);
  for (let x = 0; x < width; x++) blurLine(temp, out, x, height, width);
  return out;
}

export function positiveXYB(linear, pixels) {
  const out = [new Float32Array(pixels), new Float32Array(pixels), new Float32Array(pixels)], [r, g, b] = linear, m = S2_OPSIN;
  for (let i = 0; i < pixels; i++) {
    const l = exactCbrt(Math.max(0, m[0] * r[i] + m[1] * g[i] + m[2] * b[i] + S2_BIAS)) - BIAS_ROOT;
    const mm = exactCbrt(Math.max(0, m[3] * r[i] + m[4] * g[i] + m[5] * b[i] + S2_BIAS)) - BIAS_ROOT;
    const s = exactCbrt(Math.max(0, m[6] * r[i] + m[7] * g[i] + m[8] * b[i] + S2_BIAS)) - BIAS_ROOT;
    const X = 0.5 * (l - mm), Y = 0.5 * (l + mm);
    out[0][i] = X * 14 + 0.42; out[1][i] = Y + 0.01; out[2][i] = (s - Y) + 0.55;
  }
  return out;
}

export function positiveXYBPlane(linear, pixels, c) {
  return positiveXYBInto(linear, c, new Float32Array(pixels), 0, 0, pixels);
}

function positiveXYBInto(linear, c, out, at, from, count) {
  const m = S2_OPSIN, rgba = linear.rgba, [rp, gp, bp] = rgba ? [] : linear, L = SRGB_TO_LINEAR;
  for (let k = 0; k < count; k++) {
    const i = from + k, r = rgba ? L[rgba[i * 4]] : rp[i], g = rgba ? L[rgba[i * 4 + 1]] : gp[i], b = rgba ? L[rgba[i * 4 + 2]] : bp[i];
    const l = exactCbrt(Math.max(0, m[0] * r + m[1] * g + m[2] * b + S2_BIAS)) - BIAS_ROOT;
    const mm = exactCbrt(Math.max(0, m[3] * r + m[4] * g + m[5] * b + S2_BIAS)) - BIAS_ROOT;
    if (c === 0) { out[at + k] = 0.5 * (l - mm) * 14 + 0.42; continue; }
    const Y = 0.5 * (l + mm);
    if (c === 1) { out[at + k] = Y + 0.01; continue; }
    const s = exactCbrt(Math.max(0, m[6] * r + m[7] * g + m[8] * b + S2_BIAS)) - BIAS_ROOT;
    out[at + k] = (s - Y) + 0.55;
  }
  return out;
}

function channelSums(a, b, w, h, c, native, cached, keep) {
  const g = native ? GAUSS32 : GAUSS, N = g.radius, R = 2 * N + 1, Plane = native ? Float32Array : Float64Array;
  const [n1, n3, n5] = g.n2, [d1, d3, d5] = g.d1, line = native ? blurLine32 : blurLine;
  const p1 = new Float32Array(R * w), p2 = new Float32Array(R * w), prod = new Plane(R * w);
  const active = [0, 1, 2, 3, 4].map(k => !cached || (k !== 0 && k !== 2));
  const across = active.map(use => use ? new Plane(R * w) : null), state = active.map(use => use ? new Float64Array(6 * w) : null);
  const down = active.map(use => use ? new Plane(w) : null);
  const retained = keep && !cached ? {p1: new Float32Array(w * h), mu1: new Plane(w * h), s11: new Plane(w * h)} : null;
  let made = 0;
  const make = y => {
    const at = (y % R) * w;
    if (cached) p1.set(cached.p1.subarray(y * w, (y + 1) * w), at);
    else positiveXYBInto(a, c, p1, at, y * w, w);
    positiveXYBInto(b, c, p2, at, y * w, w);
    if (!cached) {
      line(p1, across[0], at, w, 1);
      for (let x = 0; x < w; x++) prod[at + x] = p1[at + x] * p1[at + x]; line(prod, across[2], at, w, 1);
    }
    if (retained) retained.p1.set(p1.subarray(at, at + w), y * w);
    line(p2, across[1], at, w, 1);
    for (let x = 0; x < w; x++) prod[at + x] = p2[at + x] * p2[at + x]; line(prod, across[3], at, w, 1);
    for (let x = 0; x < w; x++) prod[at + x] = p1[at + x] * p2[at + x]; line(prod, across[4], at, w, 1);
  };
  let ss1 = 0, ss4 = 0, a1 = 0, a4 = 0, l1 = 0, l4 = 0;
  for (let n = -N + 1; n < h; n++) {
    while (made < h && made <= n + N - 1) make(made++);
    const left = n - N - 1, right = n + N - 1, lo = left >= 0 ? (left % R) * w : -1, ro = right < h ? (right % R) * w : -1;
    for (let k = 0; k < 5; k++) {
      if (!active[k]) continue;
      const src = across[k], st = state[k], out = down[k];
      for (let x = 0; x < w; x++) {
        const j = 6 * x;
        let o1, o3, o5;
        if (native) {
          const sum = f32((lo >= 0 ? src[lo + x] : 0) + (ro >= 0 ? src[ro + x] : 0));
          o1 = f32(n1 * sum - f32(d1 * st[j] + st[j + 1])); o3 = f32(n3 * sum - f32(d3 * st[j + 2] + st[j + 3])); o5 = f32(n5 * sum - f32(d5 * st[j + 4] + st[j + 5]));
          if (n >= 0) out[x] = f32(f32(o1 + o3) + o5);
        } else {
          const sum = (lo >= 0 ? src[lo + x] : 0) + (ro >= 0 ? src[ro + x] : 0);
          o1 = n1 * sum - d1 * st[j] - st[j + 1]; o3 = n3 * sum - d3 * st[j + 2] - st[j + 3]; o5 = n5 * sum - d5 * st[j + 4] - st[j + 5];
          if (n >= 0) out[x] = o1 + o3 + o5;
        }
        st[j + 1] = st[j]; st[j] = o1; st[j + 3] = st[j + 2]; st[j + 2] = o3; st[j + 5] = st[j + 4]; st[j + 4] = o5;
      }
    }
    if (n < 0) continue;
    const at = (n % R) * w, [mu1, mu2, s11, s22, s12] = down;
    if (retained) { retained.mu1.set(mu1, n * w); retained.s11.set(s11, n * w); }
    for (let x = 0; x < w; x++) {
      const m1 = cached ? cached.mu1[n * w + x] : mu1[x], v11 = cached ? cached.s11[n * w + x] : s11[x];
      const m2 = mu2[x], q1 = p1[at + x], q2 = p2[at + x];
      let e, dd;
      if (native) {
        const delta = f32(m1 - m2), numM = f32(1 - f32(delta * delta));
        const numS = f32(f32(2 * f32(f32(s12[x]) - f32(m1 * m2))) + f32(C2));
        const denS = f32(f32(f32(f32(v11) - f32(m1 * m1)) + f32(f32(s22[x]) - f32(m2 * m2))) + f32(C2));
        e = Math.max(0, 1 - f32(f32(numM * numS) / denS));
        dd = (1 + Math.abs(f32(q2 - m2))) / (1 + Math.abs(f32(q1 - m1))) - 1;
      } else {
        const numM = 1 - (m1 - m2) * (m1 - m2);
        const numS = 2 * (s12[x] - m1 * m2) + C2, denS = (v11 - m1 * m1) + (s22[x] - m2 * m2) + C2;
        e = Math.max(0, 1 - numM * numS / denS);
        dd = (1 + Math.abs(q2 - m2)) / (1 + Math.abs(q1 - m1)) - 1;
      }
      ss1 += e; ss4 += e * e * e * e;
      const artifact = Math.max(dd, 0), detail = Math.max(-dd, 0);
      a1 += artifact; a4 += artifact * artifact * artifact * artifact; l1 += detail; l4 += detail * detail * detail * detail;
    }
  }
  return {sums: [ss1, ss4, a1, a4, l1, l4], reference: retained};
}

export function downsample(planes, width, height) {
  const w = (width + 1) >> 1, h = (height + 1) >> 1, out = [0, 1, 2].map(() => new Float64Array(w * h)), rgba = planes.rgba, L = SRGB_TO_LINEAR;
  for (let c = 0; c < 3; c++) {
    const p = rgba ? null : planes[c], o = out[c], v = rgba ? k => L[rgba[k * 4 + c]] : k => p[k];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const x0 = 2 * x, y0 = 2 * y, x1 = Math.min(x0 + 1, width - 1), y1 = Math.min(y0 + 1, height - 1);
      o[y * w + x] = 0.25 * (v(y0 * width + x0) + v(y0 * width + x1) + v(y1 * width + x0) + v(y1 * width + x1));
    }
  }
  return {planes: out, width: w, height: h};
}

export function linearFromRGBA(rgba, pixels) {
  const planes = [new Float64Array(pixels), new Float64Array(pixels), new Float64Array(pixels)];
  for (let i = 0; i < pixels; i++) for (let c = 0; c < 3; c++) planes[c][i] = SRGB_TO_LINEAR[rgba[i * 4 + c]];
  return planes;
}

const S2_REFERENCE = Symbol('SSIMULACRA2 reference');

function s2ReferenceSnapshot(reference, pixels) {
  if (reference.rgba) {
    const rgba = reference.rgba, values = rgba.subarray ? rgba.subarray(0, pixels * 4) : rgba.slice(0, pixels * 4);
    const copy = rgba instanceof Uint8Array || rgba instanceof Uint8ClampedArray ? new Uint8Array(values) : Float64Array.from(values);
    return {source: {rgba: copy}, bytes: copy.byteLength};
  }
  const source = [0, 1, 2].map(c => {
    const plane = reference[c];
    return Float64Array.from(plane.subarray ? plane.subarray(0, pixels) : plane.slice(0, pixels));
  });
  return {source, bytes: source.reduce((sum, plane) => sum + plane.byteLength, 0)};
}

export function ssimulacra2Reference(reference, width, height, {native = false, cacheBytes = 0, immutable = false} = {}) {
  if (!Number.isSafeInteger(cacheBytes) || cacheBytes < 0) throw new RangeError('SSIMULACRA2 cacheBytes must be a nonnegative safe integer.');
  let inputBytes = 0;
  if (!immutable && typeof reference !== 'function') {
    const snapshot = s2ReferenceSnapshot(reference, width * height); reference = snapshot.source; inputBytes = snapshot.bytes;
  }
  const state = {reference, width, height, native, scales: [], cacheBytes: 0, inputBytes, busy: false};
  let w = width, h = height, left = cacheBytes;
  for (let scale = 0; scale < SCALES; scale++) {
    if (w < 8 || h < 8) break;
    if (scale) { w = (w + 1) >> 1; h = (h + 1) >> 1; }
    const bytes = w * h * 3 * (native ? 12 : 20), keep = bytes <= left;
    state.scales.push(keep ? [] : null);
    if (keep) left -= bytes;
  }
  return Object.freeze({[S2_REFERENCE]: state, reservedBytes: cacheBytes - left,
    get cacheBytes() { return state.cacheBytes; }, get inputBytes() { return state.inputBytes; }});
}

export function ssimulacra2(reference, distorted, width, height, {wantMap = false, native = false} = {}) {
  if (native && wantMap) throw new Error('The native score has no map.');
  const fixed = reference?.[S2_REFERENCE];
  if (fixed && (fixed.width !== width || fixed.height !== height || fixed.native !== native)) {
    throw new RangeError('SSIMULACRA2 reference dimensions and arithmetic must match.');
  }
  if (fixed?.busy) throw new Error('SSIMULACRA2 reference is already in use.');
  let lastSourceScale = -1;
  if (fixed) for (let s = 0; s < fixed.scales.length; s++) if (!fixed.scales[s] || fixed.scales[s].length < 3) lastSourceScale = s;
  let a = reference, b = distorted, w = width, h = height;
  if (fixed) fixed.busy = true;
  try {
    if (fixed) a = lastSourceScale < 0 ? null : typeof fixed.reference === 'function' ? fixed.reference() : fixed.reference;
    const norms = [], map = wantMap ? new Float64Array(width * height) : null, scaleMaps = [];
    for (let scale = 0; scale < SCALES; scale++) {
      if (w < 8 || h < 8) break;
      if (scale) {
        if (a) a = downsample(a, w, h).planes;
        const db = downsample(b, w, h); b = db.planes; w = db.width; h = db.height;
      }
      const n = w * h, temp = wantMap ? new Float64Array(n) : null;
      const per = {ssim: new Float64Array(6), edge: new Float64Array(12)}, local = wantMap ? [] : null;
      const channels = fixed?.scales[scale];
      for (let c = 0; c < 3 && !wantMap; c++) {
        const result = channelSums(a, b, w, h, c, native, channels?.[c], !!channels);
        if (result.reference) {
          channels[c] = result.reference;
          fixed.cacheBytes += result.reference.p1.byteLength + result.reference.mu1.byteLength + result.reference.s11.byteLength;
        }
        const [ss1, ss4, a1, a4, l1, l4] = result.sums;
        per.ssim[c * 2] = ss1 / n; per.ssim[c * 2 + 1] = Math.sqrt(Math.sqrt(ss4 / n));
        per.edge[c * 4] = a1 / n; per.edge[c * 4 + 1] = Math.sqrt(Math.sqrt(a4 / n));
        per.edge[c * 4 + 2] = l1 / n; per.edge[c * 4 + 3] = Math.sqrt(Math.sqrt(l4 / n));
      }
      for (let c = 0; c < 3 && wantMap; c++) {
        const cached = channels?.[c], p1 = cached ? cached.p1 : positiveXYBPlane(a, n, c), p2 = positiveXYBPlane(b, n, c);
        const mu1 = cached ? cached.mu1 : s2Blur(p1, w, h, undefined, temp), mu2 = s2Blur(p2, w, h, undefined, temp);
        const product = f => { const m = new Float64Array(n); for (let i = 0; i < n; i++) m[i] = f(i); return s2Blur(m, w, h, m, temp); };
        const s11 = cached ? cached.s11 : product(i => p1[i] * p1[i]), s22 = product(i => p2[i] * p2[i]), s12 = product(i => p1[i] * p2[i]);
        if (channels && !cached) {
          channels[c] = {p1, mu1, s11}; fixed.cacheBytes += p1.byteLength + mu1.byteLength + s11.byteLength;
        }
        const d = new Float64Array(n), art = new Float64Array(n), lost = new Float64Array(n);
        let ss1 = 0, ss4 = 0, a1 = 0, a4 = 0, l1 = 0, l4 = 0;
        for (let i = 0; i < n; i++) {
          const m1 = mu1[i], m2 = mu2[i];
          const numM = 1 - (m1 - m2) * (m1 - m2);
          const numS = 2 * (s12[i] - m1 * m2) + C2, denS = (s11[i] - m1 * m1) + (s22[i] - m2 * m2) + C2;
          const e = Math.max(0, 1 - numM * numS / denS), d1 = (1 + Math.abs(p2[i] - m2)) / (1 + Math.abs(p1[i] - m1)) - 1;
          ss1 += e; ss4 += e * e * e * e;
          const artifact = Math.max(d1, 0), detail = Math.max(-d1, 0);
          a1 += artifact; a4 += artifact * artifact * artifact * artifact; l1 += detail; l4 += detail * detail * detail * detail;
          d[i] = e; art[i] = artifact; lost[i] = detail;
        }
        per.ssim[c * 2] = ss1 / n; per.ssim[c * 2 + 1] = Math.sqrt(Math.sqrt(ss4 / n));
        per.edge[c * 4] = a1 / n; per.edge[c * 4 + 1] = Math.sqrt(Math.sqrt(a4 / n));
        per.edge[c * 4 + 2] = l1 / n; per.edge[c * 4 + 3] = Math.sqrt(Math.sqrt(l4 / n));
        if (wantMap) local.push({d, art, lost});
      }
      if (fixed && scale === lastSourceScale) a = null;
      norms.push(per);
      if (wantMap) scaleMaps.push({w, h, local});
    }
    let sum = 0, i = 0;
    for (let c = 0; c < 3; c++) for (let s = 0; s < norms.length; s++) for (let k = 0; k < 2; k++) {
      sum += S2_WEIGHTS[i++] * Math.abs(norms[s].ssim[c * 2 + k]);
      sum += S2_WEIGHTS[i++] * Math.abs(norms[s].edge[c * 4 + k]);
      sum += S2_WEIGHTS[i++] * Math.abs(norms[s].edge[c * 4 + k + 2]);
    }
    const score = finalCurve(sum);
    if (wantMap) spreadMap(map, width, height, norms, scaleMaps);
    if (fixed && fixed.scales.every(channels => channels?.length === 3)) { fixed.reference = null; fixed.inputBytes = 0; }
    return {score, sum, norms, map};
  } finally {
    a = null; b = null;
    if (fixed) fixed.busy = false;
  }
}

export function finalCurve(sum) {
  let s = sum * 0.9562382616834844;
  s = 2.326765642916932 * s - 0.020884521182843837 * s * s + 6.248496625763138e-5 * s * s * s;
  return s > 0 ? 100 - 10 * exactPow(s, 0.6276336467831387) : 100;
}

function spreadMap(map, width, height, norms, scaleMaps) {
  const scales = norms.length;
  for (let s = 0; s < scales; s++) {
    const {w, h, local} = scaleMaps[s], n = w * h, share = new Float64Array(n);
    for (let c = 0; c < 3; c++) {
      const base = c * scales * 6 + s * 6, wt = k => S2_WEIGHTS[base + k];
      const terms = [[local[c].d, wt(0), wt(3), norms[s].ssim[c * 2 + 1]], [local[c].art, wt(1), wt(4), norms[s].edge[c * 4 + 1]],
        [local[c].lost, wt(2), wt(5), norms[s].edge[c * 4 + 3]]];
      for (const [values, w1, w4, norm4] of terms) {
        if (!w1 && !w4) continue;
        const k4 = norm4 > 0 ? w4 / (n * norm4 * norm4 * norm4) : 0;
        for (let i = 0; i < n; i++) { const v = values[i]; share[i] += w1 / n * v + k4 * v * v * v * v; }
      }
    }
    const f = 1 << s;
    for (let y = 0; y < height; y++) {
      const sy = Math.min(h - 1, y >> s);
      for (let x = 0; x < width; x++) map[y * width + x] += share[sy * w + Math.min(w - 1, x >> s)] / (f * f);
    }
  }
}

