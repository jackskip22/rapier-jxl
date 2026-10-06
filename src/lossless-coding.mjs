// Rapier's JPEG XL encoder: exact hybrid-integer prices for lossless residuals. MIT (LICENSE).
// Raw literal counts retain the low-bit distribution that an exponent-only histogram throws away. The
// run-length alphabet is separate while counting; projection restores it at the standard LZ77 boundary.
import {BitWriter, floorLog2} from './bits.mjs';
import {uintConfig, hybridToken, buildCode, writePrefixCode, writeUintConfig} from './prefix.mjs';
import {ALPHABET} from './modular.mjs';

const LOSSLESS_INTEGER_CONFIGS = [uintConfig(0), uintConfig(4), uintConfig(4, 1, 1), uintConfig(3, 0, 1)];

export function losslessCoding(raw) {
  const end = raw.length - 33, token = [0, 0, 0];
  let original, best;
  for (const config of LOSSLESS_INTEGER_CONFIGS) {
    const freqs = new Uint32Array(ALPHABET);
    let extra = 0;
    for (let value = 0; value < end; value++) if (raw[value]) {
      hybridToken(config, value, token);
      freqs[token[0]] += raw[value]; extra += raw[value] * token[1];
    }
    for (let s = 0; s < 33; s++) { freqs[224 + s] = raw[end + s]; extra += raw[end + s] * Math.max(0, s - 12); }
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
