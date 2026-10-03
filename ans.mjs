// SPDX-License-Identifier: MIT
// Optional JPEG XL ANS coding. The core imports none of this module.
// The normative alias construction follows ISO/IEC 18181-1; libjxl 0.11.2's
// ans_common.cc and enc_ans.cc were consulted for the wire layout.
import {BitWriter, ceilLog2, floorLog2} from './bits.mjs';
import {hybridToken, writeContextMap, writeUintConfig} from './prefix.mjs';
import {buildTokenCoding} from './entropy.mjs';

const LOG_LENGTHS = [5, 4, 4, 4, 4, 4, 3, 3, 3, 3, 3, 6, 7];
const LOG_CODES = [17, 11, 15, 3, 9, 7, 4, 2, 5, 6, 0, 33, 1];
// A VarDCT group has at most three 32x32-block planes. Each block emits one
// nonzero-count token and at most 63 AC tokens; alpha uses its separate modular stream.
const GROUP_TOKENS = 3 * 32 * 32 * 64;

function varUint8(w, value) {
  if (!value) { w.write(1, 0); return; }
  const n = floorLog2(value);
  w.write(1, 1); w.write(3, n); w.write(n, value - (1 << n));
}

// Correct the largest rounding error until the table totals exactly 4096.
// Every represented symbol keeps a positive count, including rare symbols.
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

function writeDistribution(w, counts) {
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
  // Full count precision: shift 12, encoded by the bounded gamma form.
  w.write(3, 7); w.write(3, 5);
  varUint8(w, counts.length - 3);
  const logs = new Uint8Array(counts.length);
  let omitLog = 0;
  for (let i = 0; i < counts.length; i++) if (i !== omit && counts[i]) {
    logs[i] = floorLog2(counts[i]) + 1;
    omitLog = Math.max(omitLog, logs[i] + (i < omit ? 1 : 0));
  }
  logs[omit] = omitLog;
  for (const log of logs) w.write(LOG_LENGTHS[log], LOG_CODES[log]);
  for (let i = 0; i < counts.length; i++) if (i !== omit && logs[i] > 1) {
    const bits = logs[i] - 1;
    w.write(bits, counts[i] - (1 << bits));
  }
}

// Invert the decoder's alias table once per histogram. State remainders then
// use one indexed load, with no search or approximation in the symbol loop.
function reverseAlias(counts, logAlphabet) {
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

export function buildAnsCoding(counts, options) {
  const prefix = buildTokenCoding(counts, options);
  const contexts = prefix.histograms.map(() => []);
  for (let ctx = 0; ctx < counts.contexts; ctx++) if (counts.totals[ctx]) contexts[prefix.contextMap[ctx]].push(ctx);
  const histograms = prefix.histograms.map(({config}, i) => ({config, counts: normalise(counts.tokens(contexts[i], config, 256))}));
  const logAlphabet = Math.max(5, ceilLog2(Math.max(...histograms.map(h => h.counts.length))));
  for (const histogram of histograms) Object.assign(histogram, reverseAlias(histogram.counts, logAlphabet));
  const header = new BitWriter();
  header.write(1, 0);
  if (prefix.contextMap.length > 1) writeContextMap(header, prefix.contextMap);
  header.write(1, 0); header.write(2, logAlphabet - 5);
  for (const histogram of histograms) writeUintConfig(header, histogram.config, logAlphabet);
  for (const histogram of histograms) writeDistribution(header, histogram.counts);

  // One group's storage is reused for every group; image dimensions never
  // multiply this reverse-order workspace. No input or coefficient is mutated.
  // The shared cluster builder caps histogram IDs at 48, so metadata fits one byte.
  const values = new Uint32Array(GROUP_TOKENS), metadata = new Uint8Array(GROUP_TOKENS), emitted = new Uint16Array(GROUP_TOKENS);
  const slots = [0, 0, 0];
  let length = 0;
  const write = (_w, ctx, value) => {
    values[length] = value; metadata[length++] = prefix.contextMap[ctx];
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
  // Preserve the original bucket/context choice to isolate prefix versus ANS.
  return {bits: prefix.bits, write, flush, writeHistograms: w => w.append(header)};
}
