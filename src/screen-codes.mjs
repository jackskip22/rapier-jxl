// SPDX-License-Identifier: MIT
import {uintConfig} from './prefix.mjs';

export const SCREEN_INTEGER_CONFIGS = /* @__PURE__ */ [
  [4], [0], [1], [2], [3], [6], [8],
  [4, 0, 1], [4, 0, 2], [4, 0, 3], [4, 0, 4],
  [4, 1, 3], [4, 1, 1], [4, 2, 2], [3, 0, 1]
].map(a => uintConfig(...a));
export const SCREEN_SPECIAL_DISTANCES = /* @__PURE__ */ (() => {
  const pairs = [];
  for (let dy = 0; dy < 8; dy++) for (let dx = -7; dx < 9; dx++) if (dy || dx > 0) pairs.push([dx, dy]);
  return Int8Array.from(pairs.sort(([a, b], [c, d]) => a * a + b * b - c * c - d * d || Math.abs(a) - Math.abs(c) || c - a).flat());
})();
export function screenDistanceMap(width) {
  const map = new Map();
  for (let i = SCREEN_SPECIAL_DISTANCES.length - 2; i >= 0; i -= 2)
    map.set(Math.max(1, SCREEN_SPECIAL_DISTANCES[i] + width * SCREEN_SPECIAL_DISTANCES[i + 1]), i / 2);
  return map;
}
