// SPDX-License-Identifier: MIT
// Exact prefix-header and payload pricing with the existing coefficient context clusters.
import {BitWriter} from './bits.mjs';
import {buildTokenCoding} from './entropy.mjs';
import {buildCode, uintConfig, hybridToken, writeHybrid, writeHistograms} from './prefix.mjs';

const COEFFICIENT_CONFIGS = [uintConfig(0), uintConfig(1), uintConfig(2), uintConfig(3), uintConfig(4), uintConfig(4, 1, 1), uintConfig(5, 1, 1), uintConfig(2, 0, 1), uintConfig(3, 0, 1)];
// Packed Int16 coefficients are at most 65535; these configurations then produce tokens at most 75.
// Check actual tokens too, so a wider input cannot silently disappear from a typed-array histogram.
const COEFFICIENT_ALPHABET = 128;

function eachCoefficientValue(counts, ctx, visit) {
  const base = ctx * 64;
  for (let value = 0; value < 64; value++) if (counts.small[base + value]) visit(value, counts.small[base + value]);
  const large = counts.large[ctx];
  if (large) for (const [value, frequency] of large) visit(value, frequency);
}

function validateCoefficientCounts(counts) {
  let total = 0;
  for (let ctx = 0; ctx < counts.contexts; ctx++) {
    let sum = 0;
    eachCoefficientValue(counts, ctx, (value, frequency) => {
      if (!Number.isInteger(value) || value < 0 || value > 0xffffffff || !Number.isSafeInteger(frequency) || frequency <= 0) throw new RangeError('invalid coefficient counts');
      sum += frequency;
    });
    if (sum !== counts.totals[ctx]) throw new RangeError('incomplete coefficient counts');
    total += sum;
  }
  // The incumbent builder accumulates into Uint32Array histograms.
  if (!Number.isSafeInteger(total) || total > 0xffffffff) throw new RangeError('coefficient counts exceed histogram capacity');
}

function priceCoefficientHistogram(counts, contexts, config, code) {
  const frequencies = new Uint32Array(COEFFICIENT_ALPHABET), slots = [0, 0, 0];
  let extraBits = 0;
  for (const ctx of contexts) eachCoefficientValue(counts, ctx, (value, frequency) => {
    hybridToken(config, value, slots);
    const [token, bits] = slots;
    if (!Number.isInteger(token) || token < 0 || token >= COEFFICIENT_ALPHABET) throw new RangeError('coefficient token exceeds prefix alphabet');
    frequencies[token] += frequency;
    extraBits += frequency * bits;
  });
  code ||= buildCode(frequencies);
  let payloadBits = extraBits;
  for (let token = 0; token < COEFFICIENT_ALPHABET; token++) if (frequencies[token]) {
    const length = code.lengths[token], single = code.simple?.length === 1 && code.simple[0] === token;
    if (token >= code.alphabetSize || !(length > 0 || single)) throw new RangeError('coefficient token is absent from prefix code');
    payloadBits += frequencies[token] * length;
  }
  const histogram = {config, code}, header = new BitWriter(256);
  writeHistograms(header, {contextMap: new Uint8Array(1), histograms: [histogram]});
  return {histogram, payloadBits, bits: header.bitLength + payloadBits};
}

// Keep the incumbent on equal bit counts. Only hybrid configuration and its prefix code can change;
// context-map and bundle overhead are fixed during each histogram's comparison.
export function buildExactTokenCoding(counts, options) {
  validateCoefficientCounts(counts);
  const incumbent = buildTokenCoding(counts, options), contextMap = incumbent.contextMap;
  const contexts = incumbent.histograms.map(() => []);
  for (let ctx = 0; ctx < counts.contexts; ctx++) if (counts.totals[ctx]) contexts[contextMap[ctx]].push(ctx);
  let payloadBits = 0;
  const histograms = incumbent.histograms.map(({config, code}, index) => {
    let best = priceCoefficientHistogram(counts, contexts[index], config, code);
    for (const candidate of COEFFICIENT_CONFIGS) {
      const priced = priceCoefficientHistogram(counts, contexts[index], candidate);
      if (priced.bits < best.bits) best = priced;
    }
    payloadBits += best.payloadBits;
    return best.histogram;
  });
  const header = new BitWriter();
  writeHistograms(header, {contextMap, histograms});
  const write = (w, ctx, value) => {
    const histogram = histograms[contextMap[ctx]];
    writeHybrid(w, histogram.code, histogram.config, value);
  };
  return {contextMap, histograms, write, bits: header.bitLength + payloadBits};
}
