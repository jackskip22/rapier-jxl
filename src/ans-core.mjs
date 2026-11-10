// SPDX-License-Identifier: MIT
import {floorLog2} from './bits.mjs';
import {entropyLog2} from './entropy-log.mjs';
import {kernelHooks} from './kernel-hooks.mjs';
import {writeContextMap, writeUintConfig} from './prefix.mjs';

export const LOG_LENGTHS = [5, 4, 4, 4, 4, 4, 3, 3, 3, 3, 3, 6, 7];
export const LOG_CODES = [17, 11, 15, 3, 9, 7, 4, 2, 5, 6, 0, 33, 1];
export const SYMBOL_BITS = new Float64Array(4097);
for (let count = 1; count <= 4096; count++) SYMBOL_BITS[count] = 12 - entropyLog2(count);

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

const SHAPE_ACTIVE = new Uint16Array(512);
const SHAPE_TARGETS = new Float64Array(512);
const SHAPE_ROUNDS = new Uint16Array(512);
const SHAPE_CAPS = new Uint16Array(512);
const SHAPE_UPS = new Uint16Array(512);
const SHAPE_DOWNS = new Uint16Array(512);
const SHAPE_UP_GAINS = new Float64Array(512);
const SHAPE_DOWN_GAINS = new Float64Array(512);

export function shapeHistogram(freqs, shifts = SHIFTS, headerAware = false) {
  let total = 0, last = 0, omit = 0, used = 0;
  for (let i = 0; i < freqs.length; i++) if (freqs[i]) { total += freqs[i]; last = i + 1; used++; if (freqs[i] > freqs[omit]) omit = i; }
  if (used <= 2) { const counts = normalise(freqs); return {counts, shift: 12, omit: -1, bits: distributionBits(counts, 12, -1) + expectedDataBits(freqs, counts)}; }
  if (shifts === SHIFTS) { const kernel = kernelHooks.shape?.(freqs, last, total, omit, SHAPE_TABLES, headerAware); if (kernel) return kernel.none ? null : kernel; }
  const active = last <= 512 ? SHAPE_ACTIVE : new Uint16Array(last);
  const targets = last <= 512 ? SHAPE_TARGETS : new Float64Array(last);
  const rounds = last <= 512 ? SHAPE_ROUNDS : new Uint16Array(last);
  const caps = last <= 512 ? SHAPE_CAPS : new Uint16Array(last);
  const ups = last <= 512 ? SHAPE_UPS : new Uint16Array(last);
  const downs = last <= 512 ? SHAPE_DOWNS : new Uint16Array(last);
  const upGains = last <= 512 ? SHAPE_UP_GAINS : new Float64Array(last);
  const downGains = last <= 512 ? SHAPE_DOWN_GAINS : new Float64Array(last);
  let actLen = 0, maxRoundBits = 0;
  for (let i = 0; i < last; i++) if (freqs[i] && i !== omit) {
    const idx = actLen++;
    active[idx] = i;
    const t = freqs[i] * 4096 / total, cap = i < omit ? 2047 : 4095, r = Math.max(1, Math.min(cap, Math.round(t)));
    targets[idx] = t; caps[idx] = cap; rounds[idx] = r;
    const b = floorLog2(r);
    if (b > maxRoundBits) maxRoundBits = b;
  }
  const f0 = freqs[omit];
  let best = null, prevShift = -1, prevCounts = null, prevBits = 0, prevMaxBits = 0;
  for (let k = 0; k < shifts.length; k++) {
    const shift = shifts[k];
    if (REPEATS[shift] && shifts.indexOf(shift + 1) >= 0 && shifts.indexOf(shift + 1) < k) continue;
    if (prevCounts !== null) {
      const checkMax = Math.min(11, Math.max(maxRoundBits, prevMaxBits) + 1);
      let same = true;
      for (let b = 1; b <= checkMax; b++) if (countPrecision(b, shift) !== countPrecision(b, prevShift)) { same = false; break; }
      if (same) {
        const bits = prevBits - gammaBits(prevShift) + gammaBits(shift);
        prevShift = shift; prevBits = bits;
        if (!best || bits < best.bits) best = {counts: prevCounts, shift, omit, bits};
        continue;
      }
    }
    const counts = new Uint16Array(last);
    let sum = 0;
    for (let idx = 0; idx < actLen; idx++) {
      const i = active[idx], target = targets[idx], cap = caps[idx];
      let c = rounds[idx];
      if (c > 1) { const bits = floorLog2(c), step = stepOf(c, shift); c = (1 << bits) + Math.floor((c - (1 << bits)) / step) * step; }
      const up = countUp(c, shift);
      if (up <= cap && up - target < target - c) c = up;
      counts[i] = c; sum += c;
    }
    if (sum >= 4096) { prevCounts = null; continue; }
    let initialBits = Infinity, initialCounts = null, initialMaxBits = 0;
    if (headerAware) {
      counts[omit] = 4096 - sum;
      initialBits = distributionBits(counts, shift, omit) + expectedDataBits(freqs, counts);
      initialCounts = counts.slice();
      for (let idx = 0; idx < actLen; idx++) initialMaxBits = Math.max(initialMaxBits, floorLog2(counts[active[idx]]));
      if (!best || initialBits < best.bits) best = {counts: initialCounts, shift, omit, bits: initialBits};
    }
    const symbolHeader = c => { const b = floorLog2(c); return LOG_LENGTHS[b + 1] + (b ? countPrecision(b, shift) : 0); };
    const steps = idx => {
      const i = active[idx], c = counts[i], cap = caps[idx], here = LOG2[c], h0 = headerAware ? symbolHeader(c) : 0, up = countUp(c, shift), down = countDown(c, shift);
      ups[idx] = up <= cap ? up : 0; downs[idx] = down;
      if (up <= cap) upGains[idx] = freqs[i] * (LOG2[up] - here) - (headerAware ? symbolHeader(up) - h0 : 0);
      if (down >= 1) downGains[idx] = freqs[i] * (LOG2[down] - here) - (headerAware ? symbolHeader(down) - h0 : 0);
    };
    for (let idx = 0; idx < actLen; idx++) steps(idx);
    for (let moves = 0; moves < 4 * last; moves++) {
      const rest = 4096 - sum, restBits = LOG2[rest];
      let chosenIdx = -1, to = 0, gain = 1e-9;
      for (let idx = 0; idx < actLen; idx++) {
        const i = active[idx], c = counts[i], up = ups[idx], down = downs[idx];
        if (up && rest - (up - c) >= 1) {
          const g = upGains[idx] + f0 * (LOG2[rest - (up - c)] - restBits);
          if (g > gain) { gain = g; chosenIdx = idx; to = up; }
        }
        if (down >= 1) {
          const g = downGains[idx] + f0 * (LOG2[rest + c - down] - restBits);
          if (g > gain) { gain = g; chosenIdx = idx; to = down; }
        }
      }
      if (chosenIdx < 0) break;
      const chosen = active[chosenIdx];
      sum += to - counts[chosen]; counts[chosen] = to; steps(chosenIdx);
    }
    counts[omit] = 4096 - sum;
    let maxB = 0, dataBits = f0 * SYMBOL_BITS[counts[omit]];
    for (let idx = 0; idx < actLen; idx++) {
      const i = active[idx], c = counts[i], b = floorLog2(c);
      if (b > maxB) maxB = b;
      dataBits += freqs[i] * SYMBOL_BITS[c];
    }
    const bits = distributionBits(counts, shift, omit) + dataBits;
    prevShift = shift;
    if (initialBits < bits) { prevCounts = initialCounts; prevBits = initialBits; prevMaxBits = initialMaxBits; }
    else { prevCounts = counts; prevBits = bits; prevMaxBits = maxB; }
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

export function ansEncode(n, ids, freq, start, reverses, emitted, flags) {
  let state = 0x13 * 65536;
  for (let i = n - 1; i >= 0; i--) {
    const f = freq[i];
    if ((state >>> 20) >= f) { emitted[i] = state & 65535; flags[i] = 1; state >>>= 16; }
    const q = Math.floor(state / f);
    state = q * 4096 + reverses[ids[i]][start[i] + state - q * f];
  }
  return state;
}
