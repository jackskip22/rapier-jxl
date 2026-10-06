// SPDX-License-Identifier: MIT
// Bounded, exact LZ77 over modular residual values (not prefix-code tokens).
// History is deliberately local to each plane. No dependency on an earlier
// channel, group, worker, hash-table iteration order or floating-point price.
import {packSigned} from './bits.mjs';
import {buildCode, writeHistograms, uintConfig, countToken, writeHybrid} from './prefix.mjs';
import {LZ77, RESIDUAL_CONFIG} from './modular.mjs';
const SCREEN_DISTANCE_CONFIG = uintConfig(4),
  SCREEN_HASH_SIZE = 65536;

export function screenResiduals(plane, width, height, predictor) {
  const out = new Uint32Array(width * height);
  for (let y = 0, i = 0; y < height; y++)
    for (let x = 0; x < width; x++, i++) {
      let pred = 0;
      if (predictor !== 0) {
        const left = x ? plane[i - 1] : y ? plane[i - width] : 0,
          top = y ? plane[i - width] : left;
        if (predictor === 1) pred = left;
        else if (predictor === 2) pred = top;
        else if (predictor === 3) pred = ((left + top) / 2) | 0;
        else if (predictor === 5) {
          const tl = x && y ? plane[i - width - 1] : left,
            g = left + top - tl;
          pred = Math.max(Math.min(left, top), Math.min(Math.max(left, top), g));
        } else throw new Error('screen LZ77 predictor ' + predictor);
      }
      out[i] = packSigned(plane[i] - pred);
    }
  return out;
}

// At most four collision-chain probes per position; ties retain the nearest
// match. Hash equality is never proof: every copied value is compared exactly.
export function screenMatches(values, emit, depth = 4) {
  const head = new Int32Array(SCREEN_HASH_SIZE).fill(-1),
    prev = new Int32Array(values.length).fill(-1);
  const hash = i =>
    (Math.imul(values[i] + 1, 0x1e35a7bd) ^
      Math.imul(values[i + 1] + 1, 0x6c8e9cf5) ^
      Math.imul(values[i + 2] + 1, 0x2c1b3c6d)) >>>
    16;
  const insert = i => {
    if (i + 2 >= values.length) return;
    const h = hash(i);
    prev[i] = head[h];
    head[h] = i;
  };
  for (let i = 0; i < values.length; ) {
    let length = 0,
      distance = 0;
    if (i + 7 <= values.length) {
      let at = head[hash(i)];
      for (let n = 0; n < depth && at >= 0; n++, at = prev[at]) {
        if (values[at] !== values[i] || values[at + 1] !== values[i + 1] || values[at + 2] !== values[i + 2]) continue;
        let k = 3;
        while (i + k < values.length && values[at + k] === values[i + k]) k++;
        if (k > length) {
          length = k;
          distance = i - at;
          if (i + k === values.length) break;
        }
      }
    }
    if (length >= 7) {
      emit(0, length, distance);
      for (let k = 0; k < length; k++) insert(i + k);
      i += length;
    } else {
      emit(values[i], 0, 0);
      insert(i++);
    }
  }
}

export const screenLZ77 = {
  create() {
    const distances = new Uint32Array(64);
    let distanceCode;
    return {
      code(writer, target, plane, width, height, leaf) {
        if (leaf.offset !== 0 || leaf.multiplier !== 1) throw new Error('screen LZ77 is lossless only');
        screenMatches(screenResiduals(plane, width, height, leaf.predictor), (value, length, distance) => {
          if (length) {
            // Modular streams have 120 spatial distance codes. Code 1 is west;
            // the general distance is d + 119, independent of channel width.
            const d = distance === 1 ? 1 : distance + 119;
            if (writer) {
              writeHybrid(writer, target, LZ77.lengthConfig, length - LZ77.minLength, LZ77.minSymbol);
              writeHybrid(writer, distanceCode, SCREEN_DISTANCE_CONFIG, d);
            } else {
              countToken(LZ77.lengthConfig, length - LZ77.minLength, target, LZ77.minSymbol);
              countToken(SCREEN_DISTANCE_CONFIG, d, distances);
            }
          } else if (writer) writeHybrid(writer, target, RESIDUAL_CONFIG, value);
          else countToken(RESIDUAL_CONFIG, value, target);
        });
      },
      histograms(writer, ordered, freqs, histogramOf) {
        const contextMap = new Uint8Array(ordered.length + 1);
        for (const l of ordered) contextMap[l.context] = histogramOf(l) + 1;
        distanceCode = buildCode(distances);
        const histograms = [{config: SCREEN_DISTANCE_CONFIG, code: distanceCode}];
        for (let i = 0; i < Math.max(...contextMap); i++)
          histograms.push({config: RESIDUAL_CONFIG, code: buildCode(freqs[i])});
        writeHistograms(writer, {lz77: LZ77, contextMap, histograms});
        return histograms;
      }
    };
  }
};
