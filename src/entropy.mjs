// Rapier's JPEG XL encoder: token coding over many contexts. MIT (images/jxl/LICENSE).
import {buildCode, uintConfig, hybridToken, writeHybrid, writeHistograms} from './prefix.mjs';
import {BitWriter, floorLog2, complete} from './bits.mjs';
import {unit, carried, stage, PASSED} from './step-journal.mjs';
import {entropyLog2} from './entropy-log.mjs';
export {entropyLog2};

const CONFIGS = [uintConfig(0), uintConfig(1), uintConfig(2), uintConfig(3), uintConfig(4), uintConfig(4, 1, 1), uintConfig(4, 2, 0), uintConfig(4, 1, 2), uintConfig(5, 1, 1), uintConfig(2, 0, 1), uintConfig(3, 0, 1)];
export const ANS_CONFIGS = [...CONFIGS, uintConfig(3, 1, 0), uintConfig(4, 0, 1), uintConfig(4, 1, 0), uintConfig(4, 2, 1), uintConfig(5, 1, 0), uintConfig(5, 2, 0), uintConfig(5, 2, 1)];
const PHOTO_ANS_CONFIGS = [...ANS_CONFIGS, uintConfig(1, 1, 0), uintConfig(1, 0, 1), uintConfig(2, 1, 1), uintConfig(2, 2, 0),
  uintConfig(2, 0, 2), uintConfig(3, 1, 2), uintConfig(3, 2, 1), uintConfig(3, 3, 0), uintConfig(3, 0, 3), uintConfig(4, 0, 2), uintConfig(5), uintConfig(5, 0, 1)];
const CLUSTER_CONFIG = uintConfig(4, 1, 1);
const MORE_TOKENS = /* @__PURE__ */ new Uint32Array(2048);
const MORE_CONFIGS = /* @__PURE__ */ (() => {
  const out = [];
  for (let split = 0; split <= 7; split++) for (let msb = 0; msb <= split; msb++) for (let lsb = 0; msb + lsb <= split; lsb++)
    if (!ANS_CONFIGS.some(c => c.split === split && c.msb === msb && c.lsb === lsb)) out.push(uintConfig(split, msb, lsb));
  return out;
})();

function histogramKey(tokens, length, raw) {
  let a = raw >>> 0, b = length;
  for (let i = 0; i < length; i++) { a = Math.imul(a ^ tokens[i], 0x9e3779b1); b = Math.imul(b + tokens[i], 0x85ebca77) ^ (a >>> 15); }
  return (a >>> 0) * 4294967296 + (b >>> 0);
}

export class TokenCounts {
  constructor(contexts) { this.contexts = contexts; this.small = new Uint32Array(contexts * 64); this.large = new Array(contexts).fill(null); this.totals = new Float64Array(contexts); }
  add(ctx, value) {
    this.totals[ctx]++;
    if (value < 64) { this.small[ctx * 64 + value]++; return; }
    const map = this.large[ctx] || (this.large[ctx] = new Map());
    map.set(value, (map.get(value) || 0) + 1);
  }
  addTokens(ctxs, values, n) {
    const totals = this.totals, small = this.small;
    for (let i = 0; i < n; i++) {
      const ctx = ctxs[i], value = values[i];
      if (value < 64) { totals[ctx]++; small[ctx * 64 + value]++; } else this.add(ctx, value);
    }
  }
  merge(other) {
    for (let i = 0; i < this.small.length; i++) this.small[i] += other.small[i];
    for (let ctx = 0; ctx < this.contexts; ctx++) {
      this.totals[ctx] += other.totals[ctx];
      if (!other.large[ctx]) continue;
      const map = this.large[ctx] || (this.large[ctx] = new Map());
      for (const [v, n] of other.large[ctx]) map.set(v, (map.get(v) || 0) + n);
    }
  }
  tokens(contexts, config, size = 128) {
    const freqs = new Uint32Array(size);
    for (const ctx of contexts) {
      const base = ctx * 64;
      for (let v = 0; v < 64; v++) if (this.small[base + v]) freqs[hybridTokenOf(config, v)] += this.small[base + v];
      const map = this.large[ctx];
      if (map) for (const [v, n] of map) freqs[hybridTokenOf(config, v)] += n;
    }
    return freqs;
  }
  aggregate(contexts) {
    const result = new TokenCounts(1);
    const rSmall = result.small, small = this.small, totals = this.totals, large = this.large;
    let sum = 0;
    for (let i = 0; i < contexts.length; i++) {
      const ctx = contexts[i], base = ctx * 64;
      sum += totals[ctx];
      for (let v = 0; v < 64; v++) rSmall[v] += small[base + v];
      if (large[ctx]) {
        const target = result.large[0] || (result.large[0] = new Map());
        for (const [v, n] of large[ctx]) target.set(v, (target.get(v) || 0) + n);
      }
    }
    result.totals[0] = sum;
    return result;
  }
  cost(contexts, config) {
    return entropyBits(this.tokens(contexts, config)) + this.rawBits(contexts, config);
  }
  rawBits(contexts, config) {
    let bits = 0;
    for (const ctx of contexts) {
      const base = ctx * 64;
      for (let v = config.splitToken; v < 64; v++) if (this.small[base + v]) bits += this.small[base + v] * (floorLog2(v) - config.msb - config.lsb);
      const map = this.large[ctx];
      if (map) for (const [v, n] of map) if (v >= config.splitToken) bits += n * (floorLog2(v) - config.msb - config.lsb);
    }
    return bits;
  }
}

const slots = [0, 0, 0];
function hybridTokenOf(config, value) { hybridToken(config, value, slots); return slots[0]; }
const CLUSTER_TOKEN_BELOW_64 = Uint8Array.from({length: 64}, (_, v) => hybridTokenOf(CLUSTER_CONFIG, v));
const clusterTokenOf = v => v < 64 ? CLUSTER_TOKEN_BELOW_64[v] : hybridTokenOf(CLUSTER_CONFIG, v);

const NLOG2 = new Float64Array(65536);
export const populationBits = n => n < 2 ? 0 : n < NLOG2.length
  ? NLOG2[n] || (NLOG2[n] = n * entropyLog2(n)) : n * entropyLog2(n);
function entropyBits(freqs) {
  let total = 0, bits = 0;
  for (const f of freqs) if (f) { total += f; bits -= populationBits(f); }
  return bits + populationBits(total);
}

function mergedBits(a, b, last) {
  let total = 0, bits = 0;
  for (let s = 0; s < last; s++) { const n = a[s] + b[s]; if (n) { total += n; bits -= populationBits(n); } }
  return bits + populationBits(total);
}

const MERGED_SCRATCH = new Uint32Array(64);
const LOADED = Symbol('loaded rows');

export function tokenCountsData({contexts, small, totals, large}) {
  const list = [];
  large.forEach((map, ctx) => { if (map) { list.push(ctx, map.size); for (const [v, n] of map) list.push(v, n); } });
  let n = 0, gap = 0, most = 0;
  for (let i = 0, last = 0; i < small.length; i++) if (small[i]) { n++; gap = Math.max(gap, i - last); last = i; most = Math.max(most, small[i]); }
  const gaps = gap < 65536, at = gaps ? new Uint16Array(n) : new Uint32Array(n), values = most < 65536 ? new Uint16Array(n) : new Uint32Array(n);
  for (let i = 0, j = 0, last = 0; i < small.length; i++) if (small[i]) { at[j] = gaps ? i - last : i; values[j++] = small[i]; last = i; }
  const whole = totals.every(t => t <= 0xffffffff);
  return {contexts, at, values, totals: whole ? Uint32Array.from(totals) : totals, large: Float64Array.from(list), ...(gaps && {gaps: true})};
}
export function tokenCountsFrom({contexts, at, values, totals, large: list, gaps = false}) {
  const small = new Uint32Array(contexts * 64);
  for (let j = 0, i = 0; j < at.length; j++) { i = gaps ? i + at[j] : at[j]; small[i] = values[j]; }
  const large = new Array(contexts).fill(null);
  for (let i = 0; i < list.length;) {
    const map = large[list[i]] = new Map();
    for (let n = list[i + 1], j = i + 2; n > 0; n--, j += 2) map.set(list[j], list[j + 1]);
    i += 2 + 2 * list[i + 1];
  }
  return Object.assign(Object.create(TokenCounts.prototype), {contexts, small, large, totals: totals instanceof Float64Array ? totals : Float64Array.from(totals)});
}

function packClusters(clusters) {
  const n = clusters.length, ends = new Int32Array(n), fends = new Int32Array(n), bits = new Float64Array(n), last = new Int32Array(n), cost = new Float64Array(n);
  let members = 0, size = 0;
  clusters.forEach((c, i) => { members += c.contexts.length; size += c.freqs.length; ends[i] = members; fends[i] = size; bits[i] = c.bits; last[i] = c.last; cost[i] = c.cost; });
  const contexts = new Int32Array(members), freqs = new Uint32Array(size);
  clusters.forEach((c, i) => { contexts.set(c.contexts, i ? ends[i - 1] : 0); freqs.set(c.freqs, i ? fends[i - 1] : 0); });
  return {contexts, ends, freqs, fends, bits, last, cost};
}
const unpackClusters = ({contexts, ends, freqs, fends, bits, last, cost}) => Array.from(ends, (end, i) => ({
  contexts: Array.from(contexts.subarray(i ? ends[i - 1] : 0, end)), freqs: freqs.slice(i ? fends[i - 1] : 0, fends[i]), bits: bits[i], last: last[i], cost: cost[i]}));
function packContexts(contexts) {
  const ctx = new Int32Array(contexts.length), ends = new Int32Array(contexts.length);
  let size = 0;
  contexts.forEach((c, i) => { ctx[i] = c.ctx; size += c.sparse.length; ends[i] = size; });
  const runs = new Uint32Array(size);
  contexts.forEach((c, i) => runs.set(c.sparse, i ? ends[i - 1] : 0));
  return {ctx, ends, runs};
}
const unpackContexts = ({ctx, ends, runs}) => Array.from(ctx, (c, i) => ({ctx: c, sparse: Array.from(runs.subarray(i ? ends[i - 1] : 0, ends[i]))}));

function* refineClusters(clusters, contexts, maxClusters, symbolCosts, modelCost, passes = 2, switchCost = 0, kernel = null, numContexts = 8192, ready = () => {}) {
  const merges = yield* unit('merge', () => {
  ready(clusters);
  const length = clusters.length, pairs = kernel ? null : new Float64Array(length * length), merged = MERGED_SCRATCH;
  const price = (a, b) => mergedBits(clusters[a].freqs, clusters[b].freqs, Math.max(clusters[a].last, clusters[b].last)) - clusters[a].bits - clusters[b].bits;
  if (kernel) kernel.pairsInit(length);
  else for (let a = 0; a < length; a++) for (let b = a + 1; b < length; b++) pairs[a * length + b] = price(a, b);
  for (let remaining = length; remaining > 1; remaining--) {
    let left = -1, right = -1, best = Infinity;
    if (kernel) [left, right, best] = kernel.pairMin(length);
    else for (let a = 0; a < length; a++) if (clusters[a]) for (let b = a + 1; b < length; b++) if (clusters[b] && pairs[a * length + b] < best) {
      left = a; right = b; best = pairs[a * length + b];
    }
    const a = clusters[left], b = clusters[right];
    if (remaining <= maxClusters) {
      for (let s = 0; s < 64; s++) merged[s] = a.freqs[s] + b.freqs[s];
      if (a.cost < 0) a.cost = modelCost(a.freqs, CLUSTER_CONFIG);
      if (b.cost < 0) b.cost = modelCost(b.freqs, CLUSTER_CONFIG);
      if (modelCost(merged, CLUSTER_CONFIG) >= a.cost + b.cost) break;
    }
    a.contexts.push(...b.contexts); a.last = Math.max(a.last, b.last);
    for (let s = 0; s < a.freqs.length; s++) a.freqs[s] += b.freqs[s];
    a.bits = entropyBits(a.freqs); a.cost = -1; clusters[right] = null;
    if (kernel) { kernel.row(left, a.freqs, a.bits); kernel.alive(right, false); kernel.pairsUpdate(length, left); }
    else for (let i = 0; i < length; i++) if (clusters[i] && i !== left) pairs[Math.min(i, left) * length + Math.max(i, left)] = price(i, left);
  }
  clusters = clusters.filter(Boolean);
  return null;
  }, (typeof __RAPIER_JXL_UNSTEPPED__ !== 'undefined' && __RAPIER_JXL_UNSTEPPED__ === true) ? undefined : () => packClusters(clusters));
  if (!(typeof __RAPIER_JXL_UNSTEPPED__ !== 'undefined' && __RAPIER_JXL_UNSTEPPED__ === true) && merges !== null) clusters = unpackClusters(merges);
  const assignments = new Int32Array(numContexts).fill(-1);
  clusters.forEach((cluster, i) => { for (const ctx of cluster.contexts) assignments[ctx] = i; });
  let ordered = null;
  if (switchCost > 0) {
    const at = new Array(numContexts);
    for (const context of contexts) at[context.ctx] = context;
    ordered = [];
    for (let ctx = 0; ctx < numContexts; ctx++) if (at[ctx]) ordered.push(at[ctx]);
  }
  const flat = kernel && ordered ? kernel.flatten(ordered) : null;
  for (let pass = 0; pass < passes; pass++) {
    let changed = false;
    const saved = yield* carried('pass', () => {
    const costs = clusters.map(cluster => symbolCosts(cluster.freqs));
    const next = clusters.map(() => ({contexts: [], freqs: new Uint32Array(64), bits: 0, last: 0, cost: -1}));
    if (switchCost > 0) {
      const n = ordered.length, k = costs.length;
      let back, at = 0;
      if (flat) [at, back] = kernel.assign(flat, costs, switchCost);
      else {
        back = new Int16Array(n * k);
        let best = new Float64Array(k), next2 = new Float64Array(k);
        for (let t = 0; t < n; t++) {
          let low = Infinity, lowAt = 0;
          for (let i = 0; i < k; i++) if (best[i] < low) { low = best[i]; lowAt = i; }
          const {sparse} = ordered[t];
          for (let i = 0; i < k; i++) {
            const table = costs[i];
            let cost = 0;
            for (let at = 0; at < sparse.length; at += 2) cost += sparse[at + 1] * table[sparse[at]];
            const stay = t ? best[i] : 0, change = t ? low + switchCost : 0;
            if (stay <= change) { next2[i] = cost + stay; back[t * k + i] = i; } else { next2[i] = cost + change; back[t * k + i] = lowAt; }
          }
          [best, next2] = [next2, best];
        }
        for (let i = 1; i < k; i++) if (best[i] < best[at]) at = i;
      }
      for (let t = n - 1; t >= 0; t--) {
        const {ctx, sparse} = ordered[t], cluster = next[at];
        cluster.contexts.push(ctx);
        for (let j = 0; j < sparse.length; j += 2) cluster.freqs[sparse[j]] += sparse[j + 1];
        if (assignments[ctx] !== at) changed = true;
        at = back[t * k + at];
      }
    } else for (const {ctx, sparse} of contexts) {
      const before = assignments[ctx];
      let best = before, bestCost = Infinity;
      for (let i = -1; i < costs.length; i++) {
        const index = i < 0 ? before : i, table = costs[index];
        let cost = 0;
        for (let at = 0; at < sparse.length; at += 2) cost += sparse[at + 1] * table[sparse[at]];
        if (cost < bestCost) { best = index; bestCost = cost; }
      }
      const cluster = next[best];
      cluster.contexts.push(ctx);
      for (let at = 0; at < sparse.length; at += 2) cluster.freqs[sparse[at]] += sparse[at + 1];
      if (best !== before) changed = true;
    }
    clusters = next.filter(cluster => cluster.contexts.length);
    clusters.forEach((cluster, i) => {
      for (const ctx of cluster.contexts) assignments[ctx] = i;
    });
    return null;
    }, (typeof __RAPIER_JXL_UNSTEPPED__ !== 'undefined' && __RAPIER_JXL_UNSTEPPED__ === true) ? undefined : () => ({clusters: packClusters(clusters), assignments: assignments.slice(), changed}));
    if (saved === PASSED) continue;
    if (!(typeof __RAPIER_JXL_UNSTEPPED__ !== 'undefined' && __RAPIER_JXL_UNSTEPPED__ === true) && saved !== null) { clusters = unpackClusters(saved.clusters); assignments.set(saved.assignments); changed = saved.changed; }
    if (!changed) break;
  }
  return clusters;
}

export const clusterTokenCounts = (counts, options, modelCost, symbolCosts, shapedCost) => complete(clusterTokenCountsSteps(counts, options, modelCost, symbolCosts, shapedCost));
export const clusterTokenCountsSteps = (counts, options, modelCost, symbolCosts, shapedCost) => stage('cluster', () => clusterSteps(counts, options, modelCost, symbolCosts, shapedCost));
const SEED_CHUNK = 128;
function* clusterSteps(counts, {maxClusters = 48, newClusterCost = 320, seeds: seedCap = 96, passes, switchCost, everyConfig = false, shapedMerge = false, jpeg = null, kernels = null} = {}, modelCost, symbolCosts, shapedCost) {
  passes ??= symbolCosts ? 4 : 2; switchCost ??= symbolCosts ? 4 : 0;
  const kernel = kernels && (symbolCosts ? Math.min(seedCap, maxClusters * 2) : maxClusters) <= kernels.clusters ? kernels : null;
  const totals = counts.totals, size = counts.contexts, contexts = [];
  let n = 0;
  for (let ctx = 0; ctx < size; ctx++) if (totals[ctx] > 0) n++;
  const keys = new Float64Array(n);
  for (let ctx = 0, i = 0; ctx < size; ctx++) if (totals[ctx] > 0) keys[i++] = ctx - totals[ctx] * size;
  keys.sort();
  const used = new Array(n);
  for (let i = 0; i < n; i++) { const r = keys[i] % size; used[i] = r ? r + size : 0; }
  let clusters = [];
  const seeds = symbolCosts ? Math.min(seedCap, maxClusters * 2) : maxClusters;
  const ready = list => { if (kernel && kernel[LOADED] !== list) { list.forEach((c, i) => kernel.row(i, c.freqs, c.bits)); kernel[LOADED] = list; } };
  const state = (typeof __RAPIER_JXL_UNSTEPPED__ !== 'undefined' && __RAPIER_JXL_UNSTEPPED__ === true) ? undefined : () => ({clusters: packClusters(clusters), contexts: packContexts(contexts)});
  const restore = (typeof __RAPIER_JXL_UNSTEPPED__ !== 'undefined' && __RAPIER_JXL_UNSTEPPED__ === true) ? () => {} : saved => {
    if (saved === null || saved === PASSED) return;
    clusters = unpackClusters(saved.clusters); contexts.length = 0; contexts.push(...unpackContexts(saved.contexts));
  };
  if (kernel?.seedAll && used.length) restore(yield* unit('seeds', () => {
    const seeded = kernel.seedAll(used, counts, clusterTokenOf, seeds, newClusterCost / (symbolCosts ? 2 : 1));
    clusters = kernel[LOADED] = seeded.clusters;
    if (symbolCosts) {
      const {runs, offsets} = seeded;
      for (let t = 0; t < used.length; t++) contexts.push({ctx: used[t], sparse: runs.subarray(2 * offsets[t], 2 * offsets[t + 1])});
    }
    return null;
  }, state));
  else for (let from = 0; from < used.length; from += SEED_CHUNK) restore(yield* carried('seeds', () => {
  ready(clusters);
  for (let at = from; at < Math.min(used.length, from + SEED_CHUNK); at++) {
    const ctx = used[at];
    const own = counts.tokens([ctx], CLUSTER_CONFIG, 64), ownBits = entropyBits(own), last = kernel ? 0 : own.findLastIndex(Boolean) + 1;
    if (symbolCosts) {
      const sparse = [];
      for (let s = 0; s < own.length; s++) if (own[s]) sparse.push(s, own[s]);
      contexts.push({ctx, sparse});
    }
    let best = -1, bestIncrease = Infinity;
    if (kernel) { kernel.own(own); [best, bestIncrease] = kernel.seedBest(clusters.length, ownBits); }
    else for (let i = 0; i < clusters.length; i++) {
      const cluster = clusters[i], increase = mergedBits(cluster.freqs, own, Math.max(cluster.last, last)) - cluster.bits - ownBits;
      if (increase < bestIncrease) { bestIncrease = increase; best = i; }
    }
    if (best < 0 || (clusters.length < seeds && bestIncrease > newClusterCost / (symbolCosts ? 2 : 1))) {
      clusters.push({contexts: [ctx], freqs: own, bits: ownBits, last, cost: -1});
      kernel?.row(clusters.length - 1, own, ownBits);
    } else {
      const cluster = clusters[best];
      cluster.contexts.push(ctx); cluster.last = Math.max(cluster.last, last);
      for (let t = 0; t < 64; t++) cluster.freqs[t] += own[t];
      cluster.bits = entropyBits(cluster.freqs);
      kernel?.row(best, cluster.freqs, cluster.bits);
    }
  }
  if (kernel) kernel[LOADED] = clusters;
  return null;
  }, state));
  if (symbolCosts && clusters.length > 1) clusters = yield* refineClusters(clusters, contexts, maxClusters, symbolCosts, shapedMerge && shapedCost ? shapedCost : modelCost, passes, switchCost, kernel, counts.contexts, ready);
  return yield* unit('histograms', () => {
  if (!clusters.length) clusters.push({contexts: [], freqs: new Uint32Array(64), bits: 0, last: 0, cost: -1});
  const contextMap = new Uint8Array(counts.contexts);
  const histograms = clusters.map((cluster, index) => {
    for (const ctx of cluster.contexts) contextMap[ctx] = index;
    const aggregate = counts.aggregate(cluster.contexts);
    let config = CONFIGS[0], bestCost = Infinity, freqs, extra;
    const priced = [];
    const values = [], weights = [];
    for (let v = 0; v < 64; v++) if (aggregate.small[v]) { values.push(v); weights.push(aggregate.small[v]); }
    let top = values.length ? values[values.length - 1] : 0;
    if (aggregate.large[0]) for (const [v, n] of aggregate.large[0]) { values.push(v); weights.push(n); if (v > top) top = v; }
    const ansList = jpeg ? (top < (1 << 14) ? jpeg.configs : PHOTO_ANS_CONFIGS) : seedCap === 128 ? PHOTO_ANS_CONFIGS : ANS_CONFIGS;
    const priced0 = kernel?.priceConfigs && modelCost?.kernelTables && !everyConfig && top < (1 << 17) ? kernel.priceConfigs(values, weights, ansList, modelCost.kernelTables) : null;
    if (priced0 && !(jpeg && top >= 128)) return {config: ansList[priced0.index], freqs: priced0.tokens, extra: priced0.raw};
    const length = values.length, exponents = new Int32Array(length), mantissas = new Int32Array(length);
    for (let i = 0; i < length; i++) { const v = values[i]; if (v) { exponents[i] = floorLog2(v); mantissas[i] = v - (1 << exponents[i]); } }
    const split = (candidate, tokens) => {
      const {split, msb, lsb, splitToken} = candidate, both = msb + lsb, low = (1 << lsb) - 1;
      let raw = 0, last = 0;
      for (let i = 0; i < length; i++) {
        const v = values[i], w = weights[i];
        let token = v;
        if (v >= splitToken) {
          const n = exponents[i], m = mantissas[i];
          token = splitToken + (((n - split) << both) | ((m >> (n - msb)) << lsb) | (m & low));
          raw += w * (n - both);
        }
        tokens[token] += w;
        if (token > last) last = token;
      }
      return [raw, last];
    };
    if (priced0) return jpeg.high({config: ansList[priced0.index], freqs: priced0.tokens, extra: priced0.raw, cost: priced0.cost}, top, split, modelCost, shapedMerge && shapedCost);
    for (const candidate of modelCost ? ansList : CONFIGS) {
      const widest = top >= candidate.splitToken ? candidate.splitToken + (((floorLog2(top) - candidate.split) << (candidate.msb + candidate.lsb)) | ((1 << (candidate.msb + candidate.lsb)) - 1)) + 1 : 0;
      const tokens = new Uint32Array(Math.max(128, widest)), [raw] = split(candidate, tokens);
      const cost = raw + (modelCost ? modelCost(tokens, candidate) : entropyBits(tokens) + candidate.split * 18 + (candidate.msb + candidate.lsb) * 28);
      if (everyConfig) priced.push({candidate, tokens, raw, cost});
      if (cost < bestCost) { bestCost = cost; config = candidate; freqs = tokens; extra = raw; }
    }
    if (everyConfig) {
      const usual = priced.find(p => p.candidate === config);
      const more = [], seen = new Set(priced.map(p => histogramKey(p.tokens, p.tokens.findLastIndex(Boolean) + 1, p.raw)));
      let largest = 0, direct = false;
      for (const v of values) if (v > largest) largest = v;
      for (const candidate of MORE_CONFIGS) {
        if (candidate.splitToken > largest) { if (direct) continue; direct = true; }
        const tokens = MORE_TOKENS, [raw, last] = split(candidate, tokens);
        const key = last > 255 ? 0 : histogramKey(tokens, last + 1, raw);
        if (last > 255 || seen.has(key)) { tokens.fill(0, 0, last + 1); continue; }
        seen.add(key);
        const used = tokens.slice(0, last + 1);
        tokens.fill(0, 0, last + 1);
        more.push({candidate, tokens: used, raw, rough: raw + entropyBits(used)});
      }
      more.sort((a, b) => a.rough - b.rough);
      for (const p of more.slice(0, 6)) { p.cost = p.raw + modelCost(p.tokens, p.candidate); priced.push(p); }
      const finalists = priced.sort((a, b) => a.cost - b.cost).slice(0, 4);
      if (!finalists.includes(usual)) finalists.push(usual);
      bestCost = Infinity;
      for (const p of finalists) {
        const cost = p.raw + shapedCost(p.tokens, p.candidate);
        if (cost < bestCost) { bestCost = cost; config = p.candidate; freqs = p.tokens; extra = p.raw; }
      }
    }
    return {config, freqs, extra};
  });
  if (symbolCosts) {
    let first = 0;
    while (first < counts.contexts && !counts.totals[first]) first++;
    for (let ctx = 0; ctx < counts.contexts; ctx++) if (!counts.totals[ctx]) contextMap[ctx] = ctx < first ? contextMap[first] : contextMap[ctx - 1];
    const order = new Int16Array(histograms.length).fill(-1);
    let next = 0;
    for (const id of contextMap) if (order[id] < 0) order[id] = next++;
    for (let id = 0; id < order.length; id++) if (order[id] < 0) order[id] = next++;
    const renumbered = new Array(histograms.length);
    histograms.forEach((h, id) => { renumbered[order[id]] = h; });
    for (let ctx = 0; ctx < contextMap.length; ctx++) contextMap[ctx] = order[contextMap[ctx]];
    return {contextMap, histograms: renumbered};
  }
  for (let left = 0; left + 1 < counts.contexts;) {
    if (!counts.totals[left]) { left++; continue; }
    let right = left + 1;
    while (right < counts.contexts && !counts.totals[right]) right++;
    if (right < counts.contexts && contextMap[left] === contextMap[right]) contextMap.fill(contextMap[left], left + 1, right);
    left = right;
  }
  return {contextMap, histograms};
  });
}

export function prefixGroupWriter({contextMap, histograms}) {
  const token = [0, 0, 0], lengths = new Int8Array(histograms.length * 64), bits = new Int32Array(histograms.length * 64);
  histograms.forEach(({code, config}, h) => {
    for (let v = 0; v < 64; v++) {
      hybridToken(config, v, token);
      const n = code.lengths[token[0]], total = n + token[1], at = h * 64 + v;
      if (n === undefined || total > 24) { lengths[at] = -1; continue; }
      lengths[at] = total; bits[at] = code.codes[token[0]] | token[2] << n;
    }
  });
  const write = (w, ctx, value) => {
    const h = contextMap[ctx];
    if (value >= 0 && value < 64) { const at = h * 64 + value, n = lengths[at]; if (n >= 0) { w.write(n, bits[at]); return; } }
    const histogram = histograms[h];
    writeHybrid(w, histogram.code, histogram.config, value);
  };
  return {write, writeTokens(w, ctxs, values, n) {
    for (let i = 0; i < n; i++) {
      const h = contextMap[ctxs[i]], value = values[i];
      if (value >= 0 && value < 64) {
        const at = h * 64 + value, length = lengths[at];
        if (length >= 0) { w.write(length, bits[at]); continue; }
      }
      const histogram = histograms[h];
      writeHybrid(w, histogram.code, histogram.config, value);
    }
  }};
}

export function buildTokenCoding(counts, options) {
  const {contextMap, histograms} = clusterTokenCounts(counts, options);
  let bits = 0;
  for (const histogram of histograms) {
    const {freqs, extra} = histogram, code = histogram.code = buildCode(freqs);
    bits += extra;
    for (let s = 0; s < freqs.length; s++) if (freqs[s]) bits += freqs[s] * code.lengths[s];
  }
  const header = new BitWriter();
  writeHistograms(header, {contextMap, histograms});
  bits += header.bitLength;
  const model = {kind: 'prefix', contextMap, histograms: histograms.map(({config, code}) => ({config, code}))};
  const bare = (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) && !options?.strategy;
  const {write, writeTokens} = bare ? {} : prefixGroupWriter(model), writeFilled = bare ? undefined : (options?.kernels?.prefixFilled?.(model) || undefined);
  return {contextMap, histograms, model, write, writeTokens, writeFilled, bits, writeHistograms: w => w.append(header)};
}
