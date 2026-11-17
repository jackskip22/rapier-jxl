// SPDX-License-Identifier: MIT
import {fault} from './fault.mjs';
import {SSIMULACRA2_WEIGHTS, gaussianTaps, finalCurve} from './ssimulacra2.mjs';
import {srgbLevels} from './srgb-levels.mjs';
import {cbrtTables, IS_BIAS, BLACK} from './int-spec.mjs';
import {kernelHooks} from './kernel-hooks.mjs';

const R_HALF = Float64Array.from({length: 32}, (_, k) => k ? 2 ** (k - 1) : 0.5), R_INV = Float64Array.from({length: 32}, (_, k) => 2 ** -k);
const R = (s, k) => Math.floor((s + R_HALF[k]) * R_INV[k]);

const SCALES = 6, N = 4, TWO32 = 4294967296;
let lin;
export const s2cLin = () => lin ??= Int32Array.from(srgbLevels(), v => Math.round(v * 32768));
const OPSIN = [0.30, 0.622, 0.078, 0.23, 0.692, 0.078, 0.24342268924547819, 0.20476744424496821, 0.55180986650955360];
export const S2C_MIX = Int32Array.from({length: 9}, (_, j) => j % 3 < 2 ? Math.round(OPSIN[j] * 16384)
  : 16384 - Math.round(OPSIN[j - 2] * 16384) - Math.round(OPSIN[j - 1] * 16384));
export const S2C_TAPS = (() => { const t = Array.from(gaussianTaps(), v => Math.round(v * 65536)); t[N] += 65536 - t.reduce((a, b) => a + b, 0); return Int32Array.from(t); })();
const check = (v, bound, what) => { if (!(Math.abs(v) < bound)) throw fault('JXL_INTERNAL', `s2-cells:${what} ${v}`); return v; };
let ROOTS = null;
const cbrt = v => { const {lo, hi} = ROOTS ??= cbrtTables(); return v < 65536 ? lo[v] : hi[Math.floor((v + 8) * 0.0625)]; };

const [M0, M1, M2, M3, M4, M5, M6, M7, M8] = S2C_MIX;
function xyb(r, g, b, out, o) {
  const {lo, hi} = ROOTS ??= cbrtTables();
  const v0 = (M0 * r + M1 * g + M2 * b + 256 >> 9) + IS_BIAS, v1 = (M3 * r + M4 * g + M5 * b + 256 >> 9) + IS_BIAS, v2 = (M6 * r + M7 * g + M8 * b + 256 >> 9) + IS_BIAS;
  const l = (v0 < 65536 ? lo[v0] : hi[v0 + 8 >> 4]) - BLACK, m = (v1 < 65536 ? lo[v1] : hi[v1 + 8 >> 4]) - BLACK, s = (v2 < 65536 ? lo[v2] : hi[v2 + 8 >> 4]) - BLACK;
  out[o] = check(7 * (l - m) + 440530 >> 8, 8192, 'X');
  out[o + 1] = check(l + m + 21228 >> 9, 8192, 'Y');
  out[o + 2] = check(2 * s - (l + m) + 1153690 >> 9, 8192, 'B');
}
let CONES = null;
function linPlanes([R0, G0, B0], n) {
  const {lo, hi} = ROOTS ??= cbrtTables(), X = new Int16Array(n), Y = new Int16Array(n), B = new Int16Array(n);
  const root = v => v < 65536 ? lo[v] : hi[v + 8 >> 4];
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const r = R0[i], g = G0[i], b = B0[i];
    const l = root((M0 * r + M1 * g + M2 * b + 256 >> 9) + IS_BIAS) - BLACK, m = root((M3 * r + M4 * g + M5 * b + 256 >> 9) + IS_BIAS) - BLACK;
    const s = root((M6 * r + M7 * g + M8 * b + 256 >> 9) + IS_BIAS) - BLACK, x = 7 * (l - m) + 440530 >> 8, y = l + m + 21228 >> 9, z = 2 * s - (l + m) + 1153690 >> 9;
    X[i] = x; Y[i] = y; B[i] = z; bad |= x >= 8192 || x <= -8192 || y >= 8192 || y <= -8192 || z >= 8192 || z <= -8192;
  }
  if (bad) throw fault('JXL_INTERNAL', 's2-cells:xyb-1');
  return [X, Y, B];
}

function rgbaChannel(rgba, n, c, out) {
  const {lo, hi} = ROOTS ??= cbrtTables(), [t0, t1, t2, t3, t4, t5, t6, t7, t8] = CONES ??= Array.from({length: 9}, (_, j) => Int32Array.from(s2cLin(), v => S2C_MIX[j] * v));
  const root = v => v < 65536 ? lo[v] : hi[v + 8 >> 4];
  let bad = 0;
  for (let i = 0, a = 0; i < n; i++, a += 4) {
    const r = rgba[a], g = rgba[a + 1], b = rgba[a + 2];
    const l = root((t0[r] + t1[g] + t2[b] + 256 >> 9) + IS_BIAS) - BLACK, m = root((t3[r] + t4[g] + t5[b] + 256 >> 9) + IS_BIAS) - BLACK;
    const v = c === 1 ? l + m + 21228 >> 9 : c === 0 ? 7 * (l - m) + 440530 >> 8 : 2 * (root((t6[r] + t7[g] + t8[b] + 256 >> 9) + IS_BIAS) - BLACK) - (l + m) + 1153690 >> 9;
    out[i] = v; bad |= v >= 8192 || v <= -8192;
  }
  if (bad) throw fault('JXL_INTERNAL', 's2-cells:xyb-2');
  return out;
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
  const l0 = new Uint16Array(w * h), l1 = new Uint16Array(w * h), l2 = new Uint16Array(w * h), {rgba} = pic, S2C_LIN = s2cLin();
  for (let y = 0, o = 0; y < h; y++) {
    const r0 = 2 * y * pw, r1 = Math.min(2 * y + 1, ph - 1) * pw;
    if (rgba) for (let x = 0; x < w; x++, o++) {
      const x0 = 2 * x, x1 = Math.min(x0 + 1, pw - 1), a = (r0 + x0) * 4, b = (r0 + x1) * 4, c = (r1 + x0) * 4, d = (r1 + x1) * 4;
      l0[o] = Math.floor((S2C_LIN[rgba[a]] + S2C_LIN[rgba[b]] + S2C_LIN[rgba[c]] + S2C_LIN[rgba[d]] + 2) * 0.25);
      l1[o] = Math.floor((S2C_LIN[rgba[a + 1]] + S2C_LIN[rgba[b + 1]] + S2C_LIN[rgba[c + 1]] + S2C_LIN[rgba[d + 1]] + 2) * 0.25);
      l2[o] = Math.floor((S2C_LIN[rgba[a + 2]] + S2C_LIN[rgba[b + 2]] + S2C_LIN[rgba[c + 2]] + S2C_LIN[rgba[d + 2]] + 2) * 0.25);
    }
    else {
      const [s0, s1, s2] = pic.lin;
      for (let x = 0; x < w; x++, o++) {
        const x0 = 2 * x, x1 = Math.min(x0 + 1, pw - 1), a = r0 + x0, b = r0 + x1, c = r1 + x0, d = r1 + x1;
        l0[o] = (s0[a] + s0[b] + s0[c] + s0[d] + 2) >> 2; l1[o] = (s1[a] + s1[b] + s1[c] + s1[d] + 2) >> 2; l2[o] = (s2[a] + s2[b] + s2[c] + s2[d] + 2) >> 2;
      }
    }
  }
  return {lin: [l0, l1, l2]};
}
function plane(pic, n, c, out) {
  if (pic.xyb) { out.set(pic.xyb[c]); return out; }
  if (pic.rgba) return rgbaChannel(pic.rgba, n, c, out);
  pic.xyb ??= linPlanes(pic.lin, n);
  out.set(pic.xyb[c]);
  return out;
}

function kernelSums(P1, P2, w, h, sh, stride, acc1, acc4, span = null) {
  if (!kernelHooks.s2cChannel?.(P1, P2, w, h, sh, stride, acc1, acc4, span, S2C_TAPS))
    throw fault('JXL_WASM', 'WebAssembly SIMD required');
}

export function s2CellStream(reference, width, height) {
  const scales = s2cScales(width, height), stride = Math.ceil(width / 8), rows = Math.ceil(height / 8);
  const ref = {rgba: reference.rgba, y: 0}, held = scales.map(() => ({next: 0, have: 0, a: null, b: null}));
  const terms = scales.map((_, s) => {
    const list = [];
    for (let c = 0; c < 3; c++) for (let t = 0; t < 3; t++) for (const p of [1, 4]) {
      const k = c * scales.length * 6 + s * 6 + t + (p === 4 ? 3 : 0);
      if (SSIMULACRA2_WEIGHTS[k]) list.push({k, c, t, p});
    }
    return list;
  });
  const xybRows = (pic, w, from, to, c, out) => {
    if (pic.rgba) return rgbaChannel(pic.rgba.subarray((from - pic.y) * w * 4, (to - pic.y) * w * 4), (to - from) * w, c, out);
    const v = new Int32Array(3);
    for (let i = 0, at = (from - pic.y) * w; i < (to - from) * w; i++, at++) { xyb(pic.lin[0][at], pic.lin[1][at], pic.lin[2][at], v, 0); out[i] = v[c]; }
    return out;
  };
  const halve = (pic, pw, ph, w, y, n) => {
    const lin = [0, 1, 2].map(() => new Uint16Array(w * n)), S2C_LIN = s2cLin();
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
        kernelSums(xybRows(a, w, from, to, c, P1), xybRows(at.b, w, from, to, c, P2), w, h, sh, stride, acc1, acc4, {y0: at.next, y1: limit, from, cellRow0: c0});
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
      if (y !== top.have) throw fault('JXL_INTERNAL', 's2-cells:order');
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

export function s2CellSums(reference, candidate, width, height, yOnly = false) {
  const scales = s2cScales(width, height), stride = Math.ceil(width / 8), rows = Math.ceil(height / 8), out = [];
  const kept = reference.s2c?.rgba === reference.rgba && reference.s2c.width === width && reference.s2c.height === height
    ? reference.s2c : (reference.s2c = {rgba: reference.rgba, width, height, p0: [null, null, null], below: []});
  kept.p0 ??= [null, null, null];
  let a = kept, b = {rgba: candidate.rgba};
  for (const [s, {w, h}] of scales.entries()) {
    if (s) {
      const p = scales[s - 1];
      if (!kept.below[s]) { const made = down(a, p.w, p.h, w, h); plane(made, w * h, 0, new Int16Array(w * h)); if (kept.below[s - 1]) kept.below[s - 1].lin = null; kept.below[s] = made; }
      a = kept.below[s]; b = down(b, p.w, p.h, w, h);
    }
    const n = s <= 3 ? stride * rows : w * h, sh = s <= 3 ? 3 - s : -1, sums = [], P1 = s ? new Int16Array(w * h) : null, P2 = new Int16Array(w * h);
    for (let c = yOnly && !s ? 1 : 0; c < (yOnly && !s ? 2 : 3); c++) {
      const acc1 = [null, null, null], acc4 = [null, null, null], active = [];
      for (let t = 0; t < 3; t++) for (const p of [1, 4]) {
        const k = c * scales.length * 6 + s * 6 + t + (p === 4 ? 3 : 0);
        if (!SSIMULACRA2_WEIGHTS[k]) continue;
        const sum = new Uint32Array(p === 1 ? n : 2 * n);
        (p === 1 ? acc1 : acc4)[t] = sum; active.push({k, c, t, p, sum});
      }
      if (!active.length) continue;
      const refP = s ? plane(a, w * h, c, P1) : (kept.p0[c] ??= rgbaChannel(kept.rgba, w * h, c, new Int16Array(w * h)));
      kernelSums(refP, plane(b, w * h, c, P2), w, h, sh, stride, acc1, acc4);
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
