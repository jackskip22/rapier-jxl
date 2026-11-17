// SPDX-License-Identifier: MIT
import {BitWriter} from './bits.mjs';
import {fault} from './fault.mjs';
import {SCREEN_INTEGER_CONFIGS, screenDistanceMap} from './screen-codes.mjs';
import {writeCaptureModularHeader} from './capture-headers.mjs';
import {LZ77, split, writeTree, writeModularHeader as generalModular} from './modular.mjs';
import {LOG_MANTISSA, captureCopies, captureKeyCounts, capturePieceCounts, capturePrices, captureTokens} from './capture-kernels.mjs';
import {canonicalCodes, compactCode, hybridToken, prefixCodeBits, uintConfig, writeHistograms, writeUintConfig} from './prefix.mjs';

const writeModularHeader = typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true ? writeCaptureModularHeader : generalModular;
let L = {prices: 4};
export const setStreamLevel = level => { L = level; };
let probe = null;
export const setStreamProbe = p => { probe = p; };
const timed = (stage, work) => typeof __RAPIER_JXL_PROBES__ !== 'undefined' || !probe ? work() : probe.timed(stage, work);

export const upTo = n => Array.from({length: n}, (_, k) => k);
export function intervals(property, cuts, child) {
  const build = (lo, hi) => {
    if (lo === hi) return child(lo);
    const mid = (lo + hi) >> 1;
    return split(property, cuts[mid], build(mid + 1, hi), build(lo, mid));
  };
  return build(0, cuts.length);
}

const SPATIAL = new Map();
export function spatialLookup(width) {
  let entry = SPATIAL.get(width);
  if (!entry) {
    const map = screenDistanceMap(width), max = Math.max(...map.keys()) + 1;
    const flags = new Uint8Array(max), codes = new Int16Array(max).fill(-1);
    for (const [d, code] of map) { flags[d] = code < 2 ? 1 : code < 12 ? 3 : code < 32 ? 5 : 7; codes[d] = code; }
    if (SPATIAL.size > 64) SPATIAL.clear();
    SPATIAL.set(width, entry = [flags, codes]);
  }
  return entry;
}

export const LITERAL_CONFIGS = [...SCREEN_INTEGER_CONFIGS, ...[[4, 2, 1], [5, 1, 1], [5, 2, 1], [6, 1, 1], [6, 2, 1], [7, 2, 1], [5], [6], [7], [8], [9], [10], [11], [12], [13]].map(a => uintConfig(...a))];
export const ANS_FIT = [];
for (let split = 0; split <= 8; split++) for (let msb = 0; msb <= split; msb++) for (let lsb = 0; msb + lsb <= split; lsb++) ANS_FIT.push(uintConfig(split, msb, lsb));
export const SMALL = 512;
export const log2x32 = x => {
  const e = 31 - Math.clz32(x);
  return 32 * e + LOG_MANTISSA[(e >= 5 ? x >>> e - 5 : x << 5 - e) & 31];
};
function entropy(freqs, header = 0) {
  let total = 0, used = 0, bits = 0;
  for (const n of freqs) if (n) { total += n; used++; }
  if (!total) return 0;
  const whole = log2x32(total);
  for (const n of freqs) if (n) bits += n * (whole - log2x32(n));
  return bits / 32 + 5 * used + header;
}

const DISTANCE_TOKENS = 1 << 15;
const FREQS = new Uint32Array(DISTANCE_TOKENS), USED = new Uint16Array(DISTANCE_TOKENS);
let usedLen = 0;

function clearFreqs() {
  for (let i = 0; i < usedLen; i++) FREQS[USED[i]] = 0;
  usedLen = 0;
}

export function valueCounts(small, large) {
  let size = large.values.length;
  for (let v = 0; v < SMALL; v++) if (small[v]) size++;
  const values = new Int32Array(size), counts = new Uint32Array(size);
  let i = 0;
  for (let v = 0; v < SMALL; v++) if (small[v]) { values[i] = v; counts[i++] = small[v]; }
  values.set(large.values, i); counts.set(large.counts, i);
  return {values, counts};
}
const NO_COUNTS = {values: new Int32Array(0), counts: new Uint32Array(0)};
function countKeys(keys, histograms, field) {
  if (!keys.length) return;
  const {values, counts, starts} = captureKeyCounts(keys, histograms.length);
  for (let h = 0; h < histograms.length; h++) if (starts[h + 1] > starts[h])
    histograms[h][field] = {values: values.subarray(starts[h], starts[h + 1]), counts: counts.subarray(starts[h], starts[h + 1])};
}
function mergeCounts(a, b) {
  if (!b.values.length) return a;
  if (!a.values.length) return b;
  const values = [], counts = [];
  for (let i = 0, j = 0; i < a.values.length || j < b.values.length;) {
    const va = i < a.values.length ? a.values[i] : Infinity, vb = j < b.values.length ? b.values[j] : Infinity;
    if (va === vb) { values.push(va); counts.push(a.counts[i++] + b.counts[j++]); }
    else if (va < vb) { values.push(va); counts.push(a.counts[i++]); }
    else { values.push(vb); counts.push(b.counts[j++]); }
  }
  return {values: Int32Array.from(values), counts: Uint32Array.from(counts)};
}
export function sortedCode(freqs) {
  const used = [];
  for (let i = 0; i < freqs.length; i++) if (freqs[i]) used.push(i);
  const code = compactCode(freqs, used);
  code.codes = canonicalCodes(code.lengths);
  return code;
}
const WIDE_DISTANCES = [[8, 4, 4], [10, 4, 3], [10, 5, 4], [10, 5, 5], [12, 5, 5], [12, 6, 5], [12, 6, 6], [13, 6, 6], [14, 6, 6], [14, 7, 7]].map(a => uintConfig(...a));
export const DISTANCE_CONFIGS = [...SCREEN_INTEGER_CONFIGS, ...WIDE_DISTANCES];
function distanceTokens(config, values) {
  clearFreqs();
  const token = [0, 0, 0];
  let raw = 0, uLen = 0;
  for (let i = 0; i < values.values.length; i++) {
    const v = values.values[i], n = values.counts[i];
    hybridToken(config, v, token);
    const s = token[0];
    if (s >= DISTANCE_TOKENS) { usedLen = uLen; return null; }
    if (!FREQS[s]) USED[uLen++] = s;
    FREQS[s] += n; raw += token[1] * n;
  }
  usedLen = uLen;
  return [raw, USED.subarray(0, uLen).sort()];
}
export function distancePrice(config, values) {
  const tokens = distanceTokens(config, values);
  if (!tokens) return Infinity;
  const header = new BitWriter(16);
  writeUintConfig(header, config, 15);
  return tokens[0] + header.bitLength + prefixCodeBits(FREQS, tokens[1]);
}
export function distanceCode(config, values) {
  return compactCode(FREQS, distanceTokens(config, values)[1]);
}

const CLUSTER_CONFIG = uintConfig(4, 1, 1), CLUSTER_TOKENS = 128, CLUSTER_HEADER = 48;
const clusterCost = freqs => entropy(freqs, CLUSTER_HEADER);
export function countTokens(freqs, h, config, lengthConfig, at, top) {
  const token = [0, 0, 0], add = (c, v, n, from) => { hybridToken(c, v, token); freqs[from + Math.min(token[0], top)] += n; };
  for (let v = 0; v < SMALL; v++) if (h.small[v]) add(config, v, h.small[v], 0);
  for (let i = 0; i < h.large.values.length; i++) add(config, h.large.values[i], h.large.counts[i], 0);
  for (let i = 0; i < h.lengths.values.length; i++) add(lengthConfig, h.lengths.values[i], h.lengths.counts[i], at);
  return freqs;
}
function clusterHistograms(live, limit = Infinity) {
  const n = live.length, freqs = live.map(h => countTokens(new Uint32Array(CLUSTER_TOKENS), h, CLUSTER_CONFIG, CLUSTER_CONFIG, 64, 63));
  const cost = freqs.map(clusterCost), alive = new Uint8Array(n).fill(1), parent = Int32Array.from({length: n}, (_, i) => i);
  const took = new Int32Array(n).fill(-1), near = new Int32Array(n).fill(-1), nearGain = new Float64Array(n), masks = freqs.map(f => {
    const mask = new Uint32Array(CLUSTER_TOKENS >> 5);
    for (let t = 0; t < CLUSTER_TOKENS; t++) if (f[t]) mask[t >> 5] |= 1 << (t & 31);
    return mask;
  });
  const gain = (a, b) => {
    if (live[a].constant !== live[b].constant) return Infinity;
    const fa = freqs[a], fb = freqs[b], ma = masks[a], mb = masks[b];
    let total = 0, used = 0, bits = 0;
    for (let w = 0; w < ma.length; w++) for (let m = ma[w] | mb[w]; m; m &= m - 1) { const t = w << 5 | 31 - Math.clz32(m & -m); total += fa[t] + fb[t]; used++; }
    const whole = log2x32(total);
    for (let w = 0; w < ma.length; w++) for (let m = ma[w] | mb[w]; m; m &= m - 1) { const t = w << 5 | 31 - Math.clz32(m & -m), f = fa[t] + fb[t]; bits += f * (whole - log2x32(f)); }
    return (total ? bits / 32 + 5 * used + CLUSTER_HEADER : 0) - cost[a] - cost[b];
  };
  const pair = (a, b) => took[a] < 0 && took[b] < 0 ? gain(a, b) : took[a] > took[b] ? gain(b, a) : gain(a, b);
  const nearest = a => {
    near[a] = -1;
    for (let b = a + 1; b < n; b++) if (alive[b]) { const g = pair(a, b); if (near[a] < 0 || g < nearGain[a]) { near[a] = b; nearGain[a] = g; } }
  };
  for (let a = 0; a < n; a++) nearest(a);
  for (let count = n, merges = 0; ; count--, merges++) {
    let best = count > limit ? Infinity : 0, ba = -1, bb = -1;
    for (let a = 0; a < n; a++) if (alive[a] && near[a] >= 0 && nearGain[a] < best) { best = nearGain[a]; ba = a; bb = near[a]; }
    if (ba < 0) break;
    for (let t = 0; t < CLUSTER_TOKENS; t++) freqs[ba][t] += freqs[bb][t];
    for (let w = 0; w < masks[ba].length; w++) masks[ba][w] |= masks[bb][w];
    cost[ba] = clusterCost(freqs[ba]); alive[bb] = 0; parent[bb] = ba; took[ba] = merges;
    const into = live[ba], from = live[bb];
    for (let v = 0; v < SMALL; v++) into.small[v] += from.small[v];
    into.large = mergeCounts(into.large, from.large); into.lengths = mergeCounts(into.lengths, from.lengths);
    into.literals += from.literals; into.copies += from.copies;
    nearest(ba);
    for (let a = 0; a < ba; a++) if (alive[a]) {
      if (near[a] === ba || near[a] === bb) { nearest(a); continue; }
      const g = gain(a, ba);
      if (near[a] < 0 || g < nearGain[a] || g === nearGain[a] && ba < near[a]) { near[a] = ba; nearGain[a] = g; }
    }
    for (let a = ba + 1; a < bb; a++) if (alive[a] && near[a] === bb) nearest(a);
  }
  const of = new Int32Array(n), groups = [], slot = new Int32Array(n);
  for (let i = 0; i < n; i++) if (alive[i]) { slot[i] = groups.length; groups.push(live[i]); }
  for (let i = 0; i < n; i++) { let r = i; while (!alive[r]) r = parent[r]; of[i] = slot[r]; }
  return {groups, of};
}

const pieceKeys = [new Uint32Array(0), new Uint32Array(0), new Uint32Array(0)];
export function letGoStreamKeys(keep) { for (let k = 0; k < 3; k++) if (pieceKeys[k].length > keep) pieceKeys[k] = new Uint32Array(0); }
const keySpace = (k, used, more) => {
  if (pieceKeys[k].length < used + more) { const grown = new Uint32Array(Math.max(used + more, pieceKeys[k].length * 2)); grown.set(pieceKeys[k].subarray(0, used)); pieceKeys[k] = grown; }
  return pieceKeys[k];
};
export function writeChannels(writer, models, trace, ansTools = null, own = false) {
  const start = typeof __RAPIER_JXL_PROBES__ === 'undefined' ? writer.bitLength : 0;
  const ordered = writeTree(writer, intervals(0, upTo(models.length - 1), m => models[m].tree), L.treeContexts);
  let pieces = 0;
  const histograms = [];
  let larges = 0, copies = 0, copyMinimum = 0, largeKeys, lengthKeys, copyDistances;
  for (const model of models) {
    model.base = histograms.length;
    pieces += model.count;
    const copiesBefore = copies;
    const counted = capturePieceCounts(model, SMALL, model.base);
    largeKeys = keySpace(0, larges, counted.larges.length); lengthKeys = keySpace(1, copies, counted.lengths.length); copyDistances = keySpace(2, copies, counted.lengths.length);
    largeKeys.set(counted.larges, larges); lengthKeys.set(counted.lengths, copies); copyDistances.set(counted.distances, copies);
    larges += counted.larges.length; copies += counted.lengths.length;
    for (let c = 0; c < model.classes; c++) histograms.push({small: counted.counts.subarray(c * SMALL, (c + 1) * SMALL), large: NO_COUNTS, lengths: NO_COUNTS, literals: counted.literals[c], copies: counted.copies[c], constant: model.constant});
    if (copies > copiesBefore) {
      if (copyMinimum && copyMinimum !== model.minimum) throw fault('JXL_INTERNAL', 'capture-modular-stream:minimum');
      copyMinimum = model.minimum;
    }
  }
  countKeys(largeKeys.subarray(0, larges), histograms, 'large'); countKeys(lengthKeys.subarray(0, copies), histograms, 'lengths');
  const stream = {distances: NO_COUNTS};
  countKeys(copyDistances.subarray(0, copies), [stream], 'distances');
  const {values: distanceValues, counts: distanceCounts} = stream.distances;
  let live = histograms.filter(h => h.literals + h.copies);
  const index = new Int32Array(histograms.length);
  for (let i = 0, next = 0; i < histograms.length; i++) index[i] = histograms[i].literals + histograms[i].copies ? next++ : 0;
  if (!(typeof __RAPIER_JXL_JPEG__ !== 'undefined' && __RAPIER_JXL_JPEG__ === true) && live.length > 1 && (live.length > 255 || models.some(model => model.kind === 'index' && !model.group))) {
    const {groups, of} = clusterHistograms(live, 255 - (distanceValues.length ? 1 : 0));
    for (let i = 0; i < histograms.length; i++) index[i] = of[index[i]];
    live = groups;
  }
  const token = [0, 0, 0], minSymbol = models.some(model => model.kind === 'index') && models[0].width <= 2048 ? 224 : 512;
  const configs = live.map(h => {
    const literals = valueCounts(h.small, h.large);
    if (!h.literals) return {config: LITERAL_CONFIGS[0], top: 0};
    let largest = 0, best, wide = false;
    for (const v of literals.values) if (v > largest) largest = v;
    const candidates = [];
    for (const config of LITERAL_CONFIGS) {
      if (distanceValues.length) { hybridToken(config, largest, token); if (token[0] >= minSymbol) continue; }
      if (config.splitToken > largest) { if (wide) continue; wide = true; }
      candidates.push(config);
    }
    const prices = capturePrices(candidates, literals);
    for (let c = 0; c < candidates.length; c++) {
      const config = candidates[c], option = {config, bits: prices[c * 2], top: prices[c * 2 + 1]};
      if (!best || option.bits < best.bits) best = option;
    }
    return best;
  });
  let length = {config: LZ77.lengthConfig, bits: 0};
  if (distanceValues.length) {
    length = null;
    const costs = new Float64Array(SCREEN_INTEGER_CONFIGS.length);
    for (const h of live) if (h.copies) {
      const prices = capturePrices(SCREEN_INTEGER_CONFIGS, h.lengths);
      for (let c = 0; c < costs.length; c++) costs[c] += prices[c * 2];
    }
    for (let c = 0; c < costs.length; c++) if (!length || costs[c] < length.bits)
      length = {config: SCREEN_INTEGER_CONFIGS[c], bits: costs[c]};
  }
  const codes = live.map((h, m) => sortedCode(countTokens(new Uint32Array(h.copies ? minSymbol + 1024 : configs[m].top + 1),
    h, configs[m].config, length.config, minSymbol, Infinity)));
  if (typeof __RAPIER_JXL_PROBES__ === 'undefined' && probe?.timing()) probe.timing().pieces = (probe.timing().pieces || 0) + pieces;
  let distance, sCodes = null;
  if (distanceValues.length) timed('distance', () => {
    sCodes = spatialLookup(Math.max(...models.map(model => model.width)))[1];
    const sLen = sCodes.length, spatial = new Int32Array(distanceValues.length), generic = new Int32Array(distanceValues.length);
    for (let i = 0; i < distanceValues.length; i++) {
      const d = distanceValues[i];
      spatial[i] = d < sLen && sCodes[d] >= 0 ? sCodes[d] : d + 119; generic[i] = d === 1 ? 1 : d + 119;
    }
    const ranked = [];
    for (const [kind, values] of [[true, {values: spatial, counts: distanceCounts}], [false, {values: generic, counts: distanceCounts}]]) {
      const prices = capturePrices(DISTANCE_CONFIGS, values, true);
      for (let c = 0; c < DISTANCE_CONFIGS.length; c++) ranked.push({config: DISTANCE_CONFIGS[c], kind, values, estimate: prices[c * 2]});
    }
    ranked.sort((a, b) => a.estimate - b.estimate);
    for (const {config, kind, values} of ranked.slice(0, L.prices)) {
      const bits = distancePrice(config, values);
      if (!distance || bits < distance.bits) distance = {bits, config, spatial: kind, values};
    }
    distance.code = distanceCode(distance.config, distance.values);
    distance.code.codes = canonicalCodes(distance.code.lengths);
  });
  const offset = distance ? 1 : 0, contextMap = new Uint8Array(ordered.length + offset);
  if (live.length + offset > 256) throw fault('JXL_INTERNAL', 'capture-modular-stream:histograms');
  for (const model of models) for (const node of model.leaves) contextMap[node.context] = index[model.base + node.local] + offset;
  const lz77 = distance ? {minSymbol: minSymbol, minLength: copyMinimum, lengthConfig: length.config} : null;
  const copy = distance ? {lengthConfig: length.config, distanceConfig: distance.config, code: distance.code, minSymbol, spatial: distance.spatial, sCodes} : null;
  const prefixHeader = new BitWriter(1024);
  writeHistograms(prefixHeader, {lz77, contextMap,
    histograms: [...(distance ? [{config: distance.config, code: distance.code}] : []),
      ...codes.map((code, m) => ({config: configs[m].config, code}))]
  });
  let ans = null;
  if ((typeof __RAPIER_JXL_CAPTURE_LEAN__ === 'undefined' || !__RAPIER_JXL_CAPTURE_LEAN__) && ansTools) timed('ans', () => {
    const ansCopy = copy && {...copy, distanceConfig: ansTools.distanceConfig(distance.values), lengthConfig: ansTools.lengthConfig(live, 256 - minSymbol)};
    if (copy && !(ansCopy.distanceConfig && ansCopy.lengthConfig)) return;
    const retry = !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && !own;
    const fitted = () => live.map((h, m) => {
      if (!h.literals) return configs[m].config;
      const literals = valueCounts(h.small, h.large);
      let best = null, bits = Infinity, largest = 0;
      const room = Math.min(copy ? minSymbol : Infinity, retry ? 256 : Infinity);
      if (room < Infinity) for (const v of literals.values) if (v > largest) largest = v;
      for (let at = 0; at < ANS_FIT.length; at += 64) {
        const some = ANS_FIT.slice(at, at + 64), prices = capturePrices(some, literals);
        for (let c = 0; c < some.length; c++) if (prices[c * 2] < bits && !(room < Infinity && (hybridToken(some[c], largest, token), token[0] >= room))) { bits = prices[c * 2]; best = some[c]; }
      }
      return best;
    });
    const ansConfigs = own || retry ? fitted() : configs.map(c => c.config);
    const tokens = ansTools.tokens(models, index, ansConfigs, ansCopy, codes.length, pieces + copies);
    if (!tokens) return;
    const header = new BitWriter(1024), data = new BitWriter(tokens.n + 64);
    const all = [...(distance ? [ansCopy.distanceConfig] : []), ...ansConfigs];
    if (ansTools.write(header, data, {lz77: lz77 && {...lz77, lengthConfig: ansCopy.lengthConfig}, contextMap, configs: all}, tokens)) ans = {header, data};
  });
  let fastLen = null, fastBits = null;
  const prefixWrite = target => {
    if (!fastLen) {
      fastLen = new Uint8Array(codes.length << 9); fastBits = new Uint32Array(codes.length << 9);
      for (let h = 0; h < codes.length; h++) {
        const code = codes[h], cfg = configs[h].config, base = h << 9, small = live[h].small;
        for (let v = 0; v < 512; v++) {
          if (!small[v]) continue;
          hybridToken(cfg, v, token);
          const s = token[0], l = code.lengths[s];
          if (s < code.lengths.length) { fastLen[base | v] = l + token[1]; fastBits[base | v] = code.codes[s] | (token[2] << l); }
        }
      }
    }
    return captureTokens(target, models, index, codes, configs.map(c => c.config), fastBits, fastLen, copy);
  };
  let prefixSize = null;
  const prefixBits = () => {
    if (prefixSize !== null) return prefixSize;
    let bits = 0;
    for (let m = 0; m < live.length; m++) {
      const h = live[m], code = codes[m], config = configs[m].config;
      for (let v = 0; v < SMALL; v++) if (h.small[v]) { hybridToken(config, v, token); bits += h.small[v] * (code.lengths[token[0]] + token[1]); }
      for (let i = 0; i < h.large.values.length; i++) { hybridToken(config, h.large.values[i], token); bits += h.large.counts[i] * (code.lengths[token[0]] + token[1]); }
      for (let i = 0; i < h.lengths.values.length; i++) { hybridToken(length.config, h.lengths.values[i], token); bits += h.lengths.counts[i] * (code.lengths[minSymbol + token[0]] + token[1]); }
    }
    if (distance) for (let i = 0, {values, counts} = distance.values; i < values.length; i++) { hybridToken(distance.config, values[i], token); bits += counts[i] * (distance.code.lengths[token[0]] + token[1]); }
    return prefixSize = bits;
  };
  if ((typeof __RAPIER_JXL_CAPTURE_LEAN__ === 'undefined' || !__RAPIER_JXL_CAPTURE_LEAN__) && ans) {
    if (ans.header.bitLength + ans.data.bitLength > (own || !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) ? 1 : 0.99) * (prefixHeader.bitLength + prefixBits())) ans = null;
  }
  writer.append(ans ? ans.header : prefixHeader);
  if (typeof __RAPIER_JXL_PROBES__ === 'undefined' && trace) {
    let literalBits = 0, lengthBits = 0, literals = 0, copies = 0;
    for (let m = 0; m < live.length; m++) {
      const h = live[m], code = codes[m], config = configs[m].config;
      const bits = (c, v, n, at) => { hybridToken(c, v, token); return n * (code.lengths[at + token[0]] + token[1]); };
      for (let v = 0; v < SMALL; v++) if (h.small[v]) literalBits += bits(config, v, h.small[v], 0);
      for (let i = 0; i < h.large.values.length; i++) literalBits += bits(config, h.large.values[i], h.large.counts[i], 0);
      for (let i = 0; i < h.lengths.values.length; i++) lengthBits += bits(length.config, h.lengths.values[i], h.lengths.counts[i], minSymbol);
      literals += h.literals; copies += h.copies;
    }
    trace.push({kinds: models.map(m => m.kind + (m.group ? '/group' : '')).join('+'), pieces, literals, copies, classes: histograms.length,
      codes: live.length, headerBits: writer.bitLength - start, literalBits, lengthBits, distanceBits: distance ? distance.bits : 0, ans: Boolean(ans)});
  }
  const write = ans ? () => writer.append(ans.data) : () => prefixWrite(writer);
  write.bits = () => ans ? ans.data.bitLength : prefixBits();
  return write;
}

export const runModels = models => models.some(model => model.pieceValue.some(v => v > 65535)) ? null
  : models.map(model => model.count > 1 && model.width <= 16384 && model.count <= 1 << 20 ? learnedRuns(model, model.width, model.height) : model);
export function writeCaptureStream(writer, models, ans = null, {transforms = [], global = false, runs = false} = {}) {
  const write = (target, chosen) => {
    if (typeof __RAPIER_JXL_JPEG__ !== 'undefined' && __RAPIER_JXL_JPEG__ === true || !global) writeModularHeader(target, {useGlobalTree: false, transforms});
    const data = writeChannels(target, chosen, null, ans, true);
    if (!(typeof __RAPIER_JXL_JPEG__ !== 'undefined' && __RAPIER_JXL_JPEG__ === true) && global) writeModularHeader(target, {transforms});
    data();
  };
  const withRuns = !(typeof __RAPIER_JXL_JPEG__ !== 'undefined' && __RAPIER_JXL_JPEG__ === true) && !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && runs && runModels(models);
  if (!withRuns) { write(writer, models); return; }
  const plain = new BitWriter(256), copied = new BitWriter(256);
  write(plain, models);
  write(copied, withRuns);
  writer.append(copied.bitLength < plain.bitLength ? copied : plain);
}

export function learnedRuns(learned, w, h) {
  return timed('copies', () => {
    const c = captureCopies(Uint16Array.from(learned.pieceValue), w, 0, w, h, learned.pieceContext, 0, 4, 1, spatialLookup(w)[0]);
    return {...learned, count: c.count, pieceValue: c.value, pieceDistance: c.distance, pieceContext: c.context};
  });
}
