// SPDX-License-Identifier: MIT
// patterns are libjxl's (BSD-3-Clause, Copyright (c) the JPEG XL Project Authors); the structure is ours.

import {exactExp, exactLog, exactPow} from './exact-math.mjs';
const BA_INTENSITY = 80;
const MF_MALTA = [37.0819870399, 130262059.556], MF_MALTA_X = [8246.75321353, 1009002.70582];
const HF_MALTA = [18.7237414387, 4498534.45232], HF_MALTA_X = [6923.99476109, 8051.15833247];
const UHF_MALTA = [1.10039032555, 71.7800275169], UHF_MALTA_X = [173.5, 5.0];
const BA_WMUL = [400.0, 1.50815703118, 0, 2150.0, 10.6195433239, 16.2176043152, 29.2353797994, 0.844626970982, 0.703646627719];
const BA_GLOBAL_SCALE = 1 / (17.83 * 0.79079917404);

const MALTA_LF = [[-4,0,-2,0,0,0,2,0,4,0],[0,-4,0,-2,0,0,0,2,0,4],[-3,-3,-2,-2,0,0,2,2,3,3],[3,-3,2,-2,0,0,-2,2,-3,3],
  [1,-4,1,-2,0,0,-1,2,-1,4],[-1,-4,-1,-2,0,0,1,2,1,4],[-4,-1,-2,-1,0,0,2,1,4,1],[-4,1,-2,1,0,0,2,-1,4,-1],[-2,-3,-1,-2,0,0,1,2,2,3],
  [2,-3,1,-2,0,0,-1,2,-2,3],[-3,-2,-2,-1,0,0,2,1,3,2],[3,-2,2,-1,0,0,-2,1,-3,2],[-4,2,-2,1,0,0,2,-1,4,-2],[-4,-2,-2,-1,0,0,2,1,4,2],
  [-2,-4,-1,-2,0,0,1,2,2,4],[2,-4,1,-2,0,0,-1,2,-2,4]];
const MALTA_HF = [[-4,0,-3,0,-2,0,-1,0,0,0,1,0,2,0,3,0,4,0],[0,-4,0,-3,0,-2,0,-1,0,0,0,1,0,2,0,3,0,4],
  [-3,-3,-2,-2,-1,-1,0,0,1,1,2,2,3,3],[3,-3,2,-2,1,-1,0,0,-1,1,-2,2,-3,3],[1,-4,1,-3,1,-2,0,-1,0,0,0,1,-1,2,-1,3,-1,4],
  [-1,-4,-1,-3,-1,-2,0,-1,0,0,0,1,1,2,1,3,1,4],[-4,-1,-3,-1,-2,-1,-1,0,0,0,1,0,2,1,3,1,4,1],[-4,1,-3,1,-2,1,-1,0,0,0,1,0,2,-1,3,-1,4,-1],
  [-2,-3,-1,-2,-1,-1,0,0,1,1,1,2,2,3],[2,-3,1,-2,1,-1,0,0,-1,1,-1,2,-2,3],[-3,-2,-2,-1,-1,-1,0,0,1,1,2,1,3,2],[3,-2,2,-1,1,-1,0,0,-1,1,-2,1,-3,2],
  [-4,1,-3,1,-2,1,-1,0,0,0,1,0,2,-1,3,-1,4,-1],[-4,-1,-3,-1,-2,-1,-1,0,0,0,1,0,2,1,3,1,4,1],[-1,-4,-1,-3,-1,-2,0,-1,0,0,0,1,1,2,1,3,1,4],
  [1,-4,1,-3,1,-2,0,-1,0,0,0,1,-1,2,-1,3,-1,4]];
export {MALTA_LF, MALTA_HF};

export function blurKernel(sigma) {
  const reach = Math.max(1, Math.trunc(Math.fround(2.25 * Math.abs(sigma)))), out = new Float64Array(2 * reach + 1);
  for (let i = -reach; i <= reach; i++) out[i + reach] = exactExp(-1 / (2 * sigma * sigma) * i * i);
  return out;
}
const baMirror = (x, n) => { while (x < 0 || x >= n) x = x < 0 ? -x - 1 : 2 * n - 1 - x; return x; };

export function blur(plane, width, height, sigma) {
  const kernel = blurKernel(sigma), reach = (kernel.length - 1) / 2, total = kernel.reduce((a, b) => a + b), K = kernel.length;
  const temp = new Float64Array(plane.length), out = new Float64Array(plane.length), five = K === 5;
  const edge = (src, base, step, count, i) => {
    let sum = 0, weight = 0;
    for (let k = -reach; k <= reach; k++) {
      let j = i + k;
      if (five) j = baMirror(j, count);
      else if (j < 0 || j >= count) continue;
      sum += src[base + j * step] * kernel[k + reach]; weight += kernel[k + reach];
    }
    return five ? sum / total : sum / weight;
  };
  let inner = 0;
  for (let k = 0; k < K; k++) inner += kernel[k];
  for (let y = 0; y < height; y++) {
    const base = y * width;
    for (let x = 0; x < width; x++) {
      if (x < reach || x >= width - reach) { temp[base + x] = edge(plane, base, 1, width, x); continue; }
      let sum = 0;
      for (let k = 0, at = base + x - reach; k < K; k++, at++) sum += plane[at] * kernel[k];
      temp[base + x] = five ? sum / total : sum / inner;
    }
  }
  const acc = new Float64Array(width);
  for (let y = 0; y < height; y++) {
    if (y < reach || y >= height - reach) { for (let x = 0; x < width; x++) out[y * width + x] = edge(temp, x, width, height, y); continue; }
    acc.fill(0);
    for (let k = 0; k < K; k++) {
      const w = kernel[k], row = (y - reach + k) * width;
      for (let x = 0; x < width; x++) acc[x] += temp[row + x] * w;
    }
    const d = five ? total : inner, base = y * width;
    for (let x = 0; x < width; x++) out[base + x] = acc[x] / d;
  }
  return out;
}

const BA_OPSIN = [0.29956550340058319, 0.63373087833825936, 0.077705617820981968, 1.7557483643287353,
  0.22158691104574774, 0.69391388044116142, 0.0987313588422, 1.7557483643287353,
  0.02, 0.02, 0.20480129041026129, 12.226454707163354];
const baGamma = v => 19.245013259874995 * exactLog(Math.max(0, v) + 9.9710635769299145) - 23.16046239805755;

export function opsinDynamics(rgb, width, height) {
  const n = width * height, blurred = rgb.map(p => blur(p, width, height, 1.2)), out = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  const m = BA_OPSIN, g = v => Math.max(baGamma(v) / v, 1e-4);
  for (let i = 0; i < n; i++) {
    const br = blurred[0][i] * BA_INTENSITY, bg = blurred[1][i] * BA_INTENSITY, bb = blurred[2][i] * BA_INTENSITY;
    const r = rgb[0][i] * BA_INTENSITY, gr = rgb[1][i] * BA_INTENSITY, b = rgb[2][i] * BA_INTENSITY;
    const s0 = g(Math.max(Math.max(m[0] * br + m[1] * bg + m[2] * bb + m[3], m[3]), 1e-4));
    const s1 = g(Math.max(Math.max(m[4] * br + m[5] * bg + m[6] * bb + m[7], m[7]), 1e-4));
    const s2 = g(Math.max(Math.max(m[8] * br + m[9] * bg + m[10] * bb + m[11], m[11]), 1e-4));
    const c0 = Math.max((m[0] * r + m[1] * gr + m[2] * b + m[3]) * s0, 1.7557483643287353);
    const c1 = Math.max((m[4] * r + m[5] * gr + m[6] * b + m[7]) * s1, 1.7557483643287353);
    const c2 = Math.max((m[8] * r + m[9] * gr + m[10] * b + m[11]) * s2, 12.226454707163354);
    out[0][i] = c0 - c1; out[1][i] = c0 + c1; out[2][i] = c2;
  }
  return out;
}

const removeRange = (w, x) => x > w ? x - w : x < -w ? x + w : 0;
const amplifyRange = (w, x) => x > w ? x + w : x < -w ? x - w : x + x;
const maximumClamp = (v, max) => v >= max ? (v - max) * 0.724216145665 + max : v < -max ? (v + max) * 0.724216145665 - max : v;

export function separateFrequencies(xyb, width, height) {
  const n = width * height, lf = [], mf = [];
  for (let c = 0; c < 3; c++) {
    const l = blur(xyb[c], width, height, 7.15593339443), m = new Float64Array(n);
    for (let i = 0; i < n; i++) m[i] = xyb[c][i] - l[i];
    lf.push(l); mf.push(m);
  }
  for (let i = 0; i < n; i++) {
    const x = lf[0][i], y = lf[1][i], b = lf[2][i] + -0.362267051518 * y;
    lf[0][i] = x * 33.832837186260; lf[1][i] = y * 14.458268100570; lf[2][i] = b * 49.87984651440;
  }
  const hf = [];
  for (let c = 0; c < 3; c++) {
    const blurred = blur(mf[c], width, height, 3.22489901262);
    if (c === 2) { mf[2] = blurred; break; }
    const h = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      h[i] = mf[c][i] - blurred[i];
      blurred[i] = c === 0 ? removeRange(0.29, blurred[i]) : amplifyRange(0.1, blurred[i]);
    }
    mf[c] = blurred; hf.push(h);
  }
  for (let i = 0; i < n; i++) { const vy = hf[1][i]; hf[0][i] *= 46 / (vy * vy + 46) * (1 - 0.653020556257) + 0.653020556257; }
  const uhf = [];
  for (let c = 0; c < 2; c++) {
    const u = Float64Array.from(hf[c]), h = blur(hf[c], width, height, 1.56416327805);
    for (let i = 0; i < n; i++) {
      if (c === 0) { const hv = h[i]; u[i] = removeRange(0.04, u[i] - hv); h[i] = removeRange(1.5, hv); }
      else {
        const hv = maximumClamp(h[i], 28.4691806922);
        u[i] = maximumClamp(u[i] - hv, 5.19175294647) * 2.69313763794;
        h[i] = amplifyRange(0.132, hv * 2.155);
      }
    }
    hf[c] = h; uhf.push(u);
  }
  return {lf, mf, hf, uhf};
}

function maltaDiff(a, b, width, height, w0gt1, w0lt1, norm1, lines, mulli, into) {
  const n = width * height, diffs = new Float64Array(n), len = 3.75;
  const n2gt = Math.fround(mulli * Math.sqrt(0.5 * w0gt1) / (len * 2 + 1) * norm1), n2lt = Math.fround(mulli * Math.sqrt(0.33 * w0lt1) / (len * 2 + 1) * norm1);
  for (let i = 0; i < n; i++) {
    const r0 = a[i], r1 = b[i], absval = 0.5 * (Math.abs(r0) + Math.abs(r1));
    let d = n2gt / (norm1 + absval) * (r0 - r1);
    const s2 = n2lt / (norm1 + absval), f0 = Math.abs(r0), small = 0.55 * f0, big = 1.05 * f0;
    if (r0 < 0) { if (r1 > -small) d -= s2 * (r1 + small); else if (r1 < -big) d += s2 * (-r1 - big); }
    else if (r1 < small) d += s2 * (small - r1); else if (r1 > big) d -= s2 * (r1 - big);
    diffs[i] = d;
  }
  const offsets = lines.map(line => Int32Array.from({length: line.length / 2}, (_, k) => line[2 * k + 1] * width + line[2 * k]));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = y * width + x;
    let total = 0;
    if (x >= 4 && y >= 4 && x < width - 4 && y < height - 4) {
      for (let l = 0; l < offsets.length; l++) {
        const o = offsets[l];
        let sum = 0;
        for (let k = 0; k < o.length; k++) sum += diffs[at + o[k]];
        total += sum * sum;
      }
    } else for (const line of lines) {
      let sum = 0;
      for (let k = 0; k < line.length; k += 2) {
        const xx = x + line[k], yy = y + line[k + 1];
        if (xx >= 0 && yy >= 0 && xx < width && yy < height) sum += diffs[yy * width + xx];
      }
      total += sum * sum;
    }
    into[at] += total;
  }
}

function l2(a, b, w, into) { if (w) for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; into[i] += d * d * w; } }
function l2Asymmetric(a, b, w0gt1, w0lt1, into) {
  const gt = w0gt1 * 0.8, lt = w0lt1 * 0.8;
  for (let i = 0; i < a.length; i++) {
    const v0 = a[i], v1 = b[i], d = v0 - v1, f0 = Math.abs(v0), small = 0.4 * f0, big = f0;
    const v = v0 < 0 ? (v1 > -small ? v1 + small : v1 < -big ? -v1 - big : 0) : (v1 < small ? small - v1 : v1 > big ? v1 - big : 0);
    into[i] += d * d * gt + lt * v * v;
  }
}

function maskingInput(band, n) {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const x = (band.uhf[0][i] + band.hf[0][i]) * 2.5, y = band.uhf[1][i] * 0.4 + band.hf[1][i] * 0.4;
    out[i] = Math.sqrt(x * x + y * y);
  }
  return out;
}

function diffPrecompute(plane) {
  const mul = 6.19424080439, bias = mul * 12.61050594197, root = Math.sqrt(bias);
  return plane.map(v => Math.sqrt(mul * Math.abs(v) + bias) - root);
}

function fuzzyErosion(from, width, height) {
  const out = new Float64Array(from.length), S = 3;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let m0 = from[y * width + x], m1 = 2 * m0, m2 = m1;
    const take = v => {
      if (v < m2) { if (v < m0) { m2 = m1; m1 = m0; m0 = v; } else if (v < m1) { m2 = m1; m1 = v; } else m2 = v; }
    };
    if (x >= S) { take(from[y * width + x - S]); if (y >= S) take(from[(y - S) * width + x - S]); if (y < height - S) take(from[(y + S) * width + x - S]); }
    if (x < width - S) { take(from[y * width + x + S]); if (y >= S) take(from[(y - S) * width + x + S]); if (y < height - S) take(from[(y + S) * width + x + S]); }
    if (y >= S) take(from[(y - S) * width + x]);
    if (y < height - S) take(from[(y + S) * width + x]);
    out[y * width + x] = 0.45 * m0 + 0.3 * m1 + 0.25 * m2;
  }
  return out;
}

const maskY = d => { const c = 2.5485944793 / (0.451936922203 * d + 0.829591754942), r = BA_GLOBAL_SCALE * (1 + c); return r * r; };
const maskDcY = d => { const c = 0.505054525019 / (3.87449418804 * d + 0.20025578522), r = BA_GLOBAL_SCALE * (1 + c); return r * r; };

function diffmapBands(p0, p1, width, height) {
  const n = width * height, ac = [new Float64Array(n), new Float64Array(n), new Float64Array(n)], dc = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  maltaDiff(p0.uhf[1], p1.uhf[1], width, height, UHF_MALTA[0], UHF_MALTA[0], UHF_MALTA[1], MALTA_HF, 0.39905817637, ac[1]);
  maltaDiff(p0.uhf[0], p1.uhf[0], width, height, UHF_MALTA_X[0], UHF_MALTA_X[0], UHF_MALTA_X[1], MALTA_HF, 0.39905817637, ac[0]);
  maltaDiff(p0.hf[1], p1.hf[1], width, height, HF_MALTA[0], HF_MALTA[0], HF_MALTA[1], MALTA_LF, 0.611612573796, ac[1]);
  maltaDiff(p0.hf[0], p1.hf[0], width, height, HF_MALTA_X[0], HF_MALTA_X[0], HF_MALTA_X[1], MALTA_LF, 0.611612573796, ac[0]);
  maltaDiff(p0.mf[1], p1.mf[1], width, height, MF_MALTA[0], MF_MALTA[0], MF_MALTA[1], MALTA_LF, 0.611612573796, ac[1]);
  maltaDiff(p0.mf[0], p1.mf[0], width, height, MF_MALTA_X[0], MF_MALTA_X[0], MF_MALTA_X[1], MALTA_LF, 0.611612573796, ac[0]);
  for (let c = 0; c < 3; c++) {
    if (c < 2) l2Asymmetric(p0.hf[c], p1.hf[c], BA_WMUL[c], BA_WMUL[c], ac[c]);
    l2(p0.mf[c], p1.mf[c], BA_WMUL[3 + c], ac[c]);
    l2(p0.lf[c], p1.lf[c], BA_WMUL[6 + c], dc[c]);
  }
  const b0 = blur(diffPrecompute(maskingInput(p0, n)), width, height, 2.7), b1 = blur(diffPrecompute(maskingInput(p1, n)), width, height, 2.7);
  const mask = fuzzyErosion(b0, width, height);
  for (let i = 0; i < n; i++) { const d = b0[i] - b1[i]; ac[1][i] += 10 * d * d; }
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sqrt((dc[0][i] + dc[1][i] + dc[2][i]) * maskDcY(mask[i]) + (ac[0][i] + ac[1][i] + ac[2][i]) * maskY(mask[i]));
  return out;
}

export function subsample2x(planes, width, height) {
  const w = (width + 1) >> 1, h = (height + 1) >> 1;
  const out = planes.map(p => {
    const o = new Float64Array(w * h);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) o[(y >> 1) * w + (x >> 1)] += 0.25 * p[y * width + x];
    if (width & 1) for (let y = 0; y < h; y++) o[y * w + w - 1] *= 2;
    if (height & 1) for (let x = 0; x < w; x++) o[(h - 1) * w + x] *= 2;
    return o;
  });
  return {planes: out, width: w, height: h};
}

export function butteraugliReference(rgb, width, height) {
  const levels = [{width, height, bands: separateFrequencies(opsinDynamics(rgb, width, height), width, height)}];
  const sub = subsample2x(rgb, width, height);
  if (sub.width >= 8 && sub.height >= 8)
    levels.push({width: sub.width, height: sub.height, bands: separateFrequencies(opsinDynamics(sub.planes, sub.width, sub.height), sub.width, sub.height)});
  return {width, height, levels};
}

export function butteraugli(reference, rgb) {
  const {width, height, levels} = reference;
  if (width < 8 || height < 8) throw new Error('Butteraugli here covers pictures of at least 8 x 8 pixels');
  const map = diffmapBands(levels[0].bands, separateFrequencies(opsinDynamics(rgb, width, height), width, height), width, height);
  if (levels[1]) {
    const sub = subsample2x(rgb, width, height), lv = levels[1];
    const subMap = diffmapBands(lv.bands, separateFrequencies(opsinDynamics(sub.planes, lv.width, lv.height), lv.width, lv.height), lv.width, lv.height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = y * width + x;
      map[i] = map[i] * (1 - 0.3 * 0.5) + 0.5 * subMap[(y >> 1) * lv.width + (x >> 1)];
    }
  }
  let max = 0;
  for (const v of map) max = Math.max(max, v);
  return {score: max, pnorm3: pnorm(map, 3), map};
}

export function pnorm(map, p) {
  const sums = [0, 0, 0];
  for (const v of map) { let d = exactPow(v, p); sums[0] += d; d *= d; sums[1] += d; d *= d; sums[2] += d; }
  return sums.reduce((a, s, i) => a + exactPow(s / map.length, 1 / (p * (1 << i))), 0) / 3;
}
