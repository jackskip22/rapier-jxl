// SPDX-License-Identifier: MIT AND BSD-3-Clause
// Float32 numerical kernels adapted from libjxl 0.12.0 (JPEG XL Project Authors).
// Sources: tools/ssimulacra2.cc, tools/gauss_blur.cc, lib/jxl/base/fast_math-inl.h,
// lib/jxl/cms/transfer_functions-inl.h. See LICENSE.libjxl.

import {exactCbrt, exactPow, exactTan, exactSin, exactCos, exactExp, EXACT_PI} from './exact-math.mjs';
const f32 = Math.fround;
const SIGMA = 1.5, C2 = f32(0.0009), SCALES = 6;
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

const S2_OPSIN = Float32Array.of(
  0.30, f32(1 - f32(0.078)) - f32(0.30), 0.078,
  0.23, f32(1 - f32(0.078)) - f32(0.23), 0.078,
  0.24342268924547819, 0.20476744424496821, f32(1 - f32(0.24342268924547819)) - f32(0.20476744424496821));
const S2_BIAS = f32(0.0037930732552754493), BIAS_ROOT = f32(exactCbrt(S2_BIAS));

// Keep the mathematical transfer for the encoder/Butteraugli. SSIMULACRA2 uses
// the reference CMS's float32 approximation: variance cancellation amplifies ulps.
export const SRGB_TO_LINEAR = Float64Array.from({length: 256}, (_, i) => {
  const v = i / 255; return v <= 0.04045 ? v / 12.92 : exactPow((v + 0.055) / 1.055, 2.4);
});
const S2_P = Float32Array.of(2.200248328e-4, 1.043637593e-2, 1.624820318e-1, 7.961564959e-1, 8.210152774e-1);
const S2_Q = Float32Array.of(2.631846970e-1, 1.076976492, 4.987528350e-1, -5.512498495e-2, 6.521209011e-3);
function referenceLinear(x) {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  if (x <= f32(0.04045)) return sign * f32(x * f32(1 / f32(12.92)));
  let p = S2_P[4], q = S2_Q[4];
  for (let i = 3; i >= 0; i--) { p = f32(p * x + S2_P[i]); q = f32(q * x + S2_Q[i]); }
  return sign * f32(p / q);
}
const S2_LINEAR = Float32Array.from({length: 256}, (_, i) => referenceLinear(f32(i * f32(1 / 255))));
const S2_ENCODE_P = Float32Array.of(-5.135152395e-4, 5.287254571e-3, 3.903842876e-1, 1.474205315, 7.352629620e-1);
const S2_ENCODE_Q = Float32Array.of(1.004519624e-2, 3.036675394e-1, 1.340816930, 9.258482155e-1, 2.424867759e-2);
function referenceEncoded(value) {
  const sign = value < 0 ? -1 : 1, v = Math.abs(f32(value));
  if (v <= f32(0.0031308)) return sign * f32(v * f32(12.92));
  const x = f32(Math.sqrt(v));
  let p = S2_ENCODE_P[4], q = S2_ENCODE_Q[4];
  for (let i = 3; i >= 0; i--) { p = f32(p * x + S2_ENCODE_P[i]); q = f32(q * x + S2_ENCODE_Q[i]); }
  return sign * f32(p / q);
}

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
const G_N = Float32Array.from(GAUSS.n2), G_D = Float32Array.from(GAUSS.d1);
const G_MUL = GAUSS.n2.map((n, i) => {
  const d = GAUSS.d1[i], d2 = d * d;
  return {
    input: Float32Array.of(n, -d * n, d2 * n - n, -d2 * d * n + 2 * d * n),
    prev: Float32Array.of(-d, d2 - 1, -d2 * d + 2 * d, d2 * d2 - 3 * d2 + 1),
    prev2: Float32Array.of(-1, d, -d2 + 1, d2 * d - 2 * d)
  };
});

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

// Preserve the reference's four-lane float32 evaluation order. Each f32(a*b+c)
// emulates a float32 fused operation; products of float32 operands fit in JS doubles.
function blurHorizontal(input, out, at, count) {
  const N = GAUSS.radius, prev = new Float32Array(3), prev2 = new Float32Array(3);
  const sums = new Float32Array(4), values = new Float32Array(12);
  let n = -N + 1;
  const scalar = () => {
    const left = n - N - 1, right = n + N - 1;
    const sum = f32((left >= 0 ? input[at + left] : 0) + (right < count ? input[at + right] : 0));
    for (let k = 0; k < 3; k++) {
      const m = G_MUL[k], value = f32(m.prev[0] * prev[k] + f32(m.prev2[0] * prev2[k] + f32(m.input[0] * sum)));
      prev2[k] = prev[k]; prev[k] = value;
    }
    if (n >= 0) out[at + n] = f32(prev[0] + f32(prev[1] + prev[2]));
  };
  for (; n < Math.min(Math.ceil((N + 1) / 4) * 4, count); n++) scalar();
  for (; n < count - N - 2; n += 4) {
    for (let i = 0; i < 4; i++) sums[i] = input[at + n + i - N - 1] + input[at + n + i + N - 1];
    for (let k = 0; k < 3; k++) {
      const m = G_MUL[k], o = k * 4;
      for (let lane = 0; lane < 4; lane++) {
        let value = f32(sums[0] * m.input[lane]);
        for (let i = 1; i <= lane; i++) value = f32(m.input[lane - i] * sums[i] + value);
        value = f32(m.prev2[lane] * prev2[k] + value);
        values[o + lane] = f32(m.prev[lane] * prev[k] + value);
      }
      prev2[k] = values[o + 2]; prev[k] = values[o + 3];
    }
    for (let i = 0; i < 4; i++) out[at + n + i] = f32(values[i] + f32(values[4 + i] + values[8 + i]));
  }
  for (; n < count; n++) scalar();
}

function blurVertical(input, out, at, count, stride) {
  const N = GAUSS.radius, [n1, n3, n5] = G_N, [d1, d3, d5] = G_D;
  let a1 = 0, b1 = 0, a3 = 0, b3 = 0, a5 = 0, b5 = 0;
  for (let n = -N + 1; n < count; n++) {
    const top = n - N - 1, bottom = n + N - 1;
    const sum = f32((top >= 0 ? input[at + top * stride] : 0) + (bottom < count ? input[at + bottom * stride] : 0));
    const o1 = f32(n1 * sum + f32(-d1 * a1 - b1)), o3 = f32(n3 * sum + f32(-d3 * a3 - b3)), o5 = f32(n5 * sum + f32(-d5 * a5 - b5));
    b1 = a1; a1 = o1; b3 = a3; a3 = o3; b5 = a5; a5 = o5;
    if (n >= 0) out[at + n * stride] = f32(o1 + f32(o3 + o5));
  }
}

export function s2Blur(plane, width, height, out = new Float32Array(plane.length), temp = new Float32Array(plane.length)) {
  for (let y = 0; y < height; y++) blurHorizontal(plane, temp, y * width, width);
  for (let x = 0; x < width; x++) blurVertical(temp, out, x, height, width);
  return out;
}

const rootBits = new DataView(new ArrayBuffer(4));
function cubeRootBias(x) {
  const third = f32(1 / 3), fourThirds = f32(4 / 3), xa3 = f32(third * x);
  rootBits.setFloat32(0, x, true);
  const exponent = rootBits.getInt32(0, true);
  rootBits.setInt32(0, exponent === 0 ? 0 : 0x54800000 - (exponent >> 23) * 0x002aaaaa, true);
  let r = rootBits.getFloat32(0, true);
  for (let i = 0; i < 3; i++) { const r2 = f32(r * r); r = f32(-xa3 * f32(r2 * r2) + f32(fourThirds * r)); }
  let r2 = f32(r * r);
  r = f32(third * f32(-x * f32(r2 * r2) + r) + r); r2 = f32(r * r);
  return f32(r2 * x - BIAS_ROOT);
}

export function positiveXYB(linear, pixels) {
  const out = [new Float32Array(pixels), new Float32Array(pixels), new Float32Array(pixels)], [r, g, b] = linear, m = S2_OPSIN;
  for (let i = 0; i < pixels; i++) {
    const red = f32(r[i]), green = f32(g[i]), blue = f32(b[i]);
    const l = cubeRootBias(Math.max(0, f32(m[0] * red + f32(m[1] * green + f32(m[2] * blue + S2_BIAS)))));
    const mm = cubeRootBias(Math.max(0, f32(m[3] * red + f32(m[4] * green + f32(m[5] * blue + S2_BIAS)))));
    const s = cubeRootBias(Math.max(0, f32(m[6] * red + f32(m[7] * green + f32(m[8] * blue + S2_BIAS)))));
    const X = f32(0.5 * f32(l - mm)), Y = f32(0.5 * f32(l + mm));
    out[0][i] = X * 14 + f32(0.42); out[1][i] = Y + f32(0.01); out[2][i] = f32(s - Y) + f32(0.55);
  }
  return out;
}

export function downsample(planes, width, height) {
  const w = (width + 1) >> 1, h = (height + 1) >> 1, out = planes.map(() => new Float32Array(w * h));
  for (let c = 0; c < planes.length; c++) {
    const p = planes[c], o = out[c];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const x0 = 2 * x, y0 = 2 * y, x1 = Math.min(x0 + 1, width - 1), y1 = Math.min(y0 + 1, height - 1);
      o[y * w + x] = 0.25 * f32(f32(f32(p[y0 * width + x0] + p[y0 * width + x1]) + p[y1 * width + x0]) + p[y1 * width + x1]);
    }
  }
  return {planes: out, width: w, height: h};
}

export function linearFromRGBA(rgba, pixels) {
  const planes = [new Float64Array(pixels), new Float64Array(pixels), new Float64Array(pixels)];
  for (let i = 0; i < pixels; i++) for (let c = 0; c < 3; c++) planes[c][i] = SRGB_TO_LINEAR[rgba[i * 4 + c]];
  return planes;
}

/** Native metric transfer; with background, composite in encoded sRGB first. */
export function linearForSsimulacra2(rgba, pixels, background) {
  const planes = [new Float32Array(pixels), new Float32Array(pixels), new Float32Array(pixels)];
  const norm = f32(1 / 255), bg = f32(background);
  for (let i = 0; i < pixels; i++) {
    const alpha = f32(rgba[i * 4 + 3] * norm), other = f32(f32(1 - alpha) * bg);
    for (let c = 0; c < 3; c++) planes[c][i] = background === undefined ? S2_LINEAR[rgba[i * 4 + c]]
      : referenceLinear(f32(f32(alpha * f32(rgba[i * 4 + c] * norm)) + other));
  }
  return planes;
}

/** Model the reference tool's alpha handling for a linear reconstruction. */
export function compositeForSsimulacra2(linear, rgba, pixels, background) {
  const planes = [new Float32Array(pixels), new Float32Array(pixels), new Float32Array(pixels)];
  const norm = f32(1 / 255), bg = f32(background);
  for (let i = 0; i < pixels; i++) {
    const alpha = f32(rgba[i * 4 + 3] * norm), other = f32(f32(1 - alpha) * bg);
    for (let c = 0; c < 3; c++) planes[c][i] = referenceLinear(f32(f32(alpha * referenceEncoded(linear[c][i])) + other));
  }
  return planes;
}

export function ssimulacra2(reference, distorted, width, height, {wantMap = false} = {}) {
  let a = reference, b = distorted, w = width, h = height;
  const norms = [], map = wantMap ? new Float64Array(width * height) : null, scaleMaps = [];
  for (let scale = 0; scale < SCALES; scale++) {
    if (w < 8 || h < 8) break;
    if (scale) { const da = downsample(a, w, h), db = downsample(b, w, h); a = da.planes; b = db.planes; w = da.width; h = da.height; }
    const n = w * h, x1 = positiveXYB(a, n), x2 = positiveXYB(b, n), temp = new Float32Array(n), mul = new Float32Array(n);
    const per = {ssim: new Float64Array(6), edge: new Float64Array(12)}, local = wantMap ? [] : null;
    for (let c = 0; c < 3; c++) {
      const p1 = x1[c], p2 = x2[c];
      const mu1 = s2Blur(p1, w, h, undefined, temp), mu2 = s2Blur(p2, w, h, undefined, temp);
      for (let i = 0; i < n; i++) mul[i] = p1[i] * p1[i];
      const s11 = s2Blur(mul, w, h, undefined, temp);
      for (let i = 0; i < n; i++) mul[i] = p2[i] * p2[i];
      const s22 = s2Blur(mul, w, h, undefined, temp);
      for (let i = 0; i < n; i++) mul[i] = p1[i] * p2[i];
      const s12 = s2Blur(mul, w, h, undefined, temp);
      const d = wantMap ? new Float64Array(n) : null, art = wantMap ? new Float64Array(n) : null, lost = wantMap ? new Float64Array(n) : null;
      let ss1 = 0, ss4 = 0, a1 = 0, a4 = 0, l1 = 0, l4 = 0;
      for (let i = 0; i < n; i++) {
        const m1 = mu1[i], m2 = mu2[i], numM = f32(1 - f32(m1 - m2) * f32(m1 - m2));
        const numS = f32(2 * f32(s12[i] - f32(m1 * m2)) + C2), denS = f32(f32(f32(s11[i] - f32(m1 * m1)) + f32(s22[i] - f32(m2 * m2))) + C2);
        const e = Math.max(0, 1 - f32(f32(numM * numS) / denS));
        ss1 += e; ss4 += e * e * e * e;
        const d1 = (1 + Math.abs(f32(p2[i] - m2))) / (1 + Math.abs(f32(p1[i] - m1))) - 1, artifact = Math.max(d1, 0), detail = Math.max(-d1, 0);
        a1 += artifact; a4 += artifact * artifact * artifact * artifact; l1 += detail; l4 += detail * detail * detail * detail;
        if (wantMap) { d[i] = e; art[i] = artifact; lost[i] = detail; }
      }
      per.ssim[c * 2] = ss1 / n; per.ssim[c * 2 + 1] = Math.sqrt(Math.sqrt(ss4 / n));
      per.edge[c * 4] = a1 / n; per.edge[c * 4 + 1] = Math.sqrt(Math.sqrt(a4 / n));
      per.edge[c * 4 + 2] = l1 / n; per.edge[c * 4 + 3] = Math.sqrt(Math.sqrt(l4 / n));
      if (wantMap) local.push({d, art, lost});
    }
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
  return {score, sum, norms, map};
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
