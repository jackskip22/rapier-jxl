// SPDX-License-Identifier: MIT
import {BitWriter, ceilLog2, complete} from './bits.mjs';
import {stage, unit} from './step-journal.mjs';
import {writeContextMap, writeUintConfig} from './prefix.mjs';
import {TokenCounts, clusterTokenCountsSteps} from './entropy.mjs';
import {LZ77, RESIDUAL_CONFIG} from './modular.mjs';
import {writeSmallestContextMap} from './context-map.mjs';
import {GROUP_TOKENS} from './frame.mjs';
import {fault} from './fault.mjs';
import {captureModularAnsWrite} from './capture-kernels.mjs';
import {writeAnsTokens} from './kernels.mjs';
import {LOG_CODES, LOG_LENGTHS, SYMBOL_BITS, distributionLength, expectedDataBits, normalise, reverseAlias, shapeHistogram, writeDistribution, writeAnsHistograms, writeModularAnsHeader, writeAnsDistributionBundle} from './ans-core.mjs';
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

export function ansGroupWriter(model) {
  const g = {model, values: new Uint32Array(GROUP_TOKENS), ids: new Uint8Array(GROUP_TOKENS), length: 0};
  return {write: (_w, ctx, value) => ansWrite(g, ctx, value),
    writeTokens: (_w, ctxs, tokens, n) => ansWriteTokens(g, ctxs, tokens, n),
    flush: w => ansFlush(g, w), reset: () => { g.length = 0; }};
}
function ansWrite(g, ctx, value) {
  g.values[g.length] = value; g.ids[g.length++] = g.model.contextMap[ctx];
}
function ansWriteTokens(g, ctxs, tokens, n) {
  const {values, ids, model} = g, {contextMap} = model;
  let length = g.length;
  for (let i = 0; i < n; i++) { values[length] = tokens[i]; ids[length++] = contextMap[ctxs[i]]; }
  g.length = length;
}
function ansFlush(g, w) {
  writeAnsTokens(w, g.model, g.values, g.ids, g.length);
  g.length = 0;
}

const BUILT = new Map(), BUILT_KEEP = 256, BUILT_WEAK = new WeakMap();
const RESTORED_PARTS = new WeakMap();
let builtScopes = 0, builtEpoch = 0;
export function ansCodingsKept(open) {
  builtScopes += open ? 1 : -1;
  if (!builtScopes) { BUILT.clear(); builtEpoch++; }
}
const countsHash = counts => {
  let h = counts.contexts | 0;
  const {totals, large} = counts;
  for (let i = 0; i < totals.length; i++) h = Math.imul(h ^ totals[i], 0x01000193);
  for (let c = 0; c < large.length; c++) if (large[c]) for (const [v, n] of large[c]) h = Math.imul(h ^ (c + Math.imul(v, 31) + Math.imul(n, 0x9e3779b1)), 0x01000193);
  return h >>> 0;
};
function countsCopy({contexts, totals, small, large}) {
  let ns = 0, nt = 0;
  for (let c = 0; c < totals.length; c++) {
    if (!totals[c]) continue;
    nt += 2;
    const base = c << 6;
    for (let i = base; i < base + 64; i++) if (small[i]) ns += 2;
  }
  const s = new Uint32Array(ns), t = new Float64Array(nt), l = [];
  for (let c = 0, ks = 0, kt = 0; c < totals.length; c++) {
    if (!totals[c]) continue;
    t[kt++] = c; t[kt++] = totals[c];
    const base = c << 6;
    for (let i = base; i < base + 64; i++) if (small[i]) { s[ks++] = i; s[ks++] = small[i]; }
  }
  for (let c = 0; c < large.length; c++) if (large[c]) { l.push(c, large[c].size); for (const [v, n] of large[c]) l.push(v, n); }
  return {contexts, totalsLength: totals.length, smallLength: small.length, small: s, totals: t, large: l};
}
function sameCounts(copy, {contexts, totals, small, large}) {
  if (copy.contexts !== contexts || copy.totalsLength !== totals.length || copy.smallLength !== small.length) return false;
  let ks = 0, kt = 0;
  for (let c = 0; c < totals.length; c++) {
    const tot = totals[c];
    if (!tot) continue;
    if (copy.totals[kt] !== c || copy.totals[kt + 1] !== tot) return false;
    kt += 2;
    const base = c << 6;
    for (let i = base; i < base + 64; i++) if (small[i]) {
      if (copy.small[ks] !== i || copy.small[ks + 1] !== small[i]) return false;
      ks += 2;
    }
  }
  if (kt !== copy.totals.length || ks !== copy.small.length) return false;
  let k = 0;
  const l = copy.large;
  for (let c = 0; c < large.length; c++) if (large[c]) {
    if (l[k] !== c || l[k + 1] !== large[c].size) return false;
    k += 2;
    for (const [v, n] of large[c]) { if (l[k] !== v || l[k + 1] !== n) return false; k += 2; }
  }
  return k === l.length;
}
const codingKey = options => !options ? '' : [options.maxClusters, options.newClusterCost, options.seeds, options.passes, options.switchCost,
  !!options.everyConfig, !!options.kernels, options.mapLz, !!options.smallestMap, !!options.headerAware, !!options.shapedMerge, !!options.jpeg, options.postMerge ?? 0].join();
export function buildAnsCoding(counts, options) { return complete(buildAnsCodingSteps(counts, options)); }
function* buildAnsCodingSteps(input, options) {
  const made = yield* stage('coding', function* () {
    const counts = typeof input === 'function' ? input() : input;
    return yield* buildAnsCodingCached(counts, options);
  }, coding => {
    const parts = ansCodingParts(coding);
    return {...parts, model: {...parts.model, histograms: parts.model.histograms.map(({config, counts}) => ({config, counts}))}};
  });
  if (made.write) return made;
  const histogramHeader = Object.assign(new BitWriter(0), made.header);
  const result = {bits: made.bits, payloadBits: made.payloadBits, histogramHeader, writeHistograms: w => w.append(histogramHeader)};
  RESTORED_PARTS.set(result, made);
  let writer;
  const ready = () => {
    if (!writer) {
      const histograms = made.model.histograms, logAlphabet = Math.max(5, ceilLog2(Math.max(...histograms.map(h => h.counts.length))), ...histograms.map(h => h.config.split));
      for (const histogram of histograms) Object.assign(histogram, reverseAlias(histogram.counts, logAlphabet));
      writer = ansCodingFrom(made, options?.kernels);
    }
    return writer;
  };
  for (const key of ['model', 'write', 'writeTokens', 'writeFilled', 'flush', 'reset'])
    Object.defineProperty(result, key, {get: () => ready()[key]});
  return result;
}
const countsTotalSum = totals => { let s = 0; for (let i = 0; i < totals.length; i++) s += totals[i]; return s; };
function* buildAnsCodingCached(counts, options) {
  if (!builtScopes || !(counts instanceof TokenCounts)) return yield* buildAnsCodingOnce(counts, options);
  const optKey = codingKey(options), tSum = countsTotalSum(counts.totals);
  let wEntry = BUILT_WEAK.get(counts);
  if (wEntry && wEntry.epoch === builtEpoch && wEntry.tSum === tSum) {
    const wParts = wEntry.byOpt.get(optKey);
    if (wParts) return ansCodingFrom(wParts, options?.kernels);
  }
  const key = countsHash(counts) + '|' + optKey, hit = BUILT.get(key);
  if (hit && sameCounts(hit.copy, counts)) {
    BUILT.delete(key); BUILT.set(key, hit);
    if (!wEntry || wEntry.epoch !== builtEpoch || wEntry.tSum !== tSum) BUILT_WEAK.set(counts, wEntry = {epoch: builtEpoch, tSum, byOpt: new Map()});
    wEntry.byOpt.set(optKey, hit.parts);
    return ansCodingFrom(hit.parts, options?.kernels);
  }
  const coding = yield* buildAnsCodingOnce(counts, options);
  const parts = ansCodingParts(coding);
  BUILT.delete(key); BUILT.set(key, {copy: countsCopy(counts), parts});
  if (BUILT.size > BUILT_KEEP) BUILT.delete(BUILT.keys().next().value);
  if (!wEntry || wEntry.epoch !== builtEpoch || wEntry.tSum !== tSum) BUILT_WEAK.set(counts, wEntry = {epoch: builtEpoch, tSum, byOpt: new Map()});
  wEntry.byOpt.set(optKey, parts);
  return coding;
}
buildAnsCoding.steps = buildAnsCodingSteps;
buildAnsCoding.designCache = {key: codingKey, parts: ansCodingParts, from: ansCodingFrom};
function* buildAnsCodingOnce(counts, options) {
  const shaped = new WeakMap();
  const headerAware = options?.seeds === 128 || !!options?.headerAware;
  const shapedCost = (freqs, config) => {
    const header = new BitCount(), shape = shapeHistogram(freqs, headerAware);
    shaped.set(freqs, shape);
    writeUintConfig(header, config, Math.max(5, ceilLog2(freqs.findLastIndex(Boolean) + 1)));
    return header.bitLength + shape.bits;
  };
  const clustered = yield* clusterTokenCountsSteps(counts, options, histogramCost, symbolCosts, shapedCost);
  const shapes = yield* unit('shapes', () => {
    let bits = 32;
    const histograms = clustered.histograms.map(({config, freqs, extra}) => {
      const {counts, shift, omit} = shaped.get(freqs) ?? shapeHistogram(freqs, headerAware);
      bits += extra + expectedDataBits(freqs, counts);
      return {config, counts, shift, omit};
    });
    return {bits, histograms};
  });
  const {bits, histograms} = shapes;
  const logAlphabet = Math.max(5, ceilLog2(Math.max(...histograms.map(h => h.counts.length))), ...histograms.map(h => h.config.split));
  for (const histogram of histograms) Object.assign(histogram, reverseAlias(histogram.counts, logAlphabet));
  const header = new BitWriter();
  header.write(1, 0);
  if (clustered.contextMap.length > 1) {
    const map = yield* unit('map', () => {
      const w = new BitWriter();
      (options?.smallestMap ? writeSmallestContextMap : writeContextMap)(w, clustered.contextMap, options?.mapLz ?? true);
      return {bytes: w.bytes, at: w.at, pending: w.pending, acc: w.acc};
    }, w => ({...w, bytes: w.bytes.slice(0, w.at + 1)}));
    header.append(Object.assign(new BitWriter(0), map));
  }
  writeAnsDistributionBundle(header, histograms, logAlphabet);

  const model = {kind: 'ans', contextMap: clustered.contextMap,
    histograms: histograms.map(({config, counts, starts, reverse}) => ({config, counts, starts, reverse}))};
  const {write, writeTokens, writeFilled, flush, reset} = (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) ? {write: true, flush: true} : (options?.kernels?.ansWriter?.(model) ?? ansGroupWriter(model));
  return {bits: bits + header.bitLength, payloadBits: bits, model, histogramHeader: header, write, writeTokens, writeFilled, flush, reset, writeHistograms: w => w.append(header)};
}
export function ansCodingParts(coding) {
  const saved = RESTORED_PARTS.get(coding);
  if (saved) return saved;
  const {bits, payloadBits, model, histogramHeader: {bytes, at, pending, acc}} = coding;
  return {bits, payloadBits, model, header: {bytes: bytes.slice(0, at + 1), at, pending, acc}};
}
export function ansCodingFrom({bits, payloadBits, model, header}, kernels) {
  const histogramHeader = Object.assign(new BitWriter(0), header);
  const {write, writeTokens, writeFilled, flush, reset} = (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) ? {write: true, flush: true} : (kernels?.ansWriter(model) ?? ansGroupWriter(model));
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
  for (const leaf of orderedLeaves) {
    const h = histogramOf(leaf) + 1;
    if (h > 255) throw fault('JXL_INTERNAL', 'ans:histograms');
    contextMap[leaf.context] = h;
  }
  const distance = new Uint32Array(2); distance[1] = 1;
  const shapes = [distance, ...freqs.slice(0, Math.max(...contextMap))].map(shapeOnce);
  const logAlphabet = Math.max(5, ceilLog2(Math.max(...shapes.map(h => h.shape.counts.length))));
  if (logAlphabet > 8) throw fault('JXL_SIZE', 'ANS alphabet: max 256');
  const histograms = shapes.map(({shape, aliases}) => {
    if (!aliases.has(logAlphabet)) aliases.set(logAlphabet, reverseAlias(shape.counts, logAlphabet));
    return {...shape, ...aliases.get(logAlphabet)};
  });
  writeModularAnsHeader(w, LZ77, contextMap, logAlphabet, histograms.map((_, i) => i ? configOf(i - 1) : RESIDUAL_CONFIG), histograms, writeSmallestContextMap);
  const pack = plans => {
    if (plans.length === 1 && !plans[0].histogramMap) {
      const plan = plans[0];
      return {tags: plan.tags, extras: plan.extra, n: plan.used, offset: histograms.length - plan.freqs.length};
    }
    const n = plans.reduce((sum, plan) => sum + plan.used, 0),
      tags = new Uint32Array(n), extras = new Uint32Array(n);
    let at = 0, offset = histograms.length - plans.reduce((sum, plan) => sum + plan.freqs.length, 0);
    for (const plan of plans) {
      const {histogramMap: map} = plan;
      for (let i = 0; i < plan.used; i++, at++) {
        const tag = plan.tags[i], id = offset + (map ? map[tag >>> 16] : tag >>> 16);
        tags[at] = id << 16 | tag & 0xffff;
        extras[at] = plan.extra[i];
      }
      offset += plan.freqs.length;
    }
    return {tags, extras, n, offset: 0};
  };
  let measured = null;
  const prepare = plans => {
    const packed = pack(plans),
      bits = captureModularAnsWrite(null, packed.tags, packed.extras, packed.n, histograms, packed.offset);
    if (bits === false) throw fault('JXL_INTERNAL', 'ans:layout');
    return {plans, packed, bits};
  };
  const write = plans => {
    const {packed} = measured?.plans === plans ? measured : prepare(plans);
    measured = null;
    const bits = captureModularAnsWrite(w, packed.tags, packed.extras, packed.n, histograms, packed.offset);
    if (bits === false) throw fault('JXL_INTERNAL', 'ans:writer');
    return bits;
  };
  write.measure = plans => (measured = prepare(plans)).bits;
  return write;
}
