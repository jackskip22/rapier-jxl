// SPDX-License-Identifier: MIT
import {journalFact, FACTS} from './step-journal.mjs';
export function photoPreferenceDifference(data, width, height, from = 0, to = height, sourceRow = 0,
  {stride = width, origin = 0} = {}) {
  let lumaEnergy = 0, chromaEnergy = 0;
  const pair = (a, b) => {
    const r = data[a] - data[b], g = data[a + 1] - data[b + 1], blue = data[a + 2] - data[b + 2];
    const y = 77 * r + 150 * g + 29 * blue, cb = 256 * blue - y, cr = 256 * r - y;
    lumaEnergy += y * y; chromaEnergy += cb * cb + cr * cr;
  };
  const rowStep = Math.max(1, height / 32 | 0);
  for (let y = Math.ceil(from / rowStep) * rowStep; y < Math.min(to, height); y += rowStep) for (let x = 0; x < width; x += Math.max(1, width / 32 | 0)) {
    const at = (origin + (y - sourceRow) * stride + x) * 4;
    if (x + 1 < width) pair(at, at + 4);
    if (y + 1 < height) pair(at, at + stride * 4);
  }
  return chromaEnergy - lumaEnergy;
}
export function preferXYB(data, width, height, sampling) {
  const gathered = sampling === undefined ? journalFact(data, FACTS)?.preference?.() : undefined;
  return (gathered ?? photoPreferenceDifference(data, width, height, 0, height, 0, sampling)) <= 0;
}
