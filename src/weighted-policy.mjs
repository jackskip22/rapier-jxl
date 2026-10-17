// SPDX-License-Identifier: MIT
const magnitudes = [];
for (let value = 1, i = 0; i < 16; i++) {
  magnitudes.push(value);
  const square = 2 * value * value;
  do { value++; } while (value * value < square);
}
export const WEIGHTED_CUTS = [...magnitudes.slice().reverse().map(value => -value), 0, ...magnitudes];
export const WEIGHTED_BUCKET = Int8Array.from({length: 1003}, (_, i) => WEIGHTED_CUTS.filter(cut => cut < i - 501).length);
