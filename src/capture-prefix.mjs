// SPDX-License-Identifier: MIT
import {buildCode, uintConfig, hybridToken, writeHistograms} from './prefix.mjs';
import {exactLog} from './exact-math.mjs';
import {fault} from './fault.mjs';

const CONFIGS = [uintConfig(0), uintConfig(1), uintConfig(2), uintConfig(3), uintConfig(4),
  uintConfig(4, 1, 1), uintConfig(4, 2, 0), uintConfig(4, 1, 2), uintConfig(5, 1, 1),
  uintConfig(2, 0, 1), uintConfig(3, 0, 1)];
const CLUSTER_CONFIG = CONFIGS[5], UINT32_MAX = 0xffffffff, MAX_CONTEXTS = 8192;
const CLUSTER_TOKENS = 128, POPULATIONS = new Float64Array(1024), LOG2_E = 1.4426950408889634;
const population = n => n < 2 ? 0 : n < POPULATIONS.length
  ? POPULATIONS[n] || (POPULATIONS[n] = n * exactLog(n) * LOG2_E) : n * exactLog(n) * LOG2_E;
function entropy(a, pops, b, total, end) {
  let bits = 0;
  for (let i = 0; i < end; i++) if (a[i] | b[i]) bits -= b[i] ? population(a[i] + b[i]) : pops[i];
  return bits + population(total);
}
const sequence = values => Array.isArray(values) || ArrayBuffer.isView(values) && !(values instanceof DataView);
function admitGroup(ctxs, values, n) {
  if (!sequence(ctxs) || !sequence(values) || !Number.isInteger(n) || n < 0 ||
      n > UINT32_MAX || n > ctxs.length || n > values.length)
    throw fault('JXL_INPUT', 'Token groups need matching sequences and a bounded count.');
}
const unsigned = values => values instanceof Uint32Array || values instanceof Uint16Array || values instanceof Uint8Array;
const outside = (ctxs, n, contexts) => { for (let i = 0; i < n; i++) if (ctxs[i] >= contexts) return true; return false; };
function admitToken(contexts, ctx, value) {
  if (!Number.isInteger(ctx) || ctx < 0 || ctx >= contexts ||
      !Number.isInteger(value) || value < 0 || value > UINT32_MAX)
    throw fault('JXL_INPUT', 'A token needs an admitted context and a uint32 value.');
}

function countPrefixTokens(ctxs, values, n, totals, small, large) {
  for (let i = 0; i < n; i++) {
    const ctx = ctxs[i], value = values[i];
    totals[ctx]++;
    if (value < 64) small[ctx * 64 + value]++;
    else { const map = large[ctx] || (large[ctx] = new Map()); map.set(value, (map.get(value) || 0) + 1); }
  }
}
export function buildCaptureTokenCoding(numContexts, groups, kernels = null, split = 240, most = 32) {
  if (!Number.isInteger(numContexts) || numContexts < 1 || numContexts > MAX_CONTEXTS ||
      typeof groups?.[Symbol.iterator] !== 'function')
    throw fault('JXL_INPUT', 'Token coding takes 1 to 8192 contexts and a synchronous iterable.');
  const small = new Uint32Array(numContexts * 64), large = new Array(numContexts), totals = new Uint32Array(numContexts);
  const counting = !!kernels?.begin(numContexts);
  let total = 0;
  for (const group of groups) {
    if (!group) throw fault('JXL_INPUT', 'A capture token group is required.');
    const {ctxs, values, n} = group;
    admitGroup(ctxs, values, n);
    total += n;
    if (total > UINT32_MAX) throw fault('JXL_LIMIT', 'Token counts exceed uint32.');
    const typed = unsigned(ctxs) && unsigned(values);
    if (typed && counting && kernels.count(group, totals, large)) continue;
    if (typed && outside(ctxs, n, numContexts)) admitToken(numContexts, numContexts, 0);
    if (!typed) for (let i = 0; i < n; i++) admitToken(numContexts, ctxs[i], values[i]);
    countPrefixTokens(ctxs, values, n, totals, small, large);
  }
  if (counting) kernels.end(small, totals);
  const used = [], slots = [0, 0, 0];
  for (let ctx = 0; ctx < numContexts; ctx++) if (totals[ctx]) used.push(ctx);
  used.sort((a, b) => totals[b] - totals[a] || a - b);
  const clusters = [], own = new Uint32Array(CLUSTER_TOKENS), none = new Uint32Array(CLUSTER_TOKENS);
  const tokensOf = (ctx, into) => {
    const base = ctx * 64;
    for (let value = 0; value < 64; value++) if (small[base + value]) { hybridToken(CLUSTER_CONFIG, value, slots); into[slots[0]] += small[base + value]; }
    if (large[ctx]) for (const [value, count] of large[ctx]) { hybridToken(CLUSTER_CONFIG, value, slots); into[slots[0]] += count; }
    let end = CLUSTER_TOKENS;
    while (end && !into[end - 1]) end--;
    return end;
  };
  const placed = counting ? kernels.clusters(used.length, (owns, ends, sums) => used.forEach((ctx, i) => {
    ends[i] = tokensOf(ctx, owns.subarray(i * CLUSTER_TOKENS, (i + 1) * CLUSTER_TOKENS)); sums[i] = totals[ctx];
  }), split, most) : null;
  if (placed) {
    for (let k = 0; k < placed.count; k++) clusters.push({contexts: []});
    used.forEach((ctx, i) => clusters[placed.of[i]].contexts.push(ctx));
  }
  else for (const ctx of used) {
    const total = totals[ctx], end = tokensOf(ctx, own);
    const ownBits = entropy(none, none, own, total, end);
    let best = -1, increase = Infinity, merged = 0;
    for (let i = 0; i < clusters.length; i++) {
      const {freqs, pops, total: sum, bits, end: top} = clusters[i], joined = entropy(freqs, pops, own, sum + total, Math.max(top, end)), next = joined - bits - ownBits;
      if (next < increase) { increase = next; best = i; merged = joined; }
    }
    if (best < 0 || clusters.length < most && increase > split)
      clusters.push({contexts: [ctx], freqs: Uint32Array.from(own), pops: Float64Array.from(own, population), total, bits: ownBits, end});
    else {
      const cluster = clusters[best]; cluster.contexts.push(ctx); cluster.total += total; cluster.bits = merged; cluster.end = Math.max(cluster.end, end);
      for (let s = 0; s < CLUSTER_TOKENS; s++) if (own[s]) cluster.pops[s] = population(cluster.freqs[s] += own[s]);
    }
    own.fill(0, 0, end);
  }
  if (!clusters.length) clusters.push({contexts: [], freqs: new Uint32Array(CLUSTER_TOKENS), bits: 0});
  const contextMap = new Uint8Array(numContexts), singleContext = new Uint8Array(1);
  const histograms = clusters.map((cluster, index) => {
    const values = new Map();
    for (const ctx of cluster.contexts) {
      contextMap[ctx] = index;
      for (let value = 0; value < 64; value++) {
        const count = small[ctx * 64 + value]; if (count) values.set(value, (values.get(value) || 0) + count);
      }
      if (large[ctx]) for (const [value, count] of large[ctx]) values.set(value, (values.get(value) || 0) + count);
    }
    let chosen, cost = Infinity;
    for (const config of CONFIGS) {
      const freqs = new Uint32Array(256);
      let raw = 0;
      for (const [value, count] of values) {
        hybridToken(config, value, slots); freqs[slots[0]] += count; raw += count * slots[1];
      }
      const code = buildCode(freqs), histogram = {config, freqs, code};
      const header = {bitLength: 0, write(count) { this.bitLength += count; }};
      writeHistograms(header, {contextMap: singleContext, histograms: [histogram]});
      let bits = raw + header.bitLength;
      for (let token = 0; token < code.lengths.length; token++) bits += freqs[token] * code.lengths[token];
      if (bits < cost) { cost = bits; chosen = histogram; }
    }
    return chosen;
  });
  for (let left = 0; left + 1 < numContexts;) {
    if (!totals[left]) { left++; continue; }
    let right = left + 1;
    while (right < numContexts && !totals[right]) right++;
    if (right < numContexts && contextMap[left] === contextMap[right]) contextMap.fill(contextMap[left], left + 1, right);
    left = right;
  }
  const lengths = new Int8Array(histograms.length * 64).fill(-1), bits = new Uint32Array(histograms.length * 64);
  histograms.forEach(({code, config, freqs}, h) => {
    for (let value = 0; value < 64; value++) {
      hybridToken(config, value, slots);
      const n = code.lengths[slots[0]], count = n + slots[1], at = h * 64 + value;
      if (freqs[slots[0]] && count <= 24) {
        lengths[at] = count; bits[at] = code.codes[slots[0]] | slots[2] << n;
      }
    }
  });
  const coding = {
    contextMap, configs: histograms.map(h => h.config), kernels: counting ? kernels : null,
    writeHistograms: writer => writeHistograms(writer, {contextMap, histograms}),
    writeTokens(writer, ctxs, values, n) {
      admitGroup(ctxs, values, n);
      if (counting && unsigned(ctxs) && unsigned(values) && kernels.tables(coding, contextMap, coding.configs, {lengths, bits, histograms}) &&
          kernels.write(writer, {ctxs, values, n}, false)) return;
      const typed = unsigned(ctxs) && unsigned(values);
      if (typed && outside(ctxs, n, numContexts)) admitToken(numContexts, numContexts, 0);
      for (let i = 0; i < n; i++) {
        const ctx = ctxs[i], value = values[i]; if (!typed) admitToken(numContexts, ctx, value);
        const h = contextMap[ctx], at = h * 64 + value;
        if (value < 64 && lengths[at] >= 0) { writer.write(lengths[at], bits[at]); continue; }
        const {code, config, freqs} = histograms[h]; hybridToken(config, value, slots);
        if (!freqs[slots[0]]) throw fault('JXL_INPUT', 'The capture token was not admitted by this Prefix model.');
        writer.write(code.lengths[slots[0]], code.codes[slots[0]]);
        if (slots[1]) writer.write(slots[1], slots[2]);
      }
    },
  };
  return coding;
}
