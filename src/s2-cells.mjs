// SPDX-License-Identifier: MIT
import {SSIMULACRA2_WEIGHTS, SRGB_TO_LINEAR, gaussianTaps, finalCurve} from './ssimulacra2.mjs';
import {cbrtTables, IS_BIAS, BLACK} from './int-spec.mjs';
import {kernelHooks} from './kernel-hooks.mjs';

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

function channelSums(P1, P2, w, h, sh, stride, acc1, acc4, span = null) {
  if (kernelHooks.s2cChannel?.(P1, P2, w, h, sh, stride, acc1, acc4, span, S2C_TAPS)) return;
  const T = S2C_TAPS, T4 = T[N], ring = [0, 1, 2, 3, 4].map(() => new Int32Array(RB * w));
  const q11 = new Int32Array(w), q22 = new Int32Array(w), q12 = new Int32Array(w);
  const [r0, r1, r2, r3, r4] = ring;
  const y0 = span ? span.y0 : 0, y1 = span ? span.y1 : h, from = span ? span.from : 0, cellRow0 = span ? span.cellRow0 : 0;
  const makeRow = y => {
    const o = (y % RB) * w, row = (y - from) * w;
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
  let made = Math.max(from, y0 - N);
  for (let y = y0; y < y1; y++) {
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
    const cy = (sh < 0 ? y * w : (y >> sh) * stride) - cellRow0, row = (y - from) * w;
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

export function s2CellStream(reference, width, height) {
  const scales = s2cScales(width, height), stride = Math.ceil(width / 8), rows = Math.ceil(height / 8);
  const table = () => ({keys: new Int32Array(COLORS).fill(-1), values: new Int16Array(COLORS * 3)}), tables = [table(), table()];
  const ref = {rgba: reference.rgba, y: 0}, held = scales.map(() => ({next: 0, have: 0, a: null, b: null}));
  const terms = scales.map((_, s) => {
    const list = [];
    for (let c = 0; c < 3; c++) for (let t = 0; t < 3; t++) for (const p of [1, 4]) {
      const k = c * scales.length * 6 + s * 6 + t + (p === 4 ? 3 : 0);
      if (SSIMULACRA2_WEIGHTS[k]) list.push({k, c, t, p});
    }
    return list;
  });
  const xybRows = (pic, w, from, to, c, out, colors) => {
    if (pic.rgba) return plane({rgba: pic.rgba.subarray((from - pic.y) * w * 4, (to - pic.y) * w * 4), ...colors}, (to - from) * w, c, out);
    const v = new Int32Array(3);
    for (let i = 0, at = (from - pic.y) * w; i < (to - from) * w; i++, at++) { xyb(pic.lin[0][at], pic.lin[1][at], pic.lin[2][at], v, 0); out[i] = v[c]; }
    return out;
  };
  const halve = (pic, pw, ph, w, y, n) => {
    const lin = [0, 1, 2].map(() => new Uint16Array(w * n));
    for (let c = 0; c < 3; c++) {
      const o = lin[c], value = pic.rgba ? k => S2C_LIN[pic.rgba[(k - pic.y * pw) * 4 + c]] : k => pic.lin[c][k - pic.y * pw];
      for (let r = 0; r < n; r++) for (let x = 0; x < w; x++) {
        const x0 = 2 * x, y0 = 2 * (y + r), x1 = Math.min(x0 + 1, pw - 1), y1 = Math.min(y0 + 1, ph - 1);
        o[r * w + x] = R(value(y0 * pw + x0) + value(y0 * pw + x1) + value(y1 * pw + x0) + value(y1 * pw + x1), 2);
      }
    }
    return {y, rows: n, lin};
  };
  const join = (old, add, w, keep) => {
    if (!old) return add;
    const drop = Math.max(0, keep - old.y), left = old.rows - drop, per = old.rgba ? w * 4 : w;
    const cat = (x, y) => { const out = new x.constructor((left + add.rows) * per); out.set(x.subarray(drop * per)); out.set(y, left * per); return out; };
    return old.rgba ? {y: old.y + drop, rows: left + add.rows, rgba: cat(old.rgba, add.rgba)}
      : {y: old.y + drop, rows: left + add.rows, lin: old.lin.map((x, c) => cat(x, add.lin[c]))};
  };
  const cellRow = (s, y) => s <= 3 ? (y >> (3 - s)) * stride : y * scales[s].w;
  const feed = (s, part) => {
    const {w, h} = scales[s], at = held[s], sh = s <= 3 ? 3 - s : -1, limit = at.have >= h ? h : Math.max(at.next, at.have - N);
    if (limit > at.next) {
      const from = Math.max(0, at.next - N), to = Math.min(h, limit + N), c0 = cellRow(s, at.next), c1 = cellRow(s, limit - 1) + (s <= 3 ? stride : w);
      const a = s ? at.a : ref, P1 = new Int16Array((to - from) * w), P2 = new Int16Array((to - from) * w), sums = [];
      for (let c = 0; c < 3; c++) {
        const active = terms[s].filter(term => term.c === c);
        if (!active.length) continue;
        const acc1 = [null, null, null], acc4 = [null, null, null];
        for (const term of active) sums.push((term.p === 1 ? acc1 : acc4)[term.t] = new Uint32Array(term.p === 1 ? c1 - c0 : 2 * (c1 - c0)));
        channelSums(xybRows(a, w, from, to, c, P1, tables[0]), xybRows(at.b, w, from, to, c, P2, tables[1]), w, h, sh, stride, acc1, acc4, {y0: at.next, y1: limit, from, cellRow0: c0});
      }
      part.push({s, cell: c0, sums});
      at.next = limit;
    }
    if (s + 1 < scales.length) {
      const below = held[s + 1], {w: nw, h: nh} = scales[s + 1], end = at.have >= h ? nh : at.have >> 1;
      if (end > below.have) {
        const y = below.have, n = end - y;
        below.a = join(below.a, halve(s ? at.a : ref, w, h, nw, y, n), nw, Math.max(0, below.next - N));
        below.b = join(below.b, halve(at.b, w, h, nw, y, n), nw, Math.max(0, below.next - N));
        below.have = end;
        feed(s + 1, part);
      }
    }
    const keep = Math.max(0, Math.min(at.next - N, 2 * (held[s + 1]?.have ?? h)));
    if (s) at.a = join(at.a, {y: at.a.y + at.a.rows, rows: 0, lin: [0, 1, 2].map(() => new Uint16Array(0))}, w, keep);
    at.b = join(at.b, at.b.rgba ? {y: at.b.y + at.b.rows, rows: 0, rgba: new Uint8Array(0)} : {y: at.b.y + at.b.rows, rows: 0, lin: [0, 1, 2].map(() => new Uint16Array(0))}, w, keep);
  };
  return {
    push(y, n, rgba) {
      const top = held[0];
      if (y !== top.have) throw new RangeError('A streamed cell map takes its rows in order.');
      top.b = join(top.b, {y, rows: n, rgba}, width, Math.max(0, top.next - N));
      top.have += n;
      const part = [];
      feed(0, part);
      return part;
    },
    save() { return held.map(({next, have, a, b}) => ({next, have, a, b: b && {y: b.y, rows: b.rows, ...(b.rgba ? {rgba: b.rgba} : {lin: b.lin})}})); },
    restore(saved) { saved.forEach((place, s) => Object.assign(held[s], place)); },
    finish(parts) {
      const out = scales.map(({w, h}, s) => ({w, h, sums: terms[s].map(term => ({...term, sum: new Uint32Array((term.p === 1 ? 1 : 2) * (s <= 3 ? stride * rows : w * h))}))}));
      for (const part of parts) for (const {s, cell, sums} of part) sums.forEach((add, i) => {
        const {p, sum} = out[s].sums[i];
        if (p === 1) { for (let j = 0; j < add.length; j++) sum[cell + j] += add[j]; return; }
        for (let j = 0; j < add.length; j += 2) {
          const at = 2 * cell + j;
          let lo = sum[at] + add[j], hi = sum[at + 1] + add[j + 1];
          if (lo >= TWO32) { lo -= TWO32; hi += 1; }
          sum[at] = lo; sum[at + 1] = hi;
        }
      });
      return {scales: out.map(({w, h, sums}) => ({w, h, sums: [0, 1, 2].flatMap(c => sums.filter(term => term.c === c))})), stride, rows};
    },
  };
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
