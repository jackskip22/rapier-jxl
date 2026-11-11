// SPDX-License-Identifier: MIT
import {scaleBand, scaleBandPair, pairState, bandState, downsample, referenceArena, useReferenceArena, releaseReferenceArena} from './ssimulacra2-arithmetic.mjs';
import {GAUSS32, scaleNorm, scoreNorms} from './ssimulacra2.mjs';
import {SCALES} from './ssimulacra2-reference.mjs';

const rowsOf = (held, y, rows, w) => held.rgba
  ? {rgba: held.rgba.subarray((y - held.y) * w * 4, (y - held.y + rows) * w * 4)}
  : held.planes.map(p => p.subarray((y - held.y) * w, (y - held.y + rows) * w));
function append(held, more, rows, w, keep) {
  const per = more.rgba ? w * 4 : w, drop = Math.max(0, keep - held.y), left = held.rows - drop;
  const join = (old, add) => {
    const out = new add.constructor((left + rows) * per);
    if (left > 0) out.set(old.subarray(drop * per, held.rows * per));
    out.set(add.subarray(0, rows * per), left * per);
    return out;
  };
  return more.rgba ? {y: held.y + drop, rows: left + rows, rgba: join(held.rgba ?? new Uint8Array(0), more.rgba)}
    : {y: held.y + drop, rows: left + rows, planes: [0, 1, 2].map(c => join(held.planes?.[c] ?? new Float32Array(0), more[c]))};
}

const AGAIN = 12;
export function s2Stream(reference, width, height, outputs, resumable = false) {
  if (width < 8 || height < 8) throw new RangeError('A streamed SSIMULACRA 2 needs at least 8 x 8 pixels.');
  const scales = [];
  for (let s = 0, w = width, h = height; s < SCALES; s++) {
    if (s) { if (w < 8 || h < 8) break; w = (w + 1) >> 1; h = (h + 1) >> 1; }
    scales.push({w, h, have: 0, ref: {y: 0, rows: 0}, out: Array.from({length: outputs}, () => ({y: 0, rows: 0})),
      first: -4, state: new Array(outputs).fill(null), odd: null});
  }
  const arena = referenceArena([]);
  const feed = (s, ref, outs, rows) => {
    const sc = scales[s], {w, h} = sc, from = sc.have;
    const keep = Math.min(h, Math.ceil((sc.first + 4) / 4) * 4), kept = resumable ? Math.max(0, keep - AGAIN) : keep;
    sc.ref = append(sc.ref, ref, rows, w, kept);
    sc.out = sc.out.map((held, k) => append(held, outs[k], rows, w, kept));
    sc.have += rows;
    const end = sc.have >= h ? h : Math.floor(sc.have / 4) * 4 - 4;
    if (end > sc.first) {
      const again = sc.state[0]?.states !== undefined, next = Math.ceil((sc.first + 4) / 4) * 4, inputY = again ? Math.max(0, next - AGAIN) : Math.min(h, next);
      const inputEnd = Math.min(h, Math.ceil((end + 4) / 4) * 4), a = rowsOf(sc.ref, inputY, inputEnd - inputY, w);
      const pair = outputs === 2 ? scaleBandPair(a, rowsOf(sc.out[0], inputY, inputEnd - inputY, w), rowsOf(sc.out[1], inputY, inputEnd - inputY, w),
        w, h, GAUSS32, sc.first, end, sc.state[0], sc.state[1], again ? inputY : null) : null;
      if (pair) sc.state = pair;
      else for (let k = 0; k < outputs; k++) sc.state[k] = scaleBand(a, rowsOf(sc.out[k], inputY, inputEnd - inputY, w), w, h, GAUSS32, sc.first, end, sc.state[k], again ? inputY : null);
      sc.first = end;
    }
    if (s + 1 >= scales.length) return;
    let y = from, n = rows;
    if (sc.odd !== null) { y -= 1; n += 1; }
    const pairRows = sc.have >= h ? n : n & ~1;
    if (pairRows > 0) {
      const down = image => downsample(rowsOf(image, y, pairRows, w), w, pairRows).planes;
      feed(s + 1, down(sc.ref), sc.out.map(down), Math.ceil(pairRows / 2));
    }
    sc.odd = pairRows < n ? y + pairRows : null;
  };
  return {
    push(y, rows, pictures) {
      if (y !== scales[0].have || pictures.length !== outputs) throw new RangeError('A streamed SSIMULACRA 2 takes its rows in order.');
      const close = useReferenceArena(arena);
      try { feed(0, {rgba: reference.rgba.subarray(y * width * 4, (y + rows) * width * 4)}, pictures.map(rgba => ({rgba})), rows); }
      finally { close(); }
    },
    finish() {
      if (scales[0].have !== height) throw new RangeError('A streamed SSIMULACRA 2 is missing rows.');
      return Array.from({length: outputs}, (_, k) => {
        const norms = scales.map(({w, h, state}) => {
          const per = {ssim: new Float64Array(6), edge: new Float64Array(12)};
          for (let c = 0; c < 3; c++) scaleNorm(per, c, state[k].sums.subarray(c * 6, c * 6 + 6), w * h);
          return per;
        });
        return scoreNorms(norms).score;
      });
    },
    release() { releaseReferenceArena(arena); for (const sc of scales) { sc.ref = sc.out = sc.state = null; } },
    save() {
      return scales.map(({w, have, ref, out, first, state, odd}) => {
        const keep = Math.min(have, Math.max(0, Math.ceil((first + 4) / 4) * 4 - AGAIN), odd ?? Infinity), trim = held => {
          const drop = Math.max(0, keep - held.y);
          if (!drop) return held;
          const per = held.rgba ? w * 4 : w, cut = a => a.slice(drop * per, held.rows * per);
          return held.rgba ? {y: held.y + drop, rows: held.rows - drop, rgba: cut(held.rgba)} : {y: held.y + drop, rows: held.rows - drop, planes: held.planes.map(cut)};
        };
        const places = state.map(s => s && (s.states ? s : bandState(s, w)));
        if (state[1]?.pair) places[1] = pairState(places[0], places[1], w);
        return {have, ref: trim(ref), out: out.map(trim), first, state: places, odd};
      });
    },
    restore(saved) {
      if (!Array.isArray(saved) || saved.length !== scales.length) throw new RangeError('A streamed SSIMULACRA 2 place does not match its picture.');
      saved.forEach(({have, ref, out, first, state, odd}, s) => Object.assign(scales[s], {have, ref, out: out.slice(), first, state: state.slice(), odd}));
    },
    get rows() { return scales[0].have; },
  };
}
