// SPDX-License-Identifier: MIT

export const COEFF_FREQ_CONTEXT = /* @__PURE__ */ Array.from({length: 64}, (_, i) => i < 1 ? 0 : i < 16 ? i - 1 : i < 32 ? 7 + (i >> 1) : 15 + (i >> 2));
export const COEFF_NUM_NONZERO_CONTEXT = /* @__PURE__ */ Array.from({length: 64}, (_, i) => [0, 0, 31, 62, 93, 123, 152, 180, 206][i < 3 ? i : i < 5 ? 3 : i < 9 ? 4 : i < 13 ? 5 : i < 21 ? 6 : i < 33 ? 7 : 8]);

export const DEFAULT_OPSIN = /* @__PURE__ */ Object.freeze({
  inverseMatrix: Object.freeze([11.031566901960783, -9.866943921568629, -0.16462299647058826,
    -3.254147380392157, 4.418770392156863, -0.16462299647058826,
    -3.6588512862745097, 2.7129230470588235, 1.9459282392156863]),
  opsinBiases: Object.freeze(Array(3).fill(-0.0037930732552754493)),
  quantizationBiases: Object.freeze([0.945349926692846, 0.9299455010825141, 0.9500648966626563, 0.145]),
});

export const SCREEN_SPECIAL_DISTANCES = /* @__PURE__ */ Int8Array.of(
  0, 1, 1, 0, 1, 1, -1, 1, 0, 2, 2, 0, 1, 2, -1, 2,
  2, 1, -2, 1, 2, 2, -2, 2, 0, 3, 3, 0, 1, 3, -1, 3,
  3, 1, -3, 1, 2, 3, -2, 3, 3, 2, -3, 2, 0, 4, 4, 0,
  1, 4, -1, 4, 4, 1, -4, 1, 3, 3, -3, 3, 2, 4, -2, 4,
  4, 2, -4, 2, 0, 5, 3, 4, -3, 4, 4, 3, -4, 3, 5, 0,
  1, 5, -1, 5, 5, 1, -5, 1, 2, 5, -2, 5, 5, 2, -5, 2,
  4, 4, -4, 4, 3, 5, -3, 5, 5, 3, -5, 3, 0, 6, 6, 0,
  1, 6, -1, 6, 6, 1, -6, 1, 2, 6, -2, 6, 6, 2, -6, 2,
  4, 5, -4, 5, 5, 4, -5, 4, 3, 6, -3, 6, 6, 3, -6, 3,
  0, 7, 7, 0, 1, 7, -1, 7, 5, 5, -5, 5, 7, 1, -7, 1,
  4, 6, -4, 6, 6, 4, -6, 4, 2, 7, -2, 7, 7, 2, -7, 2,
  3, 7, -3, 7, 7, 3, -7, 3, 5, 6, -5, 6, 6, 5, -6, 5,
  8, 0, 4, 7, -4, 7, 7, 4, -7, 4, 8, 1, 8, 2, 6, 6,
  -6, 6, 8, 3, 5, 7, -5, 7, 7, 5, -7, 5, 8, 4, 6, 7,
  -6, 7, 7, 6, -7, 6, 8, 5, 7, 7, -7, 7, 8, 6, 8, 7
);

export const LOG_LENGTHS = [5, 4, 4, 4, 4, 4, 3, 3, 3, 3, 3, 6, 7];
export const LOG_CODES = [17, 11, 15, 3, 9, 7, 4, 2, 5, 6, 0, 33, 1];
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

export const SIGNATURE = /* @__PURE__ */ new Uint8Array([0, 0, 0, 12, 74, 88, 76, 32, 13, 10, 135, 10]);
export const FTYP = 0x66747970, BRAND = 0x6a786c20, CODESTREAM = 0x6a786c63, PARTIAL = 0x6a786c70;
export const BROB = 0x62726f62, RECONSTRUCTION = 0x6a627264, LEVEL = 0x6a786c6c;

export function ceilLog2(value) { return value <= 1 ? 0 : 32 - Math.clz32(value - 1); }
export function float16Bits(value) {
  const sign = value < 0 || Object.is(value, -0) ? 0x8000 : 0;
  if (value === 0) return sign;
  value = Math.abs(value);
  if (!(value < 65520)) throw new Error('half float out of range: ' + value);
  let exponent = 0, mantissa = value;
  while (mantissa >= 2) { mantissa /= 2; exponent++; }
  while (mantissa < 1) { mantissa *= 2; exponent--; }
  if (exponent < -14) { mantissa = value * 16384; exponent = -15; }
  else mantissa -= 1;
  const scaled = mantissa * 1024;
  let m = Math.round(scaled);
  if (m - scaled === 0.5 && (m & 1)) m--;
  if (m === 1024) { m = 0; exponent++; }
  return sign | ((exponent + 15) << 10) | m;
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

const HALVES = /* @__PURE__ */ Array.from({length: 32}, (_, e) => 2 ** -e);
export function entropyLog2(x) {
  let exponent = 0;
  if (x >= 2 && x < 4294967296) { exponent = 31 - Math.clz32(x); x *= HALVES[exponent]; }
  while (x >= 1.4142135623730951) { x /= 2; exponent++; }
  while (x < 0.7071067811865476) { x *= 2; exponent--; }
  const z = (x - 1) / (x + 1), z2 = z * z;
  let term = z, sum = z;
  for (let k = 3; k < 30; k += 2) sum += (term *= z2) / k;
  return exponent + sum * 2.885390081777927;
}
