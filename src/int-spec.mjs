// SPDX-License-Identifier: MIT
import {scaledDCTBases, lowFrequencies} from './vardct-strategies.mjs';
import {exactLog2} from './exact-math.mjs';
import {inRange, Rn, Rb, rSplit, udiv} from './int-ops.mjs';

export const R = (s, k) => Math.floor((s + 2 ** (k - 1)) / 2 ** k);
export const ISR = Object.freeze({planeX: 2 ** 16, planeYB: 2 ** 18, planes: 2 ** 20, gaborish: 2 ** 36, split: 2 ** 31, coef: 2 ** 21, dctSum: 2 ** 41,
  u32: 2 ** 32, i32: 2 ** 31, num: 2 ** 29, level: 2 ** 21, dsum: 2 ** 53, rate: 2 ** 26, cost: 2 ** 48, hf: 2 ** 13, mw: 641, low: 2 ** 22});
const check = (v, bound, what) => { if (!(Math.abs(v) < bound)) throw new RangeError(`int-spec: ${what} ${v} outside ${bound}`); return v; };

const Q20 = 1 << 20;
const LINEAR = Float64Array.from({length: 256}, (_, i) => {
  const v = i / 255;
  if (i <= 10) return v / 12.92;
  const base = (v + 0.055) / 1.055, square = base * base;
  let fifth = Math.sqrt(Math.sqrt(square));
  for (let n = 0; n < 12; n++) fifth = (4 * fifth + square / (fifth * fifth * fifth * fifth)) / 5;
  return square * fifth;
});
const MIX = [0.3, 0.622, 0.078, 0.23, 0.692, 0.078, 0.24342268924547819, 0.20476744424496821, 0.5518098665095536], BIAS = 0.0037930732552754493;
export const IS_CONE = Int32Array.from({length: 9 * 256}, (_, j) => Math.round(MIX[j >> 8] * LINEAR[j & 255] * Q20));
export const IS_BIAS = Math.round(BIAS * Q20);
const exactRoot = v => {
  const N8 = 8n * BigInt(v) * (1n << 40n), cube = r => { const t = 2n * BigInt(r); return [(t - 1n) ** 3n, (t + 1n) ** 3n]; };
  let r = Math.round(Math.cbrt(v / Q20) * Q20);
  for (;;) { const [lo, hi] = cube(r); if (v && N8 < lo) r--; else if (N8 >= hi) r++; else return r; }
};
export const IS_CBRT_LO = Int32Array.from({length: 1 << 16}, (_, v) => exactRoot(v));
export const IS_CBRT_HI = Int32Array.from({length: ((Q20 + IS_BIAS + 2) >> 4) + 2}, (_, i) => exactRoot(i * 16));
const cbrt = v => v < 1 << 16 ? IS_CBRT_LO[v] : IS_CBRT_HI[R(v, 4)];
export const BLACK = cbrt(IS_BIAS);

export function isXYB(r, g, b) {
  const cone = o => IS_CONE[o * 256 + r] + IS_CONE[(o + 1) * 256 + g] + IS_CONE[(o + 2) * 256 + b] + IS_BIAS;
  const l = cbrt(cone(0)) - BLACK, m = cbrt(cone(3)) - BLACK, s = cbrt(cone(6)) - BLACK;
  const Y = R(255 * (l + m), 11);
  return [check(R(255 * (l - m), 11), 16384, 'X'), check(Y, ISR.planeYB, 'Y'), check(R(255 * s, 10) - Y, ISR.planeYB, 'B')];
}

export function isPlanes(data, width, height) {
  const W = Math.ceil(width / 8) * 8, H = Math.ceil(height / 8) * 8, planes = [0, 1, 2].map(() => new Int32Array(W * H));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const at = (Math.min(y, height - 1) * width + Math.min(x, width - 1)) * 4, v = isXYB(data[at], data[at + 1], data[at + 2]);
    for (let c = 0; c < 3; c++) planes[c][y * W + x] = check(v[c], c === 0 ? ISR.planeX : ISR.planeYB, 'plane');
  }
  return {planes, W, H};
}

export function isGaborishWeights([w1, w2] = [0.115169525, 0.061248592]) {
  const norm = 1 / (1 + 4 * w1 + 4 * w2), a = Math.round(w1 * norm * 65536), b = Math.round(w2 * norm * 65536);
  return [65536 - 4 * a - 4 * b, a, b];
}
export function isGaborish(t, W, H, weights = isGaborishWeights(), iterations = 4) {
  const [c, a, b] = weights, [c0, a0, b0] = isGaborishWeights();
  if (c !== c0 || a !== a0 || b !== b0 || iterations !== 4) throw new RangeError('int-spec: Gaborish takes its default weights and four steps');
  const orig = Int32Array.from(t), next = new Int32Array(t.length);
  for (let i = 0; i < iterations; i++) {
    for (let y = 0; y < H; y++) {
      const u = (y ? y - 1 : 0) * W, m = y * W, d = (y < H - 1 ? y + 1 : y) * W;
      for (let x = 0; x < W; x++) {
        const l = x ? x - 1 : 0, r = x < W - 1 ? x + 1 : x;
        const s = c * t[m + x] + a * (t[u + x] + t[d + x] + t[m + l] + t[m + r]) + b * (t[u + l] + t[u + r] + t[d + l] + t[d + r]);
        next[m + x] = check(t[m + x] + orig[m + x] - R(check(s, ISR.gaborish, 'Gaborish sum'), 16), ISR.planes, 'Gaborish iterate');
      }
    }
    t.set(next);
  }
  return t;
}

const bases = new Map();
export function isBasis(n) {
  let B = bases.get(n);
  if (!B) bases.set(n, B = Int32Array.from(scaledDCTBases(n).basis, v => Math.round(v * n * 16384)));
  return B;
}
const LOG2 = {8: 3, 16: 4, 32: 5, 64: 6};
export function isDCT(pixels, w, h, out = new Int32Array(w * h)) {
  if (!(w in LOG2) || !(h in LOG2) || w > 32 || h > 32) throw new RangeError('int-spec: DCT sides are 8, 16 or 32');
  const bw = isBasis(w), bh = isBasis(h), kw = 14 + LOG2[w], kh = 14 + LOG2[h], tmp = new Int32Array(w * h);
  for (let y = 0; y < h; y++) for (let u = 0; u < w; u++) {
    let s = 0;
    for (let x = 0; x < w; x++) s += pixels[y * w + x] * bw[u * w + x];
    tmp[y * w + u] = check(R(check(s, ISR.dctSum, 'DCT sum'), kw), ISR.coef, 'DCT row');
  }
  const tall = h >= w;
  for (let v = 0; v < h; v++) for (let u = 0; u < w; u++) {
    let s = 0;
    for (let y = 0; y < h; y++) s += tmp[y * w + u] * bh[v * h + y];
    out[tall ? u * h + v : v * w + u] = check(R(check(s, ISR.dctSum, 'DCT sum'), kh), ISR.coef, 'DCT column');
  }
  return out;
}

function splitPass(get, n, basis, k, put) {
  for (let f = 0; f < n; f++) {
    let H = 0, L = 0;
    for (let s = 0; s < n; s++) { const x = get(s), b = basis[f * n + s]; H += (x >> 11) * b; L += (x & 2047) * b; }
    put(f, rSplit(check(H, ISR.split, 'split H'), check(L, ISR.split, 'split L'), 11, k));
  }
}
export function isDCTSplit(pixels, w, h, out = new Int32Array(w * h)) {
  const bw = isBasis(w), bh = isBasis(h), tmp = new Int32Array(w * h), tall = h >= w;
  for (let y = 0; y < h; y++) splitPass(x => pixels[y * w + x], w, bw, 14 + LOG2[w], (u, v) => { tmp[y * w + u] = v; });
  for (let u = 0; u < w; u++) splitPass(y => tmp[y * w + u], h, bh, 14 + LOG2[h], (v, val) => { out[tall ? u * h + v : v * w + u] = val; });
  return out;
}

export function isqrt(n) {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`int-spec: isqrt of ${n}`);
  check(n, ISR.u32, 'isqrt');
  let r = Math.floor(Math.sqrt(n));
  while (r * r > n) r--;
  while ((r + 1) * (r + 1) <= n) r++;
  return r;
}

export function isCflSums(blocks) {
  if (blocks.length > 64) throw new RangeError('int-spec: a CfL tile holds at most 64 blocks');
  let xy = 0, yy = 0, by = 0;
  for (const [SX, SY, SB] of blocks) for (let k = 1; k < 64; k++) {
    const y = R(SY[k], 6), x = R(SX[k], 6), b = R(SB[k], 6);
    xy += x * y; yy += y * y; by += b * y;
  }
  check(xy, ISR.dctSum * 2, 'CfL sum'); check(yy, ISR.dctSum * 2, 'CfL sum'); check(by, ISR.dctSum * 2, 'CfL sum');
  return {xy, yy, by};
}
export function isCflFactor(sum, yy, cflScale = 1) {
  if (!Number.isInteger(sum) || !Number.isInteger(yy) || yy < 0 || !(cflScale > 0) || !Number.isFinite(cflScale)) throw new RangeError('int-spec: a CfL factor takes integer sums, yy >= 0 and a finite positive scale');
  return Math.max(-128, Math.min(127, Math.round(cflScale * 84 * sum / (yy + 4))));
}
export function isLevelTables(quant, thresholds) {
  if (quant.length !== 64 || thresholds.length !== 64) throw new RangeError('int-spec: level tables take 64 steps and 64 dead zones');
  for (let k = 0; k < 64; k++) {
    if (!Number.isInteger(quant[k]) || quant[k] < 1 || quant[k] > 2 ** 20) throw new RangeError(`int-spec: step ${quant[k]} at ${k}`);
    if (!(thresholds[k] >= 0 && thresholds[k] < 4)) throw new RangeError(`int-spec: dead zone ${thresholds[k]} at ${k}`);
  }
  const D = new Int32Array(64), T = new Int32Array(64);
  for (let k = 0; k < 64; k++) { D[k] = check(42 * quant[k], 2 ** 26, 'D'); T[k] = check(Math.round(thresholds[k] * D[k]), 2 ** 28, 'T'); }
  return {D, T};
}
export function isLevels8(c, S, SY, f, {D, T}, out, at) {
  if (!Number.isInteger(f) || f < -128 || f > 127) throw new RangeError(`int-spec: CfL factor ${f}`);
  for (let k = 0; k < 64; k++) {
    if (!(D[k] > 0)) throw new RangeError('int-spec: a level divides by D > 0');
    const pos = (k & 7) * 8 + (k >> 3), N = 84 * S[pos] - (k && c !== 1 ? f * SY[pos] : 0), a = Math.abs(check(N, 2 ** 29, 'level numerator'));
    const q = a < T[k] ? 0 : Math.floor((2 * a + D[k]) / (2 * D[k]));
    out[at + k] = N < 0 ? -Math.min(q, 32768) : Math.min(q, 32767);
  }
}

export function isTables(input, {rate = [1.0, 3, 2, 0.6], detailWeight = 1.25, lambda = 0.28, inhom = 0.08} = {}) {
  const T = {recip: new Map(), dw1: new Map(), dw0: new Map(), lowM: new Map()}, u32 = (v, what) => inRange(v, 0, 2 ** 32 - 1, what);
  for (const [id, t] of input.transforms) {
    const recip = [], dw1 = [], dw0 = [], size = t.w * t.h;
    for (let c = 0; c < 3; c++) {
      recip[c] = Uint32Array.from(t.steps[c], step => inRange(Math.round(2 ** 37 / (84 * step)), 1, 2 ** 32 - 1, 'recip'));
      const w = Float64Array.from(t.steps[c], step => input.norm[c] * (step / 2048) ** 2 * 4096);
      dw1[c] = Uint32Array.from(w, v => u32(Math.round(v), 'dw1')); dw0[c] = Uint32Array.from(w, v => u32(Math.round(v * detailWeight), 'dw0'));
    }
    T.recip.set(id, recip); T.dw1.set(id, dw1); T.dw0.set(id, dw0);
    const area = t.bw * t.bh, long = Math.max(t.bw, t.bh), M = new Int32Array(area * area);
    for (let j = 0; j < area; j++) {
      const e = new Float64Array(size); e[Math.floor(j / long) * long * 8 + j % long] = 1;
      const dc = lowFrequencies(e, t.bw, t.bh);
      for (let i = 0; i < area; i++) M[i * area + j] = inRange(Math.round(dc[i] * 16384), -32768, 32767, 'lowM');
    }
    T.lowM.set(id, M);
  }
  T.recip0 = Uint32Array.from(input.dcSteps, s => inRange(Math.round(2 ** 31 / (s * 256)), 1, 2 ** 32 - 1, 'recip0'));
  T.dead = Int32Array.from(input.dead ?? [0.5, 0.5, 0.5, 0.5, 0.5, 0.5], v => inRange(Math.round(v * 1024), 0, 1024, 'dead'));
  T.one = Int32Array.from(input.one, v => Math.round(v * 1024));
  T.recon = Int32Array.from({length: 4096}, (_, q) => q < 2 ? 0 : Math.round(1024 * (q - 0.145 / q)));
  T.rate = Uint32Array.from({length: 4096}, (_, q) => q ? Math.round(256 * (rate[1] + rate[2] * exactLog2(q))) : 0);
  T.rc0 = Math.round(256 * rate[0]); T.rc2 = Math.round(256 * rate[2]); T.rc3 = Math.round(256 * rate[3]);
  T.lambda = Math.round(256 * lambda); T.inhom = Math.round(inhom * lambda * 4096);
  return T;
}
export const isRate = (T, q) => { if (q < 4096) return T.rate[q]; const s = 20 - Math.clz32(q); return T.rate[q >> s] + T.rc2 * s; };

export function isLevel(mag, recip, dead, F = 64) {
  let v = Number(Rb(BigInt(mag) * BigInt(recip), 26));
  if (F !== 64) v = Rn(v * F, 6);
  v = Math.min(2147483647, v);
  return {v, q: v < dead ? 0 : Math.floor((v + 512) / 1024)};
}

export function isPrice(tr, id, T, input, f, F, MW, levels = null) {
  const t = input.transforms.get(id), {w, h, bw, bh, order, high} = t, size = w * h, area = bw * bh;
  const recipT = T.recip.get(id), dw1T = T.dw1.get(id), dw0T = T.dw0.get(id);
  let Dsum = 0n, R8 = 0;
  for (const c of [1, 0, 2]) {
    const recip = recipT[c], dw1 = dw1T[c], dw0 = dw0T[c], fc = c === 0 ? f[0] : c === 2 ? f[1] : 0, plane = tr[c], luma = tr[1];
    let d = 0n, r = 0, zeros = 0, run = 0;
    for (let k = area; k < size; k++) {
      const pos = order[k], num = check(84 * plane[pos] - fc * luma[pos], ISR.num, 'num');
      const {v, q} = isLevel(Math.abs(num), recip[pos], T.dead[c * 2 + high[pos]], F);
      const recon = q === 0 ? 0 : q === 1 ? T.one[c] : q < 4096 ? T.recon[q] : q * 1024, e = check(v - recon, 1025, 'e');
      d += BigInt(e * e) * BigInt(q ? dw1[pos] : dw0[pos]);
      if (levels) levels[c][pos] = num < 0 ? -q : q;
      if (q) { r += isRate(T, q); zeros += run; run = 0; } else run++;
    }
    Dsum += d; R8 += T.rc0 + r + T.rc3 * zeros;
  }
  check(Number(Dsum), ISR.dsum, 'D sum'); check(R8, ISR.rate, 'R');
  const D = check(Number(Rb(Rb(Dsum, 16) * BigInt(w * h) * BigInt(MW), 8)), ISR.cost, 'D');
  return {Dsum, D, R: R8, J: D + R8 * T.lambda};
}

export const isSoft = e => { const den = 256 + ((328 * e + 128) >> 8); return udiv(e * 4096 + (den >> 1), den); };
export function isMaskEnergy([X, Y, B], W, top, bx, by) {
  let s = 0;
  for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
    const i = (by * 8 + y - top) * W + bx * 8 + x;
    const dy1 = Rn(Y[i + 1] - Y[i], 6), dy2 = Rn(Y[i + W] - Y[i], 6), dd = Rn(Y[i + W + 1] + Y[i] - Y[i + 1] - Y[i + W], 6);
    const dx = Rn(X[i + 1] - X[i], 6), db = Rn(B[i + 1] - B[i], 6);
    const eY = isqrt(inRange(dy1 * dy1 + dy2 * dy2 + Math.floor((dd * dd + 1) / 2), 0, 2 ** 32 - 1, 'eY2'));
    const eC = isqrt(inRange(4 * dx * dx + Math.floor((db * db + 2) / 4), 0, 2 ** 32 - 1, 'eC2'));
    s += isSoft(eY) * 256 + isSoft(eC) * 90;
  }
  return check(udiv(s + 6272, 12544), ISR.hf, 'hf');
}
export function isMaskWeights(hf, stride, rows) {
  const n = stride * rows, w = new Uint32Array(n);
  let sum = 0;
  for (let by = 0; by < rows; by++) for (let bx = 0; bx < stride; bx++) {
    let m0 = Infinity, m1 = Infinity, m2 = Infinity;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const v = hf[Math.max(0, Math.min(rows - 1, by + dy)) * stride + Math.max(0, Math.min(stride - 1, bx + dx))];
      if (v < m0) { m2 = m1; m1 = m0; m0 = v; } else if (v < m1) { m2 = m1; m1 = v; } else if (v < m2) m2 = v;
    }
    const er = (115 * m0 + 77 * m1 + 64 * m2 + 128) >> 8;
    sum += w[by * stride + bx] = 256 + udiv(393216 + ((er + 1024) >> 1), er + 1024);
  }
  const norm = udiv(n * 2 ** 25 + sum, 2 * sum);
  return Uint16Array.from(w, v => check(Rn(v * norm, 16), ISR.mw, 'MW'));
}
export function isBlockMW(MW, stride, bx, by, bw, bh) {
  const area = bw * bh;
  if (area === 1) return MW[by * stride + bx];
  let sum = 0, max = 0;
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) { const v = MW[(by + y) * stride + bx + x]; sum += v; if (v > max) max = v; }
  const kMean = Math.round(716.8 / area), kMax = 1024 - area * kMean;
  return (kMean * sum + kMax * max + 512) >> 10;
}

export function isDC(tr, id, c, T, input) {
  const t = input.transforms.get(id), area = t.bw * t.bh, long = Math.max(t.bw, t.bh), M = T.lowM.get(id), out = new Int32Array(area);
  for (let i = 0; i < area; i++) {
    let s = 0n;
    for (let j = 0; j < area; j++) s += BigInt(M[i * area + j]) * BigInt(tr[c][Math.floor(j / long) * long * 8 + j % long]);
    const low = Rb(s, 14);
    if (low >= BigInt(ISR.low) || -low >= BigInt(ISR.low)) throw new RangeError('int-spec: low outside 2^22');
    out[i] = Number(Rb(low * BigInt(T.recip0[c]), 30));
  }
  return out;
}

export const isJ = (T, D, R8) => D + R8 * T.lambda;
export function isPenalty(T, cands) {
  if (cands.length < 2) return 0;
  let maxR = 0, minR = Infinity;
  for (const c of cands) { const r = c.R * (16 / c.area); maxR = Math.max(maxR, r); minR = Math.min(minR, r); }
  return (T.inhom * Math.max(0, maxR - 2 * minR - 32768) + 128) >> 8;
}
