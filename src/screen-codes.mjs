// SPDX-License-Identifier: MIT
import {uintConfig} from './prefix.mjs';

export const SCREEN_INTEGER_CONFIGS = [
  uintConfig(4), uintConfig(0), uintConfig(1), uintConfig(2), uintConfig(3), uintConfig(6), uintConfig(8),
  uintConfig(4, 0, 1), uintConfig(4, 0, 2), uintConfig(4, 0, 3), uintConfig(4, 0, 4),
  uintConfig(4, 1, 3), uintConfig(4, 1, 1), uintConfig(4, 2, 2), uintConfig(3, 0, 1)
];
export const SCREEN_SPECIAL_DISTANCES = Int8Array.of(
  0, 1, 1, 0, 1, 1, -1, 1, 0, 2, 2, 0, 1, 2, -1, 2,
  2, 1, -2, 1, 2, 2, -2, 2, 0, 3, 3, 0, 1, 3, -1, 3,
  3, 1, -3, 1, 2, 3, -2, 3, 3, 2, -3, 2, 0, 4, 4, 0,
  1, 4, -1, 4, 4, 1, -4, 1, 3, 3, -3, 3, 2, 4, -2, 4,
  4, 2, -4, 2, 0, 5, 3, 4, -3, 4, 4, 3, -4, 3, 5, 0,
  1, 5, -1, 5, 5, 1, -5, 1, 2, 5, -2, 5, 5, 2, -5, 2,
  4, 4, -4, 4, 3, 5, -3, 5, 5, 3, -5, 3, 0, 6, 6, 0,
  1, 6, -1, 6, 6, 1, -6, 1, 2, 6, -2, 6, 6, 2, -6, 2,
  4, 5, -4, 5, 5, 4, -5, 4, 3, 6, -3, 6, 6, 3, -6, 3,
  0, 7, 7, 0, 1, 7, -1, 7, 5, 5, -5, 5, 7, 1, -7, 1,
  4, 6, -4, 6, 6, 4, -6, 4, 2, 7, -2, 7, 7, 2, -7, 2,
  3, 7, -3, 7, 7, 3, -7, 3, 5, 6, -5, 6, 6, 5, -6, 5,
  8, 0, 4, 7, -4, 7, 7, 4, -7, 4, 8, 1, 8, 2, 6, 6,
  -6, 6, 8, 3, 5, 7, -5, 7, 7, 5, -7, 5, 8, 4, 6, 7,
  -6, 7, 7, 6, -7, 6, 8, 5, 7, 7, -7, 7, 8, 6, 8, 7
);
export function screenDistanceMap(width) {
  const map = new Map();
  for (let i = SCREEN_SPECIAL_DISTANCES.length - 2; i >= 0; i -= 2)
    map.set(Math.max(1, SCREEN_SPECIAL_DISTANCES[i] + width * SCREEN_SPECIAL_DISTANCES[i + 1]), i / 2);
  return map;
}
