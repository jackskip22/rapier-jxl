// SPDX-License-Identifier: MIT
import {ceilLog2} from './bits.mjs';
import {hybridToken, writeUintConfig} from './prefix.mjs';
import {SCREEN_INTEGER_CONFIGS} from './screen-codes.mjs';
import {learnedModel} from './capture-trees.mjs';
import {colourTransform} from './rct-search.mjs';
import {ansEncode, reverseAlias, shapeHistogram, writeAnsHistograms} from './ans-core.mjs';
import {captureAnsWrite} from './kernels.mjs';

export function captureAnsTokens(models, index, configs, copy, histograms) {
  let n = 0;
  for (const model of models) n += model.count;
  for (const model of models) for (let k = 0; k < model.count; k++) if (model.pieceDistance[k]) n++;
  const tags = new Uint32Array(n), bits = new Uint32Array(n);
  const offset = copy ? 1 : 0, freqs = Array.from({length: histograms + offset}, () => new Uint32Array(256)), token = [0, 0, 0];
  const room = copy ? Math.min(copy.minSymbol, 256) : 256;
  let at = 0;
  const put = (h, s) => {
    if (s > 255) return false;
    tags[at] = h << 16 | token[1] << 9 | s; bits[at++] = token[2]; freqs[h][s]++;
    return true;
  };
  const fast = new Int32Array(histograms << 9).fill(-1), fastBits = new Uint32Array(histograms << 9);
  for (const model of models) {
    const {count, pieceValue, pieceDistance, pieceContext} = model;
    for (let k = 0; k < count; k++) {
      const h = index[model.base + pieceContext[k]], v = pieceValue[k], d = pieceDistance[k];
      if (!d) {
        if (v < 512) {
          const slot = h << 9 | v;
          let packed = fast[slot];
          if (packed < 0) { hybridToken(configs[h], v, token); if (token[0] >= room) return null; fast[slot] = packed = token[0] << 8 | token[1]; fastBits[slot] = token[2]; }
          const target = h + offset, s = packed >> 8;
          tags[at] = target << 16 | (packed & 255) << 9 | s; bits[at++] = fastBits[slot]; freqs[target][s]++;
          continue;
        }
        hybridToken(configs[h], v, token); if (token[0] >= room || !put(h + offset, token[0])) return null; continue;
      }
      hybridToken(copy.lengthConfig, v, token);
      if (!put(h + offset, copy.minSymbol + token[0])) return null;
      let dv;
      if (copy.spatial) { const s = d < copy.sCodes.length ? copy.sCodes[d] : -1; dv = s >= 0 ? s : d + 119; }
      else dv = d === 1 ? 1 : d + 119;
      hybridToken(copy.distanceConfig, dv, token);
      if (!put(0, token[0])) return null;
    }
  }
  return {tags, bits, n, freqs};
}

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
  if (!captureAnsWrite(data, tags, bits, n, shapes)) writeAnsTokens(data, tags, bits, n, shapes);
  return true;
}

function writeAnsTokens(w, tags, bits, n, shapes) {
  const ids = new Uint8Array(n), freq = new Int32Array(n), start = new Int32Array(n), emitted = new Uint16Array(n), flagged = new Uint8Array(n);
  for (let i = 0; i < n; i++) { const h = shapes[ids[i] = tags[i] >>> 16], s = tags[i] & 511; freq[i] = h.counts[s]; start[i] = h.starts[s]; }
  w.write(32, ansEncode(n, ids, freq, start, shapes.map(h => h.reverse), emitted, flagged));
  for (let i = 0; i < n; i++) { if (flagged[i]) w.write(16, emitted[i]); const raw = tags[i] >>> 9 & 63; if (raw) w.write(raw, bits[i]); }
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

function arena(count, span, props) {
  const all = new Uint32Array(128), counts = new Uint32Array(span * props), order = new Int32Array(count), tokens = new Uint8Array(count);
  const bins = Array.from({length: props}, () => new Uint8Array(count)), scratch = new Int32Array(count);
  return {all, counts, order, tokens, bins, by: bins[0], bx: bins[1], bw: bins[2], bn: bins[3],
    tally(from, to, withBins) {
      all.fill(0);
      if (withBins) counts.fill(0);
      for (let i = from; i < to; i++) {
        const k = order[i], t = tokens[k];
        all[t]++;
        if (withBins) for (let p = 0; p < props; p++) counts[p * span + bins[p][k] * 128 + t]++;
      }
    },
    part(from, to, property, cut) {
      const b = bins[property];
      let a = from, z = 0;
      for (let i = from; i < to; i++) { const k = order[i]; if (b[k] > cut) order[a++] = k; else scratch[z++] = k; }
      order.set(scratch.subarray(0, z), a);
      return a;
    }};
}
function bins(plane, stride, origin, w, pieceValue, pieceDistance, minimum, count, remap, bins) {
  const sign = v => v < 0 ? 0 : v ? 2 : 1;
  for (let k = 0, x = 0, y = 0, at = origin; k < count; k++) {
    const W = x ? remap[plane[at - 1]] : y ? remap[plane[at - stride]] : 0, N = y ? remap[plane[at - stride]] : W;
    const NW = x && y ? remap[plane[at - stride - 1]] : W, NE = y && x + 1 < w ? remap[plane[at - stride + 1]] : N;
    bins[4][k] = sign(W - NW); bins[5][k] = sign(NW - N); bins[6][k] = sign(N - NE);
    x += pieceDistance[k] ? pieceValue[k] + minimum : 1;
    while (x >= w) { x -= w; y++; }
    at = origin + y * stride + x;
  }
}

export const CAPTURE_ANS = /* @__PURE__ */ Object.freeze({tokens: captureAnsTokens, write: writeCaptureAns, distanceConfig, lengthConfig});
export const CAPTURE_TOOLS_COMPLETE = /* @__PURE__ */ Object.freeze({top: 9, next: null, ans: CAPTURE_ANS,
  signs: (typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) ? null : Object.freeze({arena, bins}), trees: Object.freeze({model: learnedModel}), transform: colourTransform, gpu: Object.freeze({pixels: 1 << 20})});
