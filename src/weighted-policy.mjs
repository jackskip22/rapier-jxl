export const WEIGHTED_PREDICTOR = 6, WEIGHTED_PROPERTY = 15;
// SPDX-License-Identifier: MIT
const magnitudes = [];
for (let value = 1, i = 0; i < 16; i++) {
  magnitudes.push(value);
  const square = 2 * value * value;
  do { value++; } while (value * value < square);
}
export const WEIGHTED_CUTS = [...magnitudes.slice().reverse().map(value => -value), 0, ...magnitudes];
export const WEIGHTED_BUCKET = Int8Array.from({length: 1003}, (_, i) => WEIGHTED_CUTS.filter(cut => cut < i - 501).length);

export function weightedTables(i32, div, weights) {
  for (let i = 0; i < 64; i++) i32[(div >> 2) + i] = Math.floor(16777216 / (i + 1));
  for (let most = 12; most <= 13; most++) for (let sum = 0; sum < 2048; sum++) {
    const shift = Math.max(0, 26 - Math.clz32(sum + 1));
    i32[(weights >> 2) + (most - 12) * 2048 + sum] = 4 + ((most * i32[(div >> 2) + (sum >> shift)]) >> shift);
  }
}
