// SPDX-License-Identifier: MIT
import {BitWriter, ceilLog2, floorLog2} from './bits.mjs';
import {hybridToken, writeContextMap, writeUintConfig} from './prefix.mjs';
import {clusterTokenCounts, entropyLog2} from './entropy.mjs';
import {LZ77, RESIDUAL_CONFIG} from './modular.mjs';

export const LOG_LENGTHS = [5, 4, 4, 4, 4, 4, 3, 3, 3, 3, 3, 6, 7];
export const LOG_CODES = [17, 11, 15, 3, 9, 7, 4, 2, 5, 6, 0, 33, 1];
const GROUP_TOKENS = 3 * 32 * 32 * 64;
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

function writeDistribution(w, counts, runs = false) {
  const used = [];
  let omit = 0;
  for (let i = 0; i < counts.length; i++) {
    if (counts[i]) used.push(i);
    if (counts[i] > counts[omit]) omit = i;
  }
  if (used.length <= 2) {
    w.write(1, 1); w.write(1, used.length - 1);
    for (const symbol of used) varUint8(w, symbol);
    if (used.length === 2) w.write(12, counts[used[0]]);
    return;
  }
  w.write(1, 0); w.write(1, 0);
  w.write(3, 7); w.write(3, 5);
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
    if (i !== omit && logs[i] > 1) { const bits = logs[i] - 1; w.write(bits, counts[i] - (1 << bits)); }
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
  for (let i = 0; i < size; i++) for (let j = 0; j < entry; j++) {
    const own = j < cutoffs[i], symbol = own ? i : aliases[i], offset = own ? j : j + offsets[i];
    reverse[starts[symbol] + offset] = i * entry + j;
  }
  return {starts, reverse};
}

function expectedDataBits(freqs, counts) {
  let bits = 0;
  for (let s = 0; s < freqs.length; s++) if (freqs[s]) bits += freqs[s] * SYMBOL_BITS[counts[s]];
  return bits;
}

function histogramCost(freqs, config) {
  const counts = normalise(freqs), header = new BitWriter(256);
  writeUintConfig(header, config, 8);
  writeDistribution(header, counts, true);
  return header.bitLength + expectedDataBits(freqs, counts);
}

function symbolCosts(freqs) {
  const counts = normalise(freqs), costs = new Float64Array(freqs.length).fill(12);
  for (let s = 0; s < counts.length; s++) if (counts[s]) costs[s] = SYMBOL_BITS[counts[s]];
  return costs;
}

export function buildAnsCoding(counts, options) {
  const clustered = clusterTokenCounts(counts, options, histogramCost, symbolCosts);
  let bits = 32;
  const histograms = clustered.histograms.map(({config, freqs, extra}) => {
    const counts = normalise(freqs);
    bits += extra + expectedDataBits(freqs, counts);
    return {config, counts};
  });
  const logAlphabet = Math.max(5, ceilLog2(Math.max(...histograms.map(h => h.counts.length))));
  for (const histogram of histograms) Object.assign(histogram, reverseAlias(histogram.counts, logAlphabet));
  const header = new BitWriter();
  header.write(1, 0);
  if (clustered.contextMap.length > 1) writeContextMap(header, clustered.contextMap);
  header.write(1, 0); header.write(2, logAlphabet - 5);
  for (const histogram of histograms) writeUintConfig(header, histogram.config, logAlphabet);
  for (const histogram of histograms) writeDistribution(header, histogram.counts, true);

  const values = new Uint32Array(GROUP_TOKENS), metadata = new Uint8Array(GROUP_TOKENS), emitted = new Uint16Array(GROUP_TOKENS);
  const slots = [0, 0, 0];
  let length = 0;
  const write = (_w, ctx, value) => {
    values[length] = value; metadata[length++] = clustered.contextMap[ctx];
  };
  const flush = w => {
    let state = 0x13 * 65536;
    for (let i = length - 1; i >= 0; i--) {
      const h = histograms[metadata[i]];
      hybridToken(h.config, values[i], slots);
      const symbol = slots[0], freq = h.counts[symbol];
      values[i] = slots[2]; metadata[i] = slots[1];
      if ((state >>> 20) >= freq) {
        emitted[i] = state & 65535; metadata[i] |= 64; state >>>= 16;
      }
      const q = Math.floor(state / freq);
      state = q * 4096 + h.reverse[h.starts[symbol] + state - q * freq];
    }
    w.write(32, state);
    for (let i = 0; i < length; i++) {
      if (metadata[i] & 64) w.write(16, emitted[i]);
      const bits = metadata[i] & 63;
      if (bits) w.write(bits, values[i]);
    }
    length = 0;
  };
  return {bits: bits + header.bitLength, write, flush, writeHistograms: w => w.append(header)};
}

export function writeModularAnsHistograms(w, orderedLeaves, freqs, histogramOf = leaf => leaf.context, configOf = () => RESIDUAL_CONFIG) {
  const contextMap = new Uint8Array(orderedLeaves.length + 1);
  for (const leaf of orderedLeaves) contextMap[leaf.context] = histogramOf(leaf) + 1;
  const distance = new Uint32Array(2); distance[1] = 1;
  const histograms = [distance, ...freqs.slice(0, Math.max(...contextMap))].map(freq => ({counts: normalise(freq)}));
  const logAlphabet = Math.max(5, ceilLog2(Math.max(...histograms.map(h => h.counts.length))));
  if (logAlphabet > 8) throw new Error('Modular ANS alphabet exceeds 256');
  for (const histogram of histograms) Object.assign(histogram, reverseAlias(histogram.counts, logAlphabet));
  w.write(1, 1);
  w.writeU32([[0, 224], [0, 512], [0, 4096], [15, 8]], LZ77.minSymbol);
  w.writeU32([[0, 3], [0, 4], [2, 5], [8, 9]], LZ77.minLength);
  writeUintConfig(w, LZ77.lengthConfig, 8);
  if (contextMap.length > 1) writeContextMap(w, contextMap);
  w.write(1, 0); w.write(2, logAlphabet - 5);
  for (let i = 0; i < histograms.length; i++) writeUintConfig(w, i ? configOf(i - 1) : RESIDUAL_CONFIG, logAlphabet);
  for (const histogram of histograms) writeDistribution(w, histogram.counts, true);
  const encode = (plans, output) => {
    const length = plans.reduce((total, plan) => total + plan.used, 0), emitted = output ? new Uint16Array(length) : null;
    let state = 0x13 * 65536, at = length, offset = histograms.length, bits = 32;
    for (let c = plans.length - 1; c >= 0; c--) {
      const plan = plans[c], map = plan.histogramMap; offset -= plan.freqs.length;
      for (let i = plan.used - 1; i >= 0; i--) {
        const tag = plan.tags[i], h = histograms[offset + (map ? map[tag >>> 16] : tag >>> 16)], symbol = tag & 511, freq = h.counts[symbol];
        --at;
        bits += (tag >>> 9) & 63;
        if ((state >>> 20) >= freq) {
          bits += 16;
          if (output) { emitted[at] = state & 65535; plan.tags[i] |= 32768; }
          state >>>= 16;
        }
        const q = Math.floor(state / freq);
        state = q * 4096 + h.reverse[h.starts[symbol] + state - q * freq];
      }
    }
    if (!output) return bits;
    output.write(32, state); at = 0;
    for (const plan of plans) for (let i = 0; i < plan.used; i++, at++) {
      if (plan.tags[i] & 32768) { output.write(16, emitted[at]); plan.tags[i] &= ~32768; }
      const rawBits = (plan.tags[i] >>> 9) & 63;
      if (rawBits) output.write(rawBits, plan.extra[i]);
    }
    return bits;
  };
  const write = plans => encode(plans, w);
  write.measure = plans => encode(plans, null);
  return write;
}
