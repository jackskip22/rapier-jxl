// Rapier's JPEG XL encoder: token coding over many contexts. MIT (images/jxl/LICENSE).
import {buildCode, uintConfig, hybridToken, writeHybrid, writeHistograms} from './prefix.mjs';
import {BitWriter, floorLog2} from './bits.mjs';

const CONFIGS = [uintConfig(0), uintConfig(1), uintConfig(2), uintConfig(3), uintConfig(4), uintConfig(4, 1, 1), uintConfig(4, 2, 0), uintConfig(4, 1, 2), uintConfig(5, 1, 1), uintConfig(2, 0, 1), uintConfig(3, 0, 1)];
const ANS_CONFIGS = [...CONFIGS, uintConfig(3, 1, 0), uintConfig(4, 0, 1), uintConfig(4, 1, 0), uintConfig(4, 2, 1), uintConfig(5, 1, 0), uintConfig(5, 2, 0), uintConfig(5, 2, 1)];
const CLUSTER_CONFIG = uintConfig(4, 1, 1);
const MORE_CONFIGS = [], MORE_TOKENS = new Uint32Array(2048);
for (let split = 0; split <= 7; split++) for (let msb = 0; msb <= split; msb++) for (let lsb = 0; msb + lsb <= split; lsb++) {
  if (!ANS_CONFIGS.some(c => c.split === split && c.msb === msb && c.lsb === lsb)) MORE_CONFIGS.push(uintConfig(split, msb, lsb));
}

function histogramKey(tokens, length, raw) {
  let a = raw >>> 0, b = length;
  for (let i = 0; i < length; i++) { a = Math.imul(a ^ tokens[i], 0x9e3779b1); b = Math.imul(b + tokens[i], 0x85ebca77) ^ (a >>> 15); }
  return (a >>> 0) * 4294967296 + (b >>> 0);
}

export class TokenCounts {
  constructor(contexts) { this.contexts = contexts; this.small = new Uint32Array(contexts * 64); this.large = Array.from({length: contexts}, () => null); this.totals = new Float64Array(contexts); }
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
    for (const ctx of contexts) {
      result.totals[0] += this.totals[ctx];
      for (let v = 0; v < 64; v++) result.small[v] += this.small[ctx * 64 + v];
      if (this.large[ctx]) {
        const target = result.large[0] || (result.large[0] = new Map());
        for (const [v, n] of this.large[ctx]) target.set(v, (target.get(v) || 0) + n);
      }
    }
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

const HALVES = [1];
for (let e = 1; e < 32; e++) HALVES.push(HALVES[e - 1] / 2);
export function entropyLog2(x) {
  let exponent = 0;
  if (x >= 2 && x < 4294967296) { exponent = 31 - Math.clz32(x); x *= HALVES[exponent]; }
  while (x >= 1.4142135623730951) { x /= 2; exponent++; }
  while (x < 0.7071067811865476) { x *= 2; exponent--; }
  const z = (x - 1) / (x + 1), z2 = z * z;
  let term = z, sum = z;
  for (let k = 3; k < 30; k += 2) sum += (term *= z2) / k;
  return exponent + sum * 2.885390081777927;
}

const NLOG2 = new Float64Array(65536);
export const populationBits = n => n < 2 ? 0 : n < NLOG2.length
  ? NLOG2[n] || (NLOG2[n] = n * entropyLog2(n)) : n * entropyLog2(n);
function entropyBits(freqs) {
  let total = 0, bits = 0;
  for (const f of freqs) if (f) { total += f; bits -= populationBits(f); }
  return bits + populationBits(total);
}

function mergedBits(a, b) {
  let total = 0, bits = 0;
  for (let s = 0; s < a.length; s++) { const n = a[s] + b[s]; if (n) { total += n; bits -= populationBits(n); } }
  return bits + populationBits(total);
}

function refineClusters(clusters, contexts, maxClusters, symbolCosts, modelCost, passes = 2, switchCost = 0) {
  const length = clusters.length, pairs = new Float64Array(length * length);
  const price = (a, b) => mergedBits(clusters[a].freqs, clusters[b].freqs) - clusters[a].bits - clusters[b].bits;
  for (let a = 0; a < length; a++) for (let b = a + 1; b < length; b++) pairs[a * length + b] = price(a, b);
  for (let remaining = length; remaining > 1; remaining--) {
    let left = -1, right = -1, best = Infinity;
    for (let a = 0; a < length; a++) if (clusters[a]) for (let b = a + 1; b < length; b++) if (clusters[b] && pairs[a * length + b] < best) {
      left = a; right = b; best = pairs[a * length + b];
    }
    const a = clusters[left], b = clusters[right];
    if (remaining <= maxClusters) {
      const merged = new Uint32Array(64);
      for (let s = 0; s < 64; s++) merged[s] = a.freqs[s] + b.freqs[s];
      a.cost ??= modelCost(a.freqs, CLUSTER_CONFIG); b.cost ??= modelCost(b.freqs, CLUSTER_CONFIG);
      if (modelCost(merged, CLUSTER_CONFIG) >= a.cost + b.cost) break;
    }
    a.contexts.push(...b.contexts);
    for (let s = 0; s < a.freqs.length; s++) a.freqs[s] += b.freqs[s];
    a.bits = entropyBits(a.freqs); a.cost = undefined; clusters[right] = null;
    for (let i = 0; i < length; i++) if (clusters[i] && i !== left) pairs[Math.min(i, left) * length + Math.max(i, left)] = price(i, left);
  }
  clusters = clusters.filter(Boolean);
  const assignments = new Map();
  clusters.forEach((cluster, i) => { for (const ctx of cluster.contexts) assignments.set(ctx, i); });
  for (let pass = 0; pass < passes; pass++) {
    const costs = clusters.map(cluster => symbolCosts(cluster.freqs));
    const next = clusters.map(() => ({contexts: [], freqs: new Uint32Array(64), bits: 0}));
    let changed = false;
    if (switchCost > 0) {
      const ordered = [...contexts].sort((a, b) => a.ctx - b.ctx), n = ordered.length, k = costs.length;
      const back = new Int16Array(n * k);
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
      let at = 0;
      for (let i = 1; i < k; i++) if (best[i] < best[at]) at = i;
      for (let t = n - 1; t >= 0; t--) {
        const {ctx, sparse} = ordered[t], cluster = next[at];
        cluster.contexts.push(ctx);
        for (let j = 0; j < sparse.length; j += 2) cluster.freqs[sparse[j]] += sparse[j + 1];
        if (assignments.get(ctx) !== at) changed = true;
        at = back[t * k + at];
      }
    } else for (const {ctx, sparse} of contexts) {
      const before = assignments.get(ctx);
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
      cluster.bits = entropyBits(cluster.freqs);
      for (const ctx of cluster.contexts) assignments.set(ctx, i);
    });
    if (!changed) break;
  }
  return clusters;
}

export function clusterTokenCounts(counts, {maxClusters = 48, newClusterCost = 320, seeds: seedCap = 96, passes, switchCost, everyConfig = false} = {}, modelCost, symbolCosts, shapedCost) {
  passes ??= symbolCosts ? 4 : 2; switchCost ??= symbolCosts ? 4 : 0;
  const used = [], contexts = [];
  for (let ctx = 0; ctx < counts.contexts; ctx++) if (counts.totals[ctx] > 0) used.push(ctx);
  used.sort((a, b) => counts.totals[b] - counts.totals[a]);
  let clusters = [];
  const seeds = symbolCosts ? Math.min(seedCap, maxClusters * 2) : maxClusters;
  for (const ctx of used) {
    const own = counts.tokens([ctx], CLUSTER_CONFIG, 64), ownBits = entropyBits(own);
    if (symbolCosts) {
      const sparse = [];
      for (let s = 0; s < own.length; s++) if (own[s]) sparse.push(s, own[s]);
      contexts.push({ctx, sparse});
    }
    let best = -1, bestIncrease = Infinity;
    for (let i = 0; i < clusters.length; i++) {
      const cluster = clusters[i], increase = mergedBits(cluster.freqs, own) - cluster.bits - ownBits;
      if (increase < bestIncrease) { bestIncrease = increase; best = i; }
    }
    if (best < 0 || (clusters.length < seeds && bestIncrease > newClusterCost / (symbolCosts ? 2 : 1))) clusters.push({contexts: [ctx], freqs: own, bits: ownBits});
    else {
      const cluster = clusters[best];
      cluster.contexts.push(ctx);
      for (let t = 0; t < 64; t++) cluster.freqs[t] += own[t];
      cluster.bits = entropyBits(cluster.freqs);
    }
  }
  if (symbolCosts && clusters.length > 1) clusters = refineClusters(clusters, contexts, maxClusters, symbolCosts, modelCost, passes, switchCost);
  if (!clusters.length) clusters.push({contexts: [], freqs: new Uint32Array(64), bits: 0});
  const contextMap = new Uint8Array(counts.contexts);
  const histograms = clusters.map((cluster, index) => {
    for (const ctx of cluster.contexts) contextMap[ctx] = index;
    const aggregate = counts.aggregate(cluster.contexts);
    let config = CONFIGS[0], bestCost = Infinity, freqs, extra;
    const priced = [];
    for (const candidate of modelCost ? ANS_CONFIGS : CONFIGS) {
      const tokens = aggregate.tokens([0], candidate), raw = aggregate.rawBits([0], candidate);
      const cost = raw + (modelCost ? modelCost(tokens, candidate) : entropyBits(tokens) + candidate.split * 18 + (candidate.msb + candidate.lsb) * 28);
      if (everyConfig) priced.push({candidate, tokens, raw, cost});
      if (cost < bestCost) { bestCost = cost; config = candidate; freqs = tokens; extra = raw; }
    }
    if (everyConfig) {
      const usual = priced.find(p => p.candidate === config), values = [], weights = [];
      for (let v = 0; v < 64; v++) if (aggregate.small[v]) { values.push(v); weights.push(aggregate.small[v]); }
      if (aggregate.large[0]) for (const [v, n] of aggregate.large[0]) { values.push(v); weights.push(n); }
      const more = [], seen = new Set(priced.map(p => histogramKey(p.tokens, p.tokens.findLastIndex(Boolean) + 1, p.raw)));
      let largest = 0, direct = false;
      const length = values.length, exponents = new Int32Array(length), mantissas = new Int32Array(length);
      for (let i = 0; i < length; i++) {
        const v = values[i];
        if (v > largest) largest = v;
        if (v) { exponents[i] = floorLog2(v); mantissas[i] = v - (1 << exponents[i]); }
      }
      for (const candidate of MORE_CONFIGS) {
        if (candidate.splitToken > largest) { if (direct) continue; direct = true; }
        const {split, msb, lsb, splitToken} = candidate, both = msb + lsb, low = (1 << lsb) - 1, tokens = MORE_TOKENS;
        let last = 0, raw = 0;
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
}

export function prefixGroupWriter({contextMap, histograms}) {
  const token = [0, 0, 0], tables = histograms.map(({code, config}) => {
    const lengths = new Int8Array(64), bits = new Int32Array(64);
    for (let v = 0; v < 64; v++) {
      hybridToken(config, v, token);
      const n = code.lengths[token[0]], total = n + token[1];
      if (n === undefined || total > 24) { lengths[v] = -1; continue; }
      lengths[v] = total; bits[v] = code.codes[token[0]] | token[2] << n;
    }
    return {lengths, bits};
  });
  const write = (w, ctx, value) => {
    const h = contextMap[ctx];
    if (value < 64) { const table = tables[h], n = table.lengths[value]; if (n >= 0) { w.write(n, table.bits[value]); return; } }
    const histogram = histograms[h];
    writeHybrid(w, histogram.code, histogram.config, value);
  };
  return {write, writeTokens(w, ctxs, values, n) { for (let i = 0; i < n; i++) write(w, ctxs[i], values[i]); }};
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
  const {write, writeTokens} = prefixGroupWriter(model);
  return {contextMap, histograms, model, write, writeTokens, bits};
}
