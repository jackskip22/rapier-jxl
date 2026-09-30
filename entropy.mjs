// Rapier's JPEG XL encoder: token coding over many contexts. MIT (LICENSE).
// The AC coefficients of a VarDCT frame are coded in hundreds of contexts; the contexts are clustered into a few
// dozen histograms by greedy merging (the cheapest entropy increase first), each histogram takes the hybrid
// integer split that costs least on its own values, and a prefix code is built per histogram.
import {buildCode, uintConfig, hybridToken} from './prefix.mjs';
import {floorLog2} from './bits.mjs';

const CONFIGS = [uintConfig(0), uintConfig(1), uintConfig(2), uintConfig(3), uintConfig(4), uintConfig(4, 1, 1), uintConfig(5, 1, 1), uintConfig(2, 0, 1), uintConfig(3, 0, 1)];
const CLUSTER_CONFIG = uintConfig(4, 1, 1);

// Value counts per context: values below 64 in a table, larger ones in a map per context.
export class TokenCounts {
  constructor(contexts) { this.contexts = contexts; this.small = new Uint32Array(contexts * 64); this.large = Array.from({length: contexts}, () => null); this.totals = new Float64Array(contexts); }
  add(ctx, value) {
    this.totals[ctx]++;
    if (value < 64) { this.small[ctx * 64 + value]++; return; }
    const map = this.large[ctx] || (this.large[ctx] = new Map());
    map.set(value, (map.get(value) || 0) + 1);
  }
  // Token histogram of a set of contexts under a configuration.
  tokens(contexts, config, size = 64) {
    const freqs = new Uint32Array(size);
    for (const ctx of contexts) {
      const base = ctx * 64;
      for (let v = 0; v < 64; v++) if (this.small[base + v]) freqs[hybridTokenOf(config, v)] += this.small[base + v];
      const map = this.large[ctx];
      if (map) for (const [v, n] of map) freqs[hybridTokenOf(config, v)] += n;
    }
    return freqs;
  }
  // The bits a set of contexts costs under a configuration: token entropy plus the raw bits.
  cost(contexts, config) {
    const freqs = this.tokens(contexts, config);
    let total = 0, bits = 0;
    for (const f of freqs) total += f;
    for (const f of freqs) if (f) bits += f * Math.log2(total / f);
    for (const ctx of contexts) {
      const base = ctx * 64;
      for (let v = config.splitToken; v < 64; v++) if (this.small[base + v]) bits += this.small[base + v] * (floorLog2(v) - config.msb - config.lsb);
      const map = this.large[ctx];
      if (map) for (const [v, n] of map) bits += n * (floorLog2(v) - config.msb - config.lsb);
    }
    return bits;
  }
}

const slots = [0, 0, 0];
function hybridTokenOf(config, value) { hybridToken(config, value, slots); return slots[0]; }

function entropyBits(freqs) {
  let total = 0, bits = 0;
  for (const f of freqs) total += f;
  for (const f of freqs) if (f) bits += f * Math.log2(total / f);
  return bits;
}

// Clusters the used contexts (unused ones join cluster 0) and builds one prefix code per cluster. Returns the
// context map and histograms for writeHistograms, and a writer for tokens.
export function buildTokenCoding(counts, {maxClusters = 48, newClusterCost = 320} = {}) {
  const used = [];
  for (let ctx = 0; ctx < counts.contexts; ctx++) if (counts.totals[ctx] > 0) used.push(ctx);
  used.sort((a, b) => counts.totals[b] - counts.totals[a]);
  const clusters = [];  // {contexts, freqs, bits}
  for (const ctx of used) {
    const own = counts.tokens([ctx], CLUSTER_CONFIG), ownBits = entropyBits(own);
    let best = -1, bestIncrease = Infinity;
    for (let i = 0; i < clusters.length; i++) {
      const cluster = clusters[i], merged = new Uint32Array(64);
      for (let t = 0; t < 64; t++) merged[t] = cluster.freqs[t] + own[t];
      const increase = entropyBits(merged) - cluster.bits - ownBits;
      if (increase < bestIncrease) { bestIncrease = increase; best = i; }
    }
    if (best < 0 || (clusters.length < maxClusters && bestIncrease > newClusterCost)) clusters.push({contexts: [ctx], freqs: own, bits: ownBits});
    else {
      const cluster = clusters[best];
      cluster.contexts.push(ctx);
      for (let t = 0; t < 64; t++) cluster.freqs[t] += own[t];
      cluster.bits = entropyBits(cluster.freqs);
    }
  }
  if (!clusters.length) clusters.push({contexts: [], freqs: new Uint32Array(64), bits: 0});
  const contextMap = new Uint8Array(counts.contexts);
  let bits = counts.contexts * 2;  // the context map's entries, roughly
  const histograms = clusters.map((cluster, index) => {
    for (const ctx of cluster.contexts) contextMap[ctx] = index;
    let config = CONFIGS[0], bestCost = Infinity;
    for (const candidate of CONFIGS) { const cost = counts.cost(cluster.contexts, candidate); if (cost < bestCost) { bestCost = cost; config = candidate; } }
    const code = buildCode(counts.tokens(cluster.contexts, config, 128));
    bits += bestCost + code.alphabetSize * 3 + 40;
    return {config, code};
  });
  const write = (w, ctx, value) => {
    const histogram = histograms[contextMap[ctx]];
    hybridToken(histogram.config, value, slots);
    w.write(histogram.code.lengths[slots[0]], histogram.code.codes[slots[0]]);
    if (slots[1]) w.write(slots[1], slots[2]);
  };
  return {contextMap, histograms, write, bits};
}
