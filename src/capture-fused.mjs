// SPDX-License-Identifier: MIT
import {kernelModule} from './kernel-runtime.mjs';

export const FRAME_ROWS_BUDGET = 512 * 65536;
const engines = new WeakMap();
let own;
const instance = memory => {
  let frameRows = engines.get(memory);
  if (!frameRows) engines.set(memory, frameRows = new WebAssembly.Instance(kernelModule(), {env: {memory}}).exports.frameRows);
  return frameRows;
};
const ownArena = () => {
  if (own === undefined) try {
    const memory = new WebAssembly.Memory({initial: 1, maximum: FRAME_ROWS_BUDGET / 65536});
    own = {memory, base: 0, limit: FRAME_ROWS_BUDGET, grow: end => memory.grow(Math.ceil((end - memory.buffer.byteLength) / 65536))};
    instance(memory);
  } catch { own = null; }
  return own;
};

export function fusedFrameRows(data, width, dx, dy, boxes, most = 256, arena = ownArena(), rowWidth = width + dx) {
  if (!arena) return null;
  const fw = width + dx, height = data.length / (width * 4);
  const inside = boxes.map(r => {
    const x = Math.max(0, r.x), y = Math.max(0, r.y);
    return {x, y, w: Math.min(width, r.x + r.w) - x, h: Math.min(height, r.y + r.h) - y};
  }).filter(r => r.w > 0 && r.h > 0).sort((a, b) => a.y - b.y);
  const n = inside.length, at = arena.base, mask = at + 16 * n, band = (mask + width + 15) & ~15;
  if (band + rowWidth * most * 4 > arena.limit) return null;
  const {memory} = arena, frameRows = instance(memory);
  if (typeof frameRows !== 'function') return null;
  const placed = new Int32Array(4 * n);
  let tall = 0;
  inside.forEach((r, i) => { placed.set([r.x, r.y, r.w, r.h], 4 * i); if (r.h > tall) tall = r.h; });
  const rowBytes = width * 4, frameBytes = rowWidth * 4;
  return (y, count) => {
    const end = band + frameBytes * count;
    if (count > most) throw new RangeError('A band of more rows than the reader was made for.');
    if (end > memory.buffer.byteLength) arena.grow(end);
    const u8 = new Uint8Array(memory.buffer), u32 = new Uint32Array(memory.buffer);
    new Int32Array(memory.buffer, at, 4 * n).set(placed);
    for (let r = 0; r < count; r++) {
      const py = Math.max(0, y + r - dy) * rowBytes;
      u8.set(data.subarray(py, py + rowBytes), band + r * frameBytes + dx * 4);
    }
    frameRows(band, rowWidth, count, y, dy, dx, width, at, n, tall, mask);
    if (rowWidth > fw) for (let r = 0; r < count; r++) { const last = (band >> 2) + r * rowWidth + fw - 1; u32.fill(u32[last], last + 1, last + 1 + rowWidth - fw); }
    return new Uint8Array(memory.buffer, band, frameBytes * count);
  };
}
