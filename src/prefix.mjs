// Prefix codes and histogram bundles. MIT (LICENSE).
import {BitWriter, floorLog2, ceilLog2} from './bits.mjs';

const CODE_LENGTH_ORDER = [1, 2, 3, 4, 0, 5, 17, 6, 16, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const CLCL_BITS = [2, 4, 3, 2, 2, 4], CLCL_CODE = [0, 7, 3, 2, 1, 15];

export function codeLengths(freqs, limit) {
  const lengths = new Uint8Array(freqs.length), used = [];
  for (let i = 0; i < freqs.length; i++) if (freqs[i] > 0) used.push(i);
  const count = used.length;
  if (!count) return lengths;
  if (count === 1) { lengths[used[0]] = 1; return lengths; }
  const weights = new Array(count * 2 - 1), parents = new Array(count * 2 - 1);
  for (let floor = 1; ; floor *= 2) {
    used.sort((a, b) => Math.max(freqs[a], floor) - Math.max(freqs[b], floor) || a - b);
    for (let i = 0; i < count; i++) weights[i] = Math.max(freqs[used[i]], floor);
    let li = 0, ii = count;
    for (let next = count; next < weights.length; next++) {
      const a = li < count && (ii >= next || weights[li] <= weights[ii]) ? li++ : ii++;
      const b = li < count && (ii >= next || weights[li] <= weights[ii]) ? li++ : ii++;
      weights[next] = weights[a] + weights[b]; parents[a] = next; parents[b] = next;
    }
    parents[parents.length - 1] = 0;
    for (let i = parents.length - 2; i >= count; i--) parents[i] = parents[parents[i]] + 1;
    let deepest = 0;
    for (let i = 0; i < count; i++) {
      const depth = parents[parents[i]] + 1;
      lengths[used[i]] = depth;
      if (depth > deepest) deepest = depth;
    }
    if (deepest <= limit) return lengths;
  }
}

function pushRun(tokens, extras, symbol, count, mask, shift) {
  const digits = [];
  for (;;) { digits.push(count & mask); count >>= shift; if (!count) break; count--; }
  for (let i = digits.length - 1; i >= 0; i--) { tokens.push(symbol); extras.push(digits[i]); }
}

function reverseBits(value, count) { let out = 0; for (let i = 0; i < count; i++) { out = (out << 1) | (value & 1); value >>= 1; } return out; }

export function canonicalCodes(lengths) {
  const counts = new Uint32Array(17), next = new Uint32Array(17), codes = new Uint16Array(lengths.length);
  for (const length of lengths) counts[length]++;
  counts[0] = 0;
  for (let length = 1, code = 0; length <= 16; length++) { code = (code + counts[length - 1]) << 1; next[length] = code; }
  for (let i = 0; i < lengths.length; i++) if (lengths[i]) codes[i] = reverseBits(next[lengths[i]]++, lengths[i]);
  return codes;
}

export function buildCode(freqs) {
  const code = priceCode(freqs);
  code.codes = canonicalCodes(code.lengths);
  return code;
}
export function priceCode(freqs) {
  const used = [];
  for (let i = 0; i < freqs.length; i++) if (freqs[i] > 0) used.push(i);
  const count = used.length, alphabetSize = used[count - 1] + 1 || 1;
  const lengths = count <= 4 ? new Uint8Array(alphabetSize) : codeLengths(freqs, 15).subarray(0, alphabetSize);
  let treeSelect = 0;
  if (count <= 4) {
    used.sort((a, b) => freqs[b] - freqs[a] || a - b);
    treeSelect = count === 4 && freqs[used[0]] > freqs[used[2]] + freqs[used[3]] ? 1 : 0;
    const depths = count < 2 ? [0] : count === 2 ? [1, 1] : count === 3 ? [1, 2, 2] : treeSelect ? [1, 2, 3, 3] : [2, 2, 2, 2];
    used.forEach((symbol, index) => { lengths[symbol] = depths[index]; });
    used.sort((a, b) => lengths[a] - lengths[b] || a - b);
  }
  return {alphabetSize, lengths, codes: null, simple: count && count <= 4 ? used : null, treeSelect};
}

export function writePrefixCode(w, code) {
  if (code.alphabetSize <= 1) return;
  if (code.simple) {
    const bits = floorLog2(code.alphabetSize - 1) + 1;
    w.write(2, 1); w.write(2, code.simple.length - 1);
    for (const sym of code.simple) w.write(bits, sym);
    if (code.simple.length === 4) w.write(1, code.treeSelect);
    return;
  }
  const lengths = code.lengths, tokens = [], extras = [];
  let last = lengths.length - 1;
  while (last > 0 && !lengths[last]) last--;
  let previous = 8;
  for (let i = 0; i <= last;) {
    const value = lengths[i];
    let run = 1;
    while (i + run <= last && lengths[i + run] === value) run++;
    let repeats = run;
    if (value && value !== previous) { tokens.push(value); extras.push(0); repeats--; previous = value; }
    if (repeats < 3) for (let k = 0; k < repeats; k++) { tokens.push(value); extras.push(0); }
    else pushRun(tokens, extras, value ? 16 : 17, repeats - 3, value ? 3 : 7, value ? 2 : 3);
    i += run;
  }
  const freqs = new Uint32Array(18);
  for (const token of tokens) freqs[token]++;
  let distinct = 0;
  for (const f of freqs) if (f) distinct++;
  if (distinct === 1) freqs[tokens[0] ? 0 : 1] = freqs[tokens[0]];
  const clcl = codeLengths(freqs, 5), clCodes = canonicalCodes(clcl);
  let count = 18;
  while (count > 0 && !clcl[CODE_LENGTH_ORDER[count - 1]]) count--;
  w.write(2, 0);
  for (let i = 0; i < count; i++) { const length = clcl[CODE_LENGTH_ORDER[i]]; w.write(CLCL_BITS[length], CLCL_CODE[length]); }
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    w.write(clcl[token], clCodes[token]);
    if (token === 16) w.write(2, extras[i]); else if (token === 17) w.write(3, extras[i]);
  }
}

export function uintConfig(split, msb = 0, lsb = 0) { return {split, msb, lsb, splitToken: 1 << split}; }

export function writeUintConfig(w, config, logAlphabetSize = 15) {
  w.write(ceilLog2(logAlphabetSize + 1), config.split);
  if (config.split === logAlphabetSize) return;
  w.write(ceilLog2(config.split + 1), config.msb);
  w.write(ceilLog2(config.split - config.msb + 1), config.lsb);
}

export function hybridToken(config, value, out) {
  if (value < config.splitToken) { out[0] = value; out[1] = 0; out[2] = 0; return; }
  const n = floorLog2(value), below = value - (1 << n), nbits = n - config.msb - config.lsb;
  out[0] = config.splitToken + (((n - config.split) << (config.msb + config.lsb)) | ((below >> (n - config.msb)) << config.lsb) | (below & ((1 << config.lsb) - 1)));
  out[1] = nbits; out[2] = (value >> config.lsb) & ((1 << nbits) - 1);
}

export function countToken(config, value, freqs, base = 0) {
  hybridToken(config, value, scratch);
  freqs[base + scratch[0]]++;
}

const scratch = [0, 0, 0];
export function writeHybrid(w, code, config, value, base = 0) {
  hybridToken(config, value, scratch);
  const symbol = base + scratch[0];
  w.write(code.lengths[symbol], code.codes[symbol]);
  if (scratch[1]) w.write(scratch[1], scratch[2]);
}

export function writeContextMap(w, contextMap) {
  let widest = 0;
  for (const index of contextMap) widest = Math.max(widest, index);
  const bits = widest ? ceilLog2(widest + 1) : 0;
  if (bits <= 3) {
    const coded = new BitWriter(64);
    if (bits && contextMap.length >= 64) writeCodedContextMap(coded, contextMap, widest);
    if (bits && contextMap.length >= 64 && coded.bitLength < 3 + bits * contextMap.length) { w.append(coded); return; }
    w.write(1, 1); w.write(2, bits);
    if (bits) for (const index of contextMap) w.write(bits, index);
    return;
  }
  writeCodedContextMap(w, contextMap, widest);
}

function writeCodedContextMap(w, contextMap, widest) {
  w.write(1, 0); w.write(1, 0);
  const config = uintConfig(8), length = uintConfig(4), minLength = 7, minSymbol = 224;
  const runs = contextMap.length >= 64 && widest < minSymbol, freqs = new Uint32Array(runs ? minSymbol + 33 : widest + 1);
  const pieces = [];
  for (let i = 0; i < contextMap.length;) {
    let run = 1;
    while (runs && i + run < contextMap.length && contextMap[i + run] === contextMap[i]) run++;
    if (run >= minLength + 1) { pieces.push([contextMap[i], run - 1]); freqs[contextMap[i]]++; countToken(length, run - 1 - minLength, freqs, minSymbol); i += run; }
    else { for (let k = 0; k < run; k++) { pieces.push([contextMap[i], 0]); freqs[contextMap[i]]++; } i += run; }
  }
  const code = buildCode(freqs);
  if (!runs) {
    writeHistograms(w, {contextMap: new Uint8Array(1), histograms: [{config, code}]});
    for (const [index] of pieces) writeHybrid(w, code, config, index);
    return;
  }
  const distance = new Uint32Array(1); distance[0] = 1;
  writeHistograms(w, {lz77: {minSymbol, minLength, lengthConfig: length}, contextMap: new Uint8Array([1, 0]), histograms: [{config: uintConfig(0), code: buildCode(distance)}, {config, code}]});
  for (const [index, copy] of pieces) {
    writeHybrid(w, code, config, index);
    if (copy) writeHybrid(w, code, length, copy - minLength, minSymbol);
  }
}

export function writeHistograms(w, {lz77 = null, contextMap, histograms}) {
  w.write(1, lz77 ? 1 : 0);
  if (lz77) {
    w.writeU32([[0, 224], [0, 512], [0, 4096], [15, 8]], lz77.minSymbol);
    w.writeU32([[0, 3], [0, 4], [2, 5], [8, 9]], lz77.minLength);
    writeUintConfig(w, lz77.lengthConfig, 8);
  }
  if (contextMap.length > 1) writeContextMap(w, contextMap);
  w.write(1, 1);
  for (const histogram of histograms) writeUintConfig(w, histogram.config, 15);
  for (const histogram of histograms) {
    const size = histogram.code.alphabetSize - 1;
    if (!size) w.write(1, 0);
    else { const n = floorLog2(size); w.write(1, 1); w.write(4, n); w.write(n, size - (1 << n)); }
  }
  for (const histogram of histograms) writePrefixCode(w, histogram.code);
}
