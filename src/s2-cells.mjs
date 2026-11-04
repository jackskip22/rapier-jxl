// SPDX-License-Identifier: MIT
import {SSIMULACRA2_WEIGHTS, SRGB_TO_LINEAR, gaussianTaps, finalCurve} from './ssimulacra2.mjs';
import {cbrtTables, IS_BIAS, BLACK} from './int-spec.mjs';

const R_HALF = Float64Array.from({length: 32}, (_, k) => k ? 2 ** (k - 1) : 0.5), R_INV = Float64Array.from({length: 32}, (_, k) => 2 ** -k);
const R = (s, k) => Math.floor((s + R_HALF[k]) * R_INV[k]);
const R16 = s => Math.floor((s + 32768) * 0.0000152587890625);

const SCALES = 6, N = 4, RB = 2 * N + 1, COLORS = 1 << 17, TWO32 = 4294967296, C2 = 15099;
export const S2C_LIN = Int32Array.from({length: 256}, (_, i) => Math.round(SRGB_TO_LINEAR[i] * 32768));
const OPSIN = [0.30, 0.622, 0.078, 0.23, 0.692, 0.078, 0.24342268924547819, 0.20476744424496821, 0.55180986650955360];
export const S2C_MIX = Int32Array.from({length: 9}, (_, j) => j % 3 < 2 ? Math.round(OPSIN[j] * 16384)
  : 16384 - Math.round(OPSIN[j - 2] * 16384) - Math.round(OPSIN[j - 1] * 16384));
export const S2C_TAPS = (() => { const t = Array.from(gaussianTaps(), v => Math.round(v * 65536)); t[N] += 65536 - t.reduce((a, b) => a + b, 0); return Int32Array.from(t); })();
const check = (v, bound, what) => { if (!(Math.abs(v) < bound)) throw new RangeError(`s2-cells: ${what} ${v} outside ${bound}`); return v; };
let ROOTS = null;
const cbrt = v => { const {lo, hi} = ROOTS ??= cbrtTables(); return v < 65536 ? lo[v] : hi[Math.floor((v + 8) * 0.0625)]; };

function xyb(r, g, b, out, o) {
  const cone = k => R(S2C_MIX[k] * r + S2C_MIX[k + 1] * g + S2C_MIX[k + 2] * b, 9) + IS_BIAS;
  const l = cbrt(cone(0)) - BLACK, m = cbrt(cone(3)) - BLACK, s = cbrt(cone(6)) - BLACK;
  out[o] = check(R(7 * (l - m) + 440402, 8), 8192, 'X');
  out[o + 1] = check(R(l + m + 20972, 9), 8192, 'Y');
  out[o + 2] = check(R(2 * s - (l + m) + 1153434, 9), 8192, 'B');
}

export function s2cScales(width, height) {
  const scales = [];
  for (let s = 0, w = width, h = height; s < SCALES; s++) {
    if (w < 8 || h < 8) break;
    if (s) { w = (w + 1) >> 1; h = (h + 1) >> 1; }
    scales.push({w, h});
  }
  return scales;
}

function down(pic, pw, ph, w, h) {
  const lin = [0, 1, 2].map(() => new Uint16Array(w * h)), {rgba} = pic;
  for (let c = 0; c < 3; c++) {
    const o = lin[c], src = pic.lin?.[c], v = rgba ? k => S2C_LIN[rgba[k * 4 + c]] : k => src[k];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const x0 = 2 * x, y0 = 2 * y, x1 = Math.min(x0 + 1, pw - 1), y1 = Math.min(y0 + 1, ph - 1);
      o[y * w + x] = R(v(y0 * pw + x0) + v(y0 * pw + x1) + v(y1 * pw + x0) + v(y1 * pw + x1), 2);
    }
  }
  return {lin};
}
function plane(pic, n, c, out) {
  if (pic.rgba) {
    const {rgba} = pic, keys = pic.keys ??= new Int32Array(COLORS).fill(-1), values = pic.values ??= new Int16Array(COLORS * 3);
    for (let i = 0; i < n; i++) {
      const at = i * 4, key = rgba[at] << 16 | rgba[at + 1] << 8 | rgba[at + 2], slot = Math.imul(key, 0x9e3779b1) >>> 15;
      if (keys[slot] !== key) { xyb(S2C_LIN[rgba[at]], S2C_LIN[rgba[at + 1]], S2C_LIN[rgba[at + 2]], values, slot * 3); keys[slot] = key; }
      out[i] = values[slot * 3 + c];
    }
    return out;
  }
  if (!pic.xyb) {
    const [r, g, b] = pic.lin, all = pic.xyb = [0, 1, 2].map(() => new Int16Array(n)), v = new Int32Array(3);
    for (let i = 0; i < n; i++) { xyb(r[i], g[i], b[i], v, 0); all[0][i] = v[0]; all[1][i] = v[1]; all[2][i] = v[2]; }
  }
  out.set(pic.xyb[c]);
  return out;
}

function channelSums(P1, P2, w, h, sh, stride, acc1, acc4) {
  const T = S2C_TAPS, T4 = T[N], ring = [0, 1, 2, 3, 4].map(() => new Int32Array(RB * w));
  const q11 = new Int32Array(w), q22 = new Int32Array(w), q12 = new Int32Array(w);
  const [r0, r1, r2, r3, r4] = ring;
  const makeRow = y => {
    const o = (y % RB) * w, row = y * w;
    for (let x = 0; x < w; x++) { const p = P1[row + x], q = P2[row + x]; q11[x] = p * p; q22[x] = q * q; q12[x] = p * q; }
    for (let x = 0; x < w; x++) {
      let m1 = 0, m2 = 0, s11 = 0, s22 = 0, s12 = 0;
      if (x >= N && x + N < w) {
        const c = row + x;
        m1 = T4 * P1[c]; m2 = T4 * P2[c]; s11 = T4 * q11[x]; s22 = T4 * q22[x]; s12 = T4 * q12[x];
        for (let k = 1; k <= N; k++) {
          const t = T[N - k];
          m1 += t * (P1[c - k] + P1[c + k]); m2 += t * (P2[c - k] + P2[c + k]);
          s11 += t * (q11[x - k] + q11[x + k]); s22 += t * (q22[x - k] + q22[x + k]); s12 += t * (q12[x - k] + q12[x + k]);
        }
      } else {
        const k0 = x < N ? N - x : 0, k1 = x + N >= w ? N + w - 1 - x : 2 * N;
        for (let k = k0; k <= k1; k++) {
          const t = T[k], xx = x + k - N;
          m1 += t * P1[row + xx]; m2 += t * P2[row + xx]; s11 += t * q11[xx]; s22 += t * q22[xx]; s12 += t * q12[xx];
        }
      }
      r0[o + x] = R16(m1); r1[o + x] = R16(m2); r2[o + x] = R16(s11); r3[o + x] = R16(s22); r4[o + x] = R16(s12);
    }
  };
  const push4 = (arr, at, v) => {
    if (!v) return;
    const u = R(v * v, 8), q = u * u, qh = Math.floor(q / TWO32), ql = q - qh * TWO32;
    let lo = arr[2 * at] + ql, hi = arr[2 * at + 1] + qh;
    if (lo >= TWO32) { lo -= TWO32; hi += 1; }
    arr[2 * at] = lo; arr[2 * at + 1] = hi;
  };
  const [e1, a1, l1] = acc1, [e4, a4, l4] = acc4, offs = new Int32Array(RB), taps = new Int32Array(RB);
  const [A0, A1, A2, A3, A4] = [0, 1, 2, 3, 4].map(() => new Float64Array(w));
  let made = 0;
  for (let y = 0; y < h; y++) {
    while (made < h && made <= y + N) makeRow(made++);
    let nt = 0;
    for (let k = -N; k <= N; k++) { const yy = y + k; if (yy < 0 || yy >= h) continue; offs[nt] = (yy % RB) * w; taps[nt++] = T[k + N]; }
    if (nt === RB) {
      const c = offs[N], t = T[N];
      for (let x = 0; x < w; x++) { A0[x] = t * r0[c + x]; A1[x] = t * r1[c + x]; A2[x] = t * r2[c + x]; A3[x] = t * r3[c + x]; A4[x] = t * r4[c + x]; }
      for (let j = 0; j < N; j++) {
        const t = taps[j], a = offs[j], b = offs[RB - 1 - j];
        for (let x = 0; x < w; x++) {
          A0[x] += t * (r0[a + x] + r0[b + x]); A1[x] += t * (r1[a + x] + r1[b + x]); A2[x] += t * (r2[a + x] + r2[b + x]);
          A3[x] += t * (r3[a + x] + r3[b + x]); A4[x] += t * (r4[a + x] + r4[b + x]);
        }
      }
    } else {
      A0.fill(0); A1.fill(0); A2.fill(0); A3.fill(0); A4.fill(0);
      for (let j = 0; j < nt; j++) {
        const t = taps[j], o = offs[j];
        for (let x = 0; x < w; x++) { A0[x] += t * r0[o + x]; A1[x] += t * r1[o + x]; A2[x] += t * r2[o + x]; A3[x] += t * r3[o + x]; A4[x] += t * r4[o + x]; }
      }
    }
    const cy = sh < 0 ? y * w : (y >> sh) * stride, row = y * w;
    for (let x = 0; x < w; x++) {
      const m1 = A0[x], m2 = A1[x], s11 = A2[x], s22 = A3[x], s12 = A4[x];
      const mu1 = R16(m1), mu2 = R16(m2), v1 = R16(s11) - mu1 * mu1, v2 = R16(s22) - mu2 * mu2, cov = R16(s12) - mu1 * mu2;
      const sv = v1 + v2, lift = sv < 0 ? -sv : 0, numS = 2 * cov + C2 + lift, denS = sv + lift + C2;
      const ratio = Math.min(65536, Math.floor((check(Math.abs(numS) * 65536, 2 ** 44, 'ratio') + (denS >> 1)) / denS)), r = numS < 0 ? -ratio : ratio;
      const d = mu1 - mu2, numM = 16777216 - d * d;
      const e = Math.min(131071, Math.max(0, 65536 - R(check(numM * r, 2 ** 44, 'e'), 24)));
      const p1 = P1[row + x], p2 = P2[row + x], num = 4096 + Math.abs(p2 - mu2), den = 4096 + Math.abs(p1 - mu1);
      const dd = Math.floor((num * 65536 + (den >> 1)) / den) - 65536, art = Math.min(131071, Math.max(0, dd)), lost = Math.max(0, -dd);
      const at = sh < 0 ? cy + x : cy + (x >> sh);
      if (e1) e1[at] += e; if (e4) push4(e4, at, e);
      if (a1) a1[at] += art; if (a4) push4(a4, at, art);
      if (l1) l1[at] += lost; if (l4) push4(l4, at, lost);
    }
  }
}

export function s2CellSums(reference, candidate, width, height) {
  const scales = s2cScales(width, height), stride = Math.ceil(width / 8), rows = Math.ceil(height / 8), out = [];
  const kept = reference.s2c?.rgba === reference.rgba && reference.s2c.width === width && reference.s2c.height === height
    ? reference.s2c : (reference.s2c = {rgba: reference.rgba, width, height, below: []});
  let a = kept, b = {rgba: candidate.rgba};
  for (const [s, {w, h}] of scales.entries()) {
    if (s) {
      const p = scales[s - 1];
      if (!kept.below[s]) { const made = down(a, p.w, p.h, w, h); plane(made, w * h, 0, new Int16Array(w * h)); if (kept.below[s - 1]) kept.below[s - 1].lin = null; kept.below[s] = made; }
      a = kept.below[s]; b = down(b, p.w, p.h, w, h);
    }
    const n = s <= 3 ? stride * rows : w * h, sh = s <= 3 ? 3 - s : -1, sums = [], P1 = new Int16Array(w * h), P2 = new Int16Array(w * h);
    for (let c = 0; c < 3; c++) {
      const acc1 = [null, null, null], acc4 = [null, null, null], active = [];
      for (let t = 0; t < 3; t++) for (const p of [1, 4]) {
        const k = c * scales.length * 6 + s * 6 + t + (p === 4 ? 3 : 0);
        if (!SSIMULACRA2_WEIGHTS[k]) continue;
        const sum = new Uint32Array(p === 1 ? n : 2 * n);
        (p === 1 ? acc1 : acc4)[t] = sum; active.push({k, c, t, p, sum});
      }
      if (!active.length) continue;
      channelSums(plane(a, w * h, c, P1), plane(b, w * h, c, P2), w, h, sh, stride, acc1, acc4);
      sums.push(...active);
    }
    out.push({w, h, sums});
  }
  return {scales: out, stride, rows};
}

export function s2CellMap({scales, stride, rows}, width, height, at = null) {
  const cells = new Float64Array(stride * rows), norms = [];
  let total = 0;
  for (const [s, {w, h, sums}] of scales.entries()) {
    const n = w * h, per = s <= 3 ? -1 : s - 3;
    for (const {k, p, sum} of sums) {
      const weight = SSIMULACRA2_WEIGHTS[k], m = p === 1 ? sum.length : sum.length / 2, value = p === 1 ? i => sum[i] : i => sum[2 * i + 1] * TWO32 + sum[2 * i];
      let t = 0;
      for (let i = 0; i < m; i++) t += value(i);
      const norm = p === 1 ? t / n / 65536 : Math.sqrt(Math.sqrt(t / n)) / 4096, ref = at ? at.norms[norms.length] : norm;
      norms.push(norm);
      total += weight * norm;
      const coef = p === 1 ? weight / n / 65536 : ref > 0 ? weight / (4 * n * ref * ref * ref) / 281474976710656 : 0;
      if (per < 0) for (let i = 0; i < m; i++) cells[i] += coef * value(i);
      else { const f = coef / 4 ** per; for (let cy = 0; cy < rows; cy++) for (let cx = 0; cx < stride; cx++) cells[cy * stride + cx] += f * value((cy >> per) * w + (cx >> per)); }
    }
  }
  return {cells, score: finalCurve(total), norms};
}
