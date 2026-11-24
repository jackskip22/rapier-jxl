// SPDX-License-Identifier: MIT
let cachedPosLen = -1, cachedPosCap = -1, cachedPos = null;
export function positionsOf(length, cap) {
  const count = Math.min(length, cap);
  if (length === cachedPosLen && count === cachedPosCap && cachedPos) return cachedPos;
  const positions = new Uint32Array(count);
  if (count === length) { for (let i = 0; i < count; i++) positions[i] = i; }
  else for (let i = 0; i < count; i++) {
    const lo = Math.floor(i * length / count), hi = Math.floor((i + 1) * length / count);
    let hash = Math.imul(i + 1, 0x9e3779b1); hash ^= hash >>> 16; hash = Math.imul(hash, 0x85ebca6b); hash ^= hash >>> 13;
    positions[i] = lo + (hash >>> 0) % (hi - lo);
  }
  cachedPosLen = length; cachedPosCap = count; cachedPos = positions;
  return positions;
}
export const rankingPositions = (pixels, samples = 32768) => positionsOf(pixels, samples);
export const letGoPositions = () => { cachedPos = null; cachedPosLen = -1; };
