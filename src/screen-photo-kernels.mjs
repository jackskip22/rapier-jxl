// SPDX-License-Identifier: MIT
import {kernelInstance, arenaHolder, takeArena, growArena} from './kernel-runtime.mjs';
import {wasmRequired} from './capture-wasm-error.mjs';
import {fault} from './fault.mjs';

const holder = arenaHolder(() => {}), BASE = 65536, BAND_CELLS = 256;
export function textTiles(data, width, minX, minY, maxX, maxY, classified) {
  if (minX > maxX || minY > maxY) return 0;
  if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray) ||
      ![width, minX, minY, maxX, maxY].every(Number.isSafeInteger) || width < 1 || minX < 0 || minY < 0 ||
      (maxX + 1) * 32 > width || ((maxY + 1) * 32 - 1) * width * 4 + (maxX + 1) * 128 > data.length)
    throw fault('JXL_INTERNAL', 'Text classification requires whole cells inside the picture.');
  if (classified !== undefined && (!(classified instanceof Int8Array) ||
      classified.length !== (maxX - minX + 1) * (maxY - minY + 1)))
    throw fault('JXL_INTERNAL', 'Text classification requires one output per cell.');
  try {
    const {memory, exports} = kernelInstance();
    takeArena(holder);
    const capacity = Math.min(BAND_CELLS, maxX - minX + 1) * 128;
    const output = BASE + capacity * 32;
    growArena(output + BAND_CELLS);
    const bytes = new Uint8Array(memory.buffer);
    let text = 0;
    for (let ty = minY; ty <= maxY; ty++) for (let tx = minX; tx <= maxX; tx += BAND_CELLS) {
      const count = Math.min(BAND_CELLS, maxX - tx + 1), stride = count * 128;
      for (let y = 0, from = (ty * 32 * width + tx * 32) * 4; y < 32; y++, from += width * 4)
        bytes.set(data.subarray(from, from + stride), BASE + y * stride);
      text += exports.photoTextTiles(BASE, stride, count, classified ? output : 0);
      if (classified) classified.set(bytes.subarray(output, output + count),
        (ty - minY) * (maxX - minX + 1) + tx - minX);
    }
    return text;
  } catch (error) {
    if (error?.code) throw error;
    throw Object.assign(wasmRequired(), {cause: error});
  }
}
