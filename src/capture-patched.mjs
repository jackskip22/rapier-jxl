// SPDX-License-Identifier: MIT
import {encodeAtlasSteps, encodeCaptureSteps, captureExact} from './capture-codec.mjs';
import {WHOLE, bandRows} from './memory-device.mjs';
import {capturePatchGroups, PEEL_ADD, PEEL_MUL} from './capture-patches.mjs';
import {capturePatchMarks} from './capture-kernels.mjs';
import {pixelKeys} from './screen-crop.mjs';
import {pageFrameSteps} from './photo-frame-bands.mjs';
import {fusedFrameRows} from './capture-fused.mjs';
import {screenPhotoRegions} from './screen-photo-regions.mjs';
import {expandPhotoRegions} from './screen-photo-borders.mjs';
import {photoMasks} from './screen-photo-mask.mjs';
import {flatSamples} from './screen.mjs';
import {fault} from './fault.mjs';
import {CAPTURE_PROTECTION} from './capture-protection.mjs';
import {unit, stage, journaling} from './step-journal.mjs';
import {markCaptureExact} from './capture-codec.mjs';

export function patchBoxes(rects, width, height) {
  let out = [];
  for (const r of rects) {
    const x = Math.max(0, Math.floor(r.x)), y = Math.max(0, Math.floor(r.y));
    const w = Math.min(width, Math.ceil(r.x + r.width)) - x, h = Math.min(height, Math.ceil(r.y + r.height)) - y;
    if (w > 0 && h > 0) out.push({x, y, w, h});
  }
  for (let joined = true; joined;) {
    joined = false;
    out.sort((a, b) => a.y - b.y || a.x - b.x);
    const kept = [];
    for (const b of out) {
      let i = kept.length - 1;
      for (; i >= Math.max(0, kept.length - 64); i--) {
        const a = kept[i], x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
        const w = Math.max(a.x + a.w, b.x + b.w) - x, h = Math.max(a.y + a.h, b.y + b.h) - y;
        if (w * h <= a.w * a.h + b.w * b.h) { kept[i] = {x, y, w, h}; joined = true; break; }
      }
      if (i < Math.max(0, kept.length - 64)) kept.push(b);
    }
    out = kept;
  }
  return out;
}

const GAP = 3;
export function uncoveredBoxes(width, box, covered) {
  const out = [], cut = (x0, y0, x1, y1, rows) => {
    const ink = [];
    for (let i = rows ? y0 : x0; i < (rows ? y1 : x1); i++) { let any = false; for (let j = rows ? x0 : y0; j < (rows ? x1 : y1) && !any; j++) any = !covered[rows ? i * width + j : j * width + i]; ink.push(any); }
    const runs = [];
    for (let i = 0; i < ink.length;) {
      if (!ink[i]) { i++; continue; }
      let e = i + 1, gap = 0;
      for (let j = i + 1; j < ink.length; j++) { if (ink[j]) { e = j + 1; gap = 0; } else if (++gap >= GAP) break; }
      runs.push([i, e]); i = e;
    }
    return runs;
  };
  for (const [a, b] of cut(box.x, box.y, box.x + box.w, box.y + box.h, true))
    for (const [c, d] of cut(box.x, box.y + a, box.x + box.w, box.y + b, false)) {
      const x0 = box.x + c, x1 = box.x + d, y0 = box.y + a, y1 = box.y + b;
      const rows = cut(x0, y0, x1, y1, true);
      for (const [e, f] of rows) out.push({x: x0, y: y0 + e, w: x1 - x0, h: f - e});
    }
  return out;
}

const NEAR = 2, STANDS_OUT = 96, STEP = 32, PICTURE_KEPT = 0.9;
const apart = (a, b, t) => Math.abs((a >> 16) - (b >> 16)) >= t || Math.abs((a >> 8 & 255) - (b >> 8 & 255)) >= t || Math.abs((a & 255) - (b & 255)) >= t;
const cellOf = v => (v >> 9 & 0x7c00) | (v >> 6 & 0x3e0) | (v >> 3 & 0x1f);
const RING = 2, STRONG = 2, STRONG_KEPT = 0.5, STRONG_BITS = 3, FLAT = 8, FLAT_BOX = 8192;
export function groundCells(data, width, height, box, text = null) {
  const counts = new Map();
  let n = 0, most = 0, common = 0;
  for (let y = Math.max(0, box.y - RING); y < Math.min(height, box.y + box.h + RING); y++) for (let x = Math.max(0, box.x - RING); x < Math.min(width, box.x + box.w + RING); x++) {
    if (y >= box.y && y < box.y + box.h && x >= box.x && x < box.x + box.w) { x = box.x + box.w - 1; continue; }
    if (text?.[y * width + x]) continue;
    const o = (y * width + x) * 4, v = data[o] << 16 | data[o + 1] << 8 | data[o + 2], c = (counts.get(v) ?? 0) + 1;
    counts.set(v, c); n++; if (c > most) { most = c; common = v; }
  }
  if (n < 16) return null;
  const cells = new Uint8Array(32768);
  for (const v of counts.keys()) {
    const r = v >> 19, g = v >> 11 & 31, b = v >> 3 & 31;
    for (let i = Math.max(0, r - 1); i <= Math.min(31, r + 1); i++) for (let j = Math.max(0, g - 1); j <= Math.min(31, g + 1); j++) for (let k = Math.max(0, b - 1); k <= Math.min(31, b + 1); k++) cells[i << 10 | j << 5 | k] |= 1;
    if (apart(v, common, STANDS_OUT)) cells[cellOf(v)] |= STRONG;
  }
  return cells;
}
export function solidInk(data, width, box, ground = null) {
  const {x: X, y: Y, w, h} = box, n = w * h, px = new Int32Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = ((Y + y) * width + X + x) * 4; px[y * w + x] = data[o] << 16 | data[o + 1] << 8 | data[o + 2]; }
  const counts = new Map();
  let c = 0, most = 0, strong = false;
  for (let y = 0; y < h; y++) for (let x = 0, o = y * w; x < w;) {
    let e = x + 1; while (e < w && px[o + e] === px[o + x]) e++;
    if (e - x > 1 && ground && ground[cellOf(px[o + x])] & STRONG) strong = true;
    if (e - x > 1 && (!ground?.[cellOf(px[o + x])] || ground[cellOf(px[o + x])] & STRONG)) { const v = (counts.get(px[o + x]) ?? 0) + e - x - 1; counts.set(px[o + x], v); if (v > most) { most = v; c = px[o + x]; } }
    else if (e - x > 1) counts.set(px[o + x], (counts.get(px[o + x]) ?? 0) + e - x - 1);
    x = e;
  }
  if (ground ? !most : most * 50 < n) return null;
  if (strong && !ground[cellOf(c)]) {
    const rivals = new Map();
    for (const [v, runs] of counts) if (runs >= most && ground[cellOf(v)] && !(ground[cellOf(v)] & STRONG)) rivals.set(v, 0);
    for (let k = 0; k < n; k++) if (rivals.has(px[k])) rivals.set(px[k], rivals.get(px[k]) + 1);
    if ([...rivals.values()].every(m => 2 * m >= n)) strong = false;
  }
  const grown = mask => {
    const row = new Uint8Array(n);
    for (let y = 0; y < h; y++) for (let x = 0, o = y * w, last = -Infinity; x < w + NEAR; x++) {
      if (x < w && mask[o + x]) last = x;
      const at = x - NEAR; if (at >= 0 && at < w && x - last <= 2 * NEAR) row[o + at] = 1;
    }
    const out = new Uint8Array(n);
    for (let x = 0; x < w; x++) for (let y = 0, last = -Infinity; y < h + NEAR; y++) {
      if (y < h && row[y * w + x]) last = y;
      const at = y - NEAR; if (at >= 0 && at < h && y - last <= 2 * NEAR) out[at * w + x] = 1;
    }
    return out;
  };
  const ofC = new Uint8Array(n), steps = new Uint8Array(n);
  let keep;
  if (ground) {
    for (let k = 0; k < n; k++) if (!apart(px[k], c, STANDS_OUT) || !ground[cellOf(px[k])] || strong && ground[cellOf(px[k])] & STRONG) ofC[k] = 1;
    keep = grown(ofC);
  } else {
    for (let k = 0; k < n; k++) if (px[k] === c) ofC[k] = 1;
    const near = grown(ofC);
    for (let k = 0; k < n; k++) if (!near[k] && !apart(px[k], c, STANDS_OUT)) return null;
    for (let k = 0; k < n; k++) {
      if (k % w + 1 < w && apart(px[k], px[k + 1], STEP)) steps[k] = steps[k + 1] = 1;
      if (k + w < n && apart(px[k], px[k + w], STEP)) steps[k] = steps[k + w] = 1;
    }
    keep = grown(steps);
    for (let k = 0; k < n; k++) keep[k] |= near[k];
  }
  const parent = [], bounds = [], first = [];
  const root = i => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  let above = [], from = 0;
  for (let y = 0; y < h; y++) {
    const here = [];
    for (let x = 0, o = y * w; x < w;) {
      if (!keep[o + x]) { x++; continue; }
      let e = x + 1; while (e < w && keep[o + e]) e++;
      const id = parent.length; parent.push(id); bounds.push([x, y, e - 1, y]); first.push(o + x); here.push([x, e, id]);
      while (from < above.length && above[from][1] < x) from++;
      for (let k = Math.max(0, from - 1); k < above.length && above[k][0] <= e; k++) {
        const [s0, e0, j] = above[k];
        if (e0 < x || s0 > e) continue;
        const a = root(id), b = root(j);
        if (a === b) continue;
        const [lo, hi] = first[a] < first[b] ? [a, b] : [b, a];
        parent[hi] = lo; const A = bounds[lo], B = bounds[hi];
        A[0] = Math.min(A[0], B[0]); A[1] = Math.min(A[1], B[1]); A[2] = Math.max(A[2], B[2]); A[3] = Math.max(A[3], B[3]);
      }
      x = e;
    }
    above = here; from = 0;
  }
  const out = [];
  for (let i = 0; i < parent.length; i++) if (parent[i] === i) { const [x0, y0, x1, y1] = bounds[i]; out.push({x: X + x0, y: Y + y0, width: x1 - x0 + 1, height: y1 - y0 + 1}); }
  const parts = patchBoxes(out, Infinity, Infinity);
  if (ground && parts.reduce((s, r) => s + r.w * r.h, 0) >= (strong ? STRONG_KEPT : PICTURE_KEPT) * n) return null;
  if (strong) {
    const inPart = new Uint8Array(n);
    for (const r of parts) for (let y = r.y - Y; y < r.y - Y + r.h; y++) inPart.fill(1, y * w + r.x - X, y * w + r.x - X + r.w);
    let bits = 0, out = 0, off = 0;
    for (let y = 1; y < h; y++) for (let x = 1; x < w; x++) {
      if (inPart[y * w + x]) continue;
      out++;
      for (let ch = 0, i = ((Y + y) * width + X + x) * 4; ch < 3; ch++, i++) {
        const Wv = data[i - 4], N = data[i - width * 4], NW = data[i - width * 4 - 4], r = Math.abs(data[i] - Math.min(Math.max(Wv + N - NW, Math.min(Wv, N)), Math.max(Wv, N)));
        bits += Math.log2(1 + r); if (r > FLAT) off++;
      }
    }
    if ((off || n < FLAT_BOX) && bits < STRONG_BITS * out) return null;
  }
  parts.kept = {x: X, y: Y, w, h, keep};
  return parts;
}

const atlasArea = (boxes, blocks) => [...boxes.filter(r => !r.block), ...blocks].reduce((s, r) => s + r.w * r.h, 0);
function packAtlas(boxes, data, width, below = []) {
  let area = 0, side = 0;
  for (const r of boxes) { area += r.w * r.h; side = Math.max(side, r.w); }
  for (const r of below) side = Math.max(side, r.w);
  const aw = Math.max(side, Math.min(4096, Math.ceil(Math.sqrt(area * 1.1)))), sky = new Int32Array(aw);
  let ah = 0;
  const queue = new Int32Array(aw);
  const place = r => {
    let bestX = 0, bestY = Infinity, head = 0, tail = 0;
    for (let k = 0; k < aw; k++) {
      while (tail > head && sky[queue[tail - 1]] <= sky[k]) tail--;
      queue[tail++] = k;
      const x = k - r.w + 1;
      if (x < 0) continue;
      if (queue[head] < x) head++;
      const top = sky[queue[head]];
      if (top < bestY) { bestY = top; bestX = x; }
      if (!top) break;
    }
    r.ax = bestX; r.ay = bestY; sky.fill(bestY + r.h, bestX, bestX + r.w); ah = Math.max(ah, bestY + r.h);
  };
  const tallest = list => [...list].sort((a, b) => b.h - a.h || b.w - a.w);
  tallest(boxes).forEach(place);
  if (below.length) { sky.fill(ah); tallest(below).forEach(place); }
  if (aw * ah > WHOLE) return null;
  const atlas = new Uint8Array(aw * ah * 4), words = new Uint32Array(atlas.buffer), key = c => new Uint32Array(Uint8Array.of(c[0], c[1], c[2], c[3]).buffer)[0];
  words.fill(key(data.subarray(0, 4)));
  for (const r of [...boxes, ...below]) {
    const fill = r.c === undefined ? 0 : key([r.c >> 16, r.c >> 8 & 255, r.c & 255, 255]);
    if (r.role) {
      for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
        const o = ((r.ay + y) * aw + r.ax + x) * 4, i = ((r.y + y) * width + r.x + x) * 4, k = y * r.w + x;
        if (r.role === 'add') for (let c = 0; c < 3; c++) atlas[o + c] = r.adds[k] ? data[i + c] : 0;
        else atlas[o] = atlas[o + 1] = atlas[o + 2] = r.mask[k] ? 0 : 255;
        atlas[o + 3] = 255;
      }
      continue;
    }
    for (let y = 0; y < r.h; y++) {
      if (r.c === undefined) atlas.set(data.subarray(((r.y + y) * width + r.x) * 4, ((r.y + y) * width + r.x + r.w) * 4), ((r.ay + y) * aw + r.ax) * 4);
      else words.fill(fill, (r.ay + y) * aw + r.ax, (r.ay + y) * aw + r.ax + r.w);
    }
  }
  return {atlas, aw, ah};
}

function frameRows(data, width, dx, dy, boxes) {
  const fw = width + dx, sorted = [...boxes].sort((a, b) => a.y - b.y), tall = sorted.reduce((m, r) => Math.max(m, r.h), 0);
  const row = new Uint8Array(width * 4), mask = new Uint8Array(width);
  return (y, count) => {
    const out = new Uint8Array(fw * count * 4);
    let lo = 0, hi = sorted.length;
    for (const top = Math.max(0, y - dy) - tall + 1; lo < hi;) { const m = (lo + hi) >> 1; if (sorted[m].y < top) lo = m + 1; else hi = m; }
    for (let fy = y; fy < y + count; fy++) {
      const py = Math.max(0, fy - dy);
      row.set(data.subarray(py * width * 4, (py + 1) * width * 4)); mask.fill(0);
      for (let i = lo; i < sorted.length && sorted[i].y <= py; i++) { const r = sorted[i]; if (r.y + r.h > py) mask.fill(1, r.x, r.x + r.w); }
      for (let x = 0; x < width;) {
        if (!mask[x]) { x++; continue; }
        let e = x; while (e < width && mask[e]) e++;
        const L = x > 0 ? (x - 1) * 4 : -1, R = e < width ? e * 4 : -1;
        for (let k = x; k < e; k++) {
          const t = (k - x + 1) / (e - x + 1), o = k * 4;
          for (let c = 0; c < 3; c++) { const a = L >= 0 ? row[L + c] : R >= 0 ? row[R + c] : 255, b = R >= 0 ? row[R + c] : a; row[o + c] = Math.round(a + (b - a) * t); }
        }
        x = e;
      }
      const to = (fy - y) * fw * 4;
      out.set(row, to + dx * 4);
      for (let x = 0; x < dx; x++) out.set(row.subarray(0, 4), to + x * 4);
    }
    return out;
  };
}

function textPieces(data, width, height, exactRects, regions, protectedBoxes, readUnboxed, readMarks) {
  const own = exactRects.filter(r => r.solidText === true), solid = patchBoxes(own, width, height);
  const plain = [...protectedBoxes, ...patchBoxes(exactRects.filter(r => r.solidText !== true), width, height)];
  const meets = (b, r) => b.x < r.x + r.width && r.x < b.x + b.w && b.y < r.y + r.height && r.y < b.y + b.h;
  const reads = solid.map(b => regions.some(r => meets(b, r)) ? [b] : solidInk(data, width, b) ?? [b]), glyphs = reads.flat();
  const ground = groundOf(solid.flatMap((b, i) => regions.some(r => meets(b, r)) ? [reads[i]] : []), width, height);
  if (!plain.length && !glyphs.length) return {pieces: [], blocks: []};
  plain.push(...patchBoxes(unboxedMarks(data, width, height, [...plain, ...glyphs], readUnboxed), width, height));
  const {groups, covered} = readMarks();
  const pieces = groups.map(g => ({x: g.x, y: g.y, w: g.w, h: g.h, positions: g.positions}));
  const runs = [], rest = [], inked = [];
  for (const b of plain) uniformRuns(data, width, b, covered, runs, rest, 0);
  for (const b of glyphs) uniformRuns(data, width, b, covered, runs, inked, 0);
  for (const b of rest) pieces.push(...uncoveredBoxes(width, b, covered));
  for (const b of inked) for (const u of uncoveredBoxes(width, b, covered)) pieces.push(masked(data, width, u, ground) ?? u);
  const blocks = new Map(), shapes = new Map();
  for (const u of runs) {
    const pw = Math.min(BLOCK, u.w), ph = Math.min(BLOCK, u.h);
    const block = blocks.get(u.c) ?? {c: u.c, w: 0, h: 0};
    block.w = Math.max(block.w, pw); block.h = Math.max(block.h, ph); blocks.set(u.c, block);
    const key = `${u.c},${pw},${ph}`, shape = shapes.get(key) ?? {w: pw, h: ph, block, positions: []};
    shapes.set(key, shape);
    for (let y = 0; y < u.h; y += ph) for (let x = 0; x < u.w; x += pw) shape.positions.push(u.x + Math.min(x, u.w - pw), u.y + Math.min(y, u.h - ph));
  }
  pieces.push(...shapes.values());
  return {pieces, blocks: [...blocks.values()]};
}
const BLOCK = 64;
const EDGE_BITS = 6, MASKED_BITS = 512, PAGE_BITS = 0.5;
function masked(data, width, u, ground) {
  if (!ground) return null;
  const mask = new Uint8Array(u.w * u.h);
  let bits = 0, edges = 0, n = 0, any = false;
  for (let y = 0; y < u.h; y++) for (let x = 0; x < u.w; x++) {
    const p = (u.y + y) * width + u.x + x;
    if (ground[p] !== 1) { mask[y * u.w + x] = 1; any = true; continue; }
    n++;
    if (!x || !y) continue;
    for (let c = 0, i = p * 4; c < 3; c++, i++) {
      const W = data[i - 4], N = data[i - width * 4], NW = data[i - width * 4 - 4];
      bits += Math.log2(1 + Math.abs(data[i] - Math.min(Math.max(W + N - NW, Math.min(W, N)), Math.max(W, N))));
    }
  }
  for (let y = 0; y < u.h; y++) for (let x = 0, k = y * u.w; x < u.w; x++, k++) edges += (x && mask[k] !== mask[k - 1]) + (y && mask[k] !== mask[k - u.w]);
  if (!any || bits < EDGE_BITS * edges + MASKED_BITS + PAGE_BITS * n) return null;
  const adds = new Uint8Array(u.w * u.h);
  for (let y = 0; y < u.h; y++) for (let x = 0; x < u.w; x++) {
    const p = (u.y + y) * width + u.x + x;
    if (mask[y * u.w + x] && ground[p] !== 2) { adds[y * u.w + x] = 1; ground[p] = 2; }
  }
  return {...u, mask, adds};
}
const EDGE = 2;
function groundOf(reads, width, height) {
  if (!reads.some(r => r.kept)) return null;
  const state = new Uint8Array(width * height), ground = new Uint8Array(width * height);
  for (const read of reads) for (const k of read.kept ? [read.kept].flat() : []) for (let y = 0; y < k.h; y++) for (let x = 0; x < k.w; x++) {
    const p = (k.y + y) * width + k.x + x;
    let kept = x < EDGE || y < EDGE || x >= k.w - EDGE || y >= k.h - EDGE;
    for (let v = Math.max(0, y - 1); v <= Math.min(k.h - 1, y + 1) && !kept; v++) for (let u = Math.max(0, x - 1); u <= Math.min(k.w - 1, x + 1) && !kept; u++) if (k.keep[v * k.w + u]) kept = true;
    if (kept) state[p] = 2; else if (!state[p]) state[p] = 1;
  }
  for (const read of reads) for (const r of read) for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (state[y * width + x] === 1) ground[y * width + x] = 1;
  return ground;
}
const boxMask = (boxes, width, height) => { const m = new Uint8Array(width * height); for (const b of boxes) for (let y = b.y; y < b.y + b.h; y++) m.fill(1, y * width + b.x, y * width + b.x + b.w); return m; };
function uniformRuns(data, width, box, covered, runs, rest, depth) {
  const kind = (p, n, step) => {
    const i0 = p * 4, r = data[i0], g = data[i0 + 1], b = data[i0 + 2];
    let one = true, all = true;
    for (let k = 0, q = p; k < n && (one || all); k++, q += step) {
      if (one) { const i = q * 4; if (data[i] !== r || data[i + 1] !== g || data[i + 2] !== b) one = false; }
      if (all && !covered[q]) all = false;
    }
    return all ? -2 : one ? r << 16 | g << 8 | b : -1;
  };
  const rowKinds = [];
  for (let y = box.y; y < box.y + box.h; y++) rowKinds.push(kind(y * width + box.x, box.w, 1));
  for (let i = 0; i < rowKinds.length;) {
    let e = i + 1; while (e < rowKinds.length && rowKinds[e] === rowKinds[i]) e++;
    const y0 = box.y + i, h = e - i, c = rowKinds[i];
    if (c >= 0) runs.push({x: box.x, y: y0, w: box.w, h, c});
    else if (c === -1 && depth > 2) rest.push({x: box.x, y: y0, w: box.w, h});
    else if (c === -1) {
      const colKinds = [];
      for (let x = box.x; x < box.x + box.w; x++) colKinds.push(kind(y0 * width + x, h, width));
      for (let j = 0; j < colKinds.length;) {
        let f = j + 1; while (f < colKinds.length && colKinds[f] === colKinds[j]) f++;
        const c2 = colKinds[j], part = {x: box.x + j, y: y0, w: f - j, h};
        if (c2 >= 0) runs.push({...part, c: c2});
        else if (c2 === -1) uniformRuns(data, width, part, covered, runs, rest, depth + 1);
        j = f;
      }
    }
    i = e;
  }
}
const MARK_SIDE = 128, MARK_LONG = 2048, MARK_CONTRAST = 64, GROUND_CONTRAST = 96;
const grounded = (data, width, x, y, w, h) => {
  const counts = new Map(); let most = 0;
  for (let v = y; v < y + h; v++) for (let u = x, i = (v * width + x) * 4; u < x + w; u++, i += 4) {
    const k = data[i] << 16 | data[i + 1] << 8 | data[i + 2], n = (counts.get(k) ?? 0) + 1; counts.set(k, n); if (n > most) most = n;
  }
  return most * 4 >= w * h;
};
const UNBOXED_PIXELS = 1 << 22;
function unboxedSourceMarks(data, width, height, y0, h) {
  const part = data.subarray(y0 * width * 4, (y0 + h) * width * 4);
  const marks = capturePatchMarks(pixelKeys(part), width, h, MARK_LONG, 1 << 16, 1);
  if (!marks) throw fault('JXL_LIMIT', 'The text-mark budget was exhausted; exact text could not be proved.');
  const found = [];
  for (let i = 0; i < marks.length; i += 4) {
    const x = marks[i], y = marks[i + 1] + y0, w = marks[i + 2], mh = marks[i + 3];
    if (Math.min(w, mh) <= MARK_SIDE) found.push({x, y, w, h: mh, ground: ringGround(data, width, height, x, y, w, mh)});
  }
  return strokes(data, width, height, found);
}
function unboxedMarks(data, width, height, boxes, readSource = null) {
  const boxed = new Uint8Array(width * height), out = [];
  for (const b of boxes) for (let y = b.y; y < b.y + b.h; y++) boxed.fill(1, y * width + b.x, y * width + b.x + b.w);
  const rows = Math.max(1, Math.floor(UNBOXED_PIXELS / width));
  for (let y0 = 0; y0 < height; y0 += rows) {
    const h = Math.min(rows, height - y0);
    const sourceMarks = readSource ? readSource(y0, h) : unboxedSourceMarks(data, width, height, y0, h);
    for (const {x, y, w, h: mh, ground} of sourceMarks) {
      let open = false;
      const lo = [255, 255, 255], hi = [0, 0, 0];
      for (let v = y; v < y + mh; v++) for (let u = x, k = v * width + x; u < x + w; u++, k++) {
        if (!boxed[k]) open = true;
        for (let c = 0; c < 3; c++) { const s = data[k * 4 + c]; if (s < lo[c]) lo[c] = s; if (s > hi[c]) hi[c] = s; }
      }
      const off = c => { const g = ground >> (16 - 8 * c) & 255; return Math.max(hi[c] - g, g - lo[c]); };
      const stands = hi.some((v, c) => v - lo[c] >= MARK_CONTRAST) || ground >= 0 && [0, 1, 2].some(c => off(c) >= GROUND_CONTRAST);
      if (!open || !stands) continue;
      if (Math.max(w, mh) > MARK_SIDE && (Math.max(w, mh) < 3 * Math.min(w, mh) || !grounded(data, width, x, y, w, mh))) continue;
      out.push({x, y, width: w, height: mh});
    }
  }
  return out;
}
function ringGround(data, width, height, x, y, w, h) {
  const counts = new Map(); let ring = 0, ground = -1, most = 0;
  const count = (u, v) => {
    if (u < 0 || v < 0 || u >= width || v >= height) return;
    const i = (v * width + u) * 4, k = data[i] << 16 | data[i + 1] << 8 | data[i + 2], n = (counts.get(k) ?? 0) + 1;
    ring++; counts.set(k, n); if (n > most) { most = n; ground = k; }
  };
  for (let u = x - 1; u <= x + w; u++) { count(u, y - 1); count(u, y + h); }
  for (let v = y; v < y + h; v++) { count(x - 1, v); count(x + w, v); }
  return ring && most * 2 >= ring ? ground : -1;
}
const STROKE_GAP = 16, EDGE_SIDE = 3;
function strokes(data, width, height, marks) {
  const at = (u, v) => { const i = (v * width + u) * 4; return data[i] << 16 | data[i + 1] << 8 | data[i + 2]; };
  const stroke = (a, b, rows) => {
    const [p, q, s0, s1] = rows ? [a.x + a.w, b.x, Math.max(a.y, b.y), Math.min(a.y + a.h, b.y + b.h)] : [a.y + a.h, b.y, Math.max(a.x, b.x), Math.min(a.x + a.w, b.x + b.w)];
    if (q <= p || q - p > STROKE_GAP || s1 <= s0) return null;
    const [aw, bw, a0, a1, b0, b1] = rows ? [a.w, b.w, a.y, a.y + a.h, b.y, b.y + b.h] : [a.h, b.h, a.x, a.x + a.w, b.x, b.x + b.w];
    if (Math.min(aw, bw) > EDGE_SIDE || Math.abs(a0 - b0) > EDGE_SIDE - 1 || Math.abs(a1 - b1) > EDGE_SIDE - 1) return null;
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y), w = Math.max(a.x + a.w, b.x + b.w) - x, h = Math.max(a.y + a.h, b.y + b.h) - y;
    if (w > MARK_SIDE || h > MARK_SIDE) return null;
    const ground = ringGround(data, width, height, x, y, w, h);
    if (ground < 0) return null;
    for (let t = p; t < q; t++) for (let r = s0; r < s1; r++) if ((rows ? at(t, r) : at(r, t)) === ground) return null;
    return {x, y, w, h, ground};
  };
  let list = marks;
  for (let joined = true; joined;) {
    joined = false;
    for (const rows of [true, false]) {
      list.sort(rows ? (a, b) => a.x - b.x : (a, b) => a.y - b.y);
      const kept = [];
      for (let i = 0; i < list.length; i++) {
        const a = list[i];
        if (a.gone) continue;
        for (let j = i + 1; j < list.length && (rows ? list[j].x : list[j].y) <= (rows ? a.x + a.w : a.y + a.h) + STROKE_GAP; j++) {
          const b = list[j], one = !b.gone && stroke(a, b, rows);
          if (one) { Object.assign(a, one); b.gone = true; joined = true; }
        }
        kept.push(a);
      }
      list = kept;
    }
  }
  return list;
}
function pageMarks(data, width, height) {
  if (width < 16 || height < 16) return null;
  const rows = Math.floor((1 << 25) / width);
  if (rows >= height) return capturePatchGroups(pixelKeys(data), width, height, 0);
  const groups = [], seen = new Map();
  const same = (a, b) => {
    for (let r = 0; r < a.h; r++) for (let i = ((a.y + r) * width + a.x) * 4, j = ((b.y + r) * width + b.x) * 4, e = i + a.w * 4; i < e; i++, j++) if (data[i] !== data[j]) return false;
    return true;
  };
  for (let y0 = 0; y0 < height; y0 += rows) {
    const h = Math.min(rows, height - y0);
    if (h < 16) continue;
    const part = capturePatchGroups(pixelKeys(data.subarray(y0 * width * 4, (y0 + h) * width * 4)), width, h, 0);
    for (const g of part?.groups ?? []) {
      const mark = {x: g.x, y: g.y + y0, w: g.w, h: g.h, positions: g.positions.map((v, i) => i & 1 ? v + y0 : v)};
      let hash = Math.imul(mark.w, 0x9e3779b1) ^ mark.h;
      for (let i = ((mark.y + (mark.h >> 1)) * width + mark.x) * 4, e = i + mark.w * 4; i < e; i++) hash = Math.imul(hash ^ data[i], 16777619);
      const list = seen.get(hash), found = list?.find(o => o.w === mark.w && o.h === mark.h && same(o, mark));
      if (found) found.positions.push(...mark.positions);
      else { groups.push(mark); if (list) list.push(mark); else seen.set(hash, [mark]); }
    }
  }
  return groups.length ? {groups} : null;
}
export function anyRows(rows, fw, most = 256) {
  return (y, count) => {
    const out = new Uint8Array(fw * count * 4);
    for (let at = 0; at < count; at += most) { const n = Math.min(most, count - at); out.set(rows(y + at, n).subarray(0, fw * n * 4), fw * at * 4); }
    return out;
  };
}
function inkFilled(data, width, masks) {
  const out = data.slice();
  for (const r of masks) for (let y = 0; y < r.h; y++) {
    const row = (r.y + y) * width;
    for (let x = 0; x < r.w;) {
      if (!r.mask[y * r.w + x]) { x++; continue; }
      let e = x; while (e < r.w && r.mask[y * r.w + e]) e++;
      const L = r.x + x > 0 ? (row + r.x + x - 1) * 4 : -1, R = r.x + e < width ? (row + r.x + e) * 4 : -1;
      for (let k = x; k < e; k++) {
        const t = (k - x + 1) / (e - x + 1), o = (row + r.x + k) * 4;
        for (let c = 0; c < 3; c++) { const a = L >= 0 ? out[L + c] : R >= 0 ? out[R + c] : 255, b = R >= 0 ? out[R + c] : a; out[o + c] = Math.round(a + (b - a) * t); }
      }
      x = e;
    }
  }
  return out;
}
const placed = r => r.positions ? Array.from({length: r.positions.length >> 1}, (_, k) => ({x: r.positions[2 * k], y: r.positions[2 * k + 1], w: r.w, h: r.h})) : [r];

function protectedPageBoxes(data, width, height) {
  const valid = list => list.length && list.every((r, i) =>
    [r.x, r.y, r.width, r.height].every(Number.isSafeInteger) && r.x >= 0 && r.y >= 0 && r.width > 0 && r.height > 0 &&
    r.x + r.width <= width && r.y + r.height <= height && !list.slice(0, i).some(q =>
      r.x < q.x + q.width && q.x < r.x + r.width && r.y < q.y + q.height && q.y < r.y + r.height));
  const seeds = screenPhotoRegions(data, width, height, true);
  if (!valid(seeds)) return null;
  const regions = expandPhotoRegions(data, width, height, seeds, true);
  if (!valid(regions)) return null;
  const n = width * height;
  const mayBeExact = n < 2000000 && flatSamples(data, width, height) <= 32 || regions.reduce((s, r) => s + r.width * r.height, 0) * 8 < n;
  const exact = new Uint8Array(n).fill(1), masks = photoMasks(data, width, height, regions);
  let photo = 0;
  for (let i = 0; i < regions.length; i++) {
    const r = regions[i], m = masks[i];
    if (!m) continue;
    for (let y = 0, k = 0; y < r.height; y++) for (let x = 0, p = (r.y + y) * width + r.x; x < r.width; x++, k++, p++)
      if (!m.exact[k]) { exact[p] = 0; photo++; }
  }
  if (!photo) return null;
  if (regions.length > 1) {
    const x = Math.min(...regions.map(r => r.x)), y = Math.min(...regions.map(r => r.y));
    const box = {x, y, width: Math.max(...regions.map(r => r.x + r.width)) - x, height: Math.max(...regions.map(r => r.y + r.height)) - y};
    const [mask] = photoMasks(data, width, height, [box]);
    if (!mask) return null;
    for (let v = 0, k = 0; v < box.height; v++) for (let u = 0, p = (box.y + v) * width + box.x; u < box.width; u++, k++, p++)
      if (mask.exact[k] && !exact[p]) { exact[p] = 1; photo--; }
    if (!photo) return null;
  }
  const boxes = [];
  let above = new Map();
  for (let y = 0; y < height; y++) {
    const here = new Map();
    for (let x = 0, at = y * width; x < width;) {
      if (!exact[at + x]) { x++; continue; }
      let end = x + 1; while (end < width && exact[at + end]) end++;
      const key = x + ':' + end, old = above.get(key);
      const box = old ?? {x, y, w: end - x, h: 0};
      if (!old) {
        if (boxes.length === 1 << 16) return null;
        boxes.push(box);
      }
      box.h++; here.set(key, box); x = end;
    }
    above = here;
  }
  return {boxes, mayBeExact, regions};
}

function protectedLargeBoxes(data, width, height) {
  const boxes = [], rows = bandRows(width);
  for (let y = 0; y < height; y += rows) {
    const h = Math.min(rows, height - y), part = data.subarray(y * width * 4, (y + h) * width * 4);
    const protection = protectedPageBoxes(part, width, h);
    const own = !protection || protection.mayBeExact ? [{x: 0, y: 0, w: width, h}] : protection.boxes;
    if (boxes.length + own.length > 1 << 16) return null;
    for (const r of own) boxes.push({...r, y: r.y + y});
  }
  return {boxes};
}

function outsidePictures(protection, pictures) {
  let boxes = protection.boxes;
  for (const p of pictures) boxes = boxes.flatMap(b => {
    const x0 = Math.max(b.x, p.x), y0 = Math.max(b.y, p.y), x1 = Math.min(b.x + b.w, p.x + p.width), y1 = Math.min(b.y + b.h, p.y + p.height);
    if (x0 >= x1 || y0 >= y1) return [b];
    return [{x: b.x, y: b.y, w: b.w, h: y0 - b.y}, {x: b.x, y: y1, w: b.w, h: b.y + b.h - y1},
      {x: b.x, y: y0, w: x0 - b.x, h: y1 - y0}, {x: x1, y: y0, w: b.x + b.w - x1, h: y1 - y0}].filter(r => r.w > 0 && r.h > 0);
  });
  return boxes.length ? {...protection, boxes} : null;
}
export function* patchedPageSteps(source, width, height, {quality, regions = [], unconfirmed = false, confirmedPhotos = false, textComplete = false, areas = [], qualityOf = () => quality, exactRects, colorSpace, exactOptions = {}, photoBlocks = null, photoBlockEffort, readingWebp, photoRects = [], photoAdmission, photoScoreMemo = null, baseline, textReading, [CAPTURE_PROTECTION]: collector}) {
  const large = width * height > WHOLE, found = yield* unit('protection', () => large ? protectedLargeBoxes(source, width, height) : protectedPageBoxes(source, width, height));
  const protection = textComplete && found && photoRects.length ? outsidePictures(found, photoRects) : found;
  const exact = () => encodeCaptureSteps(source, width, height, {...exactOptions, colorSpace, maxError: 0});
  let unboxedSource = null, markCoverage = null;
  const readUnboxed = width * height <= UNBOXED_PIXELS
    ? (y0, h) => unboxedSource ??= unboxedSourceMarks(source, width, height, y0, h) : null;
  const readMarks = () => {
    if (markCoverage) return markCoverage;
    const groups = pageMarks(source, width, height)?.groups ?? [], covered = new Uint8Array(width * height);
    for (const g of groups) for (let i = 0; i < g.positions.length; i += 2)
      for (let r = 0, at = g.positions[i + 1] * width + g.positions[i]; r < g.h; r++, at += width) covered.fill(1, at, at + g.w);
    return markCoverage = {groups, covered};
  };
  if (!protection && unconfirmed && !confirmedPhotos && !journaling()) return yield* exact();
  const requested = baseline || textReading || !protection?.boxes.length
    ? yield* unit('text-pieces', () => textPieces(source, width, height, exactRects, regions, [], readUnboxed, readMarks)) : null;
  if (!protection) unboxedSource = markCoverage = null;
  const requiredPieces = baseline || textReading ? requested.pieces.flatMap(piece => placed(piece).map(position => ({...position, mask: piece.mask}))) : null;
  if (textReading) textReading.pieces = requiredPieces;
  const bare = baseline ? yield* fileStage('baseline', () => scaled(baseline(requiredPieces, protection?.regions), 0, 0), bare => bare.bytes, photoAdmission) : null;
  const exactFile = function* () { return bare && captureExact(bare.bytes) ? bare.bytes : yield* exact(); };
  const shorter = bytes => bare?.exact && bare.bytes.length <= bytes.length && (!photoAdmission || photoAdmission.accepts(bare.bytes)) ? bare.bytes : bytes;
  if (!protection && large) return null;
  if (!protection && unconfirmed && !confirmedPhotos) return shorter(yield* exactFile());
  let {pieces: all, blocks} = protection?.boxes.length ? yield* unit('text-pieces', () => textPieces(source, width, height, exactRects, regions, protection.boxes, readUnboxed, readMarks)) : requested;
  unboxedSource = markCoverage = null;
  if (bare?.wholePhoto && protection?.mayBeExact) ({pieces: all, blocks} = requested);
  const masks = all.filter(r => r.mask), boxes = all.filter(r => !r.mask), muls = masks.map(r => ({...r, role: 'mul'}));
  const pieces = all.map(r => r.mask ? {...r, role: 'add'} : r), layered = [...muls, ...pieces.filter(r => r.role)];
  const groups = [...layered, ...boxes], limit = 268435456;
  let work = 1 + groups.length * 6, memory = 12 + groups.length * 160;
  for (const r of groups) {
    const count = (r.positions?.length ?? 2) / 2;
    work += count * (5 + 3 * r.w * r.h); memory += count * 168;
  }
  if (work > limit || memory > limit) return large ? null : shorter(yield* exactFile());

  const selectedProtection = collector?.patches(width, height, all);


  const phases = new Float64Array(64);
  for (const r of regions) phases[(r.y & 7) * 8 + (r.x & 7)] += r.width * r.height;
  let phase = 0;
  for (let i = 1; i < 64; i++) if (phases[i] > phases[phase]) phase = i;
  const dx = (8 - (phase & 7)) & 7, dy = (8 - (phase >> 3)) & 7, fw = width + dx, fh = height + dy;
  const placedBoxes = boxes.flatMap(placed);
  let laidOut = null;
  const rowsOf = () => laidOut ??= (() => {
    const data = masks.length ? inkFilled(source, width, masks) : source;
    return fusedFrameRows(data, width, dx, dy, placedBoxes) ?? frameRows(data, width, dx, dy, placedBoxes);
  })();
  const looked = [];
  for (const r of regions) {
    const offGrid = ((r.x + dx) & 7) !== 0 || ((r.y + dy) & 7) !== 0;
    looked.push(journaling() && qualityOf.steps ? yield* stage('region-quality', () => qualityOf.steps(r, offGrid, dx, dy))
      : yield* unit('region-quality', () => qualityOf(r, offGrid, dx, dy)));
  }
  let own = regions.length || areas.length ? [...regions.map((r, i) => ({x: r.x + dx, y: r.y + dy, width: r.width, height: r.height, quality: looked[i]})), ...areas.map(a => ({...a, x: a.x + dx, y: a.y + dy}))] : null;
  const crop = dx || dy ? {x: -dx, y: -dy, width: fw, height: fh} : null;
  const placement = {imageWidth: width, imageHeight: height, crop};
  const verdictPairs = photoAdmission?.crops ? regions.map(r => ({source: r, crops: (photoRects.length ? photoRects : regions).map(p => {
    const x = Math.max(0, p.x), y = Math.max(0, p.y);
    return {x, y, width: Math.min(width, p.x + p.width) - x, height: Math.min(height, p.y + p.height) - y};
  }).filter(c => c.width > 0 && c.height > 0 && c.x < r.x + r.width && r.x < c.x + c.width && c.y < r.y + r.height && r.y < c.y + c.height)}))
    .filter(p => p.crops.length) : null;
  const photoCrops = (photoRects.length ? photoRects : regions).map(r => {
    if (!photoAdmission) return {...r, x: r.x + dx, y: r.y + dy};
    const x = Math.max(0, r.x), y = Math.max(0, r.y);
    return {...r, x: x + dx, y: y + dy, width: Math.min(width, r.x + r.width) - x, height: Math.min(height, r.y + r.height) - y};
  }).filter(r => !photoAdmission || r.width > 0 && r.height > 0);
  const referenceRows = photoBlocks && frameRows(source, width, dx, dy, []);
  const exactPieces = photoBlocks && all.flatMap(r => placed(r).map(position => ({...position, mask: r.mask})));
  const exactRows = photoBlocks && ((top, count) => {
    const mask = new Uint8Array(fw * count);
    for (const r of exactPieces) {
      const x0 = Math.max(0, r.x + dx), x1 = Math.min(fw, r.x + dx + r.w);
      const y0 = Math.max(top, r.y + dy), y1 = Math.min(top + count, r.y + dy + r.h);
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++)
        if (!r.mask || r.mask[(y - r.y - dy) * r.w + x - r.x - dx]) mask[(y - top) * fw + x] = 1;
    }
    return mask;
  });
  const project = photoBlocks && ((rgba, top) => {
    const count = rgba.length / (fw * 4);
    for (const r of exactPieces) {
      const x0 = Math.max(0, r.x + dx), x1 = Math.min(fw, r.x + dx + r.w);
      const y0 = Math.max(top, r.y + dy), y1 = Math.min(top + count, r.y + dy + r.h);
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        if (r.mask && !r.mask[(y - r.y - dy) * r.w + x - r.x - dx]) continue;
        const from = ((y - dy) * width + x - dx) * 4, to = ((y - top) * fw + x) * 4;
        rgba.set(source.subarray(from, from + 4), to);
      }
    }
  });
  if (photoBlocks && photoScoreMemo && photoBlockEffort >= 5) photoScoreMemo.patched(source, width, height,
    {dx, dy, quality, colorSpace, areas: own, crops: photoCrops, masks, placedBoxes, exactPieces}, {rows: rowsOf(), referenceRows, exactRows, project});
  const frame = (more, from, span) => {
    const steps = () => scaled((photoBlocks ?? pageFrameSteps)((y, count) => rowsOf()(y, count), fw, fh, {quality, colorSpace, areas: own,
      placement: {...placement, ...more}, effort: photoBlockEffort ?? exactOptions.effort,
      ...(photoBlocks && {photoBlockEffort, readingWebp, photoCrops, referenceRows, exactRows, project, signal: exactOptions.signal, photoAdmission, photoScoreMemo})}), from, span);
    return photoBlocks ? steps() : fileStage('page-frame', steps, bytes => bytes, photoAdmission);
  };
  if (!all.length) {
    const bytes = yield* frame({}, 0, 1); if (verdictPairs) photoAdmission.crops(verdictPairs, bytes); collector?.record(bytes, selectedProtection); return shorter(bytes);
  }
  const packing = [...pieces.filter(r => !r.block), ...blocks], placing = [...packing, ...muls];
  const made = atlasArea([...layered, ...boxes], blocks) <= WHOLE && (yield* unit('atlas-pack', () => {
    const packed = packAtlas(packing, source, width, muls);
    return {packed, places: placing.map(r => [r.ax, r.ay])};
  }));
  if (made) placing.forEach((r, i) => { [r.ax, r.ay] = made.places[i]; });
  const packed = made && made.packed;
  if (!packed) return large ? null : shorter(yield* exactFile());
  const {atlas, aw, ah} = packed;
  for (const r of boxes) if (r.block) { r.ax = r.block.ax; r.ay = r.block.ay; }
  const big = aw * ah > 131072 && Math.ceil(aw / 1024) * Math.ceil(ah / 1024) < 4;
  const first = yield* scaled(encodeAtlasSteps(atlas, aw, ah, width, height, {...exactOptions, colorSpace}, big ? 256 : undefined), 0, 0.5);
  const patches = {groups: groups.map(r => ({x: r.x, y: r.y, w: r.w, h: r.h, ax: r.ax, ay: r.ay, mode: r.role === 'mul' ? PEEL_MUL : r.role === 'add' ? PEEL_ADD : undefined, positions: (r.positions ?? [r.x, r.y]).map((v, i) => v + (i & 1 ? dy : dx))}))};
  const page = yield* frame({isFirstFrame: false, patches}, 0.5, 0.5);
  if (verdictPairs) photoAdmission.crops(verdictPairs, page);
  const bytes = new Uint8Array(first.length + page.length);
  bytes.set(first); bytes.set(page, first.length);
  collector?.record(bytes, selectedProtection);
  return shorter(photoAdmission ? photoAdmission.join(bytes, [page]) : bytes);
}

export function* fileStage(name, steps, file, admission, whole = false) {
  const made = yield* stage(name, function* () {
    const value = yield* steps(), bytes = file(value);
    return {value, exact: !!bytes && captureExact(bytes), passed: bytes && admission ? admission.accepts(bytes) : null,
      measured: bytes && admission ? admission.scored?.(bytes) ?? admission.measurements(bytes) : null};
  }, undefined, whole);
  const bytes = file(made.value);
  if (bytes && made.exact && !captureExact(bytes)) markCaptureExact(bytes);
  if (bytes && admission && made.passed !== null && (made.passed !== admission.accepts(bytes) || made.measured?.length && !admission.scored?.(bytes)?.length))
    admission.record(bytes, made.passed, made.measured);
  return made.value;
}

function* scaled(steps, from, span) {
  let step, reply, failed = false;
  try {
    while (!(step = steps.next(reply)).done) reply = yield typeof step.value === 'number' ? from + span * step.value : step.value;
    return step.value;
  } catch (error) {
    failed = true; throw error;
  } finally {
    try { steps.return?.(); } catch (error) { if (!failed) throw error; }
  }
}


