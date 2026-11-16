// SPDX-License-Identifier: MIT
import {kernelCall, room} from './kernel-call.mjs';
import {wasmRequired} from './capture-wasm-error.mjs';
import {fault} from './fault.mjs';

const BASE = 65536, BAND_CELLS = 256, BAND_PIXELS = 262144, BAND_BYTES = BAND_PIXELS * 4;
const OUTPUT = BASE + 4224 * BAND_CELLS, SCRATCH = OUTPUT + BAND_CELLS, AUX = BASE + BAND_BYTES;

function withArena(end, work) {
  try {
    return kernelCall(k => () => work(k, new Uint8Array(k.memory.buffer)), [room(end - BASE)])[0];
  } catch (error) {
    if (error?.code) throw error;
    throw wasmRequired(error);
  }
}

function runCells(label, pad, needScratch, data, width, minX, minY, maxX, maxY, classified, outStride, invoke) {
  if (minX > maxX || minY > maxY) return 0;
  if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray) ||
      ![width, minX, minY, maxX, maxY].every(Number.isSafeInteger) || width < 1 || minX < 0 || minY < 0 ||
      (maxX + 1) * 32 > width || ((maxY + 1) * 32 - 1) * width * 4 + (maxX + 1) * 128 > data.length)
    throw fault('JXL_INTERNAL', label + ' requires whole cells inside the picture.');
  const spanX = maxX - minX + 1, spanY = maxY - minY + 1;
  const strideOut = outStride === undefined ? spanX : outStride;
  if (classified !== undefined && (!(classified instanceof Int8Array) ||
      (outStride === undefined ? classified.length !== spanX * spanY
        : !Number.isSafeInteger(outStride) || outStride < spanX || (spanY - 1) * outStride + spanX > classified.length)))
    throw fault('JXL_INTERNAL', label + ' requires one output per cell.');
  return withArena(needScratch ? SCRATCH + 8200 : OUTPUT + BAND_CELLS, (exports, bytes) => {
    const stepY = Math.max(1, Math.floor(BAND_CELLS / spanX));
    let total = 0;
    for (let ty = minY; ty <= maxY; ty += stepY) {
      const rows = Math.min(maxY - ty + 1, stepY);
      for (let tx = minX; tx <= maxX; tx += BAND_CELLS) {
        const cols = Math.min(BAND_CELLS, maxX - tx + 1), stride = cols * 128 + pad;
        for (let py = 0, from = (ty * 32 * width + tx * 32) * 4, end = rows * 32; py < end; py++, from += width * 4)
          bytes.set(data.subarray(from, Math.min(data.length, from + stride)), BASE + py * stride);
        total += invoke(exports, stride, cols, rows, classified ? OUTPUT : 0);
        if (classified) {
          if (strideOut === cols && tx === minX && cols === spanX)
            classified.set(bytes.subarray(OUTPUT, OUTPUT + cols * rows), (ty - minY) * strideOut);
          else for (let r = 0; r < rows; r++)
            classified.set(bytes.subarray(OUTPUT + r * cols, OUTPUT + (r + 1) * cols), (ty - minY + r) * strideOut + tx - minX);
        }
      }
    }
    return total;
  });
}

export function textTiles(data, width, minX, minY, maxX, maxY, classified, outStride) {
  return runCells('Text classification', 0, false, data, width, minX, minY, maxX, maxY, classified, outStride,
    (exports, stride, cols, rows, out) => exports.photoTextTiles(BASE, stride, cols, rows, out));
}

export function supportTiles(data, width, minX, minY, maxX, maxY, classified, outStride) {
  return runCells('Photo support classification', 4, true, data, width, minX, minY, maxX, maxY, classified, outStride,
    (exports, stride, cols, rows, out) => exports.photoSupportTiles(BASE, stride, cols, rows, out, SCRATCH));
}

export function hiddenColor(data, width, x0, y0, w, h) {
  if (w < 1 || h < 1) return false;
  return withArena(AUX, (exports, bytes) => {
    for (let cx = 0; cx < w; cx += BAND_PIXELS) {
      const cols = Math.min(BAND_PIXELS, w - cx), rowBytes = cols * 4, stepY = Math.max(1, Math.floor(BAND_PIXELS / cols));
      for (let cy = 0; cy < h; cy += stepY) {
        const rows = Math.min(stepY, h - cy);
        if (cols === width) {
          const from = (y0 + cy) * width * 4;
          bytes.set(data.subarray(from, from + rows * rowBytes), BASE);
        } else {
          for (let r = 0, from = ((y0 + cy) * width + x0 + cx) * 4; r < rows; r++, from += width * 4)
            bytes.set(data.subarray(from, from + rowBytes), BASE + r * rowBytes);
        }
        if (exports.photoHiddenColor(BASE, rowBytes, cols, rows)) return true;
      }
    }
    return false;
  });
}

export function paletteKind(data, width, x0, y0, w, h) {
  if (w < 1 || h < 1) return -1;
  return withArena(AUX + 5128, (exports, bytes) => {
    let init = 1, kind = -1;
    for (let cx = 0; cx < w; cx += BAND_PIXELS) {
      const cols = Math.min(BAND_PIXELS, w - cx), rowBytes = cols * 4, stepY = Math.max(1, Math.floor(BAND_PIXELS / cols));
      for (let cy = 0; cy < h; cy += stepY) {
        const rows = Math.min(stepY, h - cy);
        if (cols === width) {
          const from = (y0 + cy) * width * 4;
          bytes.set(data.subarray(from, from + rows * rowBytes), BASE);
        } else {
          for (let r = 0, from = ((y0 + cy) * width + x0 + cx) * 4; r < rows; r++, from += width * 4)
            bytes.set(data.subarray(from, from + rowBytes), BASE + r * rowBytes);
        }
        kind = exports.photoPaletteBand(BASE, rowBytes, cols, rows, AUX, init);
        init = 0;
        if (kind === 0) return 0;
      }
    }
    return kind;
  });
}

export function flattenGutter(rgba, width, height, exact, r, g, b) {
  if (width < 1 || height < 1) return;
  return withArena(AUX + BAND_PIXELS, (exports, bytes) => {
    const rgb = (r & 255) | ((g & 255) << 8) | ((b & 255) << 16);
    const maxCols = 32768;
    for (let cx = 0; cx < width; cx += maxCols) {
      const cols = Math.min(maxCols, width - cx), rowBytes = cols * 4, stepY = Math.max(8, Math.floor(BAND_PIXELS / cols) & ~7);
      for (let cy = 0; cy < height; cy += stepY) {
        const rows = Math.min(stepY, height - cy);
        if (cols === width) {
          const pFrom = cy * width * 4, eFrom = cy * width;
          bytes.set(rgba.subarray(pFrom, pFrom + rows * rowBytes), BASE);
          bytes.set(exact.subarray(eFrom, eFrom + rows * width), AUX);
          exports.photoFlattenGutter(BASE, AUX, width, rows, rgb);
          rgba.set(bytes.subarray(BASE, BASE + rows * rowBytes), pFrom);
        } else {
          for (let ry = 0; ry < rows; ry++) {
            const pFrom = ((cy + ry) * width + cx) * 4, eFrom = (cy + ry) * width + cx;
            bytes.set(rgba.subarray(pFrom, pFrom + rowBytes), BASE + ry * rowBytes);
            bytes.set(exact.subarray(eFrom, eFrom + cols), AUX + ry * cols);
          }
          exports.photoFlattenGutter(BASE, AUX, cols, rows, rgb);
          for (let ry = 0; ry < rows; ry++)
            rgba.set(bytes.subarray(BASE + ry * rowBytes, BASE + (ry + 1) * rowBytes), ((cy + ry) * width + cx) * 4);
        }
      }
    }
  });
}

export function grayTiles(data, width, height) {
  const tilesX = Math.ceil(width / 64), tilesY = Math.ceil(height / 64), out = new Uint8Array(tilesX * tilesY);
  if (width < 1 || height < 1) return out;
  return withArena(AUX + 64, (exports, bytes) => {
    for (let tx = 0; tx < tilesX; tx += 64) {
      const tCols = Math.min(64, tilesX - tx), stepTileY = Math.max(1, Math.floor(64 / tCols));
      for (let ty = 0; ty < tilesY; ty += stepTileY) {
        const tRows = Math.min(stepTileY, tilesY - ty);
        const px0 = tx * 64, py0 = ty * 64;
        const bandW = Math.min(width - px0, tCols * 64), bandH = Math.min(height - py0, tRows * 64), stride = bandW * 4;
        if (bandW === width) {
          const from = py0 * width * 4;
          bytes.set(data.subarray(from, from + bandH * stride), BASE);
        } else {
          for (let ry = 0, from = (py0 * width + px0) * 4; ry < bandH; ry++, from += width * 4)
            bytes.set(data.subarray(from, from + stride), BASE + ry * stride);
        }
        exports.photoGrayTiles(BASE, stride, bandW, bandH, tCols, tRows, AUX);
        if (tCols === tilesX) out.set(bytes.subarray(AUX, AUX + tCols * tRows), ty * tilesX);
        else for (let r = 0; r < tRows; r++) out.set(bytes.subarray(AUX + r * tCols, AUX + (r + 1) * tCols), (ty + r) * tilesX + tx);
      }
    }
    return out;
  });
}
