// SPDX-License-Identifier: MIT
export const RECIPROCAL = Uint32Array.from({length: 65}, (_, i) => i ? Math.floor(16777216 / i) : 0);
export const DEFAULT_WEIGHTED = [16, 10, 7, 7, 7, 0, 0, 13, 12, 12, 12];

export function weightedDivision(value, reciprocal) {
  const high = Math.floor(value / 16777216);
  return high * reciprocal + Math.floor((value - high * 16777216) * reciprocal / 16777216);
}
