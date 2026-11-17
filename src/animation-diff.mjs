// SPDX-License-Identifier: MIT
import {kernelInstance, arenaHolder, takeArena, growArena} from './kernel-runtime.mjs';
import {wasmRequired} from './capture-wasm-error.mjs';
import {fault} from './fault.mjs';

let kept = null;
export const forgetFrame = () => { kept = null; };
const holder = arenaHolder(forgetFrame), BASE = 65536, BAND = 1 << 22;
const bytesView = data => new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

function copyRows(into, at, data, from, sourceStride, rowBytes, rows) {
  if (sourceStride === rowBytes) into.set(data.subarray(from, from + rows * rowBytes), at);
  else for (let row = 0; row < rows; row++, from += sourceStride, at += rowBytes)
    into.set(data.subarray(from, from + rowBytes), at);
}

function acquire() {
  try {
    const instance = kernelInstance();
    takeArena(holder);
    return instance;
  } catch (error) {
    if (error?.code) throw error;
    throw wasmRequired(error);
  }
}

function run(a, b, width, height, region, align, size, call, stop = false) {
  const A = bytesView(a), B = b ? bytesView(b) : null, pixelBytes = a.BYTES_PER_ELEMENT * 4;
  const {dx = 0, dy = 0, x0 = 0, x1 = width, y0 = 0, y1 = height} = region;
  if (![dx, dy, x0, x1, y0, y1].every(Number.isSafeInteger) || x0 < 0 || y0 < 0 || x1 > width || y1 > height ||
      x0 + dx < 0 || y0 + dy < 0 || x1 + dx > width || y1 + dy > height)
    throw fault('JXL_INTERNAL', 'animation-diff:window');
  if (x1 <= x0 || y1 <= y0) return {out: new Uint8Array(0), hits: 0};
  const stride = (x1 - x0) * pixelBytes, n = stride / 4, total = y1 - y0;
  const frameBytes = width * height * pixelBytes;
  if (B && region.held && frameBytes <= BAND) {
    const {memory, exports} = acquire();
    const second = BASE, first = BASE + frameBytes, output = first + frameBytes, line = width * pixelBytes;
    growArena(output + size(total, n) + 64);
    const heap = new Uint8Array(memory.buffer);
    if (kept?.a !== a) heap.set(A, first);
    if (kept?.b !== b) heap.set(B, second);
    kept = {a, b};
    const hits = call(exports, first + ((y0 + dy) * width + x0 + dx) * pixelBytes, line, second + (y0 * width + x0) * pixelBytes, line, n, total, output);
    const bytes = size(total, n);
    return {out: bytes ? heap.slice(output, output + bytes) : null, hits};
  }
  const rows = Math.min(total, Math.max(align, Math.floor(BAND / stride / align) * align));
  const totalBytes = size(total, n), out = totalBytes ? new Uint8Array(totalBytes) : null;
  const {memory, exports} = acquire();
  const second = BASE, first = BASE + (B ? rows * stride : 0), output = first + rows * stride;
  growArena(output + size(rows, n) + 64);
  const heap = new Uint8Array(memory.buffer), fullB = x0 === 0 && x1 === width;
  const key = B && rows === total && fullB ? `${y0},${y1},${width},${pixelBytes}` : null;
  let hits = 0;
  for (let y = y0, at = 0; y < y1; y += rows) {
    const count = Math.min(rows, y1 - y), reuse = key && kept?.frame === b && kept.key === key;
    copyRows(heap, first, A, ((y + dy) * width + x0 + dx) * pixelBytes, width * pixelBytes, stride, count);
    if (B && !reuse) copyRows(heap, second, B, (y * width + x0) * pixelBytes, width * pixelBytes, stride, count);
    kept = key ? {frame: b, key} : null;
    hits += call(exports, first, stride, second, stride, n, count, output);
    if (out) {
      const bytes = size(count, n);
      out.set(heap.subarray(output, output + bytes), at);
      at += bytes;
    }
    if (stop && hits) break;
  }
  return {out, hits};
}

export function frameSpans(a, b, width, height, region = {}) {
  const segments = Math.ceil(((region.x1 ?? width) - (region.x0 ?? 0)) * a.BYTES_PER_ELEMENT / 16);
  const {out, hits} = run(a, b, width, height, region, 1, rows => rows * segments * 2,
    (k, pa, sa, pb, sb, n, rows, outAt) => k.frameSpans(pa, sa, pb, sb, n, rows, outAt));
  return {spans: out, segments, hits};
}

export function blockStats(a, b, width, height, region) {
  const across = Math.ceil(((region?.x1 ?? width) - (region?.x0 ?? 0)) / 8), bias = Number(region !== undefined);
  const {out, hits} = run(a, b, width, height, region ?? {}, 8, rows => Math.ceil(rows / 8) * across * 4,
    (k, pa, sa, pb, sb, n, rows, outAt) => {
      let changed = 0;
      for (let y = 0; y < rows; y += 8)
        changed += k.blockStats(pa + y * sa, sa, pb + y * sb, sb, n, Math.min(8, rows - y), outAt + (y / 8) * across * 4, bias);
      return changed;
    });
  return {stats: out, hits};
}

export function alphaAny(data, width, height) {
  return run(data, null, width, height, {}, 1, () => 0,
    (k, pa, stride, pb, sb, n, rows) => 1 - k.opaque(pa, stride * rows), true).hits > 0;
}

export function unchangedShare(before, after, width, [x0, y0, w, h]) {
  const height = before.length / (width * 4);
  const {hits} = run(before, after, width, height, {x0, x1: x0 + w, y0, y1: y0 + h}, 1, () => 0,
    (k, pa, sa, pb, sb, n, rows) => k.unchangedCount(pa, sa, pb, sb, n, rows));
  return hits / (w * h);
}

export function maskCrop(previous, crop, width, [x0, y0, w, h], fill) {
  const {memory, exports} = acquire();
  forgetFrame();
  const rowBytes = w * 4, up = fill !== 'zero';
  const rows = Math.max(1, Math.min(h, Math.floor(BAND / (rowBytes * 2))));
  const previousAt = BASE, cropAt = previousAt + (rows + 1) * rowBytes;
  growArena(cropAt + (rows + 1) * rowBytes + 64);
  const heap = new Uint8Array(memory.buffer), before = bytesView(previous), pixels = bytesView(crop);
  for (let y = 0; y < h; y += rows) {
    const count = Math.min(rows, h - y), carry = y && up ? 1 : 0;
    if (carry) heap.set(pixels.subarray((y - 1) * rowBytes, y * rowBytes), cropAt);
    copyRows(heap, previousAt + carry * rowBytes, before, ((y0 + y) * width + x0) * 4, width * 4, rowBytes, count);
    heap.set(pixels.subarray(y * rowBytes, (y + count) * rowBytes), cropAt + carry * rowBytes);
    exports.maskCrop(previousAt, rowBytes, cropAt, w, count + carry, Number(up), carry);
    pixels.set(heap.subarray(cropAt + carry * rowBytes, cropAt + (count + carry) * rowBytes), y * rowBytes);
  }
  return crop;
}

export function voteShifts2D(before, after, width, height, tilesMask, lossy = false) {
  if (width < 8 || height < 8) return [];
  const tilesX = Math.ceil(width / 16), tilesY = Math.ceil(height / 16);
  let active = 0, minX = width, minY = height, maxX = 0, maxY = 0;
  for (let ty = 0; ty < tilesY; ty++) {
    const row = ty * tilesX;
    for (let tx = 0; tx < tilesX; tx++) {
      if (!tilesMask[row + tx]) continue;
      active++;
      minX = Math.min(minX, tx * 16); minY = Math.min(minY, ty * 16);
      maxX = Math.max(maxX, (tx + 1) * 16); maxY = Math.max(maxY, (ty + 1) * 16);
    }
  }
  if (!active) return [];
  maxX = Math.min(width, maxX); maxY = Math.min(height, maxY);
  const large = active > 64, bStep = large ? 6 : 1, pad = large ? 64 : 96,
    threshold = large ? lossy ? 52 : 48 : 28, floor = large ? 24 : 16;
  let bx0 = minX, bx1 = maxX, by0 = minY, by1 = maxY;
  if (bx1 - bx0 > 288) { const mid = (bx0 + bx1) >> 1; bx0 = mid - 144; bx1 = mid + 144; }
  if (by1 - by0 > 240) { const mid = (by0 + by1) >> 1; by0 = mid - 120; by1 = mid + 120; }
  bx0 = Math.max(2, bx0); bx1 = Math.min(width - 2, bx1);
  const bRow0 = Math.max(0, by0 - 2), bRow1 = Math.min(height, by1 + 2), bRows = bRow1 - bRow0,
    ax0 = Math.max(2, bx0 - pad), ax1 = Math.min(width - 2, bx1 + pad),
    aRow0 = Math.max(0, bRow0 - pad), aRow1 = Math.min(height, bRow1 + pad), aRows = aRow1 - aRow0;
  if (bx1 <= bx0 || ax1 <= ax0 || bRows < 5 || aRows < 5) return [];

  const column0 = ax0 - 2, columns = ax1 - ax0 + 4, rowBytes = columns * 4,
    aAt = BASE, bAt = aAt + aRows * rowBytes, maskAt = (bAt + bRows * rowBytes + 15) & ~15,
    scratchAt = (maskAt + tilesMask.length + 15) & ~15, outAt = scratchAt + 196608;
  const {memory, exports} = acquire();
  growArena(outAt + 64); forgetFrame();
  const heap = new Uint8Array(memory.buffer), A = bytesView(before), B = bytesView(after);
  copyRows(heap, aAt, A, (aRow0 * width + column0) * 4, width * 4, rowBytes, aRows);
  copyRows(heap, bAt, B, (bRow0 * width + column0) * 4, width * 4, rowBytes, bRows);
  heap.set(tilesMask, maskAt);
  const count = exports.voteShifts2D(aAt, aRow0, aRows, bAt, bRow0, bRows,
    columns, column0, tilesX, bx0, bx1, ax0, ax1, maskAt, bStep, Number(lossy), threshold, floor, scratchAt, outAt);
  const result = [], values = new Int32Array(memory.buffer, outAt, 9);
  for (let i = 0; i < count; i++) result.push({dx: values[i * 3], dy: values[i * 3 + 1], votes: values[i * 3 + 2]});
  return result;
}
