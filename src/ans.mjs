// SPDX-License-Identifier: MIT
import {BitWriter, ceilLog2, floorLog2} from './bits.mjs';
import {hybridToken, writeContextMap, writeUintConfig} from './prefix.mjs';
import {clusterTokenCounts, entropyLog2} from './entropy.mjs';
import {LZ77, RESIDUAL_CONFIG} from './modular.mjs';
import {writeSmallestContextMap} from './context-map.mjs';
import {GROUP_TOKENS} from './frame.mjs';

export const LOG_LENGTHS = [5, 4, 4, 4, 4, 4, 3, 3, 3, 3, 3, 6, 7];
export const LOG_CODES = [17, 11, 15, 3, 9, 7, 4, 2, 5, 6, 0, 33, 1];
const SYMBOL_BITS = new Float64Array(4097);
for (let count = 1; count <= 4096; count++) SYMBOL_BITS[count] = 12 - entropyLog2(count);

function varUint8(w, value) {
  if (!value) { w.write(1, 0); return; }
  const n = floorLog2(value);
  w.write(1, 1); w.write(3, n); w.write(n, value - (1 << n));
}

function normalise(freqs) {
  let total = 0, last = 0;
  for (let i = 0; i < freqs.length; i++) {
    total += freqs[i];
    if (freqs[i]) last = i + 1;
  }
  const counts = new Uint16Array(last || 1);
  if (!total) { counts[0] = 4096; return counts; }
  let sum = 0;
  for (let i = 0; i < last; i++) if (freqs[i]) sum += counts[i] = Math.max(1, Math.round(freqs[i] * 4096 / total));
  while (sum !== 4096) {
    const direction = sum < 4096 ? 1 : -1;
    let chosen = -1, error = -Infinity;
    for (let i = 0; i < last; i++) if (freqs[i] && (direction > 0 || counts[i] > 1)) {
      const candidate = direction * (freqs[i] * 4096 - counts[i] * total);
      if (candidate > error) { chosen = i; error = candidate; }
    }
    counts[chosen] += direction; sum += direction;
  }
  return counts;
}

const countPrecision = (bits, shift) => Math.max(0, Math.min(bits, shift - ((12 - bits) >> 1)));
function stepOf(count, shift) {
  const bits = floorLog2(count);
  return bits ? 1 << (bits - countPrecision(bits, shift)) : 1;
}
const countUp = (count, shift) => count + stepOf(count, shift);
function countDown(count, shift) {
  if (count <= 1) return 0;
  const bits = floorLog2(count);
  return count === 1 << bits ? count - stepOf(count - 1, shift) : count - stepOf(count, shift);
}

export function shapeHistogram(freqs, shifts = SHIFTS) {
  let total = 0, last = 0, omit = 0, used = 0;
  for (let i = 0; i < freqs.length; i++) if (freqs[i]) { total += freqs[i]; last = i + 1; used++; if (freqs[i] > freqs[omit]) omit = i; }
  if (used <= 2) { const counts = normalise(freqs); return {counts, shift: 12, omit: -1, bits: distributionBits(counts, 12, -1) + expectedDataBits(freqs, counts)}; }
  let best = null;
  const ups = new Uint16Array(last), downs = new Uint16Array(last), upGains = new Float64Array(last), downGains = new Float64Array(last);
  for (let k = 0; k < shifts.length; k++) {
    const shift = shifts[k];
    if (REPEATS[shift] && shifts.indexOf(shift + 1) >= 0 && shifts.indexOf(shift + 1) < k) continue;
    const counts = new Uint16Array(last);
    let sum = 0;
    for (let i = 0; i < last; i++) if (freqs[i] && i !== omit) {
      const target = freqs[i] * 4096 / total, cap = i < omit ? 2047 : 4095;
      let c = Math.max(1, Math.min(cap, Math.round(target)));
      if (c > 1) { const bits = floorLog2(c), step = stepOf(c, shift); c = (1 << bits) + Math.floor((c - (1 << bits)) / step) * step; }
      const up = countUp(c, shift);
      if (up <= cap && up - target < target - c) c = up;
      counts[i] = c; sum += c;
    }
    if (sum >= 4096) continue;
    const f0 = freqs[omit];
    const steps = i => {
      const c = counts[i], cap = i < omit ? 2047 : 4095, here = LOG2[c], up = countUp(c, shift), down = countDown(c, shift);
      ups[i] = up <= cap ? up : 0; downs[i] = down;
      if (up <= cap) upGains[i] = freqs[i] * (LOG2[up] - here);
      if (down >= 1) downGains[i] = freqs[i] * (LOG2[down] - here);
    };
    for (let i = 0; i < last; i++) if (counts[i] && i !== omit) steps(i);
    for (let moves = 0; moves < 4 * last; moves++) {
      const rest = 4096 - sum, restBits = LOG2[rest];
      let chosen = -1, to = 0, gain = 1e-9;
      for (let i = 0; i < last; i++) if (counts[i] && i !== omit) {
        const c = counts[i], up = ups[i], down = downs[i];
        if (up && rest - (up - c) >= 1) {
          const g = upGains[i] + f0 * (LOG2[rest - (up - c)] - restBits);
          if (g > gain) { gain = g; chosen = i; to = up; }
        }
        if (down >= 1) {
          const g = downGains[i] + f0 * (LOG2[rest + c - down] - restBits);
          if (g > gain) { gain = g; chosen = i; to = down; }
        }
      }
      if (chosen < 0) break;
      sum += to - counts[chosen]; counts[chosen] = to; steps(chosen);
    }
    counts[omit] = 4096 - sum;
    const bits = distributionBits(counts, shift, omit) + expectedDataBits(freqs, counts);
    if (!best || bits < best.bits) best = {counts, shift, omit, bits};
  }
  return best;
}
const SHIFTS = [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0];
const gammaBits = shift => { const log = floorLog2(shift + 1); return 2 * log + (log < 3 ? 1 : 0); };
const REPEATS = Array.from({length: 13}, (_, shift) => shift < 12 && gammaBits(shift) === gammaBits(shift + 1) &&
  Array.from({length: 11}, (_, b) => b + 1).every(bits => countPrecision(bits, shift) === countPrecision(bits, shift + 1)));
const LOG2 = new Float64Array(4097);
for (let n = 1; n <= 4096; n++) LOG2[n] = entropyLog2(n);
function distributionBits(counts, shift, omit) { return distributionLength(counts, true, shift, omit); }

const varUint8Length = value => value ? 4 + floorLog2(value) : 1;
function distributionLength(counts, runs = false, shift = 12, omit = -1) {
  const length = counts.length, firstLargest = omit < 0;
  let used = 0, first = -1, second = -1;
  if (firstLargest) omit = 0;
  for (let i = 0; i < length; i++) {
    if (counts[i]) { if (used === 0) first = i; else if (used === 1) second = i; used++; }
    if (firstLargest && counts[i] > counts[omit]) omit = i;
  }
  if (used <= 2) return 2 + (used ? varUint8Length(first) : 0) + (used === 2 ? varUint8Length(second) + 12 : 0);
  const code = shift + 1, log = floorLog2(code);
  let bits = 2 + 2 * log + (log < 3 ? 1 : 0) + varUint8Length(length - 3), omitLog = runs ? 10 : 0;
  for (let i = 0; i < length; i++) if (i !== omit && counts[i]) omitLog = Math.max(omitLog, floorLog2(counts[i]) + 1 + (i < omit ? 1 : 0));
  const logOf = i => i === omit ? omitLog : counts[i] ? floorLog2(counts[i]) + 1 : 0;
  for (let i = 0; i < length; i++) {
    const own = logOf(i);
    bits += LOG_LENGTHS[own];
    if (i !== omit && own > 1) bits += countPrecision(own - 1, shift);
    if (runs && i !== omit) {
      let end = i + 1;
      while (end < length && end !== omit && counts[end] === counts[i]) end++;
      if (end - i >= 5) { bits += 7 + varUint8Length(end - i - 5); i = end - 1; }
    }
  }
  return bits;
}

function writeDistribution(w, counts, runs = false, shift = 12, omit = -1) {
  const used = [];
  const firstLargest = omit < 0;
  if (firstLargest) omit = 0;
  for (let i = 0; i < counts.length; i++) {
    if (counts[i]) used.push(i);
    if (firstLargest && counts[i] > counts[omit]) omit = i;
  }
  if (used.length <= 2) {
    w.write(1, 1); w.write(1, used.length - 1);
    for (const symbol of used) varUint8(w, symbol);
    if (used.length === 2) w.write(12, counts[used[0]]);
    return;
  }
  w.write(1, 0); w.write(1, 0);
  const code = shift + 1, log = floorLog2(code);
  w.write(log, (1 << log) - 1);
  if (log < 3) w.write(1, 0);
  w.write(log, code - (1 << log));
  varUint8(w, counts.length - 3);
  const logs = new Uint8Array(counts.length);
  let omitLog = runs ? 10 : 0;
  for (let i = 0; i < counts.length; i++) if (i !== omit && counts[i]) {
    logs[i] = floorLog2(counts[i]) + 1;
    omitLog = Math.max(omitLog, logs[i] + (i < omit ? 1 : 0));
  }
  logs[omit] = omitLog;
  const repeats = runs ? new Uint16Array(counts.length) : null;
  for (let i = 0; i < counts.length; i++) {
    w.write(LOG_LENGTHS[logs[i]], LOG_CODES[logs[i]]);
    if (runs && i !== omit) {
      let end = i + 1;
      while (end < counts.length && end !== omit && counts[end] === counts[i]) end++;
      if (end - i >= 5) { repeats[i] = end - i; w.write(7, 65); varUint8(w, end - i - 5); i = end - 1; }
    }
  }
  for (let i = 0; i < counts.length; i++) {
    if (i !== omit && logs[i] > 1) {
      const bits = logs[i] - 1, kept = countPrecision(bits, shift);
      w.write(kept, (counts[i] - (1 << bits)) >> (bits - kept));
    }
    if (repeats?.[i]) i += repeats[i] - 1;
  }
}

export function reverseAlias(counts, logAlphabet) {
  const size = 1 << logAlphabet, entry = 4096 >> logAlphabet;
  const starts = new Uint16Array(counts.length + 1), reverse = new Uint16Array(4096);
  let single = -1;
  for (let i = 0; i < counts.length; i++) {
    starts[i + 1] = starts[i] + counts[i];
    if (counts[i] === 4096) single = i;
  }
  if (single >= 0) {
    for (let i = 0; i < 4096; i++) reverse[i] = i;
    return {starts, reverse};
  }
  const cutoffs = new Int32Array(size), aliases = new Uint16Array(size), offsets = new Int32Array(size);
  const under = [], over = [];
  cutoffs.set(counts);
  for (let i = 0; i < size; i++) {
    if (cutoffs[i] < entry) under.push(i);
    else if (cutoffs[i] > entry) over.push(i);
  }
  while (over.length) {
    const from = over.pop(), to = under.pop(), taken = entry - cutoffs[to];
    cutoffs[from] -= taken;
    aliases[to] = from; offsets[to] = cutoffs[from] - cutoffs[to];
    if (cutoffs[from] < entry) under.push(from);
    else if (cutoffs[from] > entry) over.push(from);
  }
  for (let i = 0; i < size; i++) {
    const cutoff = cutoffs[i], start = starts[i], aliased = starts[aliases[i]] + offsets[i], base = i * entry;
    for (let j = 0; j < cutoff; j++) reverse[start + j] = base + j;
    for (let j = cutoff; j < entry; j++) reverse[aliased + j] = base + j;
  }
  return {starts, reverse};
}

function expectedDataBits(freqs, counts) {
  let bits = 0;
  for (let s = 0; s < freqs.length; s++) if (freqs[s]) bits += freqs[s] * SYMBOL_BITS[counts[s]];
  return bits;
}

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

export function buildAnsCoding(counts, options) {
  const shaped = new WeakMap();
  const shapedCost = (freqs, config) => {
    const header = new BitCount(), shape = shapeHistogram(freqs, options?.shifts);
    shaped.set(freqs, shape);
    writeUintConfig(header, config, Math.max(5, ceilLog2(freqs.findLastIndex(Boolean) + 1)));
    return header.bitLength + shape.bits;
  };
  const clustered = clusterTokenCounts(counts, options, histogramCost, symbolCosts, shapedCost);
  let bits = 32;
  const histograms = clustered.histograms.map(({config, freqs, extra}) => {
    const {counts, shift, omit} = shaped.get(freqs) ?? shapeHistogram(freqs, options?.shifts);
    bits += extra + expectedDataBits(freqs, counts);
    return {config, counts, shift, omit};
  });
  const logAlphabet = Math.max(5, ceilLog2(Math.max(...histograms.map(h => h.counts.length))), ...histograms.map(h => h.config.split));
  for (const histogram of histograms) Object.assign(histogram, reverseAlias(histogram.counts, logAlphabet));
  const header = new BitWriter();
  header.write(1, 0);
  if (clustered.contextMap.length > 1) (options?.smallestMap ? writeSmallestContextMap : writeContextMap)(header, clustered.contextMap);
  header.write(1, 0); header.write(2, logAlphabet - 5);
  for (const histogram of histograms) writeUintConfig(header, histogram.config, logAlphabet);
  for (const histogram of histograms) writeDistribution(header, histogram.counts, true, histogram.shift, histogram.omit);

  const model = {kind: 'ans', contextMap: clustered.contextMap,
    histograms: histograms.map(({config, counts, starts, reverse}) => ({config, counts, starts, reverse}))};
  const {write, writeTokens, writeFilled, flush, reset} = options?.kernels?.ansWriter(model) ?? ansGroupWriter(model);
  return {bits: bits + header.bitLength, payloadBits: bits, model, write, writeTokens, writeFilled, flush, reset, writeHistograms: w => w.append(header)};
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
