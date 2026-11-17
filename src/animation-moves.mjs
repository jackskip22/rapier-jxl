// SPDX-License-Identifier: MIT
import {authoredPatchEntropy} from './patch-code.mjs';
import {LIMITS} from './limits.mjs';
import {fault} from './fault.mjs';
import {frameSpans, blockStats, voteShifts2D, forgetFrame, unchangedShare} from './animation-diff.mjs';

const TILE = 16, MAX_COPIES = 64, PATCH_REPLACE = 1, PATCH_BLEND_ABOVE = 4;
export const CANVAS = 2, BACKGROUND = 3;
const KEPT_COST = 256;
export const MASK_SHARE = 0.25;
const codedPixels = (rects, before, after, width, masks) => rects.reduce((sum, rect) => {
  const kept = masks ? unchangedShare(before, after, width, rect) : 0;
  return sum + area(rect) * (kept >= MASK_SHARE ? 1 - kept : 1);
}, 0);
const area = rect => rect[2] * rect[3];
const union = (a, b) => {
  const x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]);
  return [x, y, Math.max(a[0] + a[2], b[0] + b[2]) - x, Math.max(a[1] + a[3], b[1] + b[3]) - y];
};

function copyRows(into, from, width, {x, y, w, h, sx = x, sy = y}) {
  for (let row = 0; row < h; row++) {
    const start = ((sy + row) * width + sx) * 4;
    into.set(from.subarray(start, start + w * 4), ((y + row) * width + x) * 4);
  }
}
export function predictedCanvas(before, copies, width, background) {
  if (!copies.length) return before;
  const out = new Uint8Array(before);
  for (const copy of copies) copyRows(out, copy.reference === BACKGROUND ? background : before, width, copy);
  return out;
}

function decomposeGrid(grid, cols, rows) {
  const used = new Uint8Array(cols * rows), boxes = [];
  for (let r0 = 0; r0 < rows; r0++) {
    for (let c0 = 0; c0 < cols; c0++) {
      if (!grid[r0 * cols + c0] || used[r0 * cols + c0]) continue;
      let c1 = c0 + 1;
      while (c1 < cols && grid[r0 * cols + c1] && !used[r0 * cols + c1]) c1++;
      let r1 = r0 + 1;
      outer: while (r1 < rows) {
        for (let c = c0; c < c1; c++) if (!grid[r1 * cols + c] || used[r1 * cols + c]) break outer;
        r1++;
      }
      for (let r = r0; r < r1; r++) used.fill(1, r * cols + c0, r * cols + c1);
      boxes.push([c0, r0, c1, r1]);
    }
  }
  return boxes;
}

function spanRowEqual(spans, segments, vx0, vy0, y, x0, x1) {
  const rowBase = (y - vy0) * segments * 2;
  const rel0 = x0 - vx0, rel1 = x1 - vx0;
  const s0 = rel0 >> 4, s1 = (rel1 - 1) >> 4;
  for (let s = s0; s <= s1; s++) {
    const a = spans[rowBase + s * 2];
    if (a === 255) continue;
    const b = spans[rowBase + s * 2 + 1];
    const diffStart = s * 16 + a, diffEnd = s * 16 + b;
    if (diffEnd >= rel0 && diffStart < rel1) return false;
  }
  return true;
}

function refineExactSubTile(box, spans, segments, vx0, vy0, vx1, vy1) {
  let [x0, y0, x1, y1] = box;
  const topLim = Math.max(vy0, y0 - 15), botLim = Math.min(vy1, y1 + 15);
  while (y0 > topLim && spanRowEqual(spans, segments, vx0, vy0, y0 - 1, x0, x1)) y0--;
  while (y1 < botLim && spanRowEqual(spans, segments, vx0, vy0, y1, x0, x1)) y1++;

  const leftLim = Math.max(vx0, x0 - 15);
  if (leftLim < x0) {
    let bestX0 = leftLim;
    for (let y = y0; y < y1 && bestX0 < x0; y++) {
      const rowBase = (y - vy0) * segments * 2;
      const sStart = (bestX0 - vx0) >> 4, sEnd = (x0 - 1 - vx0) >> 4;
      for (let s = sEnd; s >= sStart; s--) {
        const a = spans[rowBase + s * 2];
        if (a === 255) continue;
        const b = spans[rowBase + s * 2 + 1];
        const lastPx = vx0 + s * 16 + b;
        if (lastPx >= bestX0 && vx0 + s * 16 + a < x0) {
          bestX0 = Math.min(x0, lastPx + 1);
          break;
        }
      }
    }
    x0 = bestX0;
  }

  const rightLim = Math.min(vx1, x1 + 15);
  if (rightLim > x1) {
    let bestX1 = rightLim;
    for (let y = y0; y < y1 && bestX1 > x1; y++) {
      const rowBase = (y - vy0) * segments * 2;
      const sStart = (x1 - vx0) >> 4, sEnd = (bestX1 - 1 - vx0) >> 4;
      for (let s = sStart; s <= sEnd; s++) {
        const a = spans[rowBase + s * 2];
        if (a === 255) continue;
        const firstPx = vx0 + s * 16 + a, lastPx = vx0 + s * 16 + spans[rowBase + s * 2 + 1];
        if (firstPx < bestX1 && lastPx >= x1) {
          bestX1 = Math.max(x1, firstPx);
          break;
        }
      }
    }
    x1 = bestX1;
  }
  return [x0, y0, x1, y1];
}

const occupancy = (width, height) => ({pixels: new Uint8Array(width * height), blocks: new Uint8Array(Math.ceil(width / 8) * Math.ceil(height / 8))});
function claim(box, {pixels: occupied, blocks}, width, minimum, step) {
  let [x0, y0, x1, y1] = box;
  const rowFree = y => { for (let x = x0; x < x1; x++) if (occupied[y * width + x]) return false; return true; };
  const colFree = x => { for (let y = y0; y < y1; y++) if (occupied[y * width + x]) return false; return true; };
  while (y0 < y1 && !rowFree(y0)) y0 += step;
  while (y1 > y0 && !rowFree(y1 - 1)) y1 -= step;
  while (x0 < x1 && !colFree(x0)) x0 += step;
  while (x1 > x0 && !colFree(x1 - 1)) x1 -= step;
  if (x1 <= x0 || y1 <= y0 || (x1 - x0) * (y1 - y0) < minimum) return false;
  for (let y = y0; y < y1; y++) if (!rowFree(y)) return false;
  for (let y = y0; y < y1; y++) occupied.fill(1, y * width + x0, y * width + x1);
  const across = Math.ceil(width / 8);
  for (let by = y0 >> 3; by < Math.ceil(y1 / 8); by++) blocks.fill(1, by * across + (x0 >> 3), by * across + Math.ceil(x1 / 8));
  box.splice(0, 4, x0, y0, x1, y1);
  return true;
}

const touched = (box, unresolved, across) => {
  for (let y = box[1] >> 4; y < Math.ceil(box[3] / TILE); y++)
    for (let x = box[0] >> 4; x < Math.ceil(box[2] / TILE); x++) if (unresolved[y * across + x]) return true;
  return false;
};

function shiftedCopies(before, after, width, height, dx, dy, unresolved, occupied, tolerance, maximum, reference = CANVAS) {
  if (!maximum || !dx && !dy && reference === CANVAS) return [];
  const across = Math.ceil(width / TILE), minimum = tolerance ? 256 : 192;
  let x0 = Math.max(0, -dx), y0 = Math.max(0, -dy), x1 = Math.min(width, width - dx), y1 = Math.min(height, height - dy);
  let equal, spans, segments;
  if (tolerance) {
    x0 = Math.ceil(x0 / 8) * 8; y0 = Math.ceil(y0 / 8) * 8;
    x1 = Math.floor(x1 / 8) * 8; y1 = Math.floor(y1 / 8) * 8;
    if (x1 - x0 < 8 || y1 - y0 < 8) return [];
    const {stats} = blockStats(before, after, width, height, {dx, dy, x0, x1, y0, y1, held: true}), blocks = (x1 - x0) / 8;
    equal = (x, y, step) => {
      for (let by = y; by < y + step; by += 8) for (let bx = x; bx < x + step; bx += 8) {
        const at = (((by - y0) / 8) * blocks + (bx - x0) / 8) * 4;
        if (stats[at + 2] > tolerance.most || stats[at + 3] > tolerance.maxBias ||
            (stats[at] | stats[at + 1] << 8) > tolerance.mean * 64) return false;
      }
      return true;
    };
  } else {
    if (x1 - x0 < 8 || y1 - y0 < 8) return [];
    ({spans, segments} = frameSpans(before, after, width, height, {dx, dy, x0, x1, y0, y1, held: true}));
    equal = (x, y, step) => {
      for (let row = y; row < Math.min(height, y + step); row++)
        if (!spanRowEqual(spans, segments, x0, y0, row, x, Math.min(width, x + step))) return false;
      return true;
    };
  }
  const blocksAcross = Math.ceil(width / 8), any = occupied.blocks.includes(1);
  const taken = (x, y, right, bottom) => {
    if (!any) return false;
    for (let by = y >> 3; by < Math.ceil(bottom / 8); by++)
      for (let bx = x >> 3; bx < Math.ceil(right / 8); bx++) if (occupied.blocks[by * blocksAcross + bx]) return true;
    return false;
  };
  let step = 16, cols, rows, grid;
  for (;;) {
    cols = Math.ceil(width / step); rows = Math.ceil(height / step); grid = new Uint8Array(cols * rows);
    let useful = false;
    for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
      const x = col * step, y = row * step, right = Math.min(width, x + step), bottom = Math.min(height, y + step);
      if (x < x0 || y < y0 || right > x1 || bottom > y1 || tolerance && (right - x !== step || bottom - y !== step)) continue;
      if (taken(x, y, right, bottom)) continue;
      if (equal(x, y, step)) {
        grid[row * cols + col] = 1;
        useful ||= touched([x, y, right, bottom], unresolved, across);
      }
    }
    if (useful) break;
    if (step === 8) return [];
    step = 8;
  }
  const found = [];
  for (const [left, top, right, bottom] of decomposeGrid(grid, cols, rows)) {
    let box = [left * step, top * step, Math.min(width, right * step), Math.min(height, bottom * step)];
    if (!touched(box, unresolved, across)) continue;
    if (!tolerance) box = refineExactSubTile(box, spans, segments, x0, y0, x1, y1);
    if (!claim(box, occupied, width, minimum, tolerance ? 8 : 1)) continue;
    const [x, y, endX, endY] = box;
    found.push({reference, x, y, w: endX - x, h: endY - y, sx: x + dx, sy: y + dy});
    for (let ty = Math.ceil(y / TILE); ty < Math.floor(endY / TILE); ty++)
      for (let tx = Math.ceil(x / TILE); tx < Math.floor(endX / TILE); tx++) unresolved[ty * across + tx] = 0;
    if (found.length === maximum) break;
  }
  return found;
}

const merged = rects => [rects.reduce(union)];
function shelves(rects, gap, align, across) {
  const up = value => Math.ceil(value / align) * align;
  const order = rects.map((rect, i) => i).sort((a, b) => rects[b][3] - rects[a][3] || rects[b][2] - rects[a][2] || a - b);
  const cells = new Array(rects.length);
  let x = 0, y = 0, shelf = 0, width = 0;
  for (const i of order) {
    const [, , w, h] = rects[i];
    if (x && x + up(w) > across) { y += shelf + gap; x = 0; shelf = 0; }
    cells[i] = {sx: x, sy: y};
    width = Math.max(width, x + up(w)); shelf = Math.max(shelf, up(h)); x += up(w) + gap;
  }
  return {width, height: y + shelf, cells};
}
export function residualPart(rectangles, lossy) {
  if (rectangles.length < 2) return {rects: rectangles.map(rect => rect.slice()), sheet: null};
  const whole = merged(rectangles), gap = lossy ? 8 : 0, align = lossy ? 8 : 1;
  const widest = Math.max(...rectangles.map(rect => rect[2])), total = rectangles.reduce((sum, rect) => sum + area(rect), 0);
  let best = null;
  for (const across of [widest, Math.ceil(Math.sqrt(total) * 1.25), rectangles.reduce((sum, rect) => sum + rect[2] + gap, 0)]) {
    const layout = shelves(rectangles, gap, align, Math.max(widest, across));
    if (!best || layout.width * layout.height < best.width * best.height) best = layout;
  }
  if (best.width * best.height >= area(whole[0])) return {rects: whole, sheet: null};
  return {rects: [[0, 0, best.width, best.height]], sheet: {width: best.width, height: best.height,
    cells: rectangles.map(([x, y, w, h], i) => ({x, y, w, h, sx: best.cells[i].sx, sy: best.cells[i].sy}))}};
}

export function sheetPixels(data, width, {width: across, height: rows, cells}) {
  const out = new data.constructor(across * rows * 4), filled = new Uint8Array(across * rows), words = across;
  for (const {x, y, w, h, sx, sy} of cells) for (let r = 0; r < h; r++) {
    out.set(data.subarray(((y + r) * width + x) * 4, ((y + r) * width + x + w) * 4), ((sy + r) * across + sx) * 4);
    filled.fill(1, (sy + r) * across + sx, (sy + r) * across + sx + w);
  }
  const copy = (to, from) => out.copyWithin(to * 4, from * 4, from * 4 + 4);
  let firstRow = -1;
  for (let r = 0; r < rows; r++) {
    const base = r * words;
    let first = -1;
    for (let c = 0; c < across; c++) if (filled[base + c]) { first = c; break; }
    if (first < 0) continue;
    if (firstRow < 0) firstRow = r;
    for (let c = 0; c < first; c++) copy(base + c, base + first);
    for (let c = first + 1; c < across; c++) if (!filled[base + c]) copy(base + c, base + c - 1);
    filled.fill(1, base, base + across);
  }
  for (let r = 0; r < rows; r++) if (!filled[r * words])
    out.copyWithin(r * across * 4, (r < firstRow ? firstRow : r - 1) * across * 4, ((r < firstRow ? firstRow : r - 1) + 1) * across * 4);
  return out;
}

function changedGrid(rects, width, height) {
  const across = Math.ceil(width / TILE), out = new Uint8Array(across * Math.ceil(height / TILE));
  for (const [x, y, w, h] of rects) for (let row = y >> 4; row < Math.ceil((y + h) / TILE); row++)
    out.fill(1, row * across + (x >> 4), row * across + Math.ceil((x + w) / TILE));
  return out;
}

export const TALL_LIMITS = LIMITS;
export const TALL_SLOT = BACKGROUND;

function moveWindow(width, height, dx, dy, top, bottom, block = 1) {
  const x0 = Math.ceil(Math.max(0, -dx) / block) * block, x1 = Math.floor(Math.min(width, width - dx) / block) * block;
  const y0 = Math.ceil(Math.max(top, -dy) / block) * block, y1 = Math.floor(Math.min(bottom, height - dy) / block) * block;
  return x1 - x0 < Math.min(64, width >> 1) || y1 - y0 < 64 ? null : {dx, dy, x0, x1, y0, y1, held: true};
}

function moveMatch(previous, current, width, height, dx, dy, top, bottom, tolerance) {
  const region = moveWindow(width, height, dx, dy, top, bottom);
  if (!region) return -1;
  const {spans, segments} = frameSpans(previous, current, width, height, region);
  let equal = 0;
  for (let i = 0; i < spans.length; i += 2) if (spans[i] === 255) equal++;
  const exact = equal / ((region.y1 - region.y0) * segments);
  if (!tolerance || exact >= 0.85) return exact;
  const blocks = moveWindow(width, height, dx, dy, top, bottom, 8);
  if (!blocks) return exact;
  const {stats} = blockStats(previous, current, width, height, blocks);
  let kept = 0;
  for (let at = 0; at < stats.length; at += 4)
    if ((stats[at] | stats[at + 1] << 8) <= tolerance.mean * 64 && stats[at + 2] <= tolerance.most && stats[at + 3] <= tolerance.maxBias) kept++;
  return Math.max(exact, 0.99 * kept / (stats.length / 4));
}

function ditheredMatch(previous, current, width, height, dx, dy, top, bottom) {
  const region = moveWindow(width, height, dx, dy, top, bottom, 8);
  if (!region) return -1;
  const {stats} = blockStats(previous, current, width, height, region);
  let kept = 0, bias = 0;
  const blocks = stats.length / 4, limit = !(typeof __RAPIER_JXL_FORMAT__ !== 'undefined' && __RAPIER_JXL_FORMAT__ === true) ? 8 : 6;
  for (let at = 3; at < stats.length; at += 4) { bias += stats[at]; if (stats[at] <= limit) kept++; }
  return kept / blocks - bias / (blocks * 1024);
}

function fewColours(data) {
  const words = new Uint32Array(data.buffer, data.byteOffset, data.byteLength >> 2), seen = new Set();
  for (let i = 0, step = Math.max(1, words.length >> 14); i < words.length; i += step) if (seen.add(words[i]).size > 256) return false;
  return true;
}

const rowsDiffer = (spans, segments, row) => {
  for (let s = 0; s < segments; s++) if (spans[(row * segments + s) * 2] !== 255) return true;
  return false;
};

const LOOSE = !(typeof __RAPIER_JXL_FORMAT__ !== 'undefined' && __RAPIER_JXL_FORMAT__ === true);

function movePath(shown, width, height, tolerance) {
  if (shown.length < 4 || height < 192 || width < 64) return null;
  const margin = Math.min(96, height >> 2), top = margin, bottom = height - margin;
  if (bottom - top < 96) return null;
  const across = Math.ceil(width / TILE), interior = new Uint8Array(across * Math.ceil(height / TILE));
  interior.fill(1, (top >> 4) * across, (bottom >> 4) * across);
  const offX = new Int32Array(shown.length), offY = new Int32Array(shown.length);
  const dithered = (!(typeof __RAPIER_JXL_FORMAT__ !== 'undefined' && __RAPIER_JXL_FORMAT__ === true) || !tolerance) && shown[0].data instanceof Uint8Array && fewColours(shown[0].data);
  let lastX = 0, lastY = 0, moving = 0, lowX = 0, highX = 0, lowY = 0, highY = 0, dotted = 0, sideways = false, exactSum = 0;
  for (let k = 1; k < shown.length; k++) {
    if (shown[k] === shown[k - 1]) { offX[k] = offX[k - 1]; offY[k] = offY[k - 1]; continue; }
    const previous = shown[k - 1].data, current = shown[k].data, tried = new Set();
    let bestX = 0, bestY = 0, score = -1;
    const probe = (dx, dy) => {
      const key = dx * 8192 + dy;
      if (tried.has(key) || Math.abs(dy) >= height - 64) return;
      tried.add(key);
      const s = moveMatch(previous, current, width, height, dx, dy, top, bottom, tolerance);
      if (s > score) { score = s; bestX = dx; bestY = dy; }
    };
    for (const dy of lastX || lastY ? [lastY, lastY - 1, lastY + 1, lastY - 2, lastY + 2, lastY - 3, lastY + 3, 0]
      : [1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6, 7, -7, 8, -8, 0]) { probe(lastX, dy); if (score === 1) break; }
    const votes = score < 0.97 ? voteShifts2D(previous, current, width, height, interior, Boolean(tolerance) || dithered) : [];
    if (score < 0.78) for (const {dx, dy} of votes) for (const [nx, ny] of [[0, 0], [0, -1], [0, 1], [-1, 0], [1, 0]]) probe(dx + nx, dy + ny);
    if (score < 0.97 && dithered) {
      let mean = -1, stepX = 0, stepY = 0;
      const seen = new Set(), look = (dx, dy) => {
        const key = dx * 8192 + dy;
        if (seen.has(key)) return;
        seen.add(key);
        const s = ditheredMatch(previous, current, width, height, dx, dy, top, bottom);
        if (s > mean) { mean = s; stepX = dx; stepY = dy; }
      };
      for (let dy = -16; dy <= 16; dy++) look(0, dy);
      for (const [cx, cy] of [[lastX, lastY], [bestX, bestY], ...votes.map(({dx, dy}) => [dx, dy])])
        for (let dy = cy - 2; dy <= cy + 2; dy++) for (let dx = cx - 2; dx <= cx + 2; dx++) look(dx, dy);
      if (mean < (tolerance && LOOSE ? 0.84 : 0.9) && (k === 1 || lastX || lastY)) {
        if (tolerance && LOOSE) { for (let dy = -16; dy <= 16; dy += 2) for (let dx = -16; dx <= 16; dx += 2) look(dx, dy); }
        else for (let dy = -10; dy <= 10; dy += 2) for (let dx = -10; dx <= 10; dx += 2) look(dx, dy);
        const [cx, cy] = [stepX, stepY];
        for (let dy = cy - 1; dy <= cy + 1; dy++) for (let dx = cx - 1; dx <= cx + 1; dx++) look(dx, dy);
      }
      if (mean >= (tolerance && LOOSE ? 0.84 : 0.9)) { bestX = stepX; bestY = stepY; score = Math.max(score, mean); }
      const exactStep = LOOSE ? moveMatch(previous, current, width, height, bestX, bestY, top, bottom, null) : 0;
      if (LOOSE) exactSum += Math.max(0, exactStep);
      if ((bestX | bestY) & 3 && (LOOSE ? exactStep : moveMatch(previous, current, width, height, bestX, bestY, top, bottom, null)) < 0.97) dotted++;
    } else if (!(typeof __RAPIER_JXL_FORMAT__ !== 'undefined' && __RAPIER_JXL_FORMAT__ === true) && dithered) {
      exactSum += Math.max(0, moveMatch(previous, current, width, height, bestX, bestY, top, bottom, null));
    }
    if (score < 0.7) return null;
    offX[k] = offX[k - 1] + bestX; offY[k] = offY[k - 1] + bestY; lastX = bestX; lastY = bestY;
    if (bestX || bestY) moving++;
    if (bestX) sideways = true;
    lowX = Math.min(lowX, offX[k]); highX = Math.max(highX, offX[k]); lowY = Math.min(lowY, offY[k]); highY = Math.max(highY, offY[k]);
  }
  if (moving < 3 || Math.max(highX - lowX, highY - lowY) < 32) return null;
  let head = 0, foot = 0;
  if (!sideways) {
    const scrolled = [];
    for (let k = 1; k < shown.length; k++) if (Math.abs(offY[k]) >= 6) scrolled.push(k);
    if (!scrolled.length) return null;
    const samples = scrolled.filter((_, i) => i % Math.max(1, Math.floor(scrolled.length / 16)) === 0);
    if (samples.at(-1) !== scrolled.at(-1)) samples.push(scrolled.at(-1));
    const first = shown[0].data;
    head = foot = Math.min(height >> 2, 160);
    for (const k of samples) {
      if (head) {
        const {spans, segments} = frameSpans(first, shown[k].data, width, height, {y1: head});
        for (let y = 0; y < head; y++) if (rowsDiffer(spans, segments, y)) { head = y; break; }
      }
      if (foot) {
        const {spans, segments} = frameSpans(first, shown[k].data, width, height, {y0: height - foot});
        for (let y = foot - 1; y >= 0; y--) if (rowsDiffer(spans, segments, y)) { foot = foot - 1 - y; break; }
      }
    }
    const scrolls = y => samples.every(k => y + offY[k] < 0 || y + offY[k] >= height ||
      !frameSpans(first, shown[k].data, width, height, {dy: offY[k], y0: y, y1: y + 1}).hits);
    while (head && scrolls(head - 1)) head--;
    while (foot && scrolls(height - foot)) foot--;
    if (height - head - foot < 128) return null;
  }
  let phases = false;
  if (dotted) for (let k = 2; k < Math.min(shown.length, 12) && !phases; k++) for (let j = 0; j < k; j++) {
    const dx = offX[k] - offX[j], dy = offY[k] - offY[j];
    if (!(dx || dy) || (dx | dy) & 3) continue;
    const region = moveWindow(width, height, dx, dy, top, bottom);
    if (!region) continue;
    const {hits, segments} = frameSpans(shown[j].data, shown[k].data, width, height, region);
    if (hits <= 0.04 * (region.y1 - region.y0) * segments) { phases = true; break; }
  }
  return !(typeof __RAPIER_JXL_FORMAT__ !== 'undefined' && __RAPIER_JXL_FORMAT__ === true)
    ? {offX, offY, head, foot, body: height - head - foot, phases, fuse: Boolean(tolerance) && dithered && !phases && exactSum / moving >= 0.5}
    : {offX, offY, head, foot, body: height - head - foot, phases};
}

export function tallPixels(recipe, shown, width) {
  const {width: across, height: rows, start, head, headRows, foot, footRows, body, places} = recipe, Kind = shown[0].data.constructor;
  const out = new Kind(across * rows * 4), words = new Uint32Array(out.buffer, out.byteOffset, across * rows);
  const source = shown[start].data, row = (y, from, x = 0, frame = source) =>
    out.set(frame.subarray(from * width * 4, (from + 1) * width * 4), (y * across + x) * 4);
  words.fill(new Uint32Array(Uint8Array.from(source.subarray(head * width * 4, head * width * 4 + 4)).buffer)[0]);
  for (let r = 0; r < headRows; r++) row(r, Math.min(r, head - 1));
  for (let r = 0; r < footRows; r++) row(rows - 1 - r, source.length / (width * 4) - 1 - Math.min(r, foot - 1));
  for (let i = places.length - 1; i >= 0; i--) {
    const {frame, x, y} = places[i], data = shown[frame].data;
    for (let v = 0; v < body; v++) row(y + v, head + v, x, data);
  }
  if (!(typeof __RAPIER_JXL_FORMAT__ !== 'undefined' && __RAPIER_JXL_FORMAT__ === true) && recipe.fuse && places.length > 1) {
    const n = across * rows, sumR = new Uint32Array(n), sumG = new Uint32Array(n), sumB = new Uint32Array(n), cnt = new Uint16Array(n);
    for (const {frame, x, y} of places) {
      const data = shown[frame].data;
      for (let v = 0; v < body; v++) {
        let pi = (y + v) * across + x, si = ((head + v) * width) * 4;
        for (let u = 0; u < width; u++, pi++, si += 4) {
          sumR[pi] += data[si]; sumG[pi] += data[si + 1]; sumB[pi] += data[si + 2]; cnt[pi]++;
        }
      }
    }
    for (let i = headRows * across, end = (rows - footRows) * across; i < end; i++) if (cnt[i] > 1) {
      const c = cnt[i], half = c >> 1;
      out[i * 4] = (sumR[i] + half) / c;
      out[i * 4 + 1] = (sumG[i] + half) / c;
      out[i * 4 + 2] = (sumB[i] + half) / c;
    }
  }
  return out;
}

export function tallWindow(pixels, recipe, copies, width, height) {
  const out = new pixels.constructor(width * height * 4);
  for (const {y, h, sx, sy} of copies) for (let r = 0; r < h; r++)
    out.set(pixels.subarray(((sy + r) * recipe.width + sx) * 4, ((sy + r) * recipe.width + sx + width) * 4), (y + r) * width * 4);
  return out;
}

function* planTallScroll(shown, width, height, {tolerance, changes, lossyChanges, plainArea, limits = TALL_LIMITS}) {
  const changedArea = shown[1].rects.reduce((sum, rect) => sum + area(rect), 0);
  if (changedArea < 0.2 * width * height) return null;
  const path = movePath(shown, width, height, tolerance);
  if (!path) return null;
  const {offX, offY, head, foot, body} = path;
  if (LOOSE && path.fuse && tolerance) tolerance = {mean: Math.max(tolerance.mean, 18), most: 254, maxBias: Math.max(tolerance.maxBias, 12)};
  const headRows = head && tolerance ? Math.ceil((head + 8) / 8) * 8 : head, footRows = foot && tolerance ? Math.ceil((foot + 8) / 8) * 8 : foot;
  const plans = new Array(shown.length), phaseOf = k => path.phases ? (offX[k] & 3) << 2 | offY[k] & 3 : 0;
  let codedArea = 0, start = 0;
  const planesOf = (from, to) => {
    const planes = new Map();
    for (let k = from; k <= to; k++) {
      const plane = planes.get(phaseOf(k));
      if (plane) Object.assign(plane, {lowX: Math.min(plane.lowX, offX[k]), highX: Math.max(plane.highX, offX[k]), lowY: Math.min(plane.lowY, offY[k]), highY: Math.max(plane.highY, offY[k])});
      else planes.set(phaseOf(k), {lowX: offX[k], highX: offX[k], lowY: offY[k], highY: offY[k]});
    }
    let at = headRows, across = width;
    for (const plane of planes.values()) { plane.at = at; at += plane.highY - plane.lowY + body; across = Math.max(across, plane.highX - plane.lowX + width); }
    const rows = at + footRows;
    return {planes, across, rows, fits: across <= limits.edge && rows <= limits.edge && across * rows <= limits.pixels};
  };
  while (start < shown.length) {
    let end = start;
    while (end + 1 < shown.length && planesOf(start, end + 1).fits) end++;
    const {planes, across, rows, fits} = planesOf(start, end);
    if (!fits) return null;
    const place = k => { const plane = planes.get(phaseOf(k)); return {frame: k, x: offX[k] - plane.lowX, y: plane.at + offY[k] - plane.lowY}; };
    const recipe = !(typeof __RAPIER_JXL_FORMAT__ !== 'undefined' && __RAPIER_JXL_FORMAT__ === true) && path.fuse
      ? {width: across, height: rows, start, head, headRows, foot, footRows, body, places: [], fuse: true}
      : {width: across, height: rows, start, head, headRows, foot, footRows, body, places: []};
    for (let k = start; k <= end; k++) if (!(k > start && shown[k] === shown[k - 1])) recipe.places.push(place(k));
    const pixels = tallPixels(recipe, shown, width);
    codedArea += across * rows;
    for (let k = start; k <= end; k++) {
      if (k > start && shown[k] === shown[k - 1]) { plans[k] = {copies: [], rects: []}; continue; }
      const {x, y} = place(k), copies = [{reference: TALL_SLOT, x: 0, y: head, w: width, h: body, sx: x, sy: y}];
      if (head) copies.unshift({reference: TALL_SLOT, x: 0, y: 0, w: width, h: head, sx: 0, sy: 0});
      if (foot) copies.push({reference: TALL_SLOT, x: 0, y: height - foot, w: width, h: foot, sx: 0, sy: rows - foot});
      const after = shown[k].data, view = tallWindow(pixels, recipe, copies, width, height);
      const remaining = tolerance ? lossyChanges(view, after, width, height, tolerance) : movedResidual(view, after, width, height);
      if (tolerance && LOOSE) {
        const part = residualPart(remaining || [], true);
        codedArea += part.rects.reduce((sum, rect) => sum + area(rect), 0);
        if (codedArea > 0.85 * plainArea && k >= start + 6) return null;
        plans[k] = {copies, rects: part.rects, sheet: part.sheet, window: recipe, ...(k === start && {tall: recipe})};
        forgetFrame();
        yield 0.01;
        continue;
      }
      const rects = remaining?.length ? [remaining.reduce(union)] : [];
      codedArea += rects.reduce((sum, rect) => sum + area(rect), 0);
      if (codedArea > 0.85 * plainArea && k >= start + 6) return null;
      plans[k] = {copies, rects, window: recipe, ...(k === start && {tall: recipe})};
      forgetFrame();
      yield 0.01;
    }
    start = end + 1;
  }
  return plainArea - codedArea >= 768 * (shown.length - 1) ? {frames: plans, sparedPixels: plainArea - codedArea, tall: true} : null;
}

function movedResidual(predicted, after, width, height) {
  const {spans, segments, hits} = frameSpans(predicted, after, width, height);
  if (!hits) return null;
  const across = Math.ceil(width / TILE), down = Math.ceil(height / TILE), bounds = new Int32Array(across * down * 4).fill(-1);
  for (let y = 0; y < height; y++) for (let s = 0; s < segments; s++) {
    const a = spans[(y * segments + s) * 2];
    if (a === 255) continue;
    const x0 = s * 16 + a, x1 = s * 16 + spans[(y * segments + s) * 2 + 1], t = ((y >> 4) * across + (x0 >> 4)) * 4;
    if (bounds[t] < 0) { bounds[t] = x0; bounds[t + 1] = y; bounds[t + 2] = x1; bounds[t + 3] = y; }
    else { bounds[t] = Math.min(bounds[t], x0); bounds[t + 2] = Math.max(bounds[t + 2], x1); bounds[t + 3] = y; }
  }
  const grid = new Uint8Array(across * down);
  for (let t = 0; t < grid.length; t++) grid[t] = bounds[t * 4] >= 0 ? 1 : 0;
  return decomposeGrid(grid, across, down).map(([c0, r0, c1, r1]) => {
    let x0 = width, y0 = height, x1 = -1, y1 = -1;
    for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) {
      const t = (r * across + c) * 4;
      if (bounds[t] < 0) continue;
      x0 = Math.min(x0, bounds[t]); y0 = Math.min(y0, bounds[t + 1]); x1 = Math.max(x1, bounds[t + 2]); y1 = Math.max(y1, bounds[t + 3]);
    }
    return [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
  });
}

export function* planAnimationPatches(shown, width, height, {tolerance, changes, lossyChanges, masks = false, tallLimits = TALL_LIMITS}) {
  if (shown.length < 2) return null;
  const canvasArea = width * height, plainAreas = shown.map(frame => frame.rects.reduce((sum, rect) => sum + area(rect), 0));
  const usefulArea = tolerance ? Math.max(4096, canvasArea / 16) : 192;
  if (!plainAreas.slice(1).some(value => value >= usefulArea)) return null;
  const movingTolerance = tolerance ? {...tolerance, maxBias: Math.min(255, Math.max(2, Math.round(tolerance.mean * 2.8)))} : null;
  const scroll = yield* planTallScroll(shown, width, height, {tolerance: movingTolerance, changes, lossyChanges, plainArea: plainAreas.reduce((a, b) => a + b, 0), limits: tallLimits});
  if (scroll) return scroll;
  const plans = [{copies: [], rects: [[0, 0, width, height]]}];
  const background = shown[0].data;
  let canvas = tolerance ? new Uint8Array(shown[0].data) : shown[0].data,
    foundCopies = false, misses = 0, plainArea = 0, codedArea = 0;
  for (let k = 1; k < shown.length; k++) {
    if (shown[k] === shown[k - 1]) { plans.push({copies: [], rects: []}); continue; }
    const after = shown[k].data, rects = shown[k].rects, unresolved = changedGrid(rects, width, height);
    const maySearch = plainAreas[k] >= usefulArea && misses < 2;
    const residualOf = moves => {
      const predicted = predictedCanvas(canvas, moves, width, background), remaining = tolerance
        ? lossyChanges(predicted, after, width, height, movingTolerance) : moves.length ? movedResidual(predicted, after, width, height) : rects;
      const part = residualPart(remaining || [], Boolean(tolerance));
      return {predicted, copies: moves, ...part, area: part.rects.reduce((sum, rect) => sum + area(rect), 0)};
    };
    let copies = [], kept = [];
    if (maySearch) {
      const occupied = occupancy(width, height), candidates = voteShifts2D(canvas, after, width, height, unresolved, Boolean(tolerance));
      const room = () => MAX_COPIES - copies.length - kept.length;
      let probed = !(k > 1 && foundCopies);
      const probe = () => {
        if (!probed && room() && unresolved.includes(1))
          kept = shiftedCopies(background, after, width, height, 0, 0, unresolved, occupied, movingTolerance, room(), BACKGROUND);
        probed = true;
      };
      for (const {dx, dy} of candidates) {
        if (!Number.isInteger(dx) || !Number.isInteger(dy)) continue;
        copies.push(...shiftedCopies(canvas, after, width, height, dx, dy, unresolved, occupied, movingTolerance, room()));
        probe();
        if (!room() || !unresolved.includes(1)) break;
      }
      probe();
      if (copies.length || kept.length) { foundCopies = true; misses = 0; }
      else misses++;
      if (misses === 2 && !foundCopies) return null;
    }
    let chosen = residualOf([...copies, ...kept]);
    if (kept.length) {
      const without = residualOf(copies);
      if (without.area - chosen.area < KEPT_COST * kept.length) chosen = without;
    }
    let own = false;
    if (!tolerance) {
      const union = merged(rects);
      own = (chosen.sheet ? area(chosen.rects[0]) : codedPixels(chosen.rects, chosen.predicted, after, width, masks))
        > codedPixels(union, canvas, after, width, masks);
      if (own) chosen = {predicted: canvas, copies: [], rects: union, sheet: null};
    }
    ({copies} = chosen);
    const {predicted, rects: residuals, sheet} = chosen;
    if (residuals.length > 1) throw fault('JXL_INTERNAL', 'animation-moves:residuals');
    plans.push({copies, rects: residuals, sheet});
    plainArea += plainAreas[k]; codedArea += own ? plainAreas[k] : residuals.reduce((sum, rect) => sum + area(rect), 0);
    if (k === 8 && plainArea - codedArea < 384 * k) return null;
    if (tolerance) {
      canvas = predicted;
      for (const [x, y, w, h] of sheet ? sheet.cells.map(({x, y, w, h}) => [x, y, w, h]) : residuals) copyRows(canvas, after, width, {x, y, w, h});
    } else canvas = after;
    forgetFrame();
    yield 0.01;
  }
  return foundCopies && plainArea - codedArea >= 768 * (shown.length - 1)
    ? {frames: plans, sparedPixels: plainArea - codedArea} : null;
}

export function frameViewGroups({width, height, first, copies, parts}, extraChannels) {
  const blending = mode => Array.from({length: 1 + extraChannels}, () => ({mode, alpha: 0, clamp: false}));
  const groups = [];
  parts = parts.filter(part => !part.tall);
  if (!first) groups.push({reference: CANVAS, sx: 0, sy: 0, w: width, h: height, positions: [{x: 0, y: 0, blending: blending(PATCH_REPLACE)}]});
  for (const {reference, x, y, w, h, sx, sy} of copies)
    groups.push({reference, sx, sy, w, h, positions: [{x, y, blending: blending(PATCH_REPLACE)}]});
  for (const {slot, rect: [x, y, w, h], masked, sheet} of parts) {
    if (sheet) for (const cell of sheet.cells)
      groups.push({reference: slot, sx: cell.sx, sy: cell.sy, w: cell.w, h: cell.h, positions: [{x: cell.x, y: cell.y, blending: blending(PATCH_REPLACE)}]});
    else groups.push({reference: slot, sx: 0, sy: 0, w, h, positions: [{x, y, blending: blending(masked ? PATCH_BLEND_ABOVE : PATCH_REPLACE)}]});
  }
  return groups;
}

export function* encodeFrameView(groups, extraChannels) {
  return yield* authoredPatchEntropy({groups, extraChannels, tokens: 1 + groups.length * (6 + 3 * (1 + extraChannels))});
}
