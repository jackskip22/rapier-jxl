// SPDX-License-Identifier: MIT
import {ssimulacra2, ssimulacra2Reference} from './ssimulacra2.mjs';
import {askedLook} from './photo-quality-table.mjs';
import {call} from './capture-kernels.mjs';
import {both, out, room} from './kernel-call.mjs';
import {fault} from './fault.mjs';
import {S2_MEMORY} from './ssimulacra2-memory.mjs';

export function smoothColors(source, exact) {
  const n = source.length / 4, band = Math.min(n, 1 << 20);
  let capacity = 4096, used = 0, slots = new Uint32Array(capacity * 2), words = new Uint32Array(capacity), counts = new Uint32Array(capacity);
  const pixels = from => source.subarray(from * 4, (from + Math.min(band, n - from)) * 4), mask = from => exact.subarray(from, from + Math.min(band, n - from));
  for (let from = 0, result; from < n;) {
    [result, slots, words, counts] = call(k => k.smoothCount, [pixels(from), mask(from), Math.min(band, n - from),
      both(Uint32Array, slots), capacity * 2 - 1, both(Uint32Array, words), both(Uint32Array, counts), used, capacity]);
    if (result >= 0) { used = result; from += Math.min(band, n - from); continue; }
    from += -result - 1; used = capacity; capacity *= 2;
    [, words, counts, slots] = call(k => k.smoothRehash, [words, counts, out(Uint32Array, capacity, 1), out(Uint32Array, capacity, 1),
      out(Uint32Array, capacity * 2), capacity * 2 - 1, used]);
  }
  return {
    size: used,
    remap(step, keep = Infinity) {
      const [, table] = call(k => k.smoothPalette, [words, counts, used, step, out(Uint32Array, used), room(used * 4), room(used * 4), room(1024)]);
      if (keep !== Infinity) for (let i = 0; i < used; i++) if (counts[i] >= keep) table[i] = words[i];
      let candidate;
      try { candidate = new Uint8Array(source.length); }
      catch (cause) { throw Object.assign(fault('JXL_MEMORY', 'smooth field: out of memory'), {cause}); }
      for (let from = 0; from < n; from += band) {
        const [lost, made] = call(k => k.smoothApply, [both(Uint8Array, pixels(from)), mask(from), Math.min(band, n - from), slots, capacity * 2 - 1, words, table]);
        if (lost) throw fault('JXL_INTERNAL', 'capture-smooth-quantize:palette');
        candidate.set(made, from * 4);
      }
      return candidate;
    },
    close() { slots = words = counts = null; },
  };
}

function fieldPieces(r, rectangles) {
  const ys = [r.y, r.y + r.height], blocks = [];
  for (const e of rectangles) {
    const x0 = Math.max(r.x, e.x), y0 = Math.max(r.y, e.y), x1 = Math.min(r.x + r.width, e.x + e.width), y1 = Math.min(r.y + r.height, e.y + e.height);
    if (x0 < x1 && y0 < y1) { ys.push(y0, y1); blocks.push({x0, x1, y0, y1}); }
  }
  ys.sort((a, b) => a - b);
  const pieces = [];
  for (let i = 0; i < ys.length - 1; i++) {
    const y0 = ys[i], y1 = ys[i + 1];
    if (y1 === y0) continue;
    let spans = [[r.x, r.x + r.width]];
    for (const b of blocks) if (b.y0 <= y0 && b.y1 >= y1) {
      const next = [];
      for (const [s, e] of spans) {
        if (b.x1 <= s || b.x0 >= e) next.push([s, e]);
        else { if (b.x0 > s) next.push([s, b.x0]); if (b.x1 < e) next.push([b.x1, e]); }
      }
      spans = next;
    }
    for (const [s, e] of spans) if (e - s >= 8 && y1 - y0 >= 8) pieces.push({x: s, y: y0, width: e - s, height: y1 - y0});
  }
  return pieces;
}

function cropOf(rgba, stride, p, originX, originY) {
  const out = new Uint8Array(p.width * p.height * 4);
  for (let y = 0; y < p.height; y++) {
    const from = ((p.y - originY + y) * stride + (p.x - originX)) * 4;
    out.set(rgba.subarray(from, from + p.width * 4), y * p.width * 4);
  }
  return out;
}

function edgeChanges(candidate, width, height) {
  let changes = 0;
  const row = width * 4;
  for (let y = 0, i = 0; y < height; y++) for (let x = 0; x < width; x++, i += 4) {
    if (x && (candidate[i] !== candidate[i - 4] || candidate[i + 1] !== candidate[i - 3] || candidate[i + 2] !== candidate[i - 2])) changes++;
    if (y && (candidate[i] !== candidate[i - row] || candidate[i + 1] !== candidate[i - row + 1] || candidate[i + 2] !== candidate[i - row + 2])) changes++;
  }
  return changes;
}

export function smoothQuantize(data, width, height, regions, rectangles, intent, signal) {
  const floor = askedLook(intent), pixels = new (data instanceof Uint8ClampedArray ? Uint8ClampedArray : Uint8Array)(data), kept = [], measurements = [];
  const check = () => { if (signal?.aborted) throw signal.reason; };
  for (const r of regions) {
    check();
    const n = r.width * r.height, source = new Uint8Array(n * 4), exact = new Uint8Array(n);
    for (let y = 0; y < r.height; y++) source.set(data.subarray(((r.y + y) * width + r.x) * 4, ((r.y + y) * width + r.x + r.width) * 4), y * r.width * 4);
    for (let i = 0; i < n; i++) if (source[i * 4 + 3] !== 255) exact[i] = 1;
    for (const e of rectangles) {
      const left = Math.max(r.x, e.x), right = Math.min(r.x + r.width, e.x + e.width);
      if (left >= right) continue;
      for (let y = Math.max(r.y, e.y); y < Math.min(r.y + r.height, e.y + e.height); y++)
        exact.fill(1, (y - r.y) * r.width + left - r.x, (y - r.y) * r.width + right - r.x);
    }
    let covered = 0;
    for (let i = 0; i < n; i++) covered += exact[i];
    if (covered * 2 >= n) continue;
    const palette = smoothColors(source, exact);
    if (palette.size < 256) { palette.close(); continue; }
    const pieces = fieldPieces(r, rectangles);
    if (!pieces.length) { palette.close(); continue; }
    const large = n > 65536;
    const refs = [];
    const seen = new Set();
    let active = null;
    const scorePiece = (candidate, index) => {
      const ref = refs[index];
      const score = ssimulacra2(ref.reference, {rgba: cropOf(candidate, r.width, ref.p, r.x, r.y)}, ref.p.width, ref.p.height).score;
      if (!Number.isFinite(score)) throw fault('JXL_INPUT', 'score: finite number');
      return score;
    };
    const scoreField = candidate => {
      let score = Infinity;
      const pieceScores = Array(refs.length).fill(null);
      for (let i = 0; i < refs.length; i++) {
        if (active && !active[i]) continue;
        const part = scorePiece(candidate, i);
        pieceScores[i] = part;
        if (part < score) score = part;
      }
      return {pieceScores, score};
    };
    const fillPieces = hit => {
      if (!hit) return hit;
      for (let i = 0; i < refs.length; i++) if (hit.pieceScores[i] === null) {
        const part = scorePiece(hit.candidate, i);
        hit.pieceScores[i] = part;
        if (part < hit.score) hit.score = part;
      }
      return hit;
    };
    const measure = raw => {
      const step = Math.round(raw * 64) / 64;
      if (step <= 1 || step > 128 || seen.has(step)) return null;
      seen.add(step); check();
      const candidate = palette.remap(step);
      const scored = scoreField(candidate);
      return {candidate, step, changes: 0, ...scored};
    };
    let passing = null, anchor = null, lo = 1, hi = null, sLo = 100, sHi = null;
    let step = large ? Math.max(4, Math.min(48, (100 - floor) * 0.9)) : Math.max(2, Math.min(128, 2 * Math.sqrt(Math.max(0, 100 - floor))));
    let taken = 0;
    try {
      let cacheLeft = S2_MEMORY.base + Math.min(16 << 20, n * 48);
      for (const p of pieces) {
        const reference = ssimulacra2Reference({rgba: cropOf(source, r.width, p, r.x, r.y)}, p.width, p.height,
          {immutable: true, cacheBytes: Math.max(0, cacheLeft - S2_MEMORY.base)});
        if (reference.reservedBytes) cacheLeft -= S2_MEMORY.base + reference.reservedBytes;
        refs.push({p, reference});
      }
      for (let round = 0; round < 6; round++) {
        const hit = measure(step);
        if (!hit) break;
        taken++;
        step = hit.step;
        if (taken === 1 && hit.score >= floor) {
          anchor = hit;
          if (large) active = hit.pieceScores.map(part => part <= hit.score + 2);
        }
        if (hit.score >= floor) {
          if (!passing || hit.score < passing.score) passing = hit;
          lo = step; sLo = hit.score;
          if (hit.score - floor <= 0.75 || (large && hit.score - floor <= 3)) break;
        } else { hi = step; sHi = hit.score; }
        const aim = floor + 0.3;
        if (hi !== null) {
          if (hi - lo < 1/32) break;
          step = sLo > sHi ? lo + (sLo - aim) * (hi - lo) / (sLo - sHi) : (lo + hi) / 2;
          step = Math.min(hi - 1/64, Math.max(lo + 1/64, step));
        } else {
          const divisor = large && hit.score - floor < 5 ? 6 : 2;
          step = Math.min(128, step + Math.max(0.5, (hit.score - aim) / divisor));
        }
      }
      const settled = taken < 6 && passing && passing.score - floor <= 0.75;
      if (!large && !settled && passing && passing.score - floor > 0.4) {
        passing.changes = edgeChanges(passing.candidate, r.width, r.height);
        const base = Math.max(lo, hi ?? lo);
        for (const delta of [-0.25, 0.25, 0.5, 0.625, 0.7, 0.75, 1.25, 2, 3.5, 5, 7]) {
          const hit = measure(base + delta);
          if (!hit || hit.score < floor) continue;
          hit.changes = edgeChanges(hit.candidate, r.width, r.height);
          if (hit.score <= passing.score - 0.15 && hit.changes <= passing.changes
            || hit.score <= passing.score + 0.25 && hit.changes <= passing.changes * 0.9) passing = hit;
        }
      }
      if (passing && active) {
        fillPieces(passing);
        if (passing.score < floor) passing = anchor;
      }
      if (passing) {
        const whole = ssimulacra2Reference({rgba: source}, r.width, r.height, {immutable: true, cacheBytes: Math.min(16 << 20, n * 48)});
        try {
          const clears = hit => hit && ssimulacra2(whole, {rgba: hit.candidate}, r.width, r.height).score >= floor;
          if (!clears(passing)) passing = anchor && anchor !== passing && clears(fillPieces(anchor)) && anchor.score >= floor ? anchor : null;
        } finally { whole.release(); }
      }
    } finally {
      try { for (const ref of refs) ref.reference.release(); } finally { palette.close(); }
    }
    if (!passing) continue;
    for (let y = 0; y < r.height; y++) pixels.set(passing.candidate.subarray(y * r.width * 4, (y + 1) * r.width * 4), ((r.y + y) * width + r.x) * 4);
    kept.push({r, exact, masked: true});
    for (let i = 0; i < pieces.length; i++) measurements.push({metric: 'ssimulacra2', score: passing.pieceScores[i], floor, domain: 'encoder-reconstruction', region: pieces[i]});
  }
  return {pixels, kept, measurements};
}
