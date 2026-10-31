// Prefix codes and histogram bundles. MIT (images/jxl/LICENSE).
import {BitWriter, floorLog2, ceilLog2} from './bits.mjs';

const CODE_LENGTH_ORDER = [1, 2, 3, 4, 0, 5, 17, 6, 16, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const CLCL_BITS = [2, 4, 3, 2, 2, 4], CLCL_CODE = [0, 7, 3, 2, 1, 15];
const REV8 = Uint8Array.from({length: 256}, (_, b) => {
  let out = 0, v = b;
  for (let i = 0; i < 8; i++) { out = (out << 1) | (v & 1); v >>= 1; }
  return out;
});
const reverseBits = (value, count) => ((REV8[value & 255] << 8) | REV8[(value >>> 8) & 255]) >>> (16 - count);

const HUFF_WEIGHTS = new Float64Array(1024);
const HUFF_PARENTS = new Int32Array(1024);
const CANON_COUNTS = new Uint32Array(17);
const CANON_NEXT = new Uint32Array(17);

export function codeLengths(freqs, limit, used, size = freqs.length) {
  const lengths = new Uint8Array(size);
  if (!used) {
    used = [];
    for (let i = 0; i < size; i++) if (freqs[i] > 0) used.push(i);
  }
  const count = used.length;
  if (!count) return lengths;
  if (count === 1) { lengths[used[0]] = 1; return lengths; }
  const nodes = count * 2 - 1;
  const weights = nodes <= 1024 ? HUFF_WEIGHTS : new Float64Array(nodes);
  const parents = nodes <= 1024 ? HUFF_PARENTS : new Int32Array(nodes);
  for (let floor = 1; ; floor *= 2) {
    used.sort((a, b) => Math.max(freqs[a], floor) - Math.max(freqs[b], floor) || a - b);
    for (let i = 0; i < count; i++) weights[i] = Math.max(freqs[used[i]], floor);
    let li = 0, ii = count;
    for (let next = count; next < nodes; next++) {
      const a = li < count && (ii >= next || weights[li] <= weights[ii]) ? li++ : ii++;
      const b = li < count && (ii >= next || weights[li] <= weights[ii]) ? li++ : ii++;
      weights[next] = weights[a] + weights[b]; parents[a] = next; parents[b] = next;
    }
    parents[nodes - 1] = 0;
    for (let i = nodes - 2; i >= count; i--) parents[i] = parents[parents[i]] + 1;
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

export function canonicalCodes(lengths) {
  const counts = CANON_COUNTS, next = CANON_NEXT, codes = new Uint16Array(lengths.length);
  counts.fill(0);
  for (let i = 0; i < lengths.length; i++) counts[lengths[i]]++;
  counts[0] = 0;
  for (let length = 1, code = 0; length <= 16; length++) { code = (code + counts[length - 1]) << 1; next[length] = code; }
  for (let i = 0; i < lengths.length; i++) {
    const l = lengths[i];
    if (l) codes[i] = reverseBits(next[l]++, l);
  }
  return codes;
}

export function buildCode(freqs) {
  const code = priceCode(freqs);
  code.codes = canonicalCodes(code.lengths);
  return code;
}
export function priceCode(freqs, used) {
  if (!used) { used = []; for (let i = 0; i < freqs.length; i++) if (freqs[i] > 0) used.push(i); } else used = [...used];
  const count = used.length, alphabetSize = used[count - 1] + 1 || 1;
  const lengths = count <= 4 ? new Uint8Array(alphabetSize) : codeLengths(freqs, 15, used, alphabetSize);
  let treeSelect = 0;
  if (count <= 4) {
    used.sort((a, b) => freqs[b] - freqs[a] || a - b);
    treeSelect = count === 4 && freqs[used[0]] > freqs[used[2]] + freqs[used[3]] ? 1 : 0;
    const depths = count < 2 ? [0] : count === 2 ? [1, 1] : count === 3 ? [1, 2, 2] : treeSelect ? [1, 2, 3, 3] : [2, 2, 2, 2];
    for (let index = 0; index < count; index++) lengths[used[index]] = depths[index];
    used.sort((a, b) => lengths[a] - lengths[b] || a - b);
  }
  return {alphabetSize, lengths, codes: null, simple: count && count <= 4 ? used : null, treeSelect};
}

function runEnd(lengths, i, last, value) { while (i <= last && lengths[i] === value) i++; return i; }

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
    const value = lengths[i], run = runEnd(lengths, i + 1, last, value) - i;
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

const CODED_MAP_LITERAL = uintConfig(8), CODED_MAP_LENGTH = uintConfig(4), CODED_MAP_DISTANCE = uintConfig(0);
const ONE_DISTANCE_CODE = buildCode(Uint32Array.of(1));
const CODED_MAP_FREQ = new Uint32Array(257);
let CODED_PIECE_IDX = new Uint16Array(4096);
let CODED_PIECE_COPY = new Uint32Array(4096);

export function writeContextMap(w, contextMap) {
  let widest = 0;
  for (let i = 0; i < contextMap.length; i++) if (contextMap[i] > widest) widest = contextMap[i];
  const bits = widest ? ceilLog2(widest + 1) : 0;
  if (bits <= 3) {
    if (bits && contextMap.length >= 64) {
      const coded = new BitWriter(64);
      writeCodedContextMap(coded, contextMap, widest);
      if (coded.bitLength < 3 + bits * contextMap.length) { w.append(coded); return; }
    }
    w.write(1, 1); w.write(2, bits);
    if (bits) for (let i = 0; i < contextMap.length; i++) w.write(bits, contextMap[i]);
    return;
  }
  writeCodedContextMap(w, contextMap, widest);
}

function writeCodedContextMap(w, contextMap, widest) {
  w.write(1, 0); w.write(1, 0);
  const config = CODED_MAP_LITERAL, length = CODED_MAP_LENGTH, minLength = 7, minSymbol = 224;
  const runs = contextMap.length >= 64 && widest < minSymbol, fLen = runs ? minSymbol + 33 : widest + 1;
  const freqs = fLen <= 257 ? CODED_MAP_FREQ.subarray(0, fLen) : new Uint32Array(fLen);
  freqs.fill(0);
  if (CODED_PIECE_IDX.length < contextMap.length) {
    CODED_PIECE_IDX = new Uint16Array(contextMap.length);
    CODED_PIECE_COPY = new Uint32Array(contextMap.length);
  }
  const pieceIdx = CODED_PIECE_IDX, pieceCopy = CODED_PIECE_COPY;
  let pCount = 0;
  for (let i = 0; i < contextMap.length;) {
    const v = contextMap[i];
    let run = 1;
    while (runs && i + run < contextMap.length && contextMap[i + run] === v) run++;
    if (run >= minLength + 1) {
      pieceIdx[pCount] = v; pieceCopy[pCount++] = run - 1;
      freqs[v]++; countToken(length, run - 1 - minLength, freqs, minSymbol);
      i += run;
    } else {
      for (let k = 0; k < run; k++) { pieceIdx[pCount] = v; pieceCopy[pCount++] = 0; freqs[v]++; }
      i += run;
    }
  }
  const code = buildCode(freqs);
  if (!runs) {
    writeHistograms(w, {contextMap: new Uint8Array(1), histograms: [{config, code}]});
    for (let i = 0; i < pCount; i++) writeHybrid(w, code, config, pieceIdx[i]);
    return;
  }
  writeHistograms(w, {lz77: {minSymbol, minLength, lengthConfig: length}, contextMap: new Uint8Array([1, 0]), histograms: [{config: CODED_MAP_DISTANCE, code: ONE_DISTANCE_CODE}, {config, code}]});
  for (let i = 0; i < pCount; i++) {
    const index = pieceIdx[i], copy = pieceCopy[i];
    w.write(code.lengths[index], code.codes[index]);
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
