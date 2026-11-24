// SPDX-License-Identifier: MIT
import {journalFact, FACTS} from './step-journal.mjs';
export const CAPTURE_FLAT = 64;
export function flatSamples(rgba, width, height, min = 0, stride = width, x0 = 0, y0 = 0, from = 0, to = 256) {
  if (width < 32 || height < 32) return 0;
  const flags = stride === width && !x0 && !y0 ? journalFact(rgba, FACTS)?.flats : undefined;
  let flat = 0;
  for (let s = from; s < to; s++) {
    flat += (flags ? flags[s] : flatSampleAt(rgba, width, height, s, stride, x0, y0)) & FLAT;
    if (flat + 255 - s < min) return 0;
  }
  return flat;
}
export function sharedFlatSamples(rgba, width, height) {
  if (width < 32 || height < 32) return 0;
  const flags = journalFact(rgba, FACTS)?.flats, seen = new Map();
  for (let s = 0; s < 256; s++) {
    if (!((flags ? flags[s] : flatSampleAt(rgba, width, height, s)) & FLAT)) continue;
    const p = (flatSampleY(height, s) * width + flatSampleX(width, s)) * 4;
    const color = (rgba[p] << 24 | rgba[p + 1] << 16 | rgba[p + 2] << 8 | rgba[p + 3]) >>> 0;
    seen.set(color, (seen.get(color) ?? 0) + 1);
  }
  let shared = 0;
  for (const n of seen.values()) if (n > 1) shared += n;
  return shared;
}
export const flatSampleX = (width, s) => Math.min(width - 2, Math.floor((((s % 16) * 16 + ((s * 13) & 15)) * width) / 256));
export const flatSampleY = (height, s) => Math.min(height - 2, Math.floor((((s >> 4) * 16 + ((s * 7) & 15)) * height) / 256));
export const FLAT = 1, HOLE = 2;
export function flatSampleAt(rgba, width, height, s, stride = width, x0 = 0, y0 = 0, row0 = 0) {
  const x = flatSampleX(width, s), y = flatSampleY(height, s);
  const p = ((y0 + y - row0) * stride + x0 + x) * 4, q = p + 4, r = p + stride * 4;
  return (rgba[p] === rgba[q] && rgba[p + 1] === rgba[q + 1] && rgba[p + 2] === rgba[q + 2] && rgba[p + 3] === rgba[q + 3] &&
    rgba[p] === rgba[r] && rgba[p + 1] === rgba[r + 1] && rgba[p + 2] === rgba[r + 2] && rgba[p + 3] === rgba[r + 3] ? FLAT : 0) |
    (!(rgba[p + 3] | rgba[q + 3] | rgba[r + 3]) ? HOLE : 0);
}
export function screenFromFlags(flags) {
  let flat = 0, shown = 0, shownFlat = 0;
  for (let s = 0; s < 256; s++) {
    const f = flags[s];
    flat += f & FLAT;
    if (!(f & HOLE)) { shown++; shownFlat += f & FLAT; }
  }
  return shown >= 16 ? shownFlat * 4 >= shown * 3 : flat >= 192;
}
export function screenLike(rgba, width, height) {
  if (width < 32 || height < 32) return false;
  const flags = new Uint8Array(256);
  const journal = journalFact(rgba, FACTS)?.flats;
  for (let s = 0; s < 256; s++) flags[s] = journal ? journal[s] : flatSampleAt(rgba, width, height, s);
  return screenFromFlags(flags);
}
export function flatSurround(rgba, width, height) {
  if (width < 32 || height < 32) return false;
  const flags = journalFact(rgba, FACTS)?.flats;
  let flat = 0;
  for (let s = 0; s < 256; s++) if ((flags ? flags[s] : flatSampleAt(rgba, width, height, s)) & FLAT) flat++;
  return flat >= 192;
}

const TILE = 256;
export function tilesFit(data, width, height) {
  if (data.BYTES_PER_ELEMENT !== 1 || data.length !== width * height * 4) return false;
  const words = new Uint32Array(data.buffer, data.byteOffset, data.byteLength >> 2), across = Math.ceil(width / TILE), tiles = across * Math.ceil(height / TILE);
  const seen = new Set();
  let fit = 0;
  for (let t = 0; t < tiles; t++) {
    const tx = t % across * TILE, ty = (t / across | 0) * TILE, w = Math.min(TILE, width - tx), h = Math.min(TILE, height - ty), limit = w * h / 20 | 0;
    seen.clear();
    let fits = true;
    for (let y = ty; y < ty + h && fits; y++) for (let i = y * width + tx, end = i + w; i < end; i++) if (seen.add(words[i]).size > limit) { fits = false; break; }
    if (fits) fit++;
    if (5 * fit >= 4 * tiles) return true;
    if (5 * (fit + tiles - t - 1) < 4 * tiles) return false;
  }
  return false;
}
