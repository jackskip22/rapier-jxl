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
  for (let i = 0; i < count; i++) result.push({dx: values[i * 3], dy: values[i * 3 + 1]});
  return result;
}

export function xybAddRect(dst, dstWidth, src, srcWidth, x, y, w, h, sx = 0, sy = 0, mode = 1) {
  if (w < 1 || h < 1) return dst;
  const dstHeight = dst[0].length / dstWidth, srcHeight = src[0].length / srcWidth;
  if (![x, y, w, h, sx, sy].every(Number.isSafeInteger) || x < 0 || y < 0 || sx < 0 || sy < 0 ||
      x + w > dstWidth || y + h > dstHeight || sx + w > srcWidth || sy + h > srcHeight || (mode !== 1 && mode !== 2))
    throw fault('JXL_INTERNAL', 'animation-diff:xyb-rect');
  const {memory, exports} = acquire();
  forgetFrame();
  const rowFloats = w, rowBytes = w * 4, rows = Math.max(1, Math.min(h, Math.floor(BAND / (rowBytes * 2))));
  const dstAt = BASE, srcAt = dstAt + ((rows * rowBytes + 15) & ~15);
  growArena(srcAt + rows * rowBytes + 64);
  const f32 = new Float32Array(memory.buffer), add = mode === 2 ? 1 : 0;
  for (let c = 0; c < 3; c++) {
    const dPlane = dst[c], sPlane = src[c];
    for (let r0 = 0; r0 < h; r0 += rows) {
      const count = Math.min(rows, h - r0);
      if (x === 0 && sx === 0 && w === dstWidth && w === srcWidth) {
        if (add) f32.set(dPlane.subarray((y + r0) * dstWidth, (y + r0 + count) * dstWidth), dstAt >> 2);
        f32.set(sPlane.subarray((sy + r0) * srcWidth, (sy + r0 + count) * srcWidth), srcAt >> 2);
      } else {
        for (let r = 0; r < count; r++) {
          if (add) f32.set(dPlane.subarray((y + r0 + r) * dstWidth + x, (y + r0 + r) * dstWidth + x + rowFloats), (dstAt >> 2) + r * rowFloats);
          f32.set(sPlane.subarray((sy + r0 + r) * srcWidth + sx, (sy + r0 + r) * srcWidth + sx + rowFloats), (srcAt >> 2) + r * rowFloats);
        }
      }
      exports.xybAddRows(dstAt, rowBytes, srcAt, rowBytes, w, count, add);
      if (x === 0 && w === dstWidth) {
        dPlane.set(f32.subarray(dstAt >> 2, (dstAt >> 2) + count * rowFloats), (y + r0) * dstWidth);
      } else {
        for (let r = 0; r < count; r++) {
          dPlane.set(f32.subarray((dstAt >> 2) + r * rowFloats, (dstAt >> 2) + (r + 1) * rowFloats), (y + r0 + r) * dstWidth + x);
        }
      }
    }
  }
  return dst;
}

export function xybComposeAdd(a, b, width, height) {
  const n = width * height, out = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  xybAddRect(out, width, a, width, 0, 0, width, height, 0, 0, 1);
  return xybAddRect(out, width, b, width, 0, 0, width, height, 0, 0, 2);
}

export function xybShiftL1(targetY, wPad, refY, width, x0, y0, rw, rh, dx, dy, stepY = 4) {
  if (rw < 1 || rh < 1) return Infinity;
  const {memory, exports} = acquire();
  forgetFrame();
  const totalSampled = Math.ceil(rh / stepY);
  const tRowBytes = rw * 8, rRowBytes = rw * 4;
  const batchMax = Math.max(1, Math.min(totalSampled, Math.floor(BAND / (tRowBytes + rRowBytes))));
  const tAt = BASE, rAt = tAt + ((batchMax * tRowBytes + 15) & ~15);
  growArena(rAt + batchMax * rRowBytes + 64);
  const f64 = new Float64Array(memory.buffer), f32 = new Float32Array(memory.buffer);
  let sum = 0, rowIdx = 0;
  while (rowIdx < totalSampled) {
    const count = Math.min(batchMax, totalSampled - rowIdx);
    for (let i = 0; i < count; i++) {
      const y = y0 + (rowIdx + i) * stepY;
      f64.set(targetY.subarray(y * wPad + x0, y * wPad + x0 + rw), (tAt >> 3) + i * rw);
      f32.set(refY.subarray((y + dy) * width + x0 + dx, (y + dy) * width + x0 + dx + rw), (rAt >> 2) + i * rw);
    }
    sum += exports.xybShiftL1(tAt, tRowBytes, rAt, rRowBytes, rw, count);
    rowIdx += count;
  }
  return sum / (totalSampled * rw);
}

export function xybPredictAndDelta(refMap, groups, targetPlanes, width, height) {
  const wPad = Math.ceil(width / 8) * 8, hPad = Math.ceil(height / 8) * 8, n = width * height;
  const pred = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (const g of groups) {
    const ref = refMap[g.reference];
    if (!ref) throw fault('JXL_INTERNAL', 'animation-diff:missing-ref');
    for (const pos of g.positions) xybAddRect(pred, width, ref, width, pos.x, pos.y, g.w, g.h, g.sx, g.sy, 1);
  }
  const delta = targetPlanes;
  const {memory, exports} = acquire();
  forgetFrame();
  const perRowBytes = wPad * 8 * 6 + width * 4 * 3;
  const bandRows = Math.max(1, Math.min(height, Math.floor(BAND / perRowBytes)));
  const tChunk = ((bandRows * wPad * 8) + 15) & ~15, pChunk = ((bandRows * width * 4) + 15) & ~15;
  const t0 = BASE, t1 = t0 + tChunk, t2 = t1 + tChunk;
  const o0 = t2 + tChunk, o1 = o0 + tChunk, o2 = o1 + tChunk;
  const p0 = o2 + tChunk, p1 = p0 + pChunk, p2 = p1 + pChunk;
  growArena(p2 + pChunk + 64);
  const f64 = new Float64Array(memory.buffer), f32 = new Float32Array(memory.buffer);
  const tStarts = [t0 >> 3, t1 >> 3, t2 >> 3], oStarts = [o0 >> 3, o1 >> 3, o2 >> 3], pStarts = [p0 >> 2, p1 >> 2, p2 >> 2];
  for (let y = 0; y < height; y += bandRows) {
    const count = Math.min(bandRows, height - y), tLen = count * wPad, pLen = count * width;
    for (let c = 0; c < 3; c++) {
      f64.set(targetPlanes[c].subarray(y * wPad, y * wPad + tLen), tStarts[c]);
      f32.set(pred[c].subarray(y * width, y * width + pLen), pStarts[c]);
    }
    exports.xybDeltaRows(t0, t1, t2, p0, p1, p2, o0, o1, o2, width, wPad, count);
    for (let c = 0; c < 3; c++) delta[c].set(f64.subarray(oStarts[c], oStarts[c] + tLen), y * wPad);
  }
  for (let y = height; y < hPad; y++) {
    for (let c = 0; c < 3; c++) delta[c].copyWithin(y * wPad, (height - 1) * wPad, height * wPad);
  }
  return {pred, delta};
}

export function blendPaste(canvas, canvasWidth, rgba, x, y, w, h, masked = false) {
  if (!masked) {
    for (let row = 0; row < h; row++)
      canvas.set(rgba.subarray(row * w * 4, (row + 1) * w * 4), ((y + row) * canvasWidth + x) * 4);
    return;
  }
  const f = Math.fround;
  for (let row = 0; row < h; row++) {
    let si = row * w * 4, di = ((y + row) * canvasWidth + x) * 4;
    for (let col = 0; col < w; col++, si += 4, di += 4) {
      const faByte = rgba[si + 3];
      if (faByte === 0) continue;
      if (faByte === 255) {
        canvas[di] = rgba[si]; canvas[di + 1] = rgba[si + 1]; canvas[di + 2] = rgba[si + 2]; canvas[di + 3] = 255;
        continue;
      }
      const fa = f(faByte / 255), ba = f(canvas[di + 3] / 255), rem = f(1 - fa);
      const merged = f(1 - f(rem * f(1 - ba)));
      const inv = merged > 0 ? f(1 / merged) : 0;
      for (let c = 0; c < 3; c++) {
        const fg = f(rgba[si + c] / 255), bg = f(canvas[di + c] / 255);
        const val = merged > 0 ? f(f(f(fg * fa) + f(f(bg * ba) * rem)) * inv) : 0;
        canvas[di + c] = Math.min(255, Math.max(0, Math.round(val * 255)));
      }
      canvas[di + 3] = Math.min(255, Math.max(0, Math.round(merged * 255)));
    }
  }
}
