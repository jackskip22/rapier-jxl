// Rapier's JPEG XL encoder: prefix codes and histogram bundles. MIT (LICENSE).
// The entropy code of every stream Rapier writes is a prefix (Huffman) code, never ANS: simpler, and within a
// percent or two of ANS on the pictures Rapier keeps. The bit layout follows the specification's Brotli-derived
// code header: a simple code for up to four symbols, else code lengths sent through a code-length code with the
// 16 (repeat) and 17 (zeros) run symbols.
import {floorLog2, ceilLog2} from './bits.mjs';

const CODE_LENGTH_ORDER = [1, 2, 3, 4, 0, 5, 17, 6, 16, 7, 8, 9, 10, 11, 12, 13, 14, 15];
// The fixed code for code-length-code lengths 0..5 (bits written least-significant first).
const CLCL_BITS = [2, 4, 3, 2, 2, 4], CLCL_CODE = [0, 7, 3, 2, 1, 15];

// Huffman code lengths of at most `limit` bits: a complete code whenever two or more symbols are used.
export function codeLengths(freqs, limit) {
  const lengths = new Uint8Array(freqs.length), used = [];
  for (let i = 0; i < freqs.length; i++) if (freqs[i] > 0) used.push(i);
  if (!used.length) return lengths;
  if (used.length === 1) { lengths[used[0]] = 1; return lengths; }
  for (let floor = 1; ; floor *= 2) {
    // Flattening the small frequencies shortens the longest codes; the loop ends at a balanced tree at the latest.
    const leaves = used.map(sym => ({w: Math.max(freqs[sym], floor), sym, l: null, r: null})).sort((a, b) => a.w - b.w || a.sym - b.sym);
    const inner = [];
    let li = 0, ii = 0;
    const pop = () => li < leaves.length && (ii >= inner.length || leaves[li].w <= inner[ii].w) ? leaves[li++] : inner[ii++];
    while ((leaves.length - li) + (inner.length - ii) > 1) { const a = pop(), b = pop(); inner.push({w: a.w + b.w, sym: -1, l: a, r: b}); }
    const stack = [[pop(), 0]];
    let deepest = 0;
    while (stack.length) {
      const [node, depth] = stack.pop();
      if (node.sym >= 0) { lengths[node.sym] = depth; if (depth > deepest) deepest = depth; }
      else stack.push([node.l, depth + 1], [node.r, depth + 1]);
    }
    if (deepest <= limit) return lengths;
  }
}

// A run of `count`+3 repeats as chained run symbols: the decoder folds each new symbol's extra bits into the run
// so far, so the digits go out most significant first (as Brotli writes them).
function pushRun(tokens, extras, symbol, count, mask, shift) {
  const digits = [];
  for (;;) { digits.push(count & mask); count >>= shift; if (!count) break; count--; }
  for (let i = digits.length - 1; i >= 0; i--) { tokens.push(symbol); extras.push(digits[i]); }
}

function reverseBits(value, count) { let out = 0; for (let i = 0; i < count; i++) { out = (out << 1) | (value & 1); value >>= 1; } return out; }

// Canonical codes (shorter codes first, then by symbol), already bit-reversed for least-significant-first writing.
export function canonicalCodes(lengths) {
  const counts = new Uint32Array(17), next = new Uint32Array(17), codes = new Uint16Array(lengths.length);
  for (const length of lengths) counts[length]++;
  counts[0] = 0;
  for (let length = 1, code = 0; length <= 16; length++) { code = (code + counts[length - 1]) << 1; next[length] = code; }
  for (let i = 0; i < lengths.length; i++) if (lengths[i]) codes[i] = reverseBits(next[lengths[i]]++, lengths[i]);
  return codes;
}

// A prefix code for a token histogram: `lengths`/`codes` per symbol, `alphabetSize` past the last used symbol, and
// the simple form's symbol order when four or fewer symbols are used. A histogram with no tokens has alphabet 1.
export function buildCode(freqs) {
  let last = -1, count = 0;
  for (let i = 0; i < freqs.length; i++) if (freqs[i] > 0) { last = i; count++; }
  const alphabetSize = last + 1 || 1, lengths = new Uint8Array(alphabetSize), codes = new Uint16Array(alphabetSize);
  if (count === 0) return {alphabetSize, lengths, codes, simple: null, treeSelect: 0};
  if (count <= 4) {
    // The decoder derives the lengths from the symbol order: the first symbol written takes the shortest code.
    const byWeight = [];
    for (let i = 0; i < freqs.length; i++) if (freqs[i] > 0) byWeight.push(i);
    byWeight.sort((a, b) => freqs[b] - freqs[a] || a - b);
    let simple, treeSelect = 0;
    const assign = (sym, length, index) => { lengths[sym] = length; codes[sym] = index; };
    if (count === 1) { simple = byWeight; assign(byWeight[0], 0, 0); }
    else if (count === 2) { simple = [...byWeight].sort((a, b) => a - b); assign(simple[0], 1, 0); assign(simple[1], 1, 1); }
    else if (count === 3) {
      const rest = byWeight.slice(1).sort((a, b) => a - b);
      simple = [byWeight[0], ...rest];
      assign(simple[0], 1, 0); assign(rest[0], 2, 1); assign(rest[1], 2, 3);
    } else {
      const flat = [...byWeight].sort((a, b) => a - b);
      const flatCost = 2 * flat.reduce((sum, sym) => sum + freqs[sym], 0);
      const deepRest = byWeight.slice(2).sort((a, b) => a - b);
      const deepCost = freqs[byWeight[0]] + 2 * freqs[byWeight[1]] + 3 * (freqs[deepRest[0]] + freqs[deepRest[1]]);
      if (deepCost < flatCost) {
        treeSelect = 1; simple = [byWeight[0], byWeight[1], ...deepRest];
        assign(simple[0], 1, 0); assign(simple[1], 2, 1); assign(deepRest[0], 3, 3); assign(deepRest[1], 3, 7);
      } else {
        simple = flat;
        assign(flat[0], 2, 0); assign(flat[1], 2, 2); assign(flat[2], 2, 1); assign(flat[3], 2, 3);
      }
    }
    return {alphabetSize, lengths, codes, simple, treeSelect};
  }
  const full = codeLengths(freqs.subarray ? freqs.subarray(0, alphabetSize) : freqs.slice(0, alphabetSize), 15);
  lengths.set(full);
  codes.set(canonicalCodes(lengths));
  return {alphabetSize, lengths, codes, simple: null, treeSelect: 0};
}

// The code header. An alphabet of one symbol has no header at all (the decoder reads none).
export function writePrefixCode(w, code) {
  if (code.alphabetSize <= 1) return;
  if (code.simple) {
    const bits = floorLog2(code.alphabetSize - 1) + 1;
    w.write(2, 1); w.write(2, code.simple.length - 1);
    for (const sym of code.simple) w.write(bits, sym);
    if (code.simple.length === 4) w.write(1, code.treeSelect);
    return;
  }
  // Run-length tokens over the lengths up to the last used symbol, as Brotli writes them.
  const lengths = code.lengths, tokens = [], extras = [];
  let last = lengths.length - 1;
  while (last > 0 && !lengths[last]) last--;
  let previous = 8;
  for (let i = 0; i <= last;) {
    const value = lengths[i];
    let run = 1;
    while (i + run <= last && lengths[i + run] === value) run++;
    if (value === 0) {
      if (run < 3) for (let k = 0; k < run; k++) { tokens.push(0); extras.push(0); }
      else pushRun(tokens, extras, 17, run - 3, 7, 3);
    } else {
      let repeats = run;
      if (value !== previous) { tokens.push(value); extras.push(0); repeats--; previous = value; }
      if (repeats < 3) for (let k = 0; k < repeats; k++) { tokens.push(value); extras.push(0); }
      else pushRun(tokens, extras, 16, repeats - 3, 3, 2);
    }
    i += run;
  }
  code.tokens = tokens; code.extras = extras;
  const freqs = new Uint32Array(18);
  for (const token of tokens) freqs[token]++;
  let distinct = 0;
  for (const f of freqs) if (f) distinct++;
  // A single token kind would be an incomplete code-length code: a second, unused symbol completes it.
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

// Hybrid integer configuration: values below 2^split are tokens; above, the top bit's position, the `msb` bits
// under it and the `lsb` lowest bits ride in the token, the bits between them raw. Rapier writes 0,0,0 for residuals (every bit below the top one raw)
// and 4,0,0 for run lengths, as libjxl's fast lossless path does.
export function uintConfig(split, msb = 0, lsb = 0) { return {split, msb, lsb, splitToken: 1 << split}; }

export function writeUintConfig(w, config, logAlphabetSize = 15) {
  w.write(ceilLog2(logAlphabetSize + 1), config.split);
  if (config.split === logAlphabetSize) return;
  w.write(ceilLog2(config.split + 1), config.msb);
  w.write(ceilLog2(config.split - config.msb + 1), config.lsb);
}

// The token of a value under a configuration, with its raw bits: `out` receives [token, nbits, bits].
export function hybridToken(config, value, out) {
  if (value < config.splitToken) { out[0] = value; out[1] = 0; out[2] = 0; return; }
  const n = floorLog2(value), below = value - (1 << n), nbits = n - config.msb - config.lsb;
  out[0] = config.splitToken + (((n - config.split) << (config.msb + config.lsb)) | ((below >> (n - config.msb)) << config.lsb) | (below & ((1 << config.lsb) - 1)));
  out[1] = nbits; out[2] = (value >> config.lsb) & ((1 << nbits) - 1);
}

// Counts a value into a token histogram (the same split as hybridToken), `base` symbols in (LZ77 lengths sit at 224).
export function countToken(config, value, freqs, base = 0) {
  if (value < config.splitToken) { freqs[base + value]++; return; }
  const n = floorLog2(value), below = value - (1 << n);
  freqs[base + config.splitToken + (((n - config.split) << (config.msb + config.lsb)) | ((below >> (n - config.msb)) << config.lsb) | (below & ((1 << config.lsb) - 1)))]++;
}

// Writes the value through a code and configuration (token bits, then the raw bits).
const scratch = [0, 0, 0];
export function writeHybrid(w, code, config, value) {
  hybridToken(config, value, scratch);
  w.write(code.lengths[scratch[0]], code.codes[scratch[0]]);
  if (scratch[1]) w.write(scratch[1], scratch[2]);
}

// The context map: histogram indices below 8 in the simple form (up to three bits each); otherwise the entries go
// through their own one-histogram bundle, each index a direct token (split 8), no move-to-front.
export function writeContextMap(w, contextMap) {
  let widest = 0;
  for (const index of contextMap) widest = Math.max(widest, index);
  const bits = widest ? ceilLog2(widest + 1) : 0;
  if (bits <= 3) {
    w.write(1, 1); w.write(2, bits);
    if (bits) for (const index of contextMap) w.write(bits, index);
    return;
  }
  w.write(1, 0); w.write(1, 0);
  const config = uintConfig(8), length = uintConfig(4), minLength = 7, minSymbol = 224;
  // A long map repeats itself: runs of one index of eight or more go out as the index and an LZ77 copy at distance one.
  const runs = contextMap.length >= 64, freqs = new Uint32Array(runs ? minSymbol + 33 : widest + 1);
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
  // No distance multiplier here, so the distance is the value plus one: the one distance symbol is 0.
  const distance = new Uint32Array(1); distance[0] = 1;
  writeHistograms(w, {lz77: {minSymbol, minLength, lengthConfig: length}, contextMap: new Uint8Array([1, 0]), histograms: [{config: uintConfig(0), code: buildCode(distance)}, {config, code}]});
  const t = [0, 0, 0];
  for (const [index, copy] of pieces) {
    writeHybrid(w, code, config, index);
    if (copy) { hybridToken(length, copy - minLength, t); const symbol = minSymbol + t[0]; w.write(code.lengths[symbol], code.codes[symbol]); if (t[1]) w.write(t[1], t[2]); }
  }
}

// A histogram bundle: LZ77 parameters, the context map, then one prefix code per histogram (with its integer
// configuration and alphabet size). `contextMap[i]` names the histogram of context i; with LZ77 on, the last
// context is the distance context. Only the simple context map (histogram indices below 8) is needed here.
export function writeHistograms(w, {lz77 = null, contextMap, histograms}) {
  w.write(1, lz77 ? 1 : 0);
  if (lz77) {
    w.writeU32([[0, 224], [0, 512], [0, 4096], [15, 8]], lz77.minSymbol);
    w.writeU32([[0, 3], [0, 4], [2, 5], [8, 9]], lz77.minLength);
    writeUintConfig(w, lz77.lengthConfig, 8);
  }
  if (contextMap.length > 1) writeContextMap(w, contextMap);
  w.write(1, 1);  // prefix codes
  for (const histogram of histograms) writeUintConfig(w, histogram.config, 15);
  for (const histogram of histograms) {
    const size = histogram.code.alphabetSize - 1;
    if (!size) w.write(1, 0);
    else { const n = floorLog2(size); w.write(1, 1); w.write(4, n); w.write(n, size - (1 << n)); }
  }
  for (const histogram of histograms) writePrefixCode(w, histogram.code);
}
