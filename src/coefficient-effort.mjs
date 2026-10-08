// SPDX-License-Identifier: MIT
// Entropy search shared by the JPEG and photograph entry points; coefficients and quantization never change here.
import {varDCTSteps} from './vardct.mjs';
import {ZIGZAG} from './jfif.mjs';
import {complete} from './bits.mjs';

// Frequently nonzero positions first, counted in buckets of eight blocks. Ties keep the natural transposed
// zigzag, and DC stays first. Integer counts and an explicit tie rule make the permutation deterministic.
export function coefficientOrders(components) { return complete(coefficientOrderSteps(components)); }

export function* coefficientOrderSteps(components) {
  const scan = ZIGZAG.map(n => ((n & 7) << 3) | (n >> 3));
  const histograms = components.map(() => new Uint32Array(64)), total = components.reduce((n, c) => n + c.coeffs.length, 0);
  let done = 0;
  for (let c = 0; c < components.length; c++) {
    const {coeffs} = components[c], counts = histograms[c];
    // At most one 256-pixel group's coefficient count between yields, including JPEG padding blocks.
    for (let from = 0; from < coeffs.length; from += 65536) {
      const end = Math.min(from + 65536, coeffs.length);
      for (let at = from; at < end; at += 64) for (let k = 1; k < 64; k++) if (coeffs[at + scan[k]]) counts[k]++;
      done += end - from;
      if (yield done / total) return null;
    }
  }
  return histograms.map(counts => [0, ...Array.from({length: 63}, (_, k) => k + 1).sort((a, b) => Math.floor(counts[b] / 8) - Math.floor(counts[a] / 8) || a - b)]);
}

// Rung 3 tries a 32-cluster budget at cost 160; effort level 4 also tries one learned order. Complete earlier streams
// remain available on a tie, hurry, memory failure or candidate above the stream limit. No input is mutated.
// A supplied fallback is already written; it also makes the first writer interruptible for a lossy candidate.
export function* coefficientEffortSteps(jpeg, effort, fallback) {
  if (effort < 3 && !fallback) return yield* varDCTSteps(jpeg);
  let best = fallback;
  try {
    const first = varDCTSteps(jpeg); let step, hurry;
    while (!(step = first.next()).done) {
      hurry = yield step.value / 2;
      if (hurry && best && step.value < 1) { first.return(); return best; }
    }
    if (!best || step.value.length < best.length) best = step.value;
    if (hurry || effort < 3) return best;
    const parts = effort < 4 ? 1 : 3, clustered = varDCTSteps(jpeg, {clusters: {maxClusters: 32, newClusterCost: 160}});
    while (!(step = clustered.next()).done) {
      hurry = yield 0.5 + step.value / (2 * parts);
      // The final group has already been written. Finish its stream before honoring a late hurry.
      if (hurry && step.value < 1) { clustered.return(); return best; }
    }
    if (step.value.length < best.length) best = step.value;
    if (hurry || effort < 4) return best;
    const learning = coefficientOrderSteps(jpeg.components);
    while (!(step = learning.next()).done) if (yield 0.5 + (1 + step.value) / 6) { learning.return(); return best; }
    const candidate = varDCTSteps(jpeg, {orders: step.value});
    while (!(step = candidate.next()).done) {
      hurry = yield 0.5 + (2 + step.value) / 6;
      if (hurry && step.value < 1) { candidate.return(); return best; }
    }
    return step.value.length < best.length ? step.value : best;
  } catch (error) {
    if (!best || !(error instanceof RangeError && !error.code) && error.code !== 'JXL_SIZE') throw error;
    return best;
  }
}
