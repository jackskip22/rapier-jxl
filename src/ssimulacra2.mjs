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

export function downsample(planes, width, height) {
  const w = (width + 1) >> 1, h = (height + 1) >> 1, out = planes.map(() => new Float64Array(w * h));
  for (let c = 0; c < planes.length; c++) {
    const p = planes[c], o = out[c];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const x0 = 2 * x, y0 = 2 * y, x1 = Math.min(x0 + 1, width - 1), y1 = Math.min(y0 + 1, height - 1);
      o[y * w + x] = 0.25 * (p[y0 * width + x0] + p[y0 * width + x1] + p[y1 * width + x0] + p[y1 * width + x1]);
    }
  }
  return {planes: out, width: w, height: h};
}

export function linearFromRGBA(rgba, pixels) {
  const planes = [new Float64Array(pixels), new Float64Array(pixels), new Float64Array(pixels)];
  for (let i = 0; i < pixels; i++) for (let c = 0; c < 3; c++) planes[c][i] = SRGB_TO_LINEAR[rgba[i * 4 + c]];
  return planes;
}

export function ssimulacra2(reference, distorted, width, height, {wantMap = false} = {}) {
  let a = reference, b = distorted, w = width, h = height;
  const norms = [], map = wantMap ? new Float64Array(width * height) : null, scaleMaps = [];
  for (let scale = 0; scale < SCALES; scale++) {
    if (w < 8 || h < 8) break;
    if (scale) { const da = downsample(a, w, h), db = downsample(b, w, h); a = da.planes; b = db.planes; w = da.width; h = da.height; }
    const n = w * h, x1 = positiveXYB(a, n), x2 = positiveXYB(b, n), temp = new Float64Array(n), mul = new Float64Array(n);
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
        const m1 = mu1[i], m2 = mu2[i], numM = 1 - (m1 - m2) * (m1 - m2);
        const numS = 2 * (s12[i] - m1 * m2) + C2, denS = (s11[i] - m1 * m1) + (s22[i] - m2 * m2) + C2;
        const e = Math.max(0, 1 - numM * numS / denS);
        ss1 += e; ss4 += e * e * e * e;
        const d1 = (1 + Math.abs(p2[i] - m2)) / (1 + Math.abs(p1[i] - m1)) - 1, artifact = Math.max(d1, 0), detail = Math.max(-d1, 0);
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
