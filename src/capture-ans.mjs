// SPDX-License-Identifier: MIT
import {ceilLog2} from './bits.mjs';
import {hybridToken, writeUintConfig} from './prefix.mjs';
import {SCREEN_INTEGER_CONFIGS} from './screen-codes.mjs';
import {learnedModel, letGoTrees} from './capture-trees.mjs';
import {colourTransform} from './rct-search.mjs';
import {reverseAlias, shapeHistogram, writeAnsHistograms} from './ans-core.mjs';
import {captureAnsWrite} from './kernels.mjs';
import {captureAnsTokens} from './capture-kernels.mjs';

export {captureAnsTokens};

export function writeCaptureAns(header, data, {lz77, contextMap, configs}, tokens) {
  const w = header;
  const {tags, bits, n, freqs} = tokens;
  let largest = 0;
  for (const f of freqs) for (let s = 255; s > largest; s--) if (f[s]) { largest = s; break; }
  const logAlphabet = Math.max(5, ceilLog2(largest + 1), ...configs.map(c => c.split));
  if (logAlphabet > 8) return false;
  const shapes = [];
  for (const f of freqs) {
    const shape = shapeHistogram(f);
    if (!shape) return false;
    shapes.push({...shape, ...reverseAlias(shape.counts, logAlphabet)});
  }
  w.write(1, lz77 ? 1 : 0);
  if (lz77) {
    w.writeU32([[0, 224], [0, 512], [0, 4096], [15, 8]], lz77.minSymbol);
    w.writeU32([[0, 3], [0, 4], [2, 5], [8, 9]], lz77.minLength);
    writeUintConfig(w, lz77.lengthConfig, 8);
  }
  writeAnsHistograms(w, contextMap, logAlphabet, configs, shapes);
  captureAnsWrite(data, tags, bits, n, shapes);
  return true;
}

function distanceConfig({values, counts}) {
  let best = null, least = Infinity;
  const token = [0, 0, 0];
  for (const config of SCREEN_INTEGER_CONFIGS) {
    const tally = new Map();
    let bits = 0, total = 0, fits = true;
    for (let i = 0; i < values.length && fits; i++) {
      hybridToken(config, values[i], token);
      if (token[0] > 255) fits = false;
      tally.set(token[0], (tally.get(token[0]) || 0) + counts[i]); bits += token[1] * counts[i]; total += counts[i];
    }
    if (!fits) continue;
    for (const c of tally.values()) bits += c * Math.log2(total / c);
    if (bits < least) { least = bits; best = config; }
  }
  return best;
}
function lengthConfig(live, room) {
  let best = null, least = Infinity;
  const token = [0, 0, 0];
  for (const config of SCREEN_INTEGER_CONFIGS) {
    let bits = 0, fits = true;
    for (const h of live) {
      if (!h.copies) continue;
      const tally = new Map(), {values, counts} = h.lengths;
      for (let i = 0; i < values.length && fits; i++) {
        hybridToken(config, values[i], token);
        if (token[0] >= room) fits = false;
        tally.set(token[0], (tally.get(token[0]) || 0) + counts[i]); bits += token[1] * counts[i];
      }
      for (const c of tally.values()) bits += c * Math.log2(h.copies / c);
    }
    if (fits && bits < least) { least = bits; best = config; }
  }
  return best;
}

export const CAPTURE_ANS = /* @__PURE__ */ Object.freeze({tokens: captureAnsTokens, write: writeCaptureAns, distanceConfig, lengthConfig});
export const CAPTURE_TOOLS_COMPLETE = /* @__PURE__ */ Object.freeze({top: 9, next: null, ans: CAPTURE_ANS,
  signs: !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true), trees: Object.freeze({model: learnedModel, letGo: letGoTrees}), transform: (typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || !__RAPIER_JXL_CAPTURE_PHOTO__) ? colourTransform : null, gpu: Object.freeze({pixels: 1 << 20})});
