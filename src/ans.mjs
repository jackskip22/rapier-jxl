// SPDX-License-Identifier: MIT
import {BitWriter, ceilLog2} from './bits.mjs';
import {hybridToken, writeContextMap, writeUintConfig} from './prefix.mjs';
import {TokenCounts, clusterTokenCounts} from './entropy.mjs';
import {LZ77, RESIDUAL_CONFIG} from './modular.mjs';
import {writeSmallestContextMap} from './context-map.mjs';
import {GROUP_TOKENS} from './frame.mjs';
import {LOG_CODES, LOG_LENGTHS, SYMBOL_BITS, distributionLength, expectedDataBits, normalise, reverseAlias, shapeHistogram, writeDistribution} from './ans-core.mjs';
export {LOG_LENGTHS, LOG_CODES, shapeHistogram, reverseAlias};

class BitCount {
  constructor() { this.bitLength = 0; }
  write(n) { this.bitLength += n; }
}

function histogramCost(freqs, config) {
  const counts = normalise(freqs), header = new BitCount();
  writeUintConfig(header, config, Math.max(5, ceilLog2(counts.length)));
  return header.bitLength + distributionLength(counts, true) + expectedDataBits(freqs, counts);
}

histogramCost.kernelTables = {symbolBits: SYMBOL_BITS, logLengths: Uint8Array.from(LOG_LENGTHS)};

function symbolCosts(freqs) {
  const counts = normalise(freqs), costs = new Float64Array(freqs.length).fill(12);
  for (let s = 0; s < counts.length; s++) if (counts[s]) costs[s] = SYMBOL_BITS[counts[s]];
  return costs;
}

export function ansGroupWriter({contextMap, histograms}) {
  const values = new Uint32Array(GROUP_TOKENS), metadata = new Uint8Array(GROUP_TOKENS), emitted = new Uint16Array(GROUP_TOKENS);
  const slots = [0, 0, 0];
  const small = new Int32Array(histograms.length * 64), freqs = new Int32Array(histograms.length * 64), starts = new Int32Array(histograms.length * 64);
  histograms.forEach((h, id) => {
    for (let v = 0; v < 64; v++) {
      hybridToken(h.config, v, slots);
      small[id * 64 + v] = slots[1] << 6 | slots[2]; freqs[id * 64 + v] = h.counts[slots[0]]; starts[id * 64 + v] = h.starts[slots[0]];
    }
  });
  const g = {values, metadata, emitted, slots, small, freqs, starts, histograms, contextMap, reverses: histograms.map(h => h.reverse), length: 0};
  return {write: (_w, ctx, value) => ansWrite(g, ctx, value), writeTokens: (_w, ctxs, tokens, n) => ansWriteTokens(g, ctxs, tokens, n),
    flush: w => ansFlush(g, w), reset: () => { g.length = 0; }};
}
function ansWrite(g, ctx, value) {
  g.values[g.length] = value; g.metadata[g.length++] = g.contextMap[ctx];
}
function ansWriteTokens(g, ctxs, tokens, n) {
  const {values, metadata, contextMap} = g;
  let length = g.length;
  for (let i = 0; i < n; i++) { values[length] = tokens[i]; metadata[length++] = contextMap[ctxs[i]]; }
  g.length = length;
}
function ansFlush(g, w) {
  const {values, metadata, emitted, slots, small, freqs, starts, histograms, reverses, length} = g;
  let state = 0x13 * 65536;
  for (let i = length - 1; i >= 0; i--) {
    const id = metadata[i], value = values[i];
    let freq, start, bits;
    if (value < 64) { const at = id * 64 + value, entry = small[at]; bits = entry >> 6; values[i] = entry & 63; freq = freqs[at]; start = starts[at]; }
    else {
      const h = histograms[id];
      hybridToken(h.config, value, slots); bits = slots[1]; values[i] = slots[2]; freq = h.counts[slots[0]]; start = h.starts[slots[0]];
    }
    metadata[i] = bits;
    if ((state >>> 20) >= freq) {
      emitted[i] = state & 65535; metadata[i] |= 64; state >>>= 16;
    }
    const q = Math.floor(state / freq);
    state = q * 4096 + reverses[id][start + state - q * freq];
  }
  w.write(32, state);
  for (let i = 0; i < length; i++) {
    const bits = metadata[i] & 63;
    if (metadata[i] & 64) {
      if (bits <= 8) { w.write(16 + bits, emitted[i] | values[i] << 16); continue; }
      w.write(16, emitted[i]);
    }
    if (bits) w.write(bits, values[i]);
  }
  g.length = 0;
}

const BUILT = new Map(), BUILT_KEEP = 64;
let builtScopes = 0;
export function ansCodingsKept(open) {
  builtScopes += open ? 1 : -1;
  if (!builtScopes) BUILT.clear();
}
const countsHash = counts => {
  let h = counts.contexts | 0;
  const {totals, small, large} = counts;
  for (let i = 0; i < totals.length; i++) h = Math.imul(h ^ totals[i], 0x01000193);
  for (let i = 0; i < small.length; i++) if (small[i]) h = Math.imul(h ^ (i + Math.imul(small[i], 0x9e3779b1)), 0x01000193);
  for (let c = 0; c < large.length; c++) if (large[c]) for (const [v, n] of large[c]) h = Math.imul(h ^ (c + Math.imul(v, 31) + Math.imul(n, 0x9e3779b1)), 0x01000193);
  return h >>> 0;
};
function countsCopy({contexts, totals, small, large}) {
  const s = [], t = [], l = [];
  for (let i = 0; i < small.length; i++) if (small[i]) s.push(i, small[i]);
  for (let i = 0; i < totals.length; i++) if (totals[i]) t.push(i, totals[i]);
  for (let c = 0; c < large.length; c++) if (large[c]) { l.push(c, large[c].size); for (const [v, n] of large[c]) l.push(v, n); }
  return {contexts, totalsLength: totals.length, smallLength: small.length, small: Uint32Array.from(s), totals: Float64Array.from(t), large: l};
}
function sameCounts(copy, {contexts, totals, small, large}) {
  if (copy.contexts !== contexts || copy.totalsLength !== totals.length || copy.smallLength !== small.length) return false;
  let k = 0;
  for (let i = 0; i < small.length; i++) if (small[i]) { if (copy.small[k] !== i || copy.small[k + 1] !== small[i]) return false; k += 2; }
  if (k !== copy.small.length) return false;
  k = 0;
  for (let i = 0; i < totals.length; i++) if (totals[i]) { if (copy.totals[k] !== i || copy.totals[k + 1] !== totals[i]) return false; k += 2; }
  if (k !== copy.totals.length) return false;
  k = 0;
  const l = copy.large;
  for (let c = 0; c < large.length; c++) if (large[c]) {
    if (l[k] !== c || l[k + 1] !== large[c].size) return false;
    k += 2;
    for (const [v, n] of large[c]) { if (l[k] !== v || l[k + 1] !== n) return false; k += 2; }
  }
  return k === l.length;
}
const codingKey = options => !options ? '' : [options.maxClusters, options.newClusterCost, options.seeds, options.passes, options.switchCost,
  !!options.everyConfig, !!options.kernels, options.shifts, options.mapLz, !!options.smallestMap].join();
export function buildAnsCoding(counts, options) {
  if (!builtScopes || !(counts instanceof TokenCounts)) return buildAnsCodingOnce(counts, options);
  const key = countsHash(counts) + '|' + codingKey(options), hit = BUILT.get(key);
  if (hit && sameCounts(hit.copy, counts)) { BUILT.delete(key); BUILT.set(key, hit); return ansCodingFrom(hit.parts, options?.kernels); }
  const coding = buildAnsCodingOnce(counts, options);
  BUILT.delete(key); BUILT.set(key, {copy: countsCopy(counts), parts: ansCodingParts(coding)});
  if (BUILT.size > BUILT_KEEP) BUILT.delete(BUILT.keys().next().value);
  return coding;
}
function buildAnsCodingOnce(counts, options) {
  const shaped = new WeakMap();
  const headerAware = options?.seeds === 128;
  const shapedCost = (freqs, config) => {
    const header = new BitCount(), shape = shapeHistogram(freqs, options?.shifts, headerAware);
    shaped.set(freqs, shape);
    writeUintConfig(header, config, Math.max(5, ceilLog2(freqs.findLastIndex(Boolean) + 1)));
    return header.bitLength + shape.bits;
  };
  const clustered = clusterTokenCounts(counts, options, histogramCost, symbolCosts, shapedCost);
  let bits = 32;
  const histograms = clustered.histograms.map(({config, freqs, extra}) => {
    const {counts, shift, omit} = shaped.get(freqs) ?? shapeHistogram(freqs, options?.shifts, headerAware);
    bits += extra + expectedDataBits(freqs, counts);
    return {config, counts, shift, omit};
  });
  const logAlphabet = Math.max(5, ceilLog2(Math.max(...histograms.map(h => h.counts.length))), ...histograms.map(h => h.config.split));
  for (const histogram of histograms) Object.assign(histogram, reverseAlias(histogram.counts, logAlphabet));
  const header = new BitWriter();
  header.write(1, 0);
  if (clustered.contextMap.length > 1) (options?.smallestMap ? writeSmallestContextMap : writeContextMap)(header, clustered.contextMap, options?.mapLz ?? true);
  header.write(1, 0); header.write(2, logAlphabet - 5);
  for (const histogram of histograms) writeUintConfig(header, histogram.config, logAlphabet);
  for (const histogram of histograms) writeDistribution(header, histogram.counts, true, histogram.shift, histogram.omit);

  const model = {kind: 'ans', contextMap: clustered.contextMap,
    histograms: histograms.map(({config, counts, starts, reverse}) => ({config, counts, starts, reverse}))};
  const {write, writeTokens, writeFilled, flush, reset} = options?.kernels?.ansWriter(model) ?? ansGroupWriter(model);
  return {bits: bits + header.bitLength, payloadBits: bits, model, histogramHeader: header, write, writeTokens, writeFilled, flush, reset, writeHistograms: w => w.append(header)};
}
export const ansCodingParts = ({bits, payloadBits, model, histogramHeader: {bytes, at, pending, acc}}) => ({bits, payloadBits, model, header: {bytes: bytes.slice(0, at + 1), at, pending, acc}});
export function ansCodingFrom({bits, payloadBits, model, header}, kernels) {
  const histogramHeader = Object.assign(new BitWriter(0), header);
  const {write, writeTokens, writeFilled, flush, reset} = kernels?.ansWriter(model) ?? ansGroupWriter(model);
  return {bits, payloadBits, model, histogramHeader, write, writeTokens, writeFilled, flush, reset, writeHistograms: w => w.append(histogramHeader)};
}

const SHAPES = new WeakMap();
function shapeOnce(freq) {
  const kept = SHAPES.get(freq);
  if (kept && kept.copy.length === freq.length && kept.copy.every((v, i) => v === freq[i])) return kept;
  const entry = {copy: freq.slice(), shape: shapeHistogram(freq), aliases: new Map()};
  SHAPES.set(freq, entry);
  return entry;
}

export function writeModularAnsHistograms(w, orderedLeaves, freqs, histogramOf = leaf => leaf.context, configOf = () => RESIDUAL_CONFIG, kernels = null) {
  const contextMap = new Uint8Array(orderedLeaves.length + 1);
  for (const leaf of orderedLeaves) contextMap[leaf.context] = histogramOf(leaf) + 1;
  const distance = new Uint32Array(2); distance[1] = 1;
  const shapes = [distance, ...freqs.slice(0, Math.max(...contextMap))].map(shapeOnce);
  const logAlphabet = Math.max(5, ceilLog2(Math.max(...shapes.map(h => h.shape.counts.length))));
  if (logAlphabet > 8) throw new Error('Modular ANS alphabet exceeds 256');
  const histograms = shapes.map(({shape, aliases}) => {
    if (!aliases.has(logAlphabet)) aliases.set(logAlphabet, reverseAlias(shape.counts, logAlphabet));
    return {...shape, ...aliases.get(logAlphabet)};
  });
  w.write(1, 1);
  w.writeU32([[0, 224], [0, 512], [0, 4096], [15, 8]], LZ77.minSymbol);
  w.writeU32([[0, 3], [0, 4], [2, 5], [8, 9]], LZ77.minLength);
  writeUintConfig(w, LZ77.lengthConfig, 8);
  if (contextMap.length > 1) writeContextMap(w, contextMap);
  w.write(1, 0); w.write(2, logAlphabet - 5);
  for (let i = 0; i < histograms.length; i++) writeUintConfig(w, i ? configOf(i - 1) : RESIDUAL_CONFIG, logAlphabet);
  for (const histogram of histograms) writeDistribution(w, histogram.counts, true, histogram.shift, histogram.omit);
  const encode = plans => {
    const length = plans.reduce((total, plan) => total + plan.used, 0), emitted = new Uint16Array(length), flags = new Uint8Array(length);
    let state = 0x13 * 65536, at = length, offset = histograms.length, bits = 32;
    for (let c = plans.length - 1; c >= 0; c--) {
      const plan = plans[c], map = plan.histogramMap; offset -= plan.freqs.length;
      for (let i = plan.used - 1; i >= 0; i--) {
        const tag = plan.tags[i], h = histograms[offset + (map ? map[tag >>> 16] : tag >>> 16)], symbol = tag & 511, freq = h.counts[symbol];
        --at;
        bits += (tag >>> 9) & 63;
        if ((state >>> 20) >= freq) { bits += 16; emitted[at] = state & 65535; flags[at] = 1; state >>>= 16; }
        const q = Math.floor(state / freq);
        state = q * 4096 + h.reverse[h.starts[symbol] + state - q * freq];
      }
    }
    return {plans, emitted, flags, state, bits};
  };
  const kernel = kernels?.modularAns(histograms);
  let measured = null;
  const write = plans => {
    const written = kernel?.write(w, plans);
    if (written != null && written !== false) return written;
    const {emitted, flags, state, bits} = measured?.plans === plans ? measured : encode(plans);
    measured = null;
    w.write(32, state);
    let at = 0;
    for (const plan of plans) for (let i = 0; i < plan.used; i++, at++) {
      if (flags[at]) w.write(16, emitted[at]);
      const rawBits = (plan.tags[i] >>> 9) & 63;
      if (rawBits) w.write(rawBits, plan.extra[i]);
    }
    return bits;
  };
  write.measure = plans => kernel ? kernel.bits(plans) : (measured = encode(plans)).bits;
  return write;
}
