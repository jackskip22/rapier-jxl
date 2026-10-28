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
function planePool() {
  const free = [];
  return {
    take(n, zeroed = false) {
      for (let i = free.length - 1; i >= 0; i--) if (free[i].length === n) { const plane = free.splice(i, 1)[0]; return zeroed ? plane.fill(0) : plane; }
      return new Float64Array(n);
    },
    give(...planes) { free.push(...planes); },
  };
}
const NO_POOL = Object.freeze({take: n => new Float64Array(n), give() {}});
const baMirror = (x, n) => { while (x < 0 || x >= n) x = x < 0 ? -x - 1 : 2 * n - 1 - x; return x; };

export function blur(plane, width, height, sigma, pool = NO_POOL) {
  const kernel = blurKernel(sigma), reach = (kernel.length - 1) / 2, total = kernel.reduce((a, b) => a + b), K = kernel.length;
  const temp = pool.take(plane.length), out = pool.take(plane.length), five = K === 5;
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
  const d = five ? total : inner, end = width - reach;
  for (let y = 0; y < height; y++) {
    const base = y * width;
    let x = 0;
    for (; x < width && x < reach; x++) temp[base + x] = edge(plane, base, 1, width, x);
    for (; x + 3 < end; x += 4) {
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
      for (let k = 0, at = base + x - reach; k < K; k++, at++) {
        const w = kernel[k];
        s0 += plane[at] * w; s1 += plane[at + 1] * w; s2 += plane[at + 2] * w; s3 += plane[at + 3] * w;
      }
      temp[base + x] = s0 / d; temp[base + x + 1] = s1 / d; temp[base + x + 2] = s2 / d; temp[base + x + 3] = s3 / d;
    }
    for (; x < end; x++) {
      let sum = 0;
      for (let k = 0, at = base + x - reach; k < K; k++, at++) sum += plane[at] * kernel[k];
      temp[base + x] = sum / d;
    }
    for (; x < width; x++) temp[base + x] = edge(plane, base, 1, width, x);
  }
  const acc = new Float64Array(width);
  for (let y = 0; y < height; y++) {
    if (y < reach || y >= height - reach) { for (let x = 0; x < width; x++) out[y * width + x] = edge(temp, x, width, height, y); continue; }
    acc.fill(0);
    for (let k = 0; k < K; k++) {
      const w = kernel[k], row = (y - reach + k) * width;
      for (let x = 0; x < width; x++) acc[x] += temp[row + x] * w;
    }
    const base = y * width;
    for (let x = 0; x < width; x++) out[base + x] = acc[x] / d;
  }
  pool.give(temp);
  return out;
}

const BA_OPSIN = [0.29956550340058319, 0.63373087833825936, 0.077705617820981968, 1.7557483643287353,
  0.22158691104574774, 0.69391388044116142, 0.0987313588422, 1.7557483643287353,
  0.02, 0.02, 0.20480129041026129, 12.226454707163354];
const baGamma = v => 19.245013259874995 * exactLog(Math.max(0, v) + 9.9710635769299145) - 23.16046239805755;

export function opsinDynamics(rgb, width, height, pool = NO_POOL) {
  const n = width * height, blurred = rgb.map(p => blur(p, width, height, 1.2, pool)), out = [pool.take(n), pool.take(n), pool.take(n)];
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
  pool.give(...blurred);
  return out;
}

const removeRange = (w, x) => x > w ? x - w : x < -w ? x + w : 0;
const amplifyRange = (w, x) => x > w ? x + w : x < -w ? x - w : x + x;
const maximumClamp = (v, max) => v >= max ? (v - max) * 0.724216145665 + max : v < -max ? (v + max) * 0.724216145665 - max : v;

export function separateFrequencies(xyb, width, height, pool = NO_POOL) {
  const n = width * height, lf = [], mf = [];
  for (let c = 0; c < 3; c++) {
    const l = blur(xyb[c], width, height, 7.15593339443, pool), m = pool.take(n);
    for (let i = 0; i < n; i++) m[i] = xyb[c][i] - l[i];
    lf.push(l); mf.push(m);
  }
  for (let i = 0; i < n; i++) {
    const x = lf[0][i], y = lf[1][i], b = lf[2][i] + -0.362267051518 * y;
    lf[0][i] = x * 33.832837186260; lf[1][i] = y * 14.458268100570; lf[2][i] = b * 49.87984651440;
  }
  const hf = [];
  for (let c = 0; c < 3; c++) {
    const blurred = blur(mf[c], width, height, 3.22489901262, pool);
    if (c === 2) { pool.give(mf[2]); mf[2] = blurred; break; }
    const h = pool.take(n);
    for (let i = 0; i < n; i++) {
      h[i] = mf[c][i] - blurred[i];
      blurred[i] = c === 0 ? removeRange(0.29, blurred[i]) : amplifyRange(0.1, blurred[i]);
    }
    pool.give(mf[c]); mf[c] = blurred; hf.push(h);
  }
  for (let i = 0; i < n; i++) { const vy = hf[1][i]; hf[0][i] *= 46 / (vy * vy + 46) * (1 - 0.653020556257) + 0.653020556257; }
  const uhf = [];
  for (let c = 0; c < 2; c++) {
    const u = pool.take(n), h = blur(hf[c], width, height, 1.56416327805, pool);
    u.set(hf[c]);
    for (let i = 0; i < n; i++) {
      if (c === 0) { const hv = h[i]; u[i] = removeRange(0.04, u[i] - hv); h[i] = removeRange(1.5, hv); }
      else {
        const hv = maximumClamp(h[i], 28.4691806922);
        u[i] = maximumClamp(u[i] - hv, 5.19175294647) * 2.69313763794;
        h[i] = amplifyRange(0.132, hv * 2.155);
      }
    }
    pool.give(hf[c]); hf[c] = h; uhf.push(u);
  }
  return {lf, mf, hf, uhf};
}

function maltaDiff(a, b, width, height, w0gt1, w0lt1, norm1, lines, mulli, into, pool) {
  const n = width * height, diffs = pool.take(n), len = 3.75;
  const n2gt = Math.fround(mulli * Math.sqrt(0.5 * w0gt1) / (len * 2 + 1) * norm1), n2lt = Math.fround(mulli * Math.sqrt(0.33 * w0lt1) / (len * 2 + 1) * norm1);
  for (let i = 0; i < n; i++) {
    const r0 = a[i], r1 = b[i], absval = 0.5 * (Math.abs(r0) + Math.abs(r1));
    let d = n2gt / (norm1 + absval) * (r0 - r1);
    const s2 = n2lt / (norm1 + absval), f0 = Math.abs(r0), small = 0.55 * f0, big = 1.05 * f0;
    if (r0 < 0) { if (r1 > -small) d -= s2 * (r1 + small); else if (r1 < -big) d += s2 * (-r1 - big); }
    else if (r1 < small) d += s2 * (small - r1); else if (r1 > big) d -= s2 * (r1 - big);
    diffs[i] = d;
  }
  maltaLines(diffs, width, height, lines === MALTA_HF ? MALTA_HF_SUMMED : lines, into, pool);
  pool.give(diffs);
}

function lineFive(diffs, width, height, [o0, o1, o2, o3, o4], totals) {
  for (let y = 4; y < height - 4; y++) for (let x = 4, at = y * width + 4; x < width - 4; x++, at++) {
    let sum = 0;
    sum += diffs[at + o0]; sum += diffs[at + o1]; sum += diffs[at + o2]; sum += diffs[at + o3]; sum += diffs[at + o4];
    totals[at] += sum * sum;
  }
}
function lineSeven(diffs, width, height, [o0, o1, o2, o3, o4, o5, o6], totals) {
  for (let y = 4; y < height - 4; y++) for (let x = 4, at = y * width + 4; x < width - 4; x++, at++) {
    let sum = 0;
    sum += diffs[at + o0]; sum += diffs[at + o1]; sum += diffs[at + o2]; sum += diffs[at + o3]; sum += diffs[at + o4];
    sum += diffs[at + o5]; sum += diffs[at + o6];
    totals[at] += sum * sum;
  }
}
function lineNine(diffs, width, height, [o0, o1, o2, o3, o4, o5, o6, o7, o8], totals) {
  for (let y = 4; y < height - 4; y++) for (let x = 4, at = y * width + 4; x < width - 4; x++, at++) {
    let sum = 0;
    sum += diffs[at + o0]; sum += diffs[at + o1]; sum += diffs[at + o2]; sum += diffs[at + o3]; sum += diffs[at + o4];
    sum += diffs[at + o5]; sum += diffs[at + o6]; sum += diffs[at + o7]; sum += diffs[at + o8];
    totals[at] += sum * sum;
  }
}
const LINE = {5: lineFive, 7: lineSeven, 9: lineNine};
const lineOffsets = (line, width) => Int32Array.from({length: line.length / 2}, (_, k) => line[2 * k + 1] * width + line[2 * k]);
function edgeSum(diffs, width, height, line, x, y) {
  let sum = 0;
  for (let k = 0; k < line.length; k += 2) {
    const xx = x + line[k], yy = y + line[k + 1];
    if (xx >= 0 && yy >= 0 && xx < width && yy < height) sum += diffs[yy * width + xx];
  }
  return sum;
}
const isEdge = (x, y, width, height) => x < 4 || y < 4 || x >= width - 4 || y >= height - 4;

const MALTA_HF_SUMMED = [...MALTA_HF.slice(0, 12), MALTA_HF[7], MALTA_HF[6], MALTA_HF[5], MALTA_HF[4]];
function maltaLines(diffs, width, height, lines, into, pool) {
  const totals = pool.take(width * height, true);
  for (const line of lines) LINE[line.length / 2](diffs, width, height, lineOffsets(line, width), totals);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (!isEdge(x, y, width, height)) continue;
    let total = 0;
    for (const line of lines) { const sum = edgeSum(diffs, width, height, line, x, y); total += sum * sum; }
    totals[y * width + x] = total;
  }
  for (let i = 0; i < totals.length; i++) into[i] += totals[i];
  pool.give(totals);
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

function maskingInput(band, n, pool) {
  const out = pool.take(n);
  for (let i = 0; i < n; i++) {
    const x = (band.uhf[0][i] + band.hf[0][i]) * 2.5, y = band.uhf[1][i] * 0.4 + band.hf[1][i] * 0.4;
    out[i] = Math.sqrt(x * x + y * y);
  }
  return out;
}

function diffPrecompute(plane) {
  const mul = 6.19424080439, bias = mul * 12.61050594197, root = Math.sqrt(bias);
  for (let i = 0; i < plane.length; i++) plane[i] = Math.sqrt(mul * Math.abs(plane[i]) + bias) - root;
  return plane;
}
function maskBlur(bands, width, height, pool) {
  const input = diffPrecompute(maskingInput(bands, width * height, pool)), blurred = blur(input, width, height, 2.7, pool);
  pool.give(input);
  return blurred;
}

function fuzzyErosion(from, width, height, pool = NO_POOL) {
  const out = pool.take(from.length), S = 3;
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
const maskingCache = new WeakMap();

function referenceMasking(bands, width, height) {
  const blurred = maskBlur(bands, width, height, NO_POOL);
  const ac = fuzzyErosion(blurred, width, height), dc = ac.map(maskDcY);
  for (let i = 0; i < ac.length; i++) ac[i] = maskY(ac[i]);
  return {blurred, ac, dc};
}

function diffmapBands(p0, p1, width, height, cached, pool) {
  const n = width * height, ac = [0, 1, 2].map(() => pool.take(n, true)), dc = [0, 1, 2].map(() => pool.take(n, true));
  maltaDiff(p0.uhf[1], p1.uhf[1], width, height, UHF_MALTA[0], UHF_MALTA[0], UHF_MALTA[1], MALTA_HF, 0.39905817637, ac[1], pool);
  maltaDiff(p0.uhf[0], p1.uhf[0], width, height, UHF_MALTA_X[0], UHF_MALTA_X[0], UHF_MALTA_X[1], MALTA_HF, 0.39905817637, ac[0], pool);
  maltaDiff(p0.hf[1], p1.hf[1], width, height, HF_MALTA[0], HF_MALTA[0], HF_MALTA[1], MALTA_LF, 0.611612573796, ac[1], pool);
  maltaDiff(p0.hf[0], p1.hf[0], width, height, HF_MALTA_X[0], HF_MALTA_X[0], HF_MALTA_X[1], MALTA_LF, 0.611612573796, ac[0], pool);
  maltaDiff(p0.mf[1], p1.mf[1], width, height, MF_MALTA[0], MF_MALTA[0], MF_MALTA[1], MALTA_LF, 0.611612573796, ac[1], pool);
  maltaDiff(p0.mf[0], p1.mf[0], width, height, MF_MALTA_X[0], MF_MALTA_X[0], MF_MALTA_X[1], MALTA_LF, 0.611612573796, ac[0], pool);
  for (let c = 0; c < 3; c++) {
    if (c < 2) l2Asymmetric(p0.hf[c], p1.hf[c], BA_WMUL[c], BA_WMUL[c], ac[c]);
    l2(p0.mf[c], p1.mf[c], BA_WMUL[3 + c], ac[c]);
    l2(p0.lf[c], p1.lf[c], BA_WMUL[6 + c], dc[c]);
  }
  const b0 = cached ? cached.blurred : maskBlur(p0, width, height, pool), b1 = maskBlur(p1, width, height, pool);
  for (let i = 0; i < n; i++) { const d = b0[i] - b1[i]; ac[1][i] += 10 * d * d; }
  pool.give(b1);
  const out = pool.take(n);
  if (cached) {
    for (let i = 0; i < n; i++) out[i] = Math.sqrt((dc[0][i] + dc[1][i] + dc[2][i]) * cached.dc[i] + (ac[0][i] + ac[1][i] + ac[2][i]) * cached.ac[i]);
  } else {
    const mask = fuzzyErosion(b0, width, height, pool);
    for (let i = 0; i < n; i++) out[i] = Math.sqrt((dc[0][i] + dc[1][i] + dc[2][i]) * maskDcY(mask[i]) + (ac[0][i] + ac[1][i] + ac[2][i]) * maskY(mask[i]));
    pool.give(b0, mask);
  }
  pool.give(...ac, ...dc);
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

export function butteraugliReference(rgb, width, height, {cacheBytes = 0} = {}) {
  if (!Number.isSafeInteger(cacheBytes) || cacheBytes < 0) throw new RangeError('Butteraugli cacheBytes must be a nonnegative safe integer.');
  const pool = planePool(), bandsOf = (planes, w, h) => {
    const xyb = opsinDynamics(planes, w, h, pool), bands = separateFrequencies(xyb, w, h, pool);
    pool.give(...xyb);
    return bands;
  };
  const levels = [{width, height, bands: bandsOf(rgb, width, height)}];
  const sub = subsample2x(rgb, width, height);
  if (sub.width >= 8 && sub.height >= 8) levels.push({width: sub.width, height: sub.height, bands: bandsOf(sub.planes, sub.width, sub.height)});
  let retained = 0;
  const masks = levels.map(level => {
    const bytes = 24 * level.width * level.height;
    if (!(bytes <= cacheBytes - retained)) return null;
    retained += bytes;
    return referenceMasking(level.bands, level.width, level.height);
  });
  const referenceBytes = levels.reduce((sum, level) => sum + Object.values(level.bands).flat().reduce((n, plane) => n + plane.byteLength, 0), 0);
  const reference = {width, height, levels, reservedBytes: retained, cacheBytes: retained, referenceBytes};
  if (retained) maskingCache.set(reference, masks);
  return reference;
}

export function butteraugli(reference, rgb) {
  const {width, height, levels} = reference, masks = maskingCache.get(reference);
  if (width < 8 || height < 8) throw new Error('Butteraugli here covers pictures of at least 8 x 8 pixels');
  const pool = planePool(), diffmap = (planes, lv, mask) => {
    const xyb = opsinDynamics(planes, lv.width, lv.height, pool), bands = separateFrequencies(xyb, lv.width, lv.height, pool);
    pool.give(...xyb);
    const out = diffmapBands(lv.bands, bands, lv.width, lv.height, mask, pool);
    pool.give(...bands.lf, ...bands.mf, ...bands.hf, ...bands.uhf);
    return out;
  };
  const map = diffmap(rgb, levels[0], masks?.[0]);
  if (levels[1]) {
    const sub = subsample2x(rgb, width, height), lv = levels[1], subMap = diffmap(sub.planes, lv, masks?.[1]);
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
  for (const v of map) { let d = p === 3 ? v * (v * v) : exactPow(v, p); sums[0] += d; d *= d; sums[1] += d; d *= d; sums[2] += d; }
  return sums.reduce((a, s, i) => a + exactPow(s / map.length, 1 / (p * (1 << i))), 0) / 3;
}



function rowRing(width, size, make) {
  const store = new Float64Array(size * width), tags = new Float64Array(size).fill(-1);
  return y => {
    const slot = y % size, row = store.subarray(slot * width, (slot + 1) * width);
    if (tags[slot] !== y) {
      if (tags[slot] > y) throw new Error('Butteraugli row ring is too small.');
      make(y, row); tags[slot] = y;
    }
    return row;
  };
}
const RING = 16, LF_RING = 24, OPSIN_RING = 40, INPUT_RING = 48;

function blurParams(sigma) {
  const kernel = blurKernel(sigma), K = kernel.length, reach = (K - 1) / 2, total = kernel.reduce((a, b) => a + b), five = K === 5;
  let inner = 0;
  for (let k = 0; k < K; k++) inner += kernel[k];
  return {kernel, K, reach, total, five, d: five ? total : inner};
}
function blurRowPass(src, out, width, {kernel, K, reach, total, five, d}) {
  const edge = x => {
    let sum = 0, weight = 0;
    for (let k = -reach; k <= reach; k++) {
      let j = x + k;
      if (five) j = baMirror(j, width);
      else if (j < 0 || j >= width) continue;
      sum += src[j] * kernel[k + reach]; weight += kernel[k + reach];
    }
    return five ? sum / total : sum / weight;
  };
  const end = width - reach;
  let x = 0;
  for (; x < width && x < reach; x++) out[x] = edge(x);
  for (; x + 3 < end; x += 4) {
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
    for (let k = 0, at = x - reach; k < K; k++, at++) {
      const w = kernel[k];
      s0 += src[at] * w; s1 += src[at + 1] * w; s2 += src[at + 2] * w; s3 += src[at + 3] * w;
    }
    out[x] = s0 / d; out[x + 1] = s1 / d; out[x + 2] = s2 / d; out[x + 3] = s3 / d;
  }
  for (; x < end; x++) {
    let sum = 0;
    for (let k = 0, at = x - reach; k < K; k++, at++) sum += src[at] * kernel[k];
    out[x] = sum / d;
  }
  for (; x < width; x++) out[x] = edge(x);
}
function blurRows(input, width, height, sigma, size = RING) {
  const P = blurParams(sigma), {kernel, K, reach, total, five, d} = P, acc = new Float64Array(width);
  const pass = rowRing(width, K + 1, (y, out) => blurRowPass(input(y), out, width, P));
  return rowRing(width, size, (y, out) => {
    if (y < reach || y >= height - reach) {
      let weight = 0;
      acc.fill(0);
      for (let k = -reach; k <= reach; k++) {
        let j = y + k;
        if (five) j = baMirror(j, height);
        else if (j < 0 || j >= height) continue;
        const row = pass(j), w = kernel[k + reach];
        for (let x = 0; x < width; x++) acc[x] += row[x] * w;
        weight += w;
      }
      for (let x = 0; x < width; x++) out[x] = five ? acc[x] / total : acc[x] / weight;
      return;
    }
    acc.fill(0);
    for (let k = 0; k < K; k++) {
      const w = kernel[k], row = pass(y - reach + k);
      for (let x = 0; x < width; x++) acc[x] += row[x] * w;
    }
    for (let x = 0; x < width; x++) out[x] = acc[x] / d;
  });
}
const stepRows = (width, make) => rowRing(width, RING, make);
function stepPlanes(width, count, make, size = RING) {
  const store = new Float64Array(size * count * width), tags = new Float64Array(size).fill(-1);
  const views = Array.from({length: size}, (_, slot) => Array.from({length: count}, (_, c) => store.subarray((slot * count + c) * width, (slot * count + c + 1) * width)));
  const slotOf = y => {
    const slot = y % size;
    if (tags[slot] !== y) {
      if (tags[slot] > y) throw new Error('Butteraugli row ring is too small.');
      make(y, views[slot]); tags[slot] = y;
    }
    return slot;
  };
  return Array.from({length: count}, (_, c) => y => views[slotOf(y)][c]);
}

function bandRows(rgb, width, height) {
  const m = BA_OPSIN, g = v => Math.max(baGamma(v) / v, 1e-4), blurred = rgb.map(p => blurRows(p, width, height, 1.2));
  const opsin = stepPlanes(width, 3, (y, [o0, o1, o2]) => {
    const br = blurred[0](y), bgr = blurred[1](y), bb = blurred[2](y), r = rgb[0](y), gr = rgb[1](y), b = rgb[2](y);
    for (let i = 0; i < width; i++) {
      const vr = br[i] * BA_INTENSITY, vg = bgr[i] * BA_INTENSITY, vb = bb[i] * BA_INTENSITY;
      const pr = r[i] * BA_INTENSITY, pg = gr[i] * BA_INTENSITY, pb = b[i] * BA_INTENSITY;
      const s0 = g(Math.max(Math.max(m[0] * vr + m[1] * vg + m[2] * vb + m[3], m[3]), 1e-4));
      const s1 = g(Math.max(Math.max(m[4] * vr + m[5] * vg + m[6] * vb + m[7], m[7]), 1e-4));
      const s2 = g(Math.max(Math.max(m[8] * vr + m[9] * vg + m[10] * vb + m[11], m[11]), 1e-4));
      const c0 = Math.max((m[0] * pr + m[1] * pg + m[2] * pb + m[3]) * s0, 1.7557483643287353);
      const c1 = Math.max((m[4] * pr + m[5] * pg + m[6] * pb + m[7]) * s1, 1.7557483643287353);
      const c2 = Math.max((m[8] * pr + m[9] * pg + m[10] * pb + m[11]) * s2, 12.226454707163354);
      o0[i] = c0 - c1; o1[i] = c0 + c1; o2[i] = c2;
    }
  }, OPSIN_RING);
  const lfRaw = opsin.map(p => blurRows(p, width, height, 7.15593339443, LF_RING));
  const mf0 = [0, 1, 2].map(c => stepRows(width, (y, out) => { const x = opsin[c](y), l = lfRaw[c](y); for (let i = 0; i < width; i++) out[i] = x[i] - l[i]; }));
  const lf = stepPlanes(width, 3, (y, [o0, o1, o2]) => {
    const lx = lfRaw[0](y), ly = lfRaw[1](y), lb = lfRaw[2](y);
    for (let i = 0; i < width; i++) {
      const x = lx[i], v = ly[i], b = lb[i] + -0.362267051518 * v;
      o0[i] = x * 33.832837186260; o1[i] = v * 14.458268100570; o2[i] = b * 49.87984651440;
    }
  });
  const mfBlur = mf0.map(p => blurRows(p, width, height, 3.22489901262));
  const hfRaw = [0, 1].map(c => stepRows(width, (y, out) => { const a = mf0[c](y), b = mfBlur[c](y); for (let i = 0; i < width; i++) out[i] = a[i] - b[i]; }));
  const mf = [0, 1, 2].map(c => c === 2 ? mfBlur[2] : stepRows(width, (y, out) => {
    const b = mfBlur[c](y);
    for (let i = 0; i < width; i++) out[i] = c === 0 ? removeRange(0.29, b[i]) : amplifyRange(0.1, b[i]);
  }));
  const hfScaled = [stepRows(width, (y, out) => {
    const h0 = hfRaw[0](y), h1 = hfRaw[1](y);
    for (let i = 0; i < width; i++) { const vy = h1[i]; out[i] = h0[i] * (46 / (vy * vy + 46) * (1 - 0.653020556257) + 0.653020556257); }
  }), hfRaw[1]];
  const hfBlur = hfScaled.map(p => blurRows(p, width, height, 1.56416327805));
  const uhf = [0, 1].map(c => stepRows(width, (y, out) => {
    const u = hfScaled[c](y), h = hfBlur[c](y);
    for (let i = 0; i < width; i++) {
      if (c === 0) out[i] = removeRange(0.04, u[i] - h[i]);
      else { const hv = maximumClamp(h[i], 28.4691806922); out[i] = maximumClamp(u[i] - hv, 5.19175294647) * 2.69313763794; }
    }
  }));
  const hf = [0, 1].map(c => stepRows(width, (y, out) => {
    const h = hfBlur[c](y);
    for (let i = 0; i < width; i++) out[i] = c === 0 ? removeRange(1.5, h[i]) : amplifyRange(0.132, maximumClamp(h[i], 28.4691806922) * 2.155);
  }));
  return {lf, mf, hf, uhf};
}

function maltaDiffRows(a, b, width, w0gt1, w0lt1, norm1, mulli) {
  const len = 3.75, n2gt = Math.fround(mulli * Math.sqrt(0.5 * w0gt1) / (len * 2 + 1) * norm1), n2lt = Math.fround(mulli * Math.sqrt(0.33 * w0lt1) / (len * 2 + 1) * norm1);
  return stepRows(width, (y, out) => {
    const ra = a(y), rb = b(y);
    for (let i = 0; i < width; i++) {
      const r0 = ra[i], r1 = rb[i], absval = 0.5 * (Math.abs(r0) + Math.abs(r1));
      let d = n2gt / (norm1 + absval) * (r0 - r1);
      const s2 = n2lt / (norm1 + absval), f0 = Math.abs(r0), small = 0.55 * f0, big = 1.05 * f0;
      if (r0 < 0) { if (r1 > -small) d -= s2 * (r1 + small); else if (r1 < -big) d += s2 * (-r1 - big); }
      else if (r1 < small) d += s2 * (small - r1); else if (r1 > big) d -= s2 * (r1 - big);
      out[i] = d;
    }
  });
}
function rowFive(r, d, width, totals) {
  const [a0, a1, a2, a3, a4] = r, [d0, d1, d2, d3, d4] = d;
  for (let x = 4; x < width - 4; x++) {
    let sum = 0;
    sum += a0[x + d0]; sum += a1[x + d1]; sum += a2[x + d2]; sum += a3[x + d3]; sum += a4[x + d4];
    totals[x] += sum * sum;
  }
}
function rowSeven(r, d, width, totals) {
  const [a0, a1, a2, a3, a4, a5, a6] = r, [d0, d1, d2, d3, d4, d5, d6] = d;
  for (let x = 4; x < width - 4; x++) {
    let sum = 0;
    sum += a0[x + d0]; sum += a1[x + d1]; sum += a2[x + d2]; sum += a3[x + d3]; sum += a4[x + d4];
    sum += a5[x + d5]; sum += a6[x + d6];
    totals[x] += sum * sum;
  }
}
function rowNine(r, d, width, totals) {
  const [a0, a1, a2, a3, a4, a5, a6, a7, a8] = r, [d0, d1, d2, d3, d4, d5, d6, d7, d8] = d;
  for (let x = 4; x < width - 4; x++) {
    let sum = 0;
    sum += a0[x + d0]; sum += a1[x + d1]; sum += a2[x + d2]; sum += a3[x + d3]; sum += a4[x + d4];
    sum += a5[x + d5]; sum += a6[x + d6]; sum += a7[x + d7]; sum += a8[x + d8];
    totals[x] += sum * sum;
  }
}
const ROW_LINE = {5: rowFive, 7: rowSeven, 9: rowNine};
const lineSteps = lines => lines.map(line => ({dx: Int32Array.from({length: line.length / 2}, (_, k) => line[2 * k]), dy: Int32Array.from({length: line.length / 2}, (_, k) => line[2 * k + 1])}));
function maltaLineRow(diffs, width, height, lines, steps, y, into, totals, window) {
  totals.fill(0);
  for (let dy = -4; dy <= 4; dy++) window[dy + 4] = y + dy >= 0 && y + dy < height ? diffs(y + dy) : null;
  const interior = y >= 4 && y < height - 4;
  if (interior) for (const {dx, dy} of steps) ROW_LINE[dx.length](Array.from(dy, d => window[d + 4]), dx, width, totals);
  for (let x = 0; x < width; x++) {
    if (interior && x >= 4 && x < width - 4) continue;
    let total = 0;
    for (const line of lines) {
      let sum = 0;
      for (let k = 0; k < line.length; k += 2) {
        const xx = x + line[k], row = window[line[k + 1] + 4];
        if (xx >= 0 && row && xx < width) sum += row[xx];
      }
      total += sum * sum;
    }
    totals[x] = total;
  }
  for (let x = 0; x < width; x++) into[x] += totals[x];
}
function maskRows(bands, width, height) {
  const mul = 6.19424080439, bias = mul * 12.61050594197, root = Math.sqrt(bias);
  const input = stepRows(width, (y, out) => {
    const u0 = bands.uhf[0](y), h0 = bands.hf[0](y), u1 = bands.uhf[1](y), h1 = bands.hf[1](y);
    for (let i = 0; i < width; i++) {
      const x = (u0[i] + h0[i]) * 2.5, v = u1[i] * 0.4 + h1[i] * 0.4;
      out[i] = Math.sqrt(mul * Math.abs(Math.sqrt(x * x + v * v)) + bias) - root;
    }
  });
  return blurRows(input, width, height, 2.7);
}
function diffmapRows(p0, p1, width, height) {
  const malta = [
    [maltaDiffRows(p0.uhf[1], p1.uhf[1], width, UHF_MALTA[0], UHF_MALTA[0], UHF_MALTA[1], 0.39905817637), MALTA_HF_SUMMED, 1],
    [maltaDiffRows(p0.uhf[0], p1.uhf[0], width, UHF_MALTA_X[0], UHF_MALTA_X[0], UHF_MALTA_X[1], 0.39905817637), MALTA_HF_SUMMED, 0],
    [maltaDiffRows(p0.hf[1], p1.hf[1], width, HF_MALTA[0], HF_MALTA[0], HF_MALTA[1], 0.611612573796), MALTA_LF, 1],
    [maltaDiffRows(p0.hf[0], p1.hf[0], width, HF_MALTA_X[0], HF_MALTA_X[0], HF_MALTA_X[1], 0.611612573796), MALTA_LF, 0],
    [maltaDiffRows(p0.mf[1], p1.mf[1], width, MF_MALTA[0], MF_MALTA[0], MF_MALTA[1], 0.611612573796), MALTA_LF, 1],
    [maltaDiffRows(p0.mf[0], p1.mf[0], width, MF_MALTA_X[0], MF_MALTA_X[0], MF_MALTA_X[1], 0.611612573796), MALTA_LF, 0]];
  const b0 = maskRows(p0, width, height), b1 = maskRows(p1, width, height);
  const ac = [0, 1, 2].map(() => new Float64Array(width)), dc = [0, 1, 2].map(() => new Float64Array(width));
  const totals = new Float64Array(width), window = new Array(9), steps = new Map([MALTA_HF_SUMMED, MALTA_LF].map(lines => [lines, lineSteps(lines)])), S = 3;
  return stepRows(width, (y, out) => {
    for (const plane of [...ac, ...dc]) plane.fill(0);
    for (const [diffs, lines, c] of malta) maltaLineRow(diffs, width, height, lines, steps.get(lines), y, ac[c], totals, window);
    for (let c = 0; c < 3; c++) {
      if (c < 2) {
        const a = p0.hf[c](y), b = p1.hf[c](y), into = ac[c], gt = BA_WMUL[c] * 0.8, lt = BA_WMUL[c] * 0.8;
        for (let i = 0; i < width; i++) {
          const v0 = a[i], v1 = b[i], d = v0 - v1, f0 = Math.abs(v0), small = 0.4 * f0, big = f0;
          const v = v0 < 0 ? (v1 > -small ? v1 + small : v1 < -big ? -v1 - big : 0) : (v1 < small ? small - v1 : v1 > big ? v1 - big : 0);
          into[i] += d * d * gt + lt * v * v;
        }
      }
      for (const [a, b, w, into] of [[p0.mf[c](y), p1.mf[c](y), BA_WMUL[3 + c], ac[c]], [p0.lf[c](y), p1.lf[c](y), BA_WMUL[6 + c], dc[c]]])
        if (w) for (let i = 0; i < width; i++) { const d = a[i] - b[i]; into[i] += d * d * w; }
    }
    const m0 = b0(y), m1 = b1(y);
    for (let i = 0; i < width; i++) { const d = m0[i] - m1[i]; ac[1][i] += 10 * d * d; }
    const up = y >= S ? b0(y - S) : null, down = y < height - S ? b0(y + S) : null;
    for (let x = 0; x < width; x++) {
      let e0 = m0[x], e1 = 2 * e0, e2 = e1;
      const take = v => {
        if (v < e2) { if (v < e0) { e2 = e1; e1 = e0; e0 = v; } else if (v < e1) { e2 = e1; e1 = v; } else e2 = v; }
      };
      if (x >= S) { take(m0[x - S]); if (up) take(up[x - S]); if (down) take(down[x - S]); }
      if (x < width - S) { take(m0[x + S]); if (up) take(up[x + S]); if (down) take(down[x + S]); }
      if (up) take(up[x]);
      if (down) take(down[x]);
      const mask = 0.45 * e0 + 0.3 * e1 + 0.25 * e2;
      out[x] = Math.sqrt((dc[0][x] + dc[1][x] + dc[2][x]) * maskDcY(mask) + (ac[0][x] + ac[1][x] + ac[2][x]) * maskY(mask));
    }
  });
}
function subsampleRows(plane, width, height) {
  const w = (width + 1) >> 1, h = (height + 1) >> 1;
  return rowRing(w, RING, (sy, out) => {
    out.fill(0);
    for (let y = 2 * sy; y < Math.min(height, 2 * sy + 2); y++) { const row = plane(y); for (let x = 0; x < width; x++) out[x >> 1] += 0.25 * row[x]; }
    if (width & 1) out[w - 1] *= 2;
    if (height & 1 && sy === h - 1) for (let x = 0; x < w; x++) out[x] *= 2;
  });
}

export function butteraugliRows(reference, distorted, width, height, onRow) {
  if (width < 8 || height < 8) throw new Error('Butteraugli here covers pictures of at least 8 x 8 pixels');
  const input = rows => [0, 1, 2].map(c => rowRing(width, INPUT_RING, (y, out) => out.set(rows(c, y))));
  const ref = input(reference), dist = input(distorted);
  const map = diffmapRows(bandRows(ref, width, height), bandRows(dist, width, height), width, height);
  const sw = (width + 1) >> 1, sh = (height + 1) >> 1, half = sw >= 8 && sh >= 8;
  const sub = half && diffmapRows(bandRows(ref.map(p => subsampleRows(p, width, height)), sw, sh), bandRows(dist.map(p => subsampleRows(p, width, height)), sw, sh), sw, sh);
  const out = new Float64Array(width);
  for (let y = 0; y < height; y++) {
    const row = map(y);
    if (!half) { onRow(y, row); continue; }
    const s = sub(y >> 1);
    for (let x = 0; x < width; x++) out[x] = row[x] * (1 - 0.3 * 0.5) + 0.5 * s[x >> 1];
    onRow(y, out);
  }
}
