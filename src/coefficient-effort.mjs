// SPDX-License-Identifier: MIT
import {varDCTSteps} from './vardct.mjs';
import {ZIGZAG} from './jfif.mjs';
import {complete} from './bits.mjs';

export function coefficientOrders(components) { return complete(coefficientOrderSteps(components)); }

export function* coefficientOrderSteps(components, bucket = 8) {
  const scan = ZIGZAG.map(n => ((n & 7) << 3) | (n >> 3));
  const histograms = components.map(() => new Uint32Array(64)), total = components.reduce((n, c) => n + c.coeffs.length, 0);
  let done = 0;
  for (let c = 0; c < components.length; c++) {
    const {coeffs} = components[c], counts = histograms[c];
    for (let from = 0; from < coeffs.length; from += 65536) {
      const end = Math.min(from + 65536, coeffs.length);
      for (let at = from; at < end; at += 64) for (let k = 1; k < 64; k++) if (coeffs[at + scan[k]]) counts[k]++;
      done += end - from;
      if (yield done / total) return null;
    }
  }
  return histograms.map(counts => [0, ...Array.from({length: 63}, (_, k) => k + 1).sort((a, b) => Math.floor(counts[b] / bucket) - Math.floor(counts[a] / bucket) || a - b)]);
}

export function* coefficientEffortSteps(jpeg, effort, fallback, retain) {
  if (effort < 3 && !fallback && !retain) return yield* varDCTSteps(jpeg);
  let best = fallback;
  try {
    const first = varDCTSteps(jpeg); let step, hurry;
    while (!(step = first.next()).done) {
      hurry = yield step.value / 2;
      if (hurry && best && step.value < 1) { first.return(); return best; }
    }
    if (!best || step.value.length < best.length) best = step.value;
    retain?.(step.value, {});
    if (hurry || effort < 3) return best;
    const parts = effort < 4 ? 1 : 3, clustered = varDCTSteps(jpeg, {clusters: {maxClusters: 32, newClusterCost: 160}});
    while (!(step = clustered.next()).done) {
      hurry = yield 0.5 + step.value / (2 * parts);
      if (hurry && step.value < 1) { clustered.return(); return best; }
    }
    if (step.value.length < best.length) best = step.value;
    retain?.(step.value, {clusters: {maxClusters: 32, newClusterCost: 160}});
    if (hurry || effort < 4) return best;
    const learning = coefficientOrderSteps(jpeg.components);
    while (!(step = learning.next()).done) if (yield 0.5 + (1 + step.value) / 6) { learning.return(); return best; }
    const plan = {orders: step.value}, candidate = varDCTSteps(jpeg, plan);
    while (!(step = candidate.next()).done) {
      hurry = yield 0.5 + (2 + step.value) / 6;
      if (hurry && step.value < 1) { candidate.return(); return best; }
    }
    if (step.value.length < best.length) best = step.value;
    retain?.(step.value, plan);
    return best;
  } catch (error) {
    if (!best || !(error instanceof RangeError && !error.code) && error.code !== 'JXL_SIZE') throw error;
    return best;
  }
}
