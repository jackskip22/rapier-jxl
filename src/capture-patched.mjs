// SPDX-License-Identifier: MIT
import {encodeAtlasSteps, encodeCaptureSteps, captureExact, CAPTURE_LEVEL} from './capture-codec.mjs';
import {WHOLE, bandRows} from './memory-device.mjs';
import {capturePatchGroups, PEEL_ADD, PEEL_MUL} from './capture-patches.mjs';
import {captureBoxLines, captureGroundCells, captureTextMask, captureGrounded, captureMaskComponents, captureInkBits, captureMarkFacts, captureMarkStrokes, captureProtectedBoxes, captureInkKeep, capturePatchMarks, releaseMaskArena} from './capture-kernels.mjs';
import {pixelKeys} from './screen-crop.mjs';
import {pageFrameSteps} from './photo-frame-bands.mjs';
import {fusedFrameRows} from './capture-fused.mjs';
import {screenPhotoRegions} from './screen-photo-regions.mjs';
import {expandPhotoRegions} from './screen-photo-borders.mjs';
import {photoMasks, releasePhotoMasks} from './screen-photo-mask.mjs';
import {flatSamples} from './screen-samples.mjs';
import {fault} from './fault.mjs';
import {CAPTURE_PROTECTION} from './capture-protection.mjs';
import {CAPTURE_FACTS} from './v7/capture-facts.mjs';
import {unit, stage, journaling} from './step-journal.mjs';
import {markCaptureExact} from './capture-codec.mjs';
const append = (to, items) => { for (const item of items) to.push(item); return to; };

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

const PICTURE_KEPT = 0.9;
const STRONG_KEPT = 0.5, STRONG_BITS = 3, FLAT_BOX = 8192;
export function groundCells(data, width, height, box, text = null) {
  return captureGroundCells(data, width, height, box, text);
}
export function solidInk(data, width, box, ground = null) {
  const read = captureInkKeep(data, width, box, ground);
  return read && solidParts(data, width, box, ground, read.strong, read.keep);
}
function solidParts(data, width, box, ground, strong, keep) {
  const {x: X, y: Y, w, h} = box, n = w * h;
  const out = captureMaskComponents(keep, w, h).map(r => ({x: X + r.x, y: Y + r.y, width: r.width, height: r.height}));
  const parts = patchBoxes(out, Infinity, Infinity);
  if (ground && parts.reduce((s, r) => s + r.w * r.h, 0) >= (strong ? STRONG_KEPT : PICTURE_KEPT) * n) return null;
  if (strong) {
    const {bits, out, off} = captureInkBits(data, width, box, parts);
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

const sameMarkGroups = (a, b) => a.length === b.length && a.every((g, i) => {
  const o = b[i];
  if (g === o) return true;
  if (g.x !== o.x || g.y !== o.y || g.w !== o.w || g.h !== o.h || g.positions.length !== o.positions.length) return false;
  for (let k = 0; k < g.positions.length; k++) if (g.positions[k] !== o.positions[k]) return false;
  return true;
});

function textPieces(data, width, height, exactRects, regions, protectedBoxes, readUnboxed, readMarks, textComplete = false, confirmedPhotoBoxes = [], textMask = null, releasedRects = [], shared = null) {
  const meets = (b, r) => b.x < r.x + r.width && r.x < b.x + b.w && b.y < r.y + r.height && r.y < b.y + b.h;
  const onPicture = b => regions.some(r => meets(b, r));
  let solid, plainOwn, freed, glyphs, ground;
  if (shared) {
    ({solid, plainOwn, freed, glyphs} = shared);
    ground = shared.groundBase ? shared.groundBase.slice() : null;
  } else {
    const own = exactRects.filter(r => r.solidText === true);
    solid = patchBoxes(own, width, height);
    plainOwn = patchBoxes(exactRects.filter(r => r.solidText !== true), width, height);
    const released = textMask ? releasedBoxes(own, releasedRects, textMask, width, height) : null;
    freed = solid.map(b => !!textMask && onPicture(b) && released(b));
    const reads = solid.map((b, i) => freed[i] ? [] : onPicture(b) ? [b] : solidInk(data, width, b) ?? [b]);
    glyphs = reads.flat();
    ground = groundOf(solid.flatMap((b, i) => onPicture(b) ? [reads[i]] : []), width, height);
  }
  const plain = [...protectedBoxes, ...plainOwn];
  const whole = textMask ? [...plain, ...solid.filter((b, i) => !freed[i] && onPicture(b)), ...glyphs] : [];
  const maskPieces = textMask ? maskedText(data, width, height, textMask, solid.filter((b, i) => freed[i]), whole) : [];
  if (!plain.length && !glyphs.length && !maskPieces.length) return {pieces: [], blocks: []};
  const photos = confirmedPhotoBoxes, exactBoxes = [...plain, ...glyphs];
  const maskBoxes = textComplete && photos.length ? [...exactBoxes, ...maskPieces, ...patchBoxes(photos, width, height)] : [...exactBoxes, ...maskPieces];
  append(plain, patchBoxes(unboxedMarks(data, width, height, maskBoxes, readUnboxed, textComplete ? [] : photos), width, height));
  let {groups, covered} = readMarks();
  if (photos.length && groups.length) {
    let dropped = false;
    const filtered = [];
    for (const g of groups) {
      if (!(textComplete || Math.min(g.w, g.h) >= 24 && !captureGrounded(data, width, g.x, g.y, g.w, g.h))) { filtered.push(g); continue; }
      const pos = [];
      for (let i = 0; i < g.positions.length; i += 2) {
        const box = {x: g.positions[i], y: g.positions[i + 1], w: g.w, h: g.h};
        if (photos.some(r => meets(box, r)) && !exactBoxes.some(b => meets(box, {x: b.x, y: b.y, width: b.w, height: b.h}))) { dropped = true; continue; }
        pos.push(box.x, box.y);
      }
      const c = pos.length >> 1;
      if (c >= 2 && (c - 1) * 3 * g.h > 3.5 * c + 8) filtered.push(pos.length === g.positions.length ? g : {...g, x: pos[0], y: pos[1], positions: pos});
      else if (pos.length < g.positions.length) dropped = true;
    }
    if (dropped) {
      groups = filtered;
      if (shared?.groups && sameMarkGroups(groups, shared.groups)) covered = shared.covered;
      else {
        covered = new Uint8Array(width * height);
        for (const g of groups) for (let i = 0; i < g.positions.length; i += 2)
          for (let r = 0, at = g.positions[i + 1] * width + g.positions[i]; r < g.h; r++, at += width) covered.fill(1, at, at + g.w);
      }
    }
  }
  let boxCache = null;
  if (shared && !ground) {
    if (shared.covered === covered) boxCache = shared.boxCache;
    else { shared.groups = groups; shared.covered = covered; boxCache = shared.boxCache = new Map(); }
  }
  const pieces = [...groups.map(g => ({x: g.x, y: g.y, w: g.w, h: g.h, positions: g.positions})), ...maskPieces];
  const runs = [];
  if (boxCache) {
    const readBox = b => {
      const key = `${b.x},${b.y},${b.w},${b.h}`;
      let entry = boxCache.get(key);
      if (!entry) {
        const ownRuns = [], ownRest = [], ownPieces = [];
        uniformRuns(data, width, b, covered, ownRuns, ownRest, 0);
        for (const r of ownRest) append(ownPieces, uncoveredBoxes(width, r, covered));
        entry = {runs: ownRuns, pieces: ownPieces};
        boxCache.set(key, entry);
      }
      return entry;
    };
    const plainPieces = [], glyphPieces = [];
    for (const b of plain) { const e = readBox(b); append(runs, e.runs); for (const u of e.pieces) plainPieces.push({x: u.x, y: u.y, w: u.w, h: u.h}); }
    for (const b of glyphs) { const e = readBox(b); append(runs, e.runs); for (const u of e.pieces) glyphPieces.push({x: u.x, y: u.y, w: u.w, h: u.h}); }
    append(append(pieces, plainPieces), glyphPieces);
  } else {
    const rest = [], inked = [];
    for (const b of plain) uniformRuns(data, width, b, covered, runs, rest, 0);
    for (const b of glyphs) uniformRuns(data, width, b, covered, runs, inked, 0);
    for (const b of rest) append(pieces, uncoveredBoxes(width, b, covered));
    for (const b of inked) for (const u of uncoveredBoxes(width, b, covered)) pieces.push(masked(data, width, u, ground) ?? u);
  }
  const blocks = new Map(), shapes = new Map();
  for (const u of runs) {
    const pw = Math.min(BLOCK, u.w), ph = Math.min(BLOCK, u.h);
    const block = blocks.get(u.c) ?? {c: u.c, w: 0, h: 0};
    block.w = Math.max(block.w, pw); block.h = Math.max(block.h, ph); blocks.set(u.c, block);
    const key = `${u.c},${pw},${ph}`, shape = shapes.get(key) ?? {w: pw, h: ph, block, positions: []};
    shapes.set(key, shape);
    for (let y = 0; y < u.h; y += ph) for (let x = 0; x < u.w; x += pw) shape.positions.push(u.x + Math.min(x, u.w - pw), u.y + Math.min(y, u.h - ph));
  }
  append(pieces, shapes.values());
  return {pieces, blocks: [...blocks.values()]};
}
const BLOCK = 64;
function textMaskOf(data, under, width, height) {
  return captureTextMask(data, under, width, height).mask;
}
function releasedBoxes(own, rects, mask, width, height) {
  const on = new Uint8Array(width * height);
  for (const r of patchBoxes(rects, width, height)) for (let y = r.y; y < r.y + r.h; y++) on.fill(1, y * width + r.x, y * width + r.x + r.w);
  const inside = r => { for (let y = r.y; y < r.y + r.h; y++) if (on.subarray(y * width + r.x, y * width + r.x + r.w).includes(0)) return false; return true; };
  const changed = r => { for (let y = r.y; y < r.y + r.h; y++) if (mask.subarray(y * width + r.x, y * width + r.x + r.w).includes(2)) return true; return false; };
  const each = own.map(r => patchBoxes([r], width, height)[0]).filter(Boolean).map(r => ({...r, ok: inside(r) && changed(r)}));
  return b => each.every(r => !(r.x < b.x + b.w && b.x < r.x + r.w && r.y < b.y + b.h && b.y < r.y + r.h) || r.ok);
}
function maskedText(data, width, height, mask, boxes, whole) {
  const keep = mask.map(v => v ? 1 : 0);
  for (const b of whole) for (let y = b.y; y < b.y + b.h; y++) keep.fill(0, y * width + b.x, y * width + b.x + b.w);
  for (const b of boxes) for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x, p = y * width + x; x < b.x + b.w; x++, p++) keep[p] = mask[p] ? 1 : 0;
  const parts = captureMaskComponents(keep, width, height);
  const ground = new Uint8Array(width * height), pieces = patchBoxes(parts, width, height);
  for (const u of pieces) for (let y = u.y; y < u.y + u.h; y++) for (let x = u.x, p = y * width + x; x < u.x + u.w; x++, p++) if (!keep[p]) ground[p] = 1;
  return pieces.map(u => {
    const text = new Uint8Array(u.w * u.h);
    for (let y = 0; y < u.h; y++) for (let x = 0, p = (u.y + y) * width + u.x; x < u.w; x++, p++) if (keep[p] && mask[p] === 2) text[y * u.w + x] = 1;
    const m = masked(data, width, u, ground);
    return m ? {...m, text, under: true} : {...u, text};
  });
}
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
function uniformRuns(data, width, box, covered, runs, rest, depth, lines = captureBoxLines(data, width, covered, box)) {
  const kinds = (x, y, n, rows, count) => lines(x, y, n, rows, count);
  const rowKinds = kinds(box.x, box.y, box.w, true, box.h);
  for (let i = 0; i < rowKinds.length;) {
    let e = i + 1; while (e < rowKinds.length && rowKinds[e] === rowKinds[i]) e++;
    const y0 = box.y + i, h = e - i, c = rowKinds[i];
    if (c >= 0) runs.push({x: box.x, y: y0, w: box.w, h, c});
    else if (c === -1 && depth > 2) rest.push({x: box.x, y: y0, w: box.w, h});
    else if (c === -1) {
      const colKinds = kinds(box.x, y0, h, false, box.w);
      for (let j = 0; j < colKinds.length;) {
        let f = j + 1; while (f < colKinds.length && colKinds[f] === colKinds[j]) f++;
        const c2 = colKinds[j], part = {x: box.x + j, y: y0, w: f - j, h};
        if (c2 >= 0) runs.push({...part, c: c2});
        else if (c2 === -1) uniformRuns(data, width, part, covered, runs, rest, depth + 1, lines);
        j = f;
      }
    }
    i = e;
  }
}
const MARK_SIDE = 128, MARK_LONG = 2048, MARK_CONTRAST = 64, GROUND_CONTRAST = 96;
const UNBOXED_PIXELS = 1 << 22;
const MARKS_SPENT = Symbol('marks spent');
function unboxedSourceMarks(data, width, height, y0, h) {
  const part = data.subarray(y0 * width * 4, (y0 + h) * width * 4);
  const marks = capturePatchMarks(pixelKeys(part), width, h, MARK_LONG, 1 << 16, 1);
  if (!marks) throw Object.assign(fault('JXL_LIMIT', 'text marks: budget exhausted'), {[MARKS_SPENT]: true});
  const small = [];
  for (let i = 0; i < marks.length; i += 4) if (Math.min(marks[i + 2], marks[i + 3]) <= MARK_SIDE) small.push(marks[i], marks[i + 1] + y0, marks[i + 2], marks[i + 3]);
  return captureMarkStrokes(data, width, height, y0, h, Int32Array.from(small));
}
function unboxedMarks(data, width, height, boxes, readSource = null, photos = []) {
  const rows = Math.max(1, Math.floor(UNBOXED_PIXELS / width)), boxed = new Uint8Array(Math.min(height, rows) * width), out = [];
  for (let y0 = 0; y0 < height; y0 += rows) {
    const h = Math.min(rows, height - y0), strip = boxed.subarray(0, h * width);
    strip.fill(0);
    for (const b of boxes) {
      const top = Math.max(y0, b.y), end = Math.min(y0 + h, b.y + b.h);
      for (let y = top; y < end; y++) strip.fill(1, (y - y0) * width + b.x, (y - y0) * width + b.x + b.w);
    }
    const sourceMarks = readSource ? readSource(y0, h) : unboxedSourceMarks(data, width, height, y0, h);
    const {facts, grounded} = captureMarkFacts(data, width, y0, h, strip, sourceMarks);
    for (let q = 0; q < sourceMarks.length; q++) {
      const {x, y, w, h: mh, ground} = sourceMarks[q], {open, lo, hi} = facts[q];
      const off = c => { const g = ground >> (16 - 8 * c) & 255; return Math.max(hi[c] - g, g - lo[c]); };
      const stands = hi.some((v, c) => v - lo[c] >= MARK_CONTRAST) || ground >= 0 && [0, 1, 2].some(c => off(c) >= GROUND_CONTRAST);
      if (!open || !stands) continue;
      if (photos.length && Math.min(w, mh) >= 24 && photos.some(r => x < r.x + r.width && r.x < x + w && y < r.y + r.height && r.y < y + mh) && !grounded(sourceMarks[q])) continue;
      if (Math.max(w, mh) > MARK_SIDE && (Math.max(w, mh) < 3 * Math.min(w, mh) || !grounded(sourceMarks[q]))) continue;
      out.push({x, y, width: w, height: mh});
    }
  }
  return out;
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
      if (found) append(found.positions, mark.positions);
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
function inkFilled(data, width, masks, under = null) {
  const out = data.slice();
  for (const r of masks) if (r.under && under) for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) if (r.mask[y * r.w + x]) {
    const o = ((r.y + y) * width + r.x + x) * 4;
    out[o] = under[o]; out[o + 1] = under[o + 1]; out[o + 2] = under[o + 2];
  }
  for (const r of masks) if (!(r.under && under)) for (let y = 0; y < r.h; y++) {
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

export function protectedPageBoxes(data, width, height) {
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
  const masks = photoMasks(data, width, height, regions);
  let union = null;
  if (regions.length > 1 && masks.some(Boolean)) {
    const x = Math.min(...regions.map(r => r.x)), y = Math.min(...regions.map(r => r.y));
    const box = {x, y, width: Math.max(...regions.map(r => r.x + r.width)) - x, height: Math.max(...regions.map(r => r.y + r.height)) - y};
    const [mask] = photoMasks(data, width, height, [box], [], 4096, false);
    if (!mask) { releaseMaskArena(); return null; }
    union = {box, mask};
  }
  const read = captureProtectedBoxes(width, height, regions, masks, union);
  releaseMaskArena();
  return read.photo === 0 || !read.boxes ? null : {boxes: read.boxes, mayBeExact, regions};
}

function protectedLargeBoxes(data, width, height) {
  const boxes = [], rows = bandRows(width);
  for (let y = 0; y < height; y += rows) {
    const h = Math.min(rows, height - y), part = data.subarray(y * width * 4, (y + h) * width * 4);
    const protection = protectedPageBoxes(part, width, h);
    releasePhotoMasks(part);
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
const ROUTE_MARGIN = 1.1;
const UPLOAD = typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true;
export function* patchedPageSteps(source, width, height, {quality, regions = [], unconfirmed = false, confirmedPhotos = false, textComplete = false, areas = [], qualityOf = () => quality, exactRects, colorSpace, exactOptions = {}, photoBlocks = null, photoBlockEffort, readingIntent, readingLook, photoRects = [], photoAdmission, photoScoreMemo = null, baseline, noHintFirst = false, pageRoute = null, textReading, withoutText, [CAPTURE_PROTECTION]: collector, [CAPTURE_FACTS]: facts}) {
  const large = width * height > WHOLE, found = yield* unit('protection', () => large ? protectedLargeBoxes(source, width, height) : protectedPageBoxes(source, width, height));
  const confirmed = regions.flatMap(r => photoRects.flatMap(p => {
    const x = Math.max(r.x, p.x), y = Math.max(r.y, p.y), w = Math.min(r.x + r.width, p.x + p.width) - x, h = Math.min(r.y + r.height, p.y + p.height) - y;
    return w > 0 && h > 0 ? [{x, y, width: w, height: h, ...(r.palette && {palette: true})}] : [];
  }));
  const protection = textComplete && found && confirmed.length ? outsidePictures(found, confirmed) : found;
  const confirmedPhotoBoxes = confirmed.filter(c => !c.palette);
  const exact = (answer = false) => encodeCaptureSteps(source, width, height, {...exactOptions, ...(answer && {[CAPTURE_LEVEL]: undefined}), colorSpace, maxError: 0});
  let unboxedSource = null, markCoverage = null, textShared = null;
  const readUnboxed = (y0, h) => {
    const key = `${y0}:${h}`, map = unboxedSource ??= new Map();
    let got = map.get(key);
    if (!got) map.set(key, got = unboxedSourceMarks(source, width, height, y0, h));
    return got;
  };
  const readMarks = () => {
    if (markCoverage) return markCoverage;
    const groups = pageMarks(source, width, height)?.groups ?? [], covered = new Uint8Array(width * height);
    for (const g of groups) for (let i = 0; i < g.positions.length; i += 2)
      for (let r = 0, at = g.positions[i + 1] * width + g.positions[i]; r < g.h; r++, at += width) covered.fill(1, at, at + g.w);
    return markCoverage = {groups, covered};
  };
  let mask;
  const textMask = () => mask === undefined ? mask = withoutText ? textMaskOf(source, withoutText.data, width, height) : null : mask;
  const ensureTextShared = () => {
    if (textShared) return textShared;
    const m = textMask(), own = exactRects.filter(r => r.solidText === true), solid = patchBoxes(own, width, height);
    const plainOwn = patchBoxes(exactRects.filter(r => r.solidText !== true), width, height);
    const meets = (b, r) => b.x < r.x + r.width && r.x < b.x + b.w && b.y < r.y + r.height && r.y < b.y + b.h;
    const onPicture = b => regions.some(r => meets(b, r)), released = m ? releasedBoxes(own, withoutText?.rects ?? [], m, width, height) : null;
    const freed = solid.map(b => !!m && onPicture(b) && released(b));
    const reads = solid.map((b, i) => freed[i] ? [] : onPicture(b) ? [b] : solidInk(source, width, b) ?? [b]), glyphs = reads.flat();
    const groundBase = groundOf(solid.flatMap((b, i) => onPicture(b) ? [reads[i]] : []), width, height);
    return textShared = {solid, plainOwn, freed, glyphs, groundBase, groups: null, covered: null, boxCache: null};
  };
  let spent = false;
  const textPiecesOf = boxes => {
    const shared = ensureTextShared();
    if (!spent) try { return textPieces(source, width, height, exactRects, regions, boxes, readUnboxed, readMarks, textComplete, confirmedPhotoBoxes, textMask(), withoutText?.rects, shared); }
    catch (error) { if (!error?.[MARKS_SPENT]) throw error; spent = true; if (facts) facts.textMarks = 'skipped'; }
    return textPieces(source, width, height, exactRects, regions, boxes, () => [], readMarks, textComplete, confirmedPhotoBoxes, textMask(), withoutText?.rects, shared);
  };
  if (!protection && unconfirmed && !confirmedPhotos) return yield* exact(true);
  const requested = baseline || textReading || !protection?.boxes.length
    ? yield* unit('text-pieces', () => textPiecesOf([])) : null;
  if (!protection) unboxedSource = markCoverage = textShared = null;
  const requiredPieces = baseline || textReading ? requested.pieces.flatMap(piece => placed(piece).map(position => ({...position, mask: piece.text ?? piece.mask, ...(piece.text && {released: true})}))) : null;
  if (textReading) textReading.pieces = requiredPieces;
  const bare = baseline ? yield* fileStage('baseline', () => scaled(baseline(requiredPieces, protection?.regions), 0, 0), bare => bare.bytes, photoAdmission) : null;
  if (bare?.reads?.length) baseline.seen?.(bare.reads);
  if (noHintFirst && bare?.exact && bare.bytes && !captureExact(bare.bytes) && (!photoAdmission || photoAdmission.accepts(bare.bytes))) return bare.bytes;
  const exactFile = function* () { return bare && captureExact(bare.bytes) ? bare.bytes : yield* exact(); };
  const shorter = bytes => {
    if (!(bare?.exact && bare.bytes.length <= bytes.length && (!photoAdmission || photoAdmission.accepts(bare.bytes)))) return bytes;
    if (bare.reads?.length) baseline.seen?.(bare.reads);
    return bare.bytes;
  };
  if (!protection && large) return null;
  if (!protection && unconfirmed && !confirmedPhotos) return shorter(yield* exactFile());
  let {pieces: all, blocks} = protection?.boxes.length ? yield* unit('text-pieces', () => textPiecesOf(protection.boxes)) : requested;
  unboxedSource = markCoverage = textShared = null;
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
  if (pageRoute?.smaller === 'bare' && bare?.exact && (!photoAdmission || photoAdmission.accepts(bare.bytes))) {
    const packing = [...pieces.filter(r => !r.block), ...blocks];
    const fits = !all.length || atlasArea([...layered, ...boxes], blocks) <= WHOLE && (yield* unit('atlas-pack', () => {
      const packed = packAtlas(packing, source, width, muls);
      return {packed, places: [...packing, ...muls].map(r => [r.ax, r.ay])};
    })).packed;
    releasePhotoMasks(source);
    return fits ? bare.bytes : shorter(yield* exactFile());
  }
  const ordered = bytes => { if (pageRoute && pageRoute.smaller === undefined && bare?.bytes && bytes) pageRoute.smaller = bare.bytes.length * ROUTE_MARGIN <= bytes.length ? 'bare' : 'both'; return shorter(bytes); };

  const selectedProtection = collector?.patches(width, height, all);


  const phases = new Float64Array(64);
  for (const r of regions) phases[(r.y & 7) * 8 + (r.x & 7)] += r.width * r.height;
  let phase = 0;
  for (let i = 1; i < 64; i++) if (phases[i] > phases[phase]) phase = i;
  const dx = (8 - (phase & 7)) & 7, dy = (8 - (phase >> 3)) & 7, fw = width + dx, fh = height + dy;
  const placedBoxes = boxes.flatMap(placed);
  let laidOut = null;
  const rowsOf = () => laidOut ??= (() => {
    const data = masks.length ? inkFilled(source, width, masks, withoutText?.data) : source;
    return fusedFrameRows(data, width, dx, dy, placedBoxes) ?? frameRows(data, width, dx, dy, placedBoxes);
  })();
  const targets = regions.flatMap(r => {
    if (!photoRects.length || photoRects.length > 256) return [r];
    const sub = photoRects.map(p => {
      const x = Math.max(0, r.x, Math.round(p.x)), y = Math.max(0, r.y, Math.round(p.y));
      const w = Math.min(width, r.x + r.width, Math.round(p.x + p.width)) - x;
      const h = Math.min(height, r.y + r.height, Math.round(p.y + p.height)) - y;
      return {x, y, width: w, height: h, area: Math.max(1, p.width * p.height), ...(r.rescued && {rescued: true})};
    }).filter(c => c.width >= 16 && c.height >= 16 && c.width * c.height * 2 >= c.area);
    if (sub.length > 256) return [r];
    if (sub.length > 1 || sub.length === 1 && sub[0].width * sub[0].height * 4 >= r.width * r.height * 3) return sub;
    return sub.length === 1 && sub[0].width * sub[0].height * 2 >= r.width * r.height ? [{...r, subject: sub[0]}] : [r];
  });
  const looked = [];
  for (const r of targets) {
    const offGrid = ((r.x + dx) & 7) !== 0 || ((r.y + dy) & 7) !== 0;
    const readings = qualityOf.readings;
    if (readings) {
      const [q, taken] = journaling() && qualityOf.steps ? yield* stage('region-quality', () => readings.tapped(qualityOf.steps(r, offGrid, dx, dy)))
        : yield* unit('region-quality', () => readings.taps(() => qualityOf(r, offGrid, dx, dy)));
      readings.seen(taken); looked.push(q);
    } else looked.push(journaling() && qualityOf.steps ? yield* stage('region-quality', () => qualityOf.steps(r, offGrid, dx, dy))
      : yield* unit('region-quality', () => qualityOf(r, offGrid, dx, dy)));
  }
  const halos = [];
  if (photoRects.length) for (let i = 0; i < targets.length; i++) {
    const r = targets[i].subject ?? targets[i];
    const rx0 = Math.max(0, r.x), ry0 = Math.max(0, r.y), rx1 = Math.min(width, r.x + r.width), ry1 = Math.min(height, r.y + r.height);
    const rw = rx1 - rx0, rh = ry1 - ry0;
    if (Math.min(rw, rh) < 256) continue;
    const edgeDiff = (x0, y0, sx, sy, len, ox, oy) => {
      const stride = Math.max(1, len >> 4);
      let sum = 0, n = 0;
      for (let k = 0; k < len; k += stride) {
        const a = ((y0 + k * sy) * width + x0 + k * sx) * 4, b = ((y0 + k * sy + oy) * width + x0 + k * sx + ox) * 4;
        sum += Math.abs(source[a] - source[b]) + Math.abs(source[a + 1] - source[b + 1]) + Math.abs(source[a + 2] - source[b + 2]);
        n++;
      }
      return n ? sum / n : 0;
    };
    const q = Math.min(96, Math.max(looked[i], quality) + 8);
    const fx0 = (rx0 + dx) & ~7, fy0 = (ry0 + dy) & ~7;
    const fwSpan = Math.min(fw, (rx1 + dx + 7) & ~7) - fx0, fhSpan = Math.min(fh, (ry1 + dy + 7) & ~7) - fy0;
    for (const px of [rx0, rx0 + 1, rx0 + 2])
      if (px > 0 && px < rx1 && ((px + dx) & 7) && edgeDiff(px, ry0, 0, 1, rh, -1, 0) >= 96) { halos.push({x: (px + dx) & ~7, y: fy0, width: 8, height: fhSpan, quality: q}); break; }
    for (const px of [rx1, rx1 - 1, rx1 - 2])
      if (px > rx0 && px < width && ((px + dx) & 7) && edgeDiff(px - 1, ry0, 0, 1, rh, 1, 0) >= 96) { halos.push({x: (px + dx) & ~7, y: fy0, width: 8, height: fhSpan, quality: q}); break; }
    for (const py of [ry0, ry0 + 1, ry0 + 2])
      if (py > 0 && py < ry1 && ((py + dy) & 7) && edgeDiff(rx0, py, 1, 0, rw, 0, -1) >= 96) { halos.push({x: fx0, y: (py + dy) & ~7, width: fwSpan, height: 8, quality: q}); break; }
    for (const py of [ry1, ry1 - 1, ry1 - 2])
      if (py > ry0 && py < height && ((py + dy) & 7) && edgeDiff(rx0, py - 1, 1, 0, rw, 0, 1) >= 96) { halos.push({x: fx0, y: (py + dy) & ~7, width: fwSpan, height: 8, quality: q}); break; }
  }
  let own = targets.length || areas.length || halos.length ? [...targets.map((r, i) => {
    const snap = photoRects.length > 0 && looked[i] > quality;
    const x0 = snap ? (r.x + dx) & ~7 : r.x + dx, y0 = snap ? (r.y + dy) & ~7 : r.y + dy;
    const w = snap ? Math.min(fw, (r.x + dx + r.width + 7) & ~7) - x0 : r.width;
    const h = snap ? Math.min(fh, (r.y + dy + r.height + 7) & ~7) - y0 : r.height;
    return {x: x0, y: y0, width: w, height: h, quality: looked[i]};
  }), ...halos, ...areas.map(a => ({...a, x: a.x + dx, y: a.y + dy}))] : null;
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
  const referenceRows = !UPLOAD && photoBlocks && frameRows(source, width, dx, dy, []);
  const exactPieces = !UPLOAD && photoBlocks && all.flatMap(r => placed(r).map(position => ({...position, mask: r.mask})));
  const exactRows = !UPLOAD && photoBlocks && ((top, count) => {
    const mask = new Uint8Array(fw * count);
    for (const r of exactPieces) {
      const x0 = Math.max(0, r.x + dx), x1 = Math.min(fw, r.x + dx + r.w);
      const y0 = Math.max(top, r.y + dy), y1 = Math.min(top + count, r.y + dy + r.h);
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++)
        if (!r.mask || r.mask[(y - r.y - dy) * r.w + x - r.x - dx]) mask[(y - top) * fw + x] = 1;
    }
    return mask;
  });
  const project = !UPLOAD && photoBlocks && ((rgba, top) => {
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
  if (!UPLOAD && photoBlocks && photoScoreMemo && photoBlockEffort >= 5) photoScoreMemo.patched(source, width, height,
    {dx, dy, quality, colorSpace, areas: own, crops: photoCrops, masks, placedBoxes, exactPieces}, {rows: rowsOf(), referenceRows, exactRows, project});
  const frame = (more, from, span) => {
    const steps = () => scaled(((UPLOAD ? null : photoBlocks) ?? pageFrameSteps)((y, count) => rowsOf()(y, count), fw, fh, {quality, colorSpace, areas: own,
      placement: {...placement, ...more}, effort: photoBlockEffort ?? exactOptions.effort,
      ...(!UPLOAD && photoBlocks && {photoBlockEffort, readingIntent, readingLook, photoCrops, referenceRows, exactRows, project, signal: exactOptions.signal, photoAdmission, photoScoreMemo})}), from, span);
    return !UPLOAD && photoBlocks ? steps() : fileStage('page-frame', steps, bytes => bytes, photoAdmission);
  };
  if (!all.length) {
    releasePhotoMasks(source);
    const bytes = yield* frame({}, 0, 1); if (verdictPairs) photoAdmission.crops(verdictPairs, bytes); collector?.record(bytes, selectedProtection); return ordered(bytes);
  }
  const packing = [...pieces.filter(r => !r.block), ...blocks], placing = [...packing, ...muls];
  let made = atlasArea([...layered, ...boxes], blocks) <= WHOLE && (yield* unit('atlas-pack', () => {
    const packed = packAtlas(packing, source, width, muls);
    return {packed, places: placing.map(r => [r.ax, r.ay])};
  }));
  if (made) placing.forEach((r, i) => { [r.ax, r.ay] = made.places[i]; });
  let packed = made && made.packed;
  made = null;
  if (!packed) { releasePhotoMasks(source); return large ? null : shorter(yield* exactFile()); }
  releasePhotoMasks(source);
  let {atlas, aw, ah} = packed;
  packed = null;
  for (const r of boxes) if (r.block) { r.ax = r.block.ax; r.ay = r.block.ay; }
  const big = aw * ah > 131072 && Math.ceil(aw / 1024) * Math.ceil(ah / 1024) < 4;
  const first = yield* scaled(encodeAtlasSteps(atlas, aw, ah, width, height, {...exactOptions, colorSpace}, big ? 256 : undefined), 0, 0.5);
  atlas = null;
  if (!journaling() && !pageRoute && !verdictPairs && !collector && bare?.exact && (!photoAdmission || photoAdmission.accepts(bare.bytes)) && first.length >= bare.bytes.length)
    return shorter(first);
  const patches = {groups: groups.map(r => ({x: r.x, y: r.y, w: r.w, h: r.h, ax: r.ax, ay: r.ay, mode: r.role === 'mul' ? PEEL_MUL : r.role === 'add' ? PEEL_ADD : undefined, positions: (r.positions ?? [r.x, r.y]).map((v, i) => v + (i & 1 ? dy : dx))}))};
  const page = yield* frame({isFirstFrame: false, patches}, 0.5, 0.5);
  if (verdictPairs) photoAdmission.crops(verdictPairs, page);
  const bytes = new Uint8Array(first.length + page.length);
  bytes.set(first); bytes.set(page, first.length);
  collector?.record(bytes, selectedProtection);
  return ordered(photoAdmission ? photoAdmission.join(bytes, [page]) : bytes);
}

export function* fileStage(name, steps, file, admission, whole = false) {
  const made = yield* stage(name, function* () {
    const value = yield* steps(), bytes = file(value);
    return {value, exact: !!bytes && captureExact(bytes), passed: bytes && admission ? admission.accepts(bytes) : null,
      measured: bytes && admission ? admission.scored?.(bytes) ?? admission.measurements(bytes) : null,
      ...(bytes && admission?.notesOf && {notes: admission.notesOf(bytes)})};
  }, undefined, whole);
  const bytes = file(made.value);
  if (bytes && made.exact && !captureExact(bytes)) markCaptureExact(bytes);
  if (bytes && made.notes) admission.restore(bytes, made.notes);
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


