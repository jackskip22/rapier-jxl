// SPDX-License-Identifier: MIT
import {pixelKeys} from './screen-crop.mjs';
import {captureFillHoles, captureMaskRuns} from './capture-kernels.mjs';

const PAGE = 1024, SOME = 16, AA = 12, MIN_PHOTO = 0.4, CORE = 2, EDGE = 64, HARD = 0.25, STRAIGHT = 24;
const apart = (a, b, t) => {
  for (let s = 0; s < 24; s += 8) if (Math.abs((a >>> s & 255) - (b >>> s & 255)) >= t) return true;
  return false;
};
const far = (a, b) => ((a ^ b) & 0xc0c0c0) !== 0 && apart(a, b, EDGE);
const between = (p, a, b) => {
  for (let s = 0; s < 24; s += 8) {
    const v = p >>> s & 255, x = a >>> s & 255, y = b >>> s & 255;
    if (v < (x < y ? x : y) - AA || v > (x < y ? y : x) + AA) return false;
  }
  return true;
};

const RUNS = new WeakMap();
export function photoMasks(data, width, height, regions, exactRects = []) {
  const keyed = pixelKeys(data), words = new Int32Array(keyed.buffer, keyed.byteOffset, keyed.length);
  let known = RUNS.get(data);
  if (!known) RUNS.set(data, known = new Map());
  const found = regions.map(r => {
    const key = width + ':' + r.x + ':' + r.y + ':' + r.width + ':' + r.height, had = known.get(key);
    if (had) return had;
    const runs = rectangleRuns(words, width, r);
    known.set(key, runs);
    return runs;
  });
  let count = 0;
  for (const f of found) count += f.runs.length / 3;
  let size = 64;
  while (size < count * 2) size *= 2;
  const shift = Math.clz32(size) + 1, wrap = size - 1, keys = new Int32Array(size), inside = new Uint32Array(size), outside = new Uint32Array(size);
  const find = k => { let s = Math.imul(k, 0x9e3779b1) >>> shift; while (inside[s] && keys[s] !== k) s = (s + 1) & wrap; return s; };
  for (const {runs} of found) for (let q = 0; q < runs.length; q += 3) { const s = find(runs[q + 2]); keys[s] = runs[q + 2]; inside[s] += runs[q + 1]; }
  if (count) {
    const ordered = [...regions].sort((a, b) => a.x - b.x);
    for (let y = 0; y < height; y += 2) {
      let x = 0;
      const row = y * width;
      for (const r of ordered) {
        if (y < r.y || y >= r.y + r.height) continue;
        const end = Math.min(width, r.x);
        for (; x < end; x += 2) { const s = find(words[row + x]); if (inside[s]) outside[s]++; }
        x = Math.max(x, Math.ceil((r.x + r.width) / 2) * 2);
      }
      for (; x < width; x += 2) { const s = find(words[row + x]); if (inside[s]) outside[s]++; }
    }
  }
  return regions.map((r, index) => {
    const {px, pixels, runs, transparent} = found[index], w = r.width, h = r.height, n = w * h, T = Math.max(192, n >> 12);
    const corner = words[(r.y ? r.y - 1 : 0) * width + (r.x ? r.x - 1 : 0)], exact = new Uint8Array(n);
    const list = [];
    let fill = -1, most = 0, flat = 0;
    if (transparent) for (let i = 0; i < n; i++) if (px[i] >>> 24 !== 255) { exact[i] = 1; list.push(i); }
    const border = new Uint8Array(n);
    let bordered = false;
    for (let q = 0; q < runs.length; q += 3) {
      const s = find(runs[q + 2]), c = inside[s];
      if (c < T && !(c >= SOME && outside[s] * 4 >= PAGE)) continue;
      let touches = false;
      for (let k = runs[q]; k < runs[q] + runs[q + 1]; k++) { const i = pixels[k], x = i % w; exact[i] = 1; list.push(i); touches ||= !x || x === w - 1 || i < w || i >= n - w; }
      if (touches) for (let k = runs[q]; k < runs[q] + runs[q + 1]; k++) border[pixels[k]] = 1;
      bordered ||= touches;
      if (c > most) { most = c; fill = runs[q + 2]; }
    }
    let runAt = null;
    for (const e of exactRects) {
      const x0 = Math.max(0, e.x - r.x), y0 = Math.max(0, e.y - r.y), x1 = Math.min(w, e.x + e.width - r.x), y1 = Math.min(h, e.y + e.height - r.y);
      if (x1 <= x0 || y1 <= y0) continue;
      if (e.solidText === true && !runAt) {
        runAt = new Uint8Array(n);
        for (let q = 0; q < runs.length; q += 3) for (let k = runs[q]; k < runs[q] + runs[q + 1]; k++) runAt[pixels[k]] = 1;
      }
      const keep = e.solidText === true ? solidText(px, runAt, w, x0, y0, x1, y1) : null, bw = x1 - x0;
      for (let y = y0; y < y1; y++) for (let x = x0, i = y * w + x0, k = (y - y0) * bw; x < x1; x++, i++, k++) if ((!keep || keep[k]) && !exact[i]) { exact[i] = 1; list.push(i); }
    }
    if (!list.length) return {exact, photo: n, fill: (corner | 0xff000000) >>> 0};
    const ring = [];
    for (const i of list) {
      const x = i % w, y = (i / w) | 0, c = px[i];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (!(dx | dy) || nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (exact[j]) continue;
        const qx = nx + dx, qy = ny + dy, q = qx < 0 || qy < 0 || qx >= w || qy >= h || exact[qy * w + qx] === 1 ? -1 : qy * w + qx;
        if (q < 0 || between(px[j], c, px[q])) { exact[j] = 2; ring.push(j); }
      }
    }
    if (bordered) {
      const only = new Uint8Array(n), straight = new Uint8Array(n);
      for (const j of ring) {
        const x = j % w, y = (j / w) | 0;
        let outer = false, inner = false;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy, k = ny * w + nx;
          if ((dx | dy) && nx >= 0 && ny >= 0 && nx < w && ny < h && exact[k] === 1) { if (border[k]) outer = true; else inner = true; }
        }
        only[j] = outer && !inner ? 3 : 0;
      }
      for (const j of ring) for (const [step, bit] of [[1, 1], [w, 2]]) if (only[j] & bit) {
        const row = j - j % w, ok = k => only[k] & bit && (bit > 1 || k >= row && k < row + w);
        let a = j, e = j + step;
        while (ok(a - step)) a -= step;
        while (ok(e)) e += step;
        for (let k = a; k < e; k += step) { only[k] ^= bit; if (e - a >= STRAIGHT * step) straight[k] = 1; }
      }
      for (let k = ring.length; k--;) if (straight[ring[k]]) { exact[ring[k]] = 0; ring[k] = ring[ring.length - 1]; ring.pop(); }
    }
    for (const j of ring) exact[j] = 1;
    const photo = n - list.length - ring.length;
    for (const i of list) flat += px[i] === fill;
    if (photo < 4096 || photo < MIN_PHOTO * (n - flat)) return null;
    if (fill < 0) fill = corner;
    return {exact, photo, fill: (fill | 0xff000000) >>> 0};
  });
}

export function fillHoles(rgba, w, h, exact) {
  const n = w * h;
  let count = 0;
  for (let i = 0; i < n; i++) count += exact[i];
  if (captureFillHoles(rgba, w, h, exact, count)) return rgba;
  const left = new Int32Array(count), right = new Int32Array(count), up = new Int32Array(count), down = new Int32Array(count);
  const column = new Int32Array(w);
  column.fill(-1);
  for (let y = 0, i = 0, k = 0; y < h; y++) {
    let last = -1;
    for (let x = 0; x < w; x++, i++) {
      if (!exact[i]) { last = x; column[x] = y; rgba[i * 4 + 3] = 255; continue; }
      left[k] = last; up[k++] = column[x];
    }
  }
  column.fill(-1);
  for (let y = h - 1, i = n - 1, k = count - 1; y >= 0; y--) {
    let next = -1;
    for (let x = w - 1; x >= 0; x--, i--) {
      if (!exact[i]) { next = x; column[x] = y; continue; }
      right[k] = next; down[k--] = column[x];
    }
  }
  const at = (a, b, ta, tb, c) => a < 0 ? rgba[b + c] : b < 0 ? rgba[a + c] : (rgba[a + c] * tb + rgba[b + c] * ta) / (ta + tb);
  for (let y = 0, i = 0, k = 0; y < h; y++) for (let x = 0; x < w; x++, i++) {
    if (!exact[i]) continue;
    const l = left[k], r = right[k], u = up[k], d = down[k++], p = i * 4, row = y * w;
    const along = l >= 0 || r >= 0, down2 = u >= 0 || d >= 0;
    const a = l >= 0 ? (row + l) * 4 : -1, b = r >= 0 ? (row + r) * 4 : -1, c = u >= 0 ? (u * w + x) * 4 : -1, e = d >= 0 ? (d * w + x) * 4 : -1;
    for (let ch = 0; ch < 3; ch++) {
      const v = along ? at(a, b, x - l, r - x, ch) : 0, t = down2 ? at(c, e, y - u, d - y, ch) : 0;
      if (along || down2) rgba[p + ch] = (along && down2 ? (v + t) / 2 : along ? v : t) + 0.5 | 0;
    }
    rgba[p + 3] = 0;
  }
  return rgba;
}

const NEAR = 2, STANDS_OUT = 96, STEP = 32;
function solidText(px, runAt, w, x0, y0, x1, y1) {
  const bw = x1 - x0, bh = y1 - y0, n = bw * bh, counts = new Map(), at = k => (y0 + (k / bw | 0)) * w + x0 + k % bw;
  let c = 0, most = 0;
  for (let k = 0; k < n; k++) if (runAt[at(k)]) { const v = (counts.get(px[at(k)]) ?? 0) + 1; counts.set(px[at(k)], v); if (v > most) { most = v; c = px[at(k)]; } }
  if (most * 50 < n) return null;
  const keep = new Uint8Array(n), near = new Uint8Array(n);
  const grow = (into, k) => { const x = k % bw, y = k / bw | 0; for (let v = Math.max(0, y - NEAR); v <= Math.min(bh - 1, y + NEAR); v++) into.fill(1, v * bw + Math.max(0, x - NEAR), v * bw + Math.min(bw, x + NEAR + 1)); };
  for (let k = 0; k < n; k++) if (px[at(k)] === c) grow(near, k);
  for (let k = 0; k < n; k++) if (!near[k] && !apart(px[at(k)], c, STANDS_OUT)) return null;
  for (let k = 0; k < n; k++) {
    const i = at(k), p = px[i];
    if (near[k] || runAt[i]) keep[k] = 1;
    if (k % bw + 1 < bw && apart(p, px[i + 1], STEP)) { grow(keep, k); grow(keep, k + 1); }
    if (k + bw < n && apart(p, px[i + w], STEP)) { grow(keep, k); grow(keep, k + bw); }
  }
  return keep;
}

function rectangleRuns(words, width, r) {
    const w = r.width, h = r.height, n = w * h, px = new Int32Array(n), mark = new Uint8Array(n);
    for (let y = 0; y < h; y++) px.set(words.subarray((r.y + y) * width + r.x, (r.y + y) * width + r.x + w), y * w);
    const flooded = captureMaskRuns(px, w, h);
    if (flooded) return {px, ...flooded};
    for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) {
      const c = px[i];
      if (x + 1 < w && px[i + 1] === c) mark[i] = mark[i + 1] = 1;
      if (y + 1 < h && px[i + w] === c) mark[i] = mark[i + w] = 1;
    }
    const pixels = new Int32Array(n), runs = [];
    let end = 0, opaque = 0;
    for (let i = 0; i < n; i++) {
      if (px[i] >>> 24 !== 255) opaque++;
      if (mark[i] !== 1) continue;
      const c = px[i], x0 = i % w;
      if (!(x0 > 0 && far(c, px[i - 1]) || x0 + 1 < w && far(c, px[i + 1]) || i >= w && far(c, px[i - w]) || i + w < n && far(c, px[i + w]))) continue;
      const start = end;
      let top = end, rim = 0, hard = 0;
      pixels[top++] = i; mark[i] = 2;
      while (end < top) {
        const j = pixels[end++], x = j % w;
        let side = 0;
        for (const k of [x > 0 ? j - 1 : -1, x + 1 < w ? j + 1 : -1, j - w, j + w < n ? j + w : -1]) if (k >= 0) {
          if (px[k] !== c) side |= far(c, px[k]) ? 3 : 1; else if (mark[k] === 1) { mark[k] = 2; pixels[top++] = k; }
        }
        rim += side & 1; hard += side >> 1;
      }
      if (end - start >= CORE && hard >= HARD * rim) runs.push(start, end - start, c);
      else end = start;
    }
    return {px, pixels, runs, transparent: opaque};
}
