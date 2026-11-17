// SPDX-License-Identifier: MIT
import {fault} from './fault.mjs';
import {scaleBand, scaleBandPair, pairState, bandState, residentScratch, downsample, referenceArena, useReferenceArena, releaseReferenceArena} from './ssimulacra2-arithmetic.mjs';
import {GAUSS32, scaleNorm, scoreNorms} from './ssimulacra2.mjs';
import {SCALES} from './ssimulacra2-reference.mjs';

const rowsOf = (held, y, rows, w) => held.rgba
  ? {rgba: held.rgba.subarray((y - held.y) * w * 4, (y - held.y + rows) * w * 4)}
  : held.planes.map(p => p.subarray((y - held.y) * w, (y - held.y + rows) * w));
const ROOM = 32;
function append(held, more, rows, w, keep) {
  const per = more.rgba ? w * 4 : w, drop = Math.max(0, keep - held.y), left = held.rows - drop, need = (left + rows) * per;
  const join = (old, add) => {
    const out = held.own && old.length >= need ? old : new add.constructor(need + ROOM * per);
    if (left > 0 && out !== old) out.set(old.subarray(drop * per, held.rows * per));
    else if (left > 0 && drop > 0) out.copyWithin(0, drop * per, held.rows * per);
    out.set(add.subarray(0, rows * per), left * per);
    return out;
  };
  return more.rgba ? {y: held.y + drop, rows: left + rows, own: true, rgba: join(held.rgba ?? new Uint8Array(0), more.rgba)}
    : {y: held.y + drop, rows: left + rows, own: true, planes: [0, 1, 2].map(c => join(held.planes?.[c] ?? new Float32Array(0), more[c]))};
}

const AGAIN = 12;
export function s2Stream(reference, width, height, outputs, resumable = false, libjxl = false, refCache = null) {
  if (width < 8 || height < 8) throw fault('JXL_INTERNAL', 'photo-s2-stream:size');
  const scales = [];
  for (let s = 0, w = width, h = height; s < SCALES; s++) {
    if (s) { if (w < 8 || h < 8) break; w = (w + 1) >> 1; h = (h + 1) >> 1; }
    scales.push({w, h, have: 0, ref: {y: 0, rows: 0}, out: Array.from({length: outputs}, () => ({y: 0, rows: 0})),
      first: -4, state: new Array(outputs).fill(null), odd: null, halves: Array.from({length: outputs + 1}, () => null)});
  }
  const arena = referenceArena([], outputs <= 2 ? scales.map(sc => outputs === 1 ? -sc.w : sc.w) : []);
  const feed = (s, ref, outs, rows) => {
    const sc = scales[s], {w, h} = sc, from = sc.have;
    const keep = Math.min(h, Math.ceil((sc.first + 4) / 4) * 4), kept = resumable ? Math.max(0, keep - AGAIN) : keep;
    sc.ref = !resumable && (!s && reference.rgba || refCache?.[s]?.h >= from + rows) ? {y: 0, rows: from + rows, ...(s ? {planes: refCache[s].p} : {rgba: reference.rgba})} : append(sc.ref, ref, rows, w, kept);
    sc.out = sc.out.map((held, k) => append(held, outs[k], rows, w, kept));
    sc.have += rows;
    const end = sc.have >= h ? h : Math.floor(sc.have / 4) * 4 - 4;
    if (end > sc.first) {
      const again = sc.state[0]?.states !== undefined, next = Math.ceil((sc.first + 4) / 4) * 4, inputY = again ? Math.max(0, next - AGAIN) : Math.min(h, next);
      const inputEnd = Math.min(h, Math.ceil((end + 4) / 4) * 4), a = rowsOf(sc.ref, inputY, inputEnd - inputY, w);
      const place = arena.places[s] ?? null;
      const pair = outputs === 2 ? scaleBandPair(a, rowsOf(sc.out[0], inputY, inputEnd - inputY, w), rowsOf(sc.out[1], inputY, inputEnd - inputY, w),
        w, h, GAUSS32, sc.first, end, sc.state[0], sc.state[1], again ? inputY : null, place, libjxl) : null;
      if (pair) sc.state = pair;
      else for (let k = 0; k < outputs; k++) sc.state[k] = scaleBand(a, rowsOf(sc.out[k], inputY, inputEnd - inputY, w), w, h, GAUSS32, sc.first, end, sc.state[k], again ? inputY : null, libjxl, outputs === 1 ? place : null);
      sc.first = end;
    }
    if (s + 1 >= scales.length) return;
    let y = from, n = rows;
    if (sc.odd !== null) { y -= 1; n += 1; }
    const pairRows = sc.have >= h ? n : n & ~1;
    if (pairRows > 0) {
      const w1 = w + 1 >> 1, r1 = pairRows + 1 >> 1, m = w1 * r1, down = (image, k) => {
        if (!sc.halves[k] || sc.halves[k][0].length < m) sc.halves[k] = [0, 1, 2].map(() => new Float32Array(m + ROOM * w1));
        return downsample(rowsOf(image, y, pairRows, w), w, pairRows, sc.halves[k]).planes;
      };
      let dRef;
      if (refCache && !resumable) {
        const y1 = y >> 1, h1 = scales[s + 1].h;
        let e = refCache[s + 1];
        if (!e || e.h < h1) {
          if (e?.h !== y1) e = refCache[s + 1] = {p: [0, 1, 2].map(() => new Float32Array(w1 * h1)), h: 0};
          downsample(rowsOf(sc.ref, y, pairRows, w), w, pairRows, e.p.map(p => p.subarray(y1 * w1, (y1 + r1) * w1)));
          e.h = y1 + r1;
        }
        dRef = e.p.map(p => p.subarray(y1 * w1, (y1 + r1) * w1));
      } else dRef = down(sc.ref, 0);
      feed(s + 1, dRef, sc.out.map((image, k) => down(image, k + 1)), r1);
    }
    sc.odd = pairRows < n ? y + pairRows : null;
  };
  return {
    push(y, rows, pictures) {
      if (y !== scales[0].have || pictures.length !== outputs) throw fault('JXL_INTERNAL', 'photo-s2-stream:order');
      const close = useReferenceArena(arena, false);
      try { feed(0, reference.rgba ? {rgba: reference.rgba.subarray(y * width * 4, (y + rows) * width * 4)} : reference(y, rows), pictures.map(p => Array.isArray(p) ? p : {rgba: p}), rows); }
      finally { close(); }
    },
    finish() {
      if (scales[0].have !== height) throw fault('JXL_INTERNAL', 'photo-s2-stream:missing');
      return Array.from({length: outputs}, (_, k) => {
        const norms = scales.map(({w, h, state}) => {
          const per = {ssim: new Float64Array(6), edge: new Float64Array(12)};
          for (let c = 0; c < 3; c++) scaleNorm(per, c, state[k].sums.subarray(c * 6, c * 6 + 6), w * h);
          return per;
        });
        return scoreNorms(norms).score;
      });
    },
    release() { releaseReferenceArena(arena); for (const sc of scales) { sc.ref = sc.out = sc.state = sc.halves = null; } },
    save() {
      return scales.map(({w, have, ref, out, first, state, odd}, s) => {
        const keep = Math.min(have, Math.max(0, Math.ceil((first + 4) / 4) * 4 - AGAIN), odd ?? Infinity), trim = held => {
          const drop = Math.max(0, keep - held.y);
          if (!held.rgba && !held.planes) return held;
          const per = held.rgba ? w * 4 : w, cut = a => a.slice(drop * per, held.rows * per);
          return held.rgba ? {y: held.y + drop, rows: held.rows - drop, rgba: cut(held.rgba)} : {y: held.y + drop, rows: held.rows - drop, planes: held.planes.map(cut)};
        };
        const places = state.map((st, k) => st && (st.states ? st : bandState(st.resident ? {scratch: residentScratch(arena, arena.places[s], st.output), sums: st.sums} : st, w)));
        if (state[1]?.pair) places[1] = pairState(places[0], places[1], w);
        return {have, ref: trim(ref), out: out.map(trim), first, state: places, odd};
      });
    },
    restore(saved) {
      if (!Array.isArray(saved) || saved.length !== scales.length) throw fault('JXL_INTERNAL', 'photo-s2-stream:place');
      saved.forEach(({have, ref, out, first, state, odd}, s) => Object.assign(scales[s], {have, ref, out: out.slice(), first, state: state.slice(), odd}));
    },
    get rows() { return scales[0].have; },
  };
}