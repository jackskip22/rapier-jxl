// SPDX-License-Identifier: MIT
export {DEFAULT_OPSIN} from './opsin-defaults.mjs';
export {SIGNATURE, FTYP, BRAND, CODESTREAM, PARTIAL, BROB, RECONSTRUCTION, LEVEL} from './container.mjs';
export {ceilLog2, float16Bits} from './bits.mjs';

export const QUANT_FIELD_MAX = 256;
export const COEFF_FREQ_CONTEXT = /* @__PURE__ */ Array.from({length: 64}, (_, i) => i < 1 ? 0 : i < 16 ? i - 1 : i < 32 ? 7 + (i >> 1) : 15 + (i >> 2));
export const COEFF_NUM_NONZERO_CONTEXT = /* @__PURE__ */ Array.from({length: 64}, (_, i) => [0, 0, 31, 62, 93, 123, 152, 180, 206][i < 3 ? i : i < 5 ? 3 : i < 9 ? 4 : i < 13 ? 5 : i < 21 ? 6 : i < 33 ? 7 : 8]);

export const SCREEN_SPECIAL_DISTANCES = /* @__PURE__ */ (() => {
  const pairs = [];
  for (let dy = 0; dy < 8; dy++) for (let dx = -7; dx < 9; dx++) if (dy || dx > 0) pairs.push([dx, dy]);
  return Int8Array.from(pairs.sort(([a, b], [c, d]) => a * a + b * b - c * c - d * d || Math.abs(a) - Math.abs(c) || c - a).flat());
})();

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

const REV8 = /* @__PURE__ */ Uint8Array.from({length: 256}, (_, v) => {
  let out = 0;
  for (let i = 0; i < 8; i++) out = (out << 1) | ((v >>> i) & 1);
  return out;
});
const COUNTS17 = new Uint32Array(17), NEXT17 = new Uint32Array(17);
export function canonicalCodes(lengths) {
  COUNTS17.fill(0);
  const codes = new Uint16Array(lengths.length);
  for (let i = 0; i < lengths.length; i++) COUNTS17[lengths[i]]++;
  COUNTS17[0] = 0;
  for (let length = 1, code = 0; length <= 16; length++) { code = (code + COUNTS17[length - 1]) << 1; NEXT17[length] = code; }
  for (let i = 0; i < lengths.length; i++) {
    const len = lengths[i];
    if (len) { const v = NEXT17[len]++; codes[i] = ((REV8[v & 255] << 8) | REV8[v >>> 8]) >>> (16 - len); }
  }
  return codes;
}
