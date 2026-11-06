// SPDX-License-Identifier: MIT
import {packSigned} from './bits.mjs';
import {writeContextMap} from './prefix.mjs';
import {NONZERO_BUCKETS, ZERO_DENSITY_CONTEXTS, ORDERS} from './dct8-contexts.mjs';

const ORDER_CLASS = [0, 1, 2, 2, 3, 4, 5, 6, 7, 7, 7, 7, 7];
export const DESIGNS = {
  dcBuckets: grey => (row, ord, i, n) => row === 0 ? i : grey ? n : row === 1 ? n + (i >> 1) : n + ((n - 1) >> 1) + 1 + (i >> 1),
  sizes: grey => (row, ord) => (grey && row ? 1 : row) * 2 + (ord ? 1 : 0),
  sizesShared: () => (row, ord) => (row ? 2 : 0) + (ord ? 1 : 0),
  sizes3: grey => (row, ord) => (grey && row ? 1 : row) * 3 + (ORDER_CLASS[ord] === 0 ? 0 : ORDER_CLASS[ord] === 2 ? 1 : 2),
  sizes3Shared: () => (row, ord) => (row ? 3 : 0) + (ORDER_CLASS[ord] === 0 ? 0 : ORDER_CLASS[ord] === 2 ? 1 : 2),
  sizesDc: grey => (row, ord, i, n) => {
    const b = n <= 2 ? i : (i * 2 / n) | 0;
    if (row === 0) return (ORDER_CLASS[ord] ? 2 : 0) + b;
    if (grey) return 4 + (ORDER_CLASS[ord] ? 1 : 0);
    return 4 + (row - 1) * 2 + (ORDER_CLASS[ord] ? 1 : 0);
  },
  fine: () => (row, ord, i, n) => (row * 8 + ORDER_CLASS[ord]) * n + i,
};
export function blockContexts(luma, thresholdsWanted, grey, design = DESIGNS.dcBuckets(grey)) {
  const thresholds = [];
  if (thresholdsWanted > 0) {
    let low = -1024, high = 1023, total = 0;
    for (const value of luma) { if (value < low) low = value; else if (value > high) high = value; }
    const counts = new Uint32Array(high - low + 1);
    for (const value of luma) { counts[value - low]++; total++; }
    let cumulative = 0, cut = total / (thresholdsWanted + 1);
    for (let j = 0; j < counts.length && thresholds.length < thresholdsWanted; j++) {
      cumulative += counts[j];
      if (cumulative > cut) { thresholds.push(j + low - 1); cut = total * (thresholds.length + 1) / (thresholdsWanted + 1); }
    }
  }
  return contextsFromThresholds(thresholds, grey, design);
}
export function contextsFromThresholds(thresholds, grey, design = DESIGNS.dcBuckets(grey)) {
  const numDc = thresholds.length + 1, map = new Uint8Array(3 * ORDERS * numDc);
  for (let row = 0; row < 3; row++) for (let ord = 0; ord < ORDERS; ord++) for (let i = 0; i < numDc; i++) map[(row * ORDERS + ord) * numDc + i] = design(row, ord, i, numDc);
  let numCtxs = 0;
  for (const v of map) numCtxs = Math.max(numCtxs, v + 1);
  const bucketOf = value => { let b = 0; for (const t of thresholds) if (value > t) b++; return b; };
  return {thresholds, numDc, map, numCtxs, bucketOf, ...acContexts(map, numDc, numCtxs)};
}

export function acContexts(map, numDc, numCtxs) {
  return {contextOf: (c, bucket, ord = 0) => map[((c < 2 ? c ^ 1 : 2) * ORDERS + ord) * numDc + bucket],
    nonZero: (predicted, blockCtx) => (Math.min(predicted, 64) < 8 ? Math.min(predicted, 64) : 4 + (Math.min(predicted, 64) >> 1)) * numCtxs + blockCtx,
    zeroDensityOffset: blockCtx => numCtxs * NONZERO_BUCKETS + ZERO_DENSITY_CONTEXTS * blockCtx,
    contexts: numCtxs * (NONZERO_BUCKETS + ZERO_DENSITY_CONTEXTS)};
}

export function writeBlockContexts(w, contexts) {
  w.write(4, contexts.thresholds.length);
  for (const t of contexts.thresholds) w.writeU32([[4, 0], [8, 16], [16, 272], [32, 65808]], packSigned(t));
  w.write(4, 0); w.write(4, 0);
  writeContextMap(w, contexts.map);
}

