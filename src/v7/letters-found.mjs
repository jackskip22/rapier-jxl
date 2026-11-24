// SPDX-License-Identifier: MIT
import {kernelFlat, arenaHolder, takeArena, growArena} from '../kernel-runtime.mjs';
import {kernelCaller, out, outUpTo, rect, room} from '../kernel-call.mjs';
import {wasmRequired} from '../capture-wasm-error.mjs';

const inkHolder = arenaHolder(() => {}), INK_BASE = 131072, INK_OVERLAP = 256, INK_BOXES = 256;
const call = kernelCaller(lay => {
  const k = kernelFlat();
  takeArena(inkHolder);
  const at = lay(INK_BASE);
  growArena(at.end);
  return {k, at};
}, error => { throw error?.code ? error : wasmRequired(error); });
const TILE_BYTES = 32 << 20, TILE_OVERLAP = 4 * 256 + 16, SAMPLE_BYTES = 13;
function tiles(data, width, height, each) {
  const rows = Math.min(height, 2 * INK_OVERLAP);
  const cols = width * rows * SAMPLE_BYTES <= TILE_BYTES ? width : Math.max(2 * TILE_OVERLAP, Math.floor(TILE_BYTES / (rows * SAMPLE_BYTES)));
  for (let y0 = 0; ; y0 += rows - INK_OVERLAP) {
    const bh = Math.min(rows, height - y0), cuts = [y0 > 0 ? 1 : 0, y0 + bh < height ? 1 : 0];
    for (let x0 = 0; ; x0 += cols - TILE_OVERLAP) {
      const tw = Math.min(cols, width - x0);
      const scratch = bh * tw * 8 + (1 << 20), tile = tw === width ? data.subarray(y0 * width * 4, (y0 + bh) * width * 4) : rect(Uint8Array, data, width, x0, y0, tw, bh, 4);
      if (each(bh, tw, [tile, tw, bh, room(scratch), scratch], cuts, y0, x0)) return true;
      if (x0 + tw >= width) break;
    }
    if (y0 + bh >= height) return false;
  }
}
const rgba = (data, width, height) => (data instanceof Uint8Array || data instanceof Uint8ClampedArray) && data.length === width * height * 4;

export function lettersFound(data, width, height) {
  if (!rgba(data, width, height)) return true;
  if (width < 3 || height < 3) return false;
  return tiles(data, width, height, (bh, tw, head, cuts) => call(k => k.inkLines, [...head, room(INK_BOXES * 16), INK_BOXES, ...cuts])[0] !== 0);
}

export function findText(data, width, height) {
  if (!rgba(data, width, height)) return null;
  let mask = null;
  const lines = [];
  if (width < 3 || height < 3) return {mask: new Uint8Array(width * height), lines};
  tiles(data, width, height, (bh, tw, head, cuts, y0, x0) => {
    const [n, b, marks] = call(k => k.findText, [...head, outUpTo(Int32Array, INK_BOXES * 8, c => 8 * Math.max(0, Math.min(c, INK_BOXES))),
      INK_BOXES, ...cuts, out(Uint8Array, bh * tw, 1)], true);
    if (n !== 0) mask ??= new Uint8Array(width * height);
    if (n < 0) { for (let r = 0; r < bh; r++) mask.fill(1, (y0 + r) * width + x0, (y0 + r) * width + x0 + tw); return false; }
    if (n === 0) return false;
    const [, merged] = call(k => k.protectedCompose,
      [{...rect(Uint8Array, mask, width, x0, y0, tw, bh), back: tw * bh}, tw, marks.byteOffset, 0, 0, tw, bh, 1], true);
    for (let r = 0; r < bh; r++) mask.set(merged.subarray(r * tw, (r + 1) * tw), (y0 + r) * width + x0);
    for (let i = 0; i < b.length; i += 8) {
      const line = {x0: b[i] + x0, y0: b[i + 1] + y0, x1: b[i + 2] + x0, y1: b[i + 3] + y0, ink: b[i + 4] >>> 0, baseline: b[i + 5] + y0, strokes: b[i + 6], strokeRows: b[i + 7]};
      const same = (y0 > 0 || x0 > 0) && lines.find(l => l.ink === line.ink && l.baseline === line.baseline && l.x0 <= line.x1 && line.x0 <= l.x1);
      if (same) { same.x0 = Math.min(same.x0, line.x0); same.x1 = Math.max(same.x1, line.x1); same.y0 = Math.min(same.y0, line.y0); same.y1 = Math.max(same.y1, line.y1);
        same.strokes = Math.max(same.strokes, line.strokes); same.strokeRows = Math.max(same.strokeRows, line.strokeRows); }
      else lines.push(line);
    }
    return false;
  });
  return {mask: mask ?? new Uint8Array(width * height), lines};
}
