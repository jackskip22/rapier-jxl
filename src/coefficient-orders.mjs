// SPDX-License-Identifier: MIT
import {BitWriter} from './bits.mjs';
import {fault} from './admit.mjs';
import {uintConfig, countToken, buildCode, writeHistograms, writeHybrid} from './prefix.mjs';
import {naturalOrder, TRANSFORMS} from './vardct-strategies.mjs';

const ORDER_BUCKET_NAMES = ['dct8', 'small', 'dct16', 'dct32', 'dct16x8', 'dct32x8', 'dct32x16',
  'dct64', 'dct64x32', 'dct128', 'dct128x64', 'dct256', 'dct256x128'];
const ORDER_STRATEGY_BUCKETS = [0, 1, 1, 1, 2, 3, 4, 4, 5, 5, 6, 6, 1, 1, 1, 1, 1, 1, 7, 8, 8, 9, 10, 10, 11, 12, 12];
export const COEFFICIENT_ORDER_BUCKETS = Object.freeze(ORDER_BUCKET_NAMES.map((name, id) => {
  const strategies = TRANSFORMS.filter(strategy => ORDER_STRATEGY_BUCKETS[strategy.id] === id), first = strategies[0];
  const width = Math.max(first.width, first.height), height = Math.min(first.width, first.height);
  return Object.freeze({name, id, width, height, lowFrequencyCount: width * height / 64,
    strategies: Object.freeze(strategies.map(strategy => strategy.name))});
}));

function admitOrderPermutation(value, size, skip) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || value.length !== size)
    throw fault('JXL_INPUT', 'Each coefficient order is a complete natural-scan-rank permutation, or null.');
  const permutation = new Uint32Array(size), seen = new Uint8Array(size);
  let changed = false;
  for (let i = 0; i < size; i++) {
    const rank = value[i];
    if (!Number.isInteger(rank) || rank < 0 || rank >= size || seen[rank])
      throw fault('JXL_INPUT', 'A coefficient order contains each natural-scan rank exactly once.');
    if (i < skip && rank !== i)
      throw fault('JXL_INPUT', 'A coefficient order leaves every low-frequency prefix rank in its original position.');
    permutation[i] = rank; seen[rank] = 1; changed ||= rank !== i;
  }
  return changed ? permutation : null;
}

function orderPermutationTokens(permutation, skip, size) {
  if (!permutation) return new Uint32Array(1);
  const available = new Uint32Array(size + 1), lehmer = new Uint32Array(size);
  for (let i = 1; i <= size; i++) available[i] = i & -i;
  for (let i = 0; i < size; i++) {
    const rank = permutation[i];
    for (let at = rank; at; at -= at & -at) lehmer[i] += available[at];
    for (let at = rank + 1; at <= size; at += at & -at) available[at]--;
  }
  let end = size;
  while (end > skip && !lehmer[end - 1]) end--;
  const tokens = new Uint32Array(end - skip + 1);
  tokens[0] = end - skip; tokens.set(lehmer.subarray(skip, end), 1);
  return tokens;
}

function prepareOrderPass(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ArrayBuffer.isView(value))
    throw fault('JXL_INPUT', 'coefficientOrders maps standard order-bucket names to three channel permutations.');
  const entries = new Map();
  for (const [name, channels] of Object.entries(value)) {
    const id = ORDER_BUCKET_NAMES.indexOf(name);
    if (id < 0) throw fault('JXL_INPUT', 'Coefficient-order keys name a bucket exported by COEFFICIENT_ORDER_BUCKETS.');
    if (!Array.isArray(channels) || channels.length !== 3)
      throw fault('JXL_INPUT', 'Each coefficient-order bucket has three channel permutations in JPEG XL frame order.');
    const bucket = COEFFICIENT_ORDER_BUCKETS[id], size = bucket.width * bucket.height;
    const permutations = Array.from({length: 3}, (_, channel) => admitOrderPermutation(channels[channel], size, bucket.lowFrequencyCount));
    if (permutations.some(Boolean)) entries.set(id, permutations);
  }
  const header = new BitWriter(64), byStrategy = [], tokenLists = [];
  let mask = 0, ordinary = null;
  for (let id = 0; id < COEFFICIENT_ORDER_BUCKETS.length; id++) {
    const permutations = entries.get(id);
    if (!permutations) continue;
    mask |= 1 << id;
    const bucket = COEFFICIENT_ORDER_BUCKETS[id], size = bucket.width * bucket.height;
    const natural = naturalOrder(bucket.width / 8, bucket.height / 8);
    const scans = permutations.map(permutation => permutation && Uint32Array.from(permutation, rank => natural[rank]));
    for (const strategy of TRANSFORMS) if (ORDER_STRATEGY_BUCKETS[strategy.id] === id) byStrategy[strategy.id] = scans;
    if (id === 0) ordinary = scans.map(scan => scan && Uint8Array.from(scan, position => ((position & 7) << 3) | (position >> 3)));
    for (const permutation of permutations) tokenLists.push(orderPermutationTokens(permutation, bucket.lowFrequencyCount, size));
  }
  header.writeU32([[0, 95], [0, 19], [0, 0], [13, 0]], mask);
  if (mask) {
    const config = uintConfig(0), freqs = new Uint32Array(32);
    for (const tokens of tokenLists) for (const token of tokens) countToken(config, token, freqs);
    const code = buildCode(freqs);
    writeHistograms(header, {contextMap: new Uint8Array(8), histograms: [{config, code}]});
    for (const tokens of tokenLists) for (const token of tokens) writeHybrid(header, code, config, token);
  }
  header.bytes = header.bytes.slice(0, header.at);
  return {header, byStrategy, ordinary};
}

export function prepareCoefficientOrders(value, numPasses) {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || ArrayBuffer.isView(value))
    throw fault('JXL_INPUT', 'coefficientOrders is an order-bucket map or an object with one map per pass.');
  const fields = new Map(Object.entries(value));
  if (fields.has('passes')) {
    const passes = fields.get('passes');
    if (fields.size !== 1 || !Array.isArray(passes) || passes.length !== numPasses)
      throw fault('JXL_INPUT', 'coefficientOrders.passes contains exactly one order map for each main-frame pass.');
    return Array.from(passes, prepareOrderPass);
  }
  return Array(numPasses).fill(prepareOrderPass(value));
}
