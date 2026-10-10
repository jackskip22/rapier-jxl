// SPDX-License-Identifier: MIT
// Signed geometric error bands: each next squared magnitude reaches twice the previous.
const magnitudes = [];
for (let value = 1, i = 0; i < 16; i++) {
  magnitudes.push(value);
  const square = 2 * value * value;
  do { value++; } while (value * value < square);
}
export const WEIGHTED_CUTS = [...magnitudes.slice().reverse().map(value => -value), 0, ...magnitudes];
// The kernel lookup domain includes both saturated tails.
export const WEIGHTED_BUCKET = Int8Array.from({length: 1003}, (_, i) => WEIGHTED_CUTS.filter(cut => cut < i - 501).length);
