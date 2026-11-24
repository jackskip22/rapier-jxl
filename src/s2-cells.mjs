// SPDX-License-Identifier: MIT
import {OPSIN} from './color-transform.mjs';
import {fault} from './fault.mjs';
import {SSIMULACRA2_WEIGHTS, finalCurve} from './ssimulacra2.mjs';
import {srgbLevels} from './srgb-levels.mjs';
import {cbrtTables, IS_BIAS, BLACK} from './int-spec.mjs';
import {kernelHooks} from './kernel-hooks.mjs';

const R_HALF = Float64Array.from({length: 32}, (_, k) => k ? 2 ** (k - 1) : 0.5), R_INV = Float64Array.from({length: 32}, (_, k) => 2 ** -k);
const R = (s, k) => Math.floor((s + R_HALF[k]) * R_INV[k]);

const SCALES = 6, N = 4, TWO32 = 4294967296;
let lin;
export const s2cLin = () => lin ??= Int32Array.from(srgbLevels(), v => Math.round(v * 32768));
export const S2C_MIX = Int32Array.from({length: 9}, (_, j) => j % 3 < 2 ? Math.round(OPSIN[j] * 16384)
  : 16384 - Math.round(OPSIN[j - 2] * 16384) - Math.round(OPSIN[j - 1] * 16384));
export const S2C_TAPS = Int32Array.of(617, 2360, 7165, 13954, 17344, 13954, 7165, 2360, 617);
let PREP_TABLES = null;
const prepTables = () => {
  if (PREP_TABLES) return PREP_TABLES;
  if (!kernelHooks.s2cPrep) kernelHooks.ensure?.();
  const {lo, hi} = cbrtTables(), linTbl = s2cLin();
  return PREP_TABLES = {bias: IS_BIAS, black: BLACK, mix: S2C_MIX, lin: linTbl,
    cones: Array.from({length: 9}, (_, j) => Int32Array.from(linTbl, v => S2C_MIX[j] * v)), lo, hi};
};
function prepCall(op, a0, a1, a2, a3, a4) {
  const tables = prepTables(), res = kernelHooks.s2cPrep?.(op, tables, a0, a1, a2, a3, a4);
  if (!res) throw fault('JXL_WASM', 'WebAssembly SIMD required');
  return res;
}
const linPlanes = (planes, n) => prepCall('lin3', planes, n);
const rgbaPlanes = (rgba, n) => prepCall('rgba3', rgba, n);
const rgbaChannel = (rgba, n, c, out) => prepCall('rgba1', rgba, n, c, out);

export function s2cScales(width, height) {
  const scales = [];
  for (let s = 0, w = width, h = height; s < SCALES; s++) {
    if (w < 8 || h < 8) break;
    if (s) { w = (w + 1) >> 1; h = (h + 1) >> 1; }
    scales.push({w, h});
  }
  return scales;
}

const down = (pic, pw, ph, w, h) => prepCall('down', pic, pw, ph, w, h);
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

export function s2CellStream(reference, width, height, yOnly = false) {
  const scales = s2cScales(width, height), stride = Math.ceil(width / 8), rows = Math.ceil(height / 8);
  const raw = reference.rgba, prev = raw && ArrayBuffer.isView(raw) ? (reference.s2c?.rgba === raw ? reference.s2c : S2C_REFS.get(raw)) : null;
  const cachedRef = raw && ArrayBuffer.isView(raw) ? (prev?.rgba === raw && prev.width === width && prev.height === height ? prev
    : {rgba: raw, width, height, p0: [null, null, null], below: []}) : null;
  if (cachedRef) { S2C_REFS.set(raw, cachedRef); reference.s2c = cachedRef; cachedRef.p0 ??= [null, null, null]; }
  const ref = {rgba: reference.rgba, y: 0}, held = scales.map(() => ({next: 0, have: 0, a: null, b: null}));
  const terms = scales.map((_, s) => {
    const list = [];
    for (let c = yOnly && !s ? 1 : 0; c < (yOnly && !s ? 2 : 3); c++) for (let t = 0; t < 3; t++) for (const p of [1, 4]) {
      const k = c * 36 + s * 6 + t + (p === 4 ? 3 : 0);
      if (SSIMULACRA2_WEIGHTS[k]) list.push({k, c, t, p});
    }
    return list;
  });
  const xybRows = (pic, w, from, to, c, out) => {
    const count = (to - from) * w, off = (from - pic.y) * w;
    if (pic.rgba) return rgbaChannel(pic.rgba.subarray(off * 4, (off + count) * 4), count, c, out);
    const planes = linPlanes([pic.lin[0].subarray(off, off + count), pic.lin[1].subarray(off, off + count), pic.lin[2].subarray(off, off + count)], count);
    out.set(planes[c]);
    return out;
  };
  const halve = (pic, pw, ph, w, y, n) => {
    const sy0 = 2 * y - pic.y, shRows = Math.min(ph - 2 * y, 2 * n);
    const sub = pic.rgba
      ? {rgba: pic.rgba.subarray(sy0 * pw * 4, (sy0 + shRows) * pw * 4)}
      : {lin: pic.lin.map(p => p.subarray(sy0 * pw, (sy0 + shRows) * pw))};
    return {y, rows: n, lin: down(sub, pw, shRows, w, n).lin};
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
      if (cachedRef && s && !cachedRef.below[s]) {
        const p = scales[s - 1], src = s === 1 ? cachedRef : cachedRef.below[s - 1];
        const made = down(src, p.w, p.h, w, h);
        made.xyb = linPlanes(made.lin, w * h);
        if (s > 1 && cachedRef.below[s - 1]) cachedRef.below[s - 1].lin = null;
        cachedRef.below[s] = made;
      }
      const a = s ? at.a : ref, P1 = cachedRef ? null : new Int16Array((to - from) * w), P2 = new Int16Array((to - from) * w), sums = [];
      for (let c = 0; c < 3; c++) {
        const active = terms[s].filter(term => term.c === c);
        if (!active.length) continue;
        const acc1 = [null, null, null], acc4 = [null, null, null];
        for (const term of active) sums.push((term.p === 1 ? acc1 : acc4)[term.t] = new Uint32Array(term.p === 1 ? c1 - c0 : 2 * (c1 - c0)));
        let refSlice;
        if (cachedRef) {
          const fullPlane = s ? cachedRef.below[s].xyb[c] : (cachedRef.p0[c] ??= rgbaChannel(cachedRef.rgba, w * h, c, new Int16Array(w * h)));
          refSlice = fullPlane.subarray(from * w, to * w);
        } else refSlice = xybRows(a, w, from, to, c, P1);
        kernelSums(refSlice, xybRows(at.b, w, from, to, c, P2), w, h, sh, stride, acc1, acc4, {y0: at.next, y1: limit, from, cellRow0: c0});
      }
      part.push({s, cell: c0, sums});
      at.next = limit;
    }
    if (s + 1 < scales.length) {
      const below = held[s + 1], {w: nw, h: nh} = scales[s + 1], end = at.have >= h ? nh : at.have >> 1;
      if (end > below.have) {
        const y = below.have, n = end - y;
        if (!cachedRef) below.a = join(below.a, halve(s ? at.a : ref, w, h, nw, y, n), nw, Math.max(0, below.next - N));
        below.b = join(below.b, halve(at.b, w, h, nw, y, n), nw, Math.max(0, below.next - N));
        below.have = end;
        feed(s + 1, part);
      }
    }
    const keep = Math.max(0, Math.min(at.next - N, 2 * (held[s + 1]?.have ?? h)));
    if (s && !cachedRef) at.a = join(at.a, {y: at.a.y + at.a.rows, rows: 0, lin: [0, 1, 2].map(() => new Uint16Array(0))}, w, keep);
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

const S2C_REFS = new WeakMap();
export function s2CellSums(reference, candidate, width, height, yOnly = false) {
  const scales = s2cScales(width, height), stride = Math.ceil(width / 8), rows = Math.ceil(height / 8), out = [];
  const raw = reference.rgba, held = reference.s2c?.rgba === raw ? reference.s2c : S2C_REFS.get(raw);
  const kept = held?.rgba === raw && held.width === width && held.height === height ? held
    : {rgba: raw, width, height, p0: [null, null, null], below: []};
  if (ArrayBuffer.isView(raw)) S2C_REFS.set(raw, kept);
  reference.s2c = kept;
  kept.p0 ??= [null, null, null];
  let a = kept, b = {rgba: candidate.rgba};
  for (const [s, {w, h}] of scales.entries()) {
    if (s) {
      const p = scales[s - 1];
      if (!kept.below[s]) { const made = down(a, p.w, p.h, w, h); plane(made, w * h, 0, new Int16Array(w * h)); if (kept.below[s - 1]) kept.below[s - 1].lin = null; kept.below[s] = made; }
      a = kept.below[s]; b = down(b, p.w, p.h, w, h);
    }
    const n = s <= 3 ? stride * rows : w * h, sh = s <= 3 ? 3 - s : -1, sums = [];
    if (!s && !yOnly) {
      if (!kept.p0[0] || !kept.p0[1] || !kept.p0[2]) { const [rx, ry, rb] = rgbaPlanes(kept.rgba, w * h); kept.p0[0] ??= rx; kept.p0[1] ??= ry; kept.p0[2] ??= rb; }
      b.xyb = rgbaPlanes(b.rgba, w * h);
    } else if (s) {
      a.xyb ??= linPlanes(a.lin, w * h);
      b.xyb ??= linPlanes(b.lin, w * h);
    }
    let P2 = null;
    for (let c = yOnly && !s ? 1 : 0; c < (yOnly && !s ? 2 : 3); c++) {
      const acc1 = [null, null, null], acc4 = [null, null, null], active = [];
      for (let t = 0; t < 3; t++) for (const p of [1, 4]) {
        const k = c * 36 + s * 6 + t + (p === 4 ? 3 : 0);
        if (!SSIMULACRA2_WEIGHTS[k]) continue;
        const sum = new Uint32Array(p === 1 ? n : 2 * n);
        (p === 1 ? acc1 : acc4)[t] = sum; active.push({k, c, t, p, sum});
      }
      if (!active.length) continue;
      const refP = s ? a.xyb[c] : (kept.p0[c] ??= rgbaChannel(kept.rgba, w * h, c, new Int16Array(w * h)));
      const candP = b.xyb ? b.xyb[c] : rgbaChannel(b.rgba, w * h, c, P2 ??= new Int16Array(w * h));
      kernelSums(refP, candP, w, h, sh, stride, acc1, acc4);
      sums.push(...active);
    }
    if (!s) b.xyb = null;
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
      const weight = SSIMULACRA2_WEIGHTS[k], m = p === 1 ? sum.length : sum.length / 2;
      let t = 0;
      if (p === 1) for (let i = 0; i < m; i++) t += sum[i];
      else for (let i = 0; i < m; i++) t += sum[2 * i + 1] * TWO32 + sum[2 * i];
      const norm = p === 1 ? t / n / 65536 : Math.sqrt(Math.sqrt(t / n)) / 4096, ref = at ? at.norms[norms.length] : norm;
      norms.push(norm);
      total += weight * norm;
      const coef = p === 1 ? weight / n / 65536 : ref > 0 ? weight / (4 * n * ref * ref * ref) / 281474976710656 : 0;
      if (per < 0) {
        if (p === 1) for (let i = 0; i < m; i++) cells[i] += coef * sum[i];
        else for (let i = 0; i < m; i++) cells[i] += coef * (sum[2 * i + 1] * TWO32 + sum[2 * i]);
      } else {
        const f = coef / 4 ** per;
        for (let cy = 0; cy < rows; cy++) for (let cx = 0; cx < stride; cx++) {
          const i = (cy >> per) * w + (cx >> per);
          cells[cy * stride + cx] += f * (p === 1 ? sum[i] : sum[2 * i + 1] * TWO32 + sum[2 * i]);
        }
      }
    }
  }
  return {cells, score: finalCurve(total), norms};
}
