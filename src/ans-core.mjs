// SPDX-License-Identifier: MIT
import {floorLog2} from './bits.mjs';
import {kernelHooks, ensured, missing, declined} from './kernel-hooks.mjs';
import {writeContextMap, writeUintConfig} from './prefix.mjs';

export const LOG_LENGTHS = [5, 4, 4, 4, 4, 4, 3, 3, 3, 3, 3, 6, 7];
export const LOG_CODES = [17, 11, 15, 3, 9, 7, 4, 2, 5, 6, 0, 33, 1];
export const SYMBOL_BITS = new Float64Array(4097);
for (let count = 1; count <= 4096; count++) SYMBOL_BITS[count] = 12 - Math.log2(count);

function varUint8(w, value) {
  if (!value) { w.write(1, 0); return; }
  const n = floorLog2(value);
  w.write(1, 1); w.write(3, n); w.write(n, value - (1 << n));
}

export function normalise(freqs) {
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

export function shapeHistogram(freqs, headerAware = false) {
  let total = 0, last = 0, omit = 0, used = 0;
  for (let i = 0; i < freqs.length; i++) if (freqs[i]) { total += freqs[i]; last = i + 1; used++; if (freqs[i] > freqs[omit]) omit = i; }
  if (used <= 2) { const counts = normalise(freqs); return {counts, shift: 12, omit: -1, bits: distributionBits(counts, 12, -1) + expectedDataBits(freqs, counts)}; }
  const shaped = (kernelHooks.shape ?? ensured().shape ?? missing())(freqs, last, total, omit, SHAPE_TABLES, headerAware);
  if (!shaped) throw declined('shape');
  return shaped.none ? null : shaped;
}
const gammaBits = shift => { const log = floorLog2(shift + 1); return 2 * log + (log < 3 ? 1 : 0); };
const REPEATS = Array.from({length: 13}, (_, shift) => shift < 12 && gammaBits(shift) === gammaBits(shift + 1) &&
  Array.from({length: 11}, (_, b) => b + 1).every(bits => countPrecision(bits, shift) === countPrecision(bits, shift + 1)));
const LOG2 = new Float64Array(4097);
for (let n = 1; n <= 4096; n++) LOG2[n] = Math.log2(n);
function distributionBits(counts, shift, omit) { return distributionLength(counts, true, shift, omit); }
const SHAPE_TABLES = Object.freeze({log2: LOG2, symbolBits: SYMBOL_BITS, logLengths: Int32Array.from(LOG_LENGTHS), repeats: Int32Array.from(REPEATS, Number)});

const varUint8Length = value => value ? 4 + floorLog2(value) : 1;
export function distributionLength(counts, runs = false, shift = 12, omit = -1) {
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

export function writeDistribution(w, counts, runs = false, shift = 12, omit = -1) {
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

const ALIAS_CUTOFFS = new Int32Array(256);
const ALIAS_ALIASES = new Uint16Array(256);
const ALIAS_OFFSETS = new Int32Array(256);
const ALIAS_UNDER = new Uint16Array(256);
const ALIAS_OVER = new Uint16Array(256);
const ALIAS_IOTA = Uint16Array.from({length: 4096}, (_, i) => i);
export function reverseAlias(counts, logAlphabet) {
  const size = 1 << logAlphabet, entry = 4096 >> logAlphabet;
  const starts = new Uint16Array(counts.length + 1), reverse = new Uint16Array(4096);
  let single = -1;
  for (let i = 0; i < counts.length; i++) {
    starts[i + 1] = starts[i] + counts[i];
    if (counts[i] === 4096) single = i;
  }
  if (single >= 0) {
    reverse.set(ALIAS_IOTA);
    return {starts, reverse};
  }
  const cutoffs = size <= 256 ? ALIAS_CUTOFFS : new Int32Array(size);
  const aliases = size <= 256 ? ALIAS_ALIASES : new Uint16Array(size);
  const offsets = size <= 256 ? ALIAS_OFFSETS : new Int32Array(size);
  const under = size <= 256 ? ALIAS_UNDER : new Uint16Array(size);
  const over = size <= 256 ? ALIAS_OVER : new Uint16Array(size);
  cutoffs.fill(0, 0, size); aliases.fill(0, 0, size); offsets.fill(0, 0, size);
  cutoffs.set(counts);
  let uLen = 0, oLen = 0;
  for (let i = 0; i < size; i++) {
    if (cutoffs[i] < entry) under[uLen++] = i;
    else if (cutoffs[i] > entry) over[oLen++] = i;
  }
  while (oLen > 0) {
    const from = over[--oLen], to = under[--uLen], taken = entry - cutoffs[to];
    cutoffs[from] -= taken;
    aliases[to] = from; offsets[to] = cutoffs[from] - cutoffs[to];
    if (cutoffs[from] < entry) under[uLen++] = from;
    else if (cutoffs[from] > entry) over[oLen++] = from;
  }
  for (let i = 0; i < size; i++) {
    const cutoff = cutoffs[i], start = starts[i], aliased = starts[aliases[i]] + offsets[i], base = i * entry;
    if (cutoff >= 16 && start >= 0 && start + cutoff <= 4096) reverse.set(ALIAS_IOTA.subarray(base, base + cutoff), start);
    else for (let j = 0; j < cutoff; j++) reverse[start + j] = base + j;
    if (entry - cutoff >= 16 && aliased + cutoff >= 0 && aliased + entry <= 4096) reverse.set(ALIAS_IOTA.subarray(base + cutoff, base + entry), aliased + cutoff);
    else for (let j = cutoff; j < entry; j++) reverse[aliased + j] = base + j;
  }
  return {starts, reverse};
}

export function expectedDataBits(freqs, counts) {
  let bits = 0;
  for (let s = 0; s < freqs.length; s++) if (freqs[s]) bits += freqs[s] * SYMBOL_BITS[counts[s]];
  return bits;
}

export function writeAnsHistograms(w, contextMap, logAlphabet, configs, histograms, mapWriter = writeContextMap) {
  if (contextMap.length > 1) mapWriter(w, contextMap);
  w.write(1, 0); w.write(2, logAlphabet - 5);
  for (const config of configs) writeUintConfig(w, config, logAlphabet);
  for (const h of histograms) writeDistribution(w, h.counts, true, h.shift, h.omit);
}

export function writeModularAnsHeader(w, lz77, contextMap, logAlphabet, configs, histograms, mapWriter = writeContextMap) {
  w.write(1, lz77 ? 1 : 0);
  if (lz77) {
    w.writeU32([[0, 224], [0, 512], [0, 4096], [15, 8]], lz77.minSymbol);
    w.writeU32([[0, 3], [0, 4], [2, 5], [8, 9]], lz77.minLength);
    writeUintConfig(w, lz77.lengthConfig, 8);
  }
  writeAnsHistograms(w, contextMap, logAlphabet, configs, histograms, mapWriter);
}

export function writeAnsDistributionBundle(w, histograms, logAlphabet) {
  w.write(1, 0); w.write(2, logAlphabet - 5);
  for (const histogram of histograms) writeUintConfig(w, histogram.config, logAlphabet);
  for (const histogram of histograms) writeDistribution(w, histogram.counts, true, histogram.shift, histogram.omit);
}
