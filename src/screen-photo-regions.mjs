// SPDX-License-Identifier: MIT
import {textTiles} from './screen-photo-kernels.mjs';
export {textTiles};
const TILE = 32, MAX_RECTS = 64;
const abs = Math.abs;
const rgb = (data, at) => data[at] | data[at + 1] << 8 | data[at + 2] << 16;
const textured = (data, at, s4) => data[at] | data[at + 4] << 8 | data[at + s4] << 16;
function nearGrey(data, base, s4) {
  for (let y = 0; y < TILE; y += 4) for (let x = 0, at = base + y * s4; x < TILE; x += 4, at += 16)
    if (Math.max(abs(data[at] - data[at + 1]), abs(data[at + 1] - data[at + 2]), abs(data[at + 2] - data[at])) > 12) return false;
  return true;
}
const keys = new Int32Array(1024), stamps = new Uint32Array(1024);
let stamp = 0;
function hasColors(need, data, s4, at, cols, rows, dx, dy, tuple) {
  if ((stamp = (stamp + 1) >>> 0) === 0) { stamps.fill(0); stamp = 1; }
  let count = 0;
  for (let v = 0; v < rows; v++) for (let u = 0, p = at + v * dy; u < cols; u++, p += dx) {
    const k = tuple ? textured(data, p, s4) : rgb(data, p);
    let s = Math.imul(k ^ (k >>> 16), 0x9e3779b1) & 1023;
    while (stamps[s] === stamp && keys[s] !== k) s = (s + 1) & 1023;
    if (stamps[s] !== stamp) { if (++count >= need) return true; stamps[s] = stamp; keys[s] = k; }
  }
  return false;
}
function opaque(data, width, tx, ty, tw, th) {
  for (let y = ty * TILE; y < (ty + th) * TILE; y++) for (let at = (y * width + tx * TILE) * 4 + 3, end = at + tw * TILE * 4; at < end; at += 4) if (data[at] < 255) return false;
  return true;
}
const sum = (data, a, b) => abs(data[a] - data[b]) + abs(data[a + 1] - data[b + 1]) + abs(data[a + 2] - data[b + 2]);

const step = (data, a, b) => Math.max(abs(data[a] - data[b]), abs(data[a + 1] - data[b + 1]), abs(data[a + 2] - data[b + 2]));

function cell(data, s4, base) {
  if (!hasColors(2, data, s4, base, 16, 1, 8, 0, false) && !hasColors(2, data, s4, base + (TILE - 1) * s4, 16, 1, 8, 0, false) &&
    !hasColors(2, data, s4, base, 1, 16, 0, 2 * s4, false) && !hasColors(2, data, s4, base + (TILE - 1) * 4, 1, 16, 0, 2 * s4, false)) return 0;
  let runs = 0;
  for (let i = 0; i < 64; i++) { const at = base + (i >> 3) * 4 * s4 + (i & 7) * 16; runs += rgb(data, at) === rgb(data, at + 12); }
  if (runs >= 52) return 0;
  const tuple = nearGrey(data, base, s4), quad = tuple ? 18 : 20, many = tuple ? 80 : 96;
  if (!hasColors(32, data, s4, base, 16, 16, 8, 2 * s4, tuple)) return 0;
  let changes = 0, texture = 0, rough = 0, moving = 0, reversing = 0;
  for (let y = 0; y < TILE; y += 2) for (let x = 0; x < TILE; x += 2) {
    const at = base + y * s4 + x * 4;
    changes += sum(data, at, at + 4) > 30 && sum(data, at, at + s4) > 30;
    const move = Math.min(step(data, at, at + 4), step(data, at, at + s4));
    texture += move > 1; rough += move > 2;
    const p = data[at + 5] - data[at + 1];
    if (p) { moving++; reversing += p * (data[at + 9] - data[at + 5]) < 0; }
  }
  const quarter = q => hasColors(quad, data, s4, base + (q & 2) * 8 * s4 + (q & 1) * 64, 8, 8, 8, 2 * s4, tuple);
  return quarter(0) && quarter(1) && quarter(2) && quarter(3) && hasColors(many, data, s4, base, 16, 16, 8, 2 * s4, tuple) || texture >= 64 && reversing * 10 < moving * 6 ? 1 + (changes >= 4 || rough >= 128) : 0;
}

const CELLS = new WeakMap();
export function photoCells(data, width, height) {
  const had = CELLS.get(data);
  if (had && had.width === width && had.height === height) return had;
  const cols = Math.floor(width / TILE), rows = Math.floor(height / TILE);
  const cells = {cols, rows, kind: new Int8Array(cols * rows).fill(-1), text: new Int8Array(cols * rows).fill(-1), data, width, height};
  CELLS.set(data, cells);
  return cells;
}
const kindAt = (cells, tx, ty) => {
  const i = ty * cells.cols + tx;
  return cells.kind[i] >= 0 ? cells.kind[i] : cells.kind[i] = cell(cells.data, cells.width * 4, (ty * cells.width + tx) * TILE * 4);
};
const textAt = (cells, tx, ty) => {
  const i = ty * cells.cols + tx;
  return cells.text[i] >= 0 ? cells.text[i] : cells.text[i] = textTiles(cells.data, cells.width, tx, ty, tx, ty);
};
const cacheText = (cells, minX, minY, maxX, maxY) => {
  for (let ty = minY; ty <= maxY; ty++) for (let tx = minX; tx <= maxX; tx++) {
    const start = tx, at = ty * cells.cols + tx;
    if (cells.text[at] >= 0) continue;
    while (tx < maxX && cells.text[ty * cells.cols + tx + 1] < 0) tx++;
    textTiles(cells.data, cells.width, start, ty, tx, ty, cells.text.subarray(at, at + tx - start + 1));
  }
};
const textIn = (cells, minX, minY, maxX, maxY) => {
  cacheText(cells, minX, minY, maxX, maxY);
  let n = 0;
  for (let ty = minY; ty <= maxY; ty++) for (let tx = minX; tx <= maxX; tx++) n += textAt(cells, tx, ty);
  return n;
};

const meet = (p, q) => p.x < q.x + q.width && q.x < p.x + p.width && p.y < q.y + q.height && q.y < p.y + p.height;
export function screenPhotoTiles(data, width, height, {x, y, width: w, height: h}, exactRects = [], cells = photoCells(data, width, height), textComplete = false) {
  const x0 = Math.ceil(x / TILE), y0 = Math.ceil(y / TILE), x1 = Math.floor(Math.min(x + w, width) / TILE), y1 = Math.floor(Math.min(y + h, height) / TILE);
  const count = (x1 - x0) * (y1 - y0);
  cacheText(cells, x0, y0, x1 - 1, y1 - 1);
  let text = 0, found = 0;
  for (let ty = y0; ty < y1; ty++) for (let tx = x0; tx < x1; tx++) {
    const X = tx * TILE, Y = ty * TILE;
    found += kindAt(cells, tx, ty) > 0;
    text += !textComplete && !exactRects.some(e => meet(e, {x: X, y: Y, width: TILE, height: TILE})) && textAt(cells, tx, ty);
  }
  return x1 > x0 && y1 > y0 && text * 16 <= count ? found / count : 0;
}

export function screenPhotoResample(data, width, height, {x, y, width: w, height: h}) {
  const x0 = Math.ceil(x / TILE), y0 = Math.ceil(y / TILE);
  const x1 = Math.floor(Math.min(x + w, width) / TILE), y1 = Math.floor(Math.min(y + h, height) / TILE);
  const count = (x1 - x0) * (y1 - y0);
  if (count < 1) return 0;
  const s4 = width * 4;
  let found = 0;
  for (let ty = y0; ty < y1; ty++) for (let tx = x0; tx < x1; tx++) {
    const base = (ty * width + tx) * TILE * 4;
    if (!hasColors(32, data, s4, base, 16, 16, 8, 2 * s4, false)) continue;
    let texture = 0, moving = 0, reversing = 0;
    for (let yy = 0; yy < TILE; yy += 2) for (let xx = 0; xx < TILE; xx += 2) {
      const at = base + yy * s4 + xx * 4;
      texture += Math.min(step(data, at, at + 4), step(data, at, at + s4)) > 1;
      const p = data[at + 5] - data[at + 1];
      if (p) { moving++; reversing += p * (data[at + 9] - data[at + 5]) < 0; }
    }
    found += texture >= 16 && reversing * 10 < moving * 6;
  }
  return found / count;
}

export function screenPhotoRegions(data, width, height, masked = false, extra = [], cells = null) {
  const pixels = width * height;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || data.length !== pixels * 4) return [...extra];
  const cols = Math.floor(width / TILE), rows = Math.floor(height / TILE), tiles = cols >= 4 && rows >= 3 ? cols * rows : 0;
  const seeds = new Uint8Array(tiles), support = new Uint8Array(tiles);
  cells ??= photoCells(data, width, height);
  for (let i = 0; i < tiles; i++) seeds[i] = (support[i] = kindAt(cells, i % cols, i / cols | 0)) > 1;
  const textOf = (x0, y0, x1, y1) => textIn(cells, x0, y0, x1, y1);

  const seen = new Uint8Array(tiles), queue = new Int32Array(tiles), regions = [];
  for (let start = 0; start < tiles; start++) {
    if (!seeds[start] || seen[start]) continue;
    let front = 0, end = 1, strong = 0, minX = start % cols, maxX = minX;
    let minY = Math.floor(start / cols), maxY = minY;
    queue[0] = start; seen[start] = 1;
    while (front < end) {
      const tile = queue[front++], tx = tile % cols, ty = Math.floor(tile / cols);
      strong += seeds[tile];
      minX = Math.min(minX, tx); maxX = Math.max(maxX, tx);
      minY = Math.min(minY, ty); maxY = Math.max(maxY, ty);
      for (let y = Math.max(0, ty - 1); y <= Math.min(rows - 1, ty + 1); y++)
        for (let x = Math.max(0, tx - 1); x <= Math.min(cols - 1, tx + 1); x++) {
          const next = y * cols + x;
          if (support[next] && !seen[next]) { seen[next] = 1; queue[end++] = next; }
        }
    }
    const tw = maxX - minX + 1, th = maxY - minY + 1, area = tw * th;
    if (tw < 4 || th < 3 || strong < Math.min(20, area >> 3) || end * 4 < area ||
        area < 32 && (strong * 2 < area || textOf(minX, minY, maxX, maxY)) ||
        textOf(minX + 1, minY + 1, maxX - 1, maxY - 1) * 16 > (tw - 2) * (th - 2) ||
        !masked && !opaque(data, width, minX, minY, tw, th)) continue;
    regions.push({x: minX * TILE, y: minY * TILE, width: tw * TILE, height: th * TILE});
  }
  regions.push(...extra);
  const kept = [];
  if (masked) for (let a = 0; a < regions.length; a++) for (let b = a + 1; b < regions.length; b++) {
    const p = regions[a], q = regions[b], x = Math.min(p.x, q.x), y = Math.min(p.y, q.y);
    if (meet(p, q)) { regions[a] = {x, y, width: Math.max(p.x + p.width, q.x + q.width) - x, height: Math.max(p.y + p.height, q.y + q.height) - y}; regions.splice(b, 1); a = -1; break; }
  }
  for (const region of regions.sort((a, b) => b.width * b.height - a.width * a.height))
    if (kept.length < MAX_RECTS && !kept.some(r => meet(r, region))) kept.push(region);
  return kept.sort((a, b) => a.y - b.y || a.x - b.x);
}
