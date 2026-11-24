// SPDX-License-Identifier: MIT
import {complete} from './bits.mjs';
import {TRANSFORMS, naturalOrder} from './vardct-strategies.mjs';
import {zeroDensityContext} from './vardct.mjs';
import {strategyAnsSteps} from './coefficient-ans.mjs';
import {prepareCoefficientOrders, COEFFICIENT_ORDER_BUCKETS} from './coefficient-orders.mjs';
import {populationBits} from './entropy.mjs';
import {VB_ZD, VB_TOKENS, token, vbPackSigned} from './varblock-core.mjs';
import {journaling, unit} from './step-journal.mjs';

const ORDER_BUCKET = /* @__PURE__ */ TRANSFORMS.map(t => COEFFICIENT_ORDER_BUCKETS.find(b => b.strategies.includes(t.name)));
const LEARNED_COUNTS = new WeakMap(), LEARNED_ORDERS = new WeakMap(), OPTIMAL_ORDERS = new WeakMap();
export const seedLearnedOrderCounts = (image, byBucket) => { LEARNED_COUNTS.set(image.strategyData, byBucket); LEARNED_ORDERS.delete(image.strategyData); };
export function learnedOrders(image) {
  const key = image.strategyData;
  if (key && LEARNED_ORDERS.has(key)) return LEARNED_ORDERS.get(key);
  const out = ordersFromCounts(LEARNED_COUNTS.get(key) ?? learnedOrderCounts(allBlocks(image.strategyData)));
  if (key) LEARNED_ORDERS.set(key, out);
  return out;
}
export function learnedOrderCounts(blocks, byBucket = new Array(COEFFICIENT_ORDER_BUCKETS.length)) {
  for (const block of blocks) {
    const bucket = ORDER_BUCKET[block.id];
    if (!bucket || bucket.id === 1) continue;
    let c3 = byBucket[bucket.id];
    if (!c3) byBucket[bucket.id] = c3 = [new Uint32Array(block.size), new Uint32Array(block.size), new Uint32Array(block.size)];
    const {area, size, order, coeffs} = block;
    for (let c = 0; c < 3; c++) {
      const plane = coeffs[c], n = c3[c];
      for (let k = area; k < size; k++) if (plane[order[k]]) n[k]++;
    }
  }
  return byBucket;
}
function ordersFromCounts(byBucket) {
  const value = {};
  for (let id = 0; id < byBucket.length; id++) {
    const c3 = byBucket[id];
    if (!c3) continue;
    const bucket = COEFFICIENT_ORDER_BUCKETS[id], skip = bucket.lowFrequencyCount, size = c3[0].length;
    value[bucket.name] = c3.map(n => {
      const rest = Array.from({length: size - skip}, (_, i) => i + skip).sort((a, b) => (n[b] >>> 2) - (n[a] >>> 2) || a - b);
      return [...Array.from({length: skip}, (_, i) => i), ...rest];
    });
  }
  return prepareCoefficientOrders(value, 1);
}

export function encodeStrategyImage(image, orders = true, effort = 7) {
  return complete(encodeStrategyImageSteps(image, orders, effort));
}
export function optimalLearnedOrders(image) {
  const sdKey = image.strategyData;
  if (sdKey && OPTIMAL_ORDERS.has(sdKey)) return OPTIMAL_ORDERS.get(sdKey);
  const out = preparedOrders(optimalOrderValue(image));
  if (sdKey) OPTIMAL_ORDERS.set(sdKey, out);
  return out;
}
const preparedOrders = value => value && Object.keys(value).length
  ? prepareCoefficientOrders(Object.fromEntries(Object.entries(value).map(([name, perms]) => [name, perms.map(p => p && Array.from(p))])), 1) : null;
function* allBlocks(strategyData) {
  if (!strategyData.packed) { yield* strategyData.blocks; return; }
  for (let g = 0; g < strategyData.groups.length; g++) yield* strategyData.groups[g];
}
function optimalOrderValue(image) {
  const byBucket = new Map(), seeded = LEARNED_COUNTS.get(image.strategyData);
  if (seeded && image.strategyData?.blocks) {
    for (const block of image.strategyData.blocks) {
      const bucket = ORDER_BUCKET[block.id];
      if (!bucket || bucket.name === 'small' || byBucket.has(bucket.name)) continue;
      const c3 = seeded[bucket.id];
      if (!c3) continue;
      byBucket.set(bucket.name, {bucket, nat: block.order ?? naturalOrder(block.bw, block.bh), counts: c3, candidates: [[], [], []]});
    }
  } else {
    for (const block of allBlocks(image.strategyData)) {
      const bucket = ORDER_BUCKET[block.id];
      if (!bucket || bucket.name === 'small') continue;
      let entry = byBucket.get(bucket.name);
      if (!entry) byBucket.set(bucket.name, entry = {bucket, nat: block.order, counts: [0, 1, 2].map(() => new Float64Array(block.size)), candidates: [[], [], []]});
      const {area, size, order} = block;
      for (let c = 0; c < 3; c++) {
        const plane = block.coeffs[c], n = entry.counts[c];
        for (let k = area; k < size; k++) if (plane[order[k]]) n[k]++;
      }
    }
  }
  for (const [name, entry] of byBucket) {
    const {bucket, counts, candidates, nat} = entry, skip = bucket.lowFrequencyCount, size = bucket.width * bucket.height;
    for (let c = 0; c < 3; c++) {
      candidates[c].push({perm: null, scan: nat, freq: new Uint32Array(VB_ZD * VB_TOKENS), extra: 0});
      const n = counts[c];
      let prevRest = null;
      for (const div of [1, 2, 4, 8, 16]) {
        const rest = Array.from({length: size - skip}, (_, i) => i + skip).sort((a, b) => Math.floor(n[b] / div) - Math.floor(n[a] / div) || a - b);
        if (!rest.some((r, i) => r !== i + skip)) continue;
        if (prevRest && rest.every((r, i) => r === prevRest[i])) continue;
        prevRest = rest;
        const perm = [...Array.from({length: skip}, (_, i) => i), ...rest];
        const testObj = {[name]: [c === 0 ? perm : null, c === 1 ? perm : null, c === 2 ? perm : null]};
        candidates[c].push({perm, scan: Uint32Array.from(perm, r => nat[r]), freq: new Uint32Array(VB_ZD * VB_TOKENS), extra: 0,
          hBits: prepareCoefficientOrders(testObj, 1)[0].header.bitLength - 4});
      }
    }
  }
  let hasNonTrivial = false;
  for (const {candidates} of byBucket.values()) if (candidates[0].length > 1 || candidates[1].length > 1 || candidates[2].length > 1) { hasNonTrivial = true; break; }
  if (!hasNonTrivial) return {};
  for (const block of allBlocks(image.strategyData)) {
    const bucket = ORDER_BUCKET[block.id];
    if (!bucket || bucket.name === 'small') continue;
    const {candidates} = byBucket.get(bucket.name);
    if (candidates[0].length <= 1 && candidates[1].length <= 1 && candidates[2].length <= 1) continue;
    const {area, size, order} = block;
    const pow2 = (area & (area - 1)) === 0, sh = pow2 ? 31 - Math.clz32(area) : 0, areaMask = area - 1;
    for (let c = 0; c < 3; c++) {
      const cands = candidates[c];
      if (cands.length <= 1) continue;
      const coeffs = block.coeffs[c];
      let count = 0;
      for (let k = area; k < size; k++) if (coeffs[order[k]]) count++;
      if (!count) continue;
      const initPrev = count > (size >> 4) ? 0 : 1;
      for (let ci = 0; ci < cands.length; ci++) {
        const candidate = cands[ci], {scan, freq} = candidate;
        let prev = initPrev, left = count, extra = 0;
        for (let k = area; k < size && left; k++) {
          const q = coeffs[scan[k]];
          const lDiv = pow2 ? (left + areaMask) >>> sh : Math.ceil(left / area);
          const kDiv = pow2 ? k >>> sh : Math.floor(k / area);
          const ctxBase = zeroDensityContext(lDiv, kDiv, prev) * VB_TOKENS;
          if (q === 0) {
            freq[ctxBase]++;
            prev = 0;
          } else {
            const u = q < 0 ? -2 * q - 1 : 2 * q;
            if (u < 16) freq[ctxBase + u]++;
            else {
              const n = 31 - Math.clz32(u), eb = n - 1, t = 16 + ((n - 4) << 1) + ((u >>> eb) & 1);
              freq[ctxBase + (t < 63 ? t : 63)]++;
              extra += eb;
            }
            prev = 1; left--;
          }
        }
        candidate.extra += extra;
      }
    }
  }
  const bitsOf = ({freq, extra}) => {
    let bits = extra;
    for (let ctx = 0; ctx < VB_ZD; ctx++) {
      const base = ctx * VB_TOKENS;
      let tot = 0, b = 0;
      for (let t = 0; t < VB_TOKENS; t++) { const f = freq[base + t]; if (f) { tot += f; b -= populationBits(f); } }
      if (tot > 1) bits += b + populationBits(tot);
    }
    return bits;
  };
  const value = {};
  for (const [name, {candidates}] of byBucket) {
    const baseBits = candidates.map(list => bitsOf(list[0]));
    const bestPerms = [null, null, null], bestGain = [0, 0, 0], bestTBits = [0, 0, 0];
    for (let c = 0; c < 3; c++) for (const candidate of candidates[c].slice(1)) {
      const tBits = bitsOf(candidate), gain = baseBits[c] - (tBits + candidate.hBits * 0.85);
      if (gain > bestGain[c]) { bestGain[c] = gain; bestPerms[c] = candidate.perm; bestTBits[c] = tBits; }
    }
    if (bestPerms.some(Boolean)) {
      const combined = {[name]: bestPerms};
      const totalH = prepareCoefficientOrders(combined, 1)[0].header.bitLength - 4;
      const rawGain = [0, 1, 2].reduce((s, c) => s + (bestPerms[c] ? baseBits[c] - bestTBits[c] : 0), 0);
      if (rawGain > totalH) value[name] = bestPerms.map(p => p && Int32Array.from(p));
    }
  }
  return value;
}

export function* encodeStrategyImageSteps(image, orders = true, effort = 7, pooled = false, primed = null, both = true) {
  if (!orders || effort <= 6) return yield* strategyAnsSteps(image, effort, null, pooled, primed, both);
  const std = learnedOrders(image);
  if (effort < 8) return yield* strategyAnsSteps(image, effort, std, pooled, primed, both);
  const opt = journaling() ? preparedOrders(yield* unit('optimal-orders', () => optimalOrderValue(image))) : optimalLearnedOrders(image);
  return yield* strategyAnsSteps(image, effort, [std, sameOrderPasses(std, opt) ? null : opt].filter(Boolean), pooled, primed, both);
}
function sameOrderPasses(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]?.header, y = b[i]?.header;
    if (!x || !y || x.bitLength !== y.bitLength || x.at !== y.at || x.acc !== y.acc || x.pending !== y.pending) return false;
    for (let k = 0; k < x.at; k++) if (x.bytes[k] !== y.bytes[k]) return false;
  }
  return true;
}
