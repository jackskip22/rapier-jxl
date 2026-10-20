// Rapier's JPEG XL encoder: exact hybrid-integer prices for lossless residuals. MIT (LICENSE).
import {BitWriter, floorLog2} from './bits.mjs';
import {uintConfig, hybridToken, buildCode, writePrefixCode, writeUintConfig} from './prefix.mjs';
import {ALPHABET} from './modular.mjs';

const LOSSLESS_INTEGER_CONFIGS = [uintConfig(0), uintConfig(4), uintConfig(4, 1, 1), uintConfig(3, 0, 1), uintConfig(4, 2, 0), uintConfig(4, 2, 1), uintConfig(4, 1, 2)];

export function losslessCoding(raw) {
  const token = [0, 0, 0], literals = [], lengths = raw.lengths || raw.subarray(raw.length - 33);
  if (raw.literals) { for (const [value, count] of raw.literals) if (count) literals.push(value, count); }
  else for (let value = 0, end = raw.length - 33; value < end; value++) if (raw[value]) literals.push(value, raw[value]);
  let runExtra = 0;
  for (let s = 0; s < 33; s++) runExtra += lengths[s] * Math.max(0, s - 12);
  let original, best;
  candidate: for (const config of LOSSLESS_INTEGER_CONFIGS) {
    const freqs = new Uint32Array(ALPHABET);
    let extra = runExtra;
    for (let i = 0; i < literals.length; i += 2) {
      hybridToken(config, literals[i], token);
      if (token[0] >= 224) continue candidate;
      freqs[token[0]] += literals[i + 1]; extra += literals[i + 1] * token[1];
    }
    freqs.set(lengths, 224);
    const code = buildCode(freqs), w = new BitWriter(128);
    writeUintConfig(w, config); writePrefixCode(w, code);
    let bits = w.bitLength + extra + (code.alphabetSize === 1 ? 1 : 5 + floorLog2(code.alphabetSize - 1));
    for (let s = 0; s < freqs.length; s++) if (freqs[s]) bits += freqs[s] * code.lengths[s];
    const model = {config, freqs, bits, extra};
    if (!original) original = model;
    if (!best || bits < best.bits) best = model;
  }
  return [original, best];
}
