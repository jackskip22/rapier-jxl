// SPDX-License-Identifier: MIT
// Bounded, exact LZ77 over modular residual values (not prefix-code tokens).
// History is deliberately local to each plane. No dependency on an earlier
// channel, group, worker, hash-table iteration order or floating-point price.
import {BitWriter, packSigned} from './bits.mjs';
import {buildCode, writePrefixCode, writeHistograms, uintConfig, hybridToken, countToken, writeHybrid} from './prefix.mjs';
import {ALPHABET, LZ77, RESIDUAL_CONFIG, leaf, channelTree, writeTree} from './modular.mjs';
import {kernelHooks} from './kernel-hooks.mjs';
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
  create(options = {}) {
    const distances = options.distances instanceof Uint32Array && options.distances.length === 64
      ? options.distances : new Uint32Array(64);
    let distanceCode = options.distanceCode;
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

// Larger groups can retain a repeated row after short runs have buried it in
// the hash chain. Rows are hints only: each copied value is still compared.
// The fast matcher above does not build or consult this additional index.
// How far two positions agree. Four comparisons per trip: the decision is the same as one-at-a-time.
function matchSpan(values, i, at) {
  const limit = values.length - i;
  let n = 0;
  while (n + 4 <= limit) {
    if (values[at + n] !== values[i + n]) return n;
    if (values[at + n + 1] !== values[i + n + 1]) return n + 1;
    if (values[at + n + 2] !== values[i + n + 2]) return n + 2;
    if (values[at + n + 3] !== values[i + n + 3]) return n + 3;
    n += 4;
  }
  while (n < limit && values[at + n] === values[i + n]) n++;
  return n;
}

function screenRowMatches(values, width, emit, depth) {
  const head = new Int32Array(SCREEN_HASH_SIZE).fill(-1),
    previous = new Int32Array(values.length),
    rows = new Int32Array(Math.ceil(values.length / width)).fill(-1),
    seen = new Map();
  for (let y = 0, start = 0; start < values.length; y++, start += width) {
    let h = 0x811c9dc5;
    for (let i = start; i < Math.min(values.length, start + width); i++) h = Math.imul(h ^ values[i], 16777619);
    rows[y] = seen.get(h) ?? -1;
    seen.set(h, start);
  }
  const hash = i =>
    (Math.imul(values[i] + 1, 0x1e35a7bd) ^
      Math.imul(values[i + 1] + 1, 0x6c8e9cf5) ^
      Math.imul(values[i + 2] + 1, 0x2c1b3c6d)) >>> 16;
  const insert = i => {
    if (i + 2 >= values.length) return;
    const h = hash(i);
    previous[i] = head[h];
    head[h] = i;
  };
  // One probe closure serves every position in the plane.
  let i = 0, length = 0, distance = 0;
  const probe = at => {
    if (at < 0 || at >= i || values[at] !== values[i]) return;
    // Farther than the current match, and already shorter at the far end: it cannot win.
    if (length && i - at >= distance) {
      const end = i + length;
      if (end > values.length || values[at + length - 1] !== values[i + length - 1]) return;
      if (end < values.length && values[at + length] !== values[i + length]) return;
    } else if (length && values[at + length - 1] !== values[i + length - 1] && i + length - 1 < values.length) return;
    const n = matchSpan(values, i, at);
    if (n > length || (n === length && i - at < distance)) { length = n; distance = i - at; }
  };
  for (; i < values.length; ) {
    length = 0; distance = 0;
    if (i + LZ77.minLength <= values.length) {
      const row = rows[(i / width) | 0];
      if (row >= 0) probe(row + (i % width));
      for (let at = head[hash(i)], n = 0; at >= 0 && n < depth && i + length < values.length; at = previous[at], n++) probe(at);
    }
    if (length >= LZ77.minLength) {
      emit(0, length, distance);
      for (let n = 0; n < length; n++) insert(i + n);
      i += length;
    } else { emit(values[i], 0, 0); insert(i++); }
  }
}

// Score each plane's copied residuals and its own prefix headers. Distance
// codes are merged across planes when writing; complete streams price that
// coupling, the tree and framing. Plain residual entropy misses repeated rows.
export function screenModel(plane, width, height, depth = 4) {
  let best;
  for (const predictor of [0, 1, 2, 5]) {
    const pieces = [], freqs = new Uint32Array(ALPHABET), distances = new Uint32Array(64), token = [0, 0, 0];
    let raw = 0;
    const count = (config, value, target, base = 0) => {
      hybridToken(config, value, token); target[base + token[0]]++; raw += token[1];
    };
    const emit = (value, length, distance) => {
      if (length) {
        pieces.push(length - LZ77.minLength, distance);
        count(LZ77.lengthConfig, length - LZ77.minLength, freqs, LZ77.minSymbol);
        count(SCREEN_DISTANCE_CONFIG, distance === 1 ? 1 : distance + 119, distances);
      } else { pieces.push(value, 0); count(RESIDUAL_CONFIG, value, freqs); }
    };
    if (!kernelHooks.screen?.(plane, width, height, predictor, depth, emit))
      screenRowMatches(screenResiduals(plane, width, height, predictor), width, emit, depth);
    const code = buildCode(freqs), distance = buildCode(distances), writer = new BitWriter(256);
    writePrefixCode(writer, code); writePrefixCode(writer, distance);
    let bits = writer.bitLength + raw;
    for (let s = 0; s < freqs.length; s++) if (freqs[s]) bits += freqs[s] * code.lengths[s];
    for (let s = 0; s < distances.length; s++) if (distances[s]) bits += distances[s] * distance.lengths[s];
    if (!best || bits < best.bits) best = {leaf: leaf(predictor), code, distances, pieces, bits};
  }
  return best;
}

export function writeScreenModel(writer, models) {
  const leaves = models.map(model => model.leaf), ordered = writeTree(writer, channelTree(leaves)),
    distances = new Uint32Array(64), contextMap = new Uint8Array(ordered.length + 1);
  for (const model of models) for (let s = 0; s < distances.length; s++) distances[s] += model.distances[s];
  for (const l of ordered) contextMap[l.context] = leaves.indexOf(l) + 1;
  const distance = buildCode(distances);
  writeHistograms(writer, {lz77: LZ77, contextMap, histograms: [
    {config: SCREEN_DISTANCE_CONFIG, code: distance}, ...models.map(model => ({config: RESIDUAL_CONFIG, code: model.code}))
  ]});
  return () => {
    for (const model of models) for (let i = 0; i < model.pieces.length; i += 2) {
      const value = model.pieces[i], d = model.pieces[i + 1];
      writeHybrid(writer, model.code, d ? LZ77.lengthConfig : RESIDUAL_CONFIG, value, d ? LZ77.minSymbol : 0);
      if (d) writeHybrid(writer, distance, SCREEN_DISTANCE_CONFIG, d === 1 ? 1 : d + 119);
    }
  };
}
