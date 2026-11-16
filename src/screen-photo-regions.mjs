// SPDX-License-Identifier: MIT
import {textTiles, supportTiles} from './screen-photo-kernels.mjs';
export {textTiles, supportTiles};
const TILE = 32, MAX_RECTS = 256;

function opaque(data, width, tx, ty, tw, th) {
  for (let y = ty * TILE; y < (ty + th) * TILE; y++) for (let at = (y * width + tx * TILE) * 4 + 3, end = at + tw * TILE * 4; at < end; at += 4) if (data[at] < 255) return false;
  return true;
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

function cacheCells(arr, fn, cells, minX, minY, maxX, maxY) {
  if (minX > maxX || minY > maxY) return;
  const {cols, data, width} = cells;
  let bx0 = maxX + 1, by0 = maxY + 1, bx1 = -1, by1 = -1, missing = 0;
  for (let ty = minY; ty <= maxY; ty++) {
    const row = ty * cols;
    for (let tx = minX; tx <= maxX; tx++) if (arr[row + tx] < 0) {
      if (tx < bx0) bx0 = tx;
      if (tx > bx1) bx1 = tx;
      if (ty < by0) by0 = ty;
      by1 = ty;
      missing++;
    }
  }
  if (!missing) return;
  if (missing === (bx1 - bx0 + 1) * (by1 - by0 + 1)) {
    fn(data, width, bx0, by0, bx1, by1, arr.subarray(by0 * cols + bx0), cols);
    return;
  }
  for (let ty = by0; ty <= by1; ty++) {
    const row = ty * cols;
    let first0 = -1, first1 = -1, runs = 0;
    for (let tx = bx0; tx <= bx1; tx++) if (arr[row + tx] < 0) {
      const s = tx;
      while (tx < bx1 && arr[row + tx + 1] < 0) tx++;
      if (++runs === 1) { first0 = s; first1 = tx; }
    }
    if (!runs) continue;
    if (runs === 1) {
      let yEnd = ty;
      while (yEnd < by1) {
        const nextRow = (yEnd + 1) * cols;
        let ok = true;
        for (let tx = bx0; tx <= bx1; tx++) if ((arr[nextRow + tx] < 0) !== (tx >= first0 && tx <= first1)) { ok = false; break; }
        if (!ok) break;
        yEnd++;
      }
      fn(data, width, first0, ty, first1, yEnd, arr.subarray(ty * cols + first0), cols);
      ty = yEnd;
      continue;
    }
    for (let tx = bx0; tx <= bx1; tx++) if (arr[row + tx] < 0) {
      const s = tx;
      while (tx < bx1 && arr[row + tx + 1] < 0) tx++;
      fn(data, width, s, ty, tx, ty, arr.subarray(row + s), cols);
    }
  }
}

const cacheKind = (cells, minX, minY, maxX, maxY) => cacheCells(cells.kind, supportTiles, cells, minX, minY, maxX, maxY);
const cacheText = (cells, minX, minY, maxX, maxY) => cacheCells(cells.text, textTiles, cells, minX, minY, maxX, maxY);

export function photoCellText(cells, minX, minY, maxX, maxY) {
  cacheText(cells, minX, minY, maxX, maxY);
  return cells.text;
}

const textIn = (cells, minX, minY, maxX, maxY) => {
  if (minX > maxX || minY > maxY) return 0;
  cacheText(cells, minX, minY, maxX, maxY);
  let n = 0;
  for (let ty = minY; ty <= maxY; ty++) for (let tx = minX, at = ty * cells.cols + minX; tx <= maxX; tx++, at++) n += cells.text[at];
  return n;
};

const meet = (p, q) => p.x < q.x + q.width && q.x < p.x + p.width && p.y < q.y + q.height && q.y < p.y + p.height;
export function screenPhotoTiles(data, width, height, {x, y, width: w, height: h}, exactRects = [], cells = photoCells(data, width, height), textComplete = false) {
  const rx = Math.max(0, x), ry = Math.max(0, y), rw = Math.min(x + w, width) - rx, rh = Math.min(y + h, height) - ry;
  const x0 = Math.ceil(rx / TILE), y0 = Math.ceil(ry / TILE), x1 = Math.floor((rx + rw) / TILE), y1 = Math.floor((ry + rh) / TILE);
  if (x1 <= x0 || y1 <= y0) {
    if (rw < TILE || rh < TILE) return 0;
    const cx = rx + ((rw - TILE) >> 1), cy = ry + ((rh - TILE) >> 1), base = (cy * width + cx) * 4;
    if (!supportTiles(data.subarray(base), width, 0, 0, 0, 0)) return 0;
    if (!textComplete && !exactRects.some(e => meet(e, {x: cx, y: cy, width: TILE, height: TILE})) &&
        textTiles(data.subarray(base), width, 0, 0, 0, 0)) return 0;
    return 1;
  }
  const count = (x1 - x0) * (y1 - y0);
  cacheKind(cells, x0, y0, x1 - 1, y1 - 1);
  if (!textComplete) cacheText(cells, x0, y0, x1 - 1, y1 - 1);
  let text = 0, found = 0;
  for (let ty = y0; ty < y1; ty++) for (let tx = x0; tx < x1; tx++) {
    const X = tx * TILE, Y = ty * TILE, i = ty * cells.cols + tx;
    found += cells.kind[i] > 0;
    text += !textComplete && !exactRects.some(e => meet(e, {x: X, y: Y, width: TILE, height: TILE})) && cells.text[i];
  }
  return text * 16 <= count ? found / count : 0;
}

function mergeTouching(boxes) {
  let list = boxes;
  while (list.length > 1) {
    const sorted = list.slice().sort((a, b) => a.x - b.x || a.y - b.y);
    const next = [];
    let merged = false;
    for (let i = 0; i < sorted.length; i++) {
      let cur = sorted[i];
      if (!cur) continue;
      let right = cur.x + cur.width;
      for (let j = i + 1; j < sorted.length; j++) {
        const q = sorted[j];
        if (!q) continue;
        if (q.x >= right) break;
        if (cur.y < q.y + q.height && q.y < cur.y + cur.height) {
          const x = Math.min(cur.x, q.x), y = Math.min(cur.y, q.y);
          cur = {x, y, width: Math.max(cur.x + cur.width, q.x + q.width) - x, height: Math.max(cur.y + cur.height, q.y + q.height) - y};
          right = cur.x + cur.width;
          sorted[j] = null; merged = true;
        }
      }
      next.push(cur);
    }
    list = next;
    if (!merged) break;
  }
  return list;
}

export function screenPhotoRegions(data, width, height, masked = false, extra = [], cells = null) {
  const pixels = width * height;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || data.length !== pixels * 4) return [...extra];
  const cols = Math.floor(width / TILE), rows = Math.floor(height / TILE), tiles = cols >= 4 && rows >= 3 ? cols * rows : 0;
  const seeds = new Uint8Array(tiles), support = new Uint8Array(tiles);
  cells ??= photoCells(data, width, height);
  if (tiles) cacheKind(cells, 0, 0, cols - 1, rows - 1);
  for (let i = 0; i < tiles; i++) seeds[i] = (support[i] = cells.kind[i]) > 1;
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
    let tw = maxX - minX + 1, th = maxY - minY + 1, area = tw * th;
    if (strong >= 20 && tw >= 4 && th >= 4 && textOf(minX + 1, minY + 1, maxX - 1, maxY - 1) * 16 > (tw - 2) * (th - 2)) {
      let y0 = minY, y1 = maxY;
      while (y1 - y0 + 1 > 3 && textOf(minX + 1, y0 + 1, maxX - 1, y1 - 1) * 16 > (tw - 2) * (y1 - y0 - 1)) {
        const bot = textOf(minX + 1, y1 - 1, maxX - 1, y1 - 1), top = textOf(minX + 1, y0 + 1, maxX - 1, y0 + 1);
        if (bot >= top && bot > 0) y1--;
        else if (top > 0) y0++;
        else break;
      }
      if (textOf(minX + 1, y0 + 1, maxX - 1, y1 - 1) === 0) {
        let keptStrong = 0, keptSupport = 0;
        for (let i = 0; i < end; i++) {
          const tile = queue[i], ty = Math.floor(tile / cols);
          if (ty >= y0 && ty <= y1) { keptSupport++; keptStrong += seeds[tile]; }
        }
        minY = y0; maxY = y1; th = maxY - minY + 1; area = tw * th; strong = keptStrong; end = keptSupport;
      }
    }
    const componentText = () => {
      cacheText(cells, minX, minY, maxX, maxY);
      let n = 0;
      for (let i = 0; i < end; i++) {
        const tile = queue[i], ty = Math.floor(tile / cols);
        if (ty >= minY && ty <= maxY) n += cells.text[tile];
      }
      return n;
    };
    if ((!(tw >= 4 && th >= 3) && !(tw >= 3 && th >= 5)) || strong < Math.min(20, area >> 3) || end * 4 < area ||
        area < 32 && (strong * 2 < area && !(end === area && strong >= 2) || (masked ? componentText() || textOf(minX + 1, minY + 1, maxX - 1, maxY - 1) : textOf(minX, minY, maxX, maxY))) ||
        textOf(minX + 1, minY + 1, maxX - 1, maxY - 1) * 16 > Math.max(0, (tw - 2) * (th - 2)) ||
        !masked && !opaque(data, width, minX, minY, tw, th)) continue;
    regions.push({x: minX * TILE, y: minY * TILE, width: tw * TILE, height: th * TILE});
  }
  regions.push(...extra);
  const kept = [];
  const candidates = masked ? mergeTouching(regions) : regions;
  for (const region of candidates.sort((a, b) => b.width * b.height - a.width * a.height))
    if (kept.length < MAX_RECTS && !kept.some(r => meet(r, region))) kept.push(region);
  return kept.sort((a, b) => a.y - b.y || a.x - b.x);
}
