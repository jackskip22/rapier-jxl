// SPDX-License-Identifier: MIT
// Bounded, exact LZ77 over modular residual values (not prefix-code tokens).
// History is deliberately local to each plane. No dependency on an earlier
// channel, group, worker, hash-table iteration order or floating-point price.
import {BitWriter, packSigned} from './bits.mjs';
import {buildCode, writePrefixCode, writeHistograms, uintConfig, hybridToken, countToken, writeHybrid, writeUintConfig} from './prefix.mjs';
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
    if (!best || bits < best.bits) best = {leaf: leaf(predictor), code, distances, pieces, bits, width};
  }
  return best;
}

const SCREEN_INTEGER_CONFIGS = [
  uintConfig(4), uintConfig(0), uintConfig(1), uintConfig(2), uintConfig(3), uintConfig(6), uintConfig(8),
  uintConfig(4, 0, 1), uintConfig(4, 0, 2), uintConfig(4, 0, 3), uintConfig(4, 0, 4),
  uintConfig(4, 1, 3), uintConfig(4, 1, 1), uintConfig(4, 2, 2), uintConfig(3, 0, 1)
];
// JPEG XL's fixed spatial distances. A stream uses its widest decoded channel as the row stride.
const SCREEN_SPECIAL_DISTANCES = Int8Array.of(
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
function screenDistanceMap(width) {
  const map = new Map();
  for (let i = SCREEN_SPECIAL_DISTANCES.length - 2; i >= 0; i -= 2)
    map.set(Math.max(1, SCREEN_SPECIAL_DISTANCES[i] + width * SCREEN_SPECIAL_DISTANCES[i + 1]), i / 2);
  return map;
}

// Price the complete prefix histogram and its payload, including configuration and alphabet headers.
function screenIntegerPrice(freqs, config, raw) {
  const code = buildCode(freqs), writer = new BitWriter(256);
  writeHistograms(writer, {contextMap: new Uint8Array(1), histograms: [{config, code}]});
  let bits = writer.bitLength + raw;
  for (let s = 0; s < freqs.length; s++) if (freqs[s]) bits += freqs[s] * code.lengths[s];
  return {code, bits};
}

export function writeScreenModel(writer, models) {
  const ordered = writeTree(writer, channelTree(models.map(model => model.leaf))),
    counts = [], distances = new Map(), token = [0, 0, 0];
  // Keep raw copy values until choosing their integer configurations. A 1024-square group needs at most
  // 512 prefix symbols under these configurations, including the reserved copy-length range.
  for (const model of models) {
    const literals = new Uint32Array(512), lengths = new Map();
    let raw = 0;
    for (let i = 0; i < model.pieces.length; i += 2) {
      const value = model.pieces[i], distance = model.pieces[i + 1];
      if (distance) {
        lengths.set(value, (lengths.get(value) || 0) + 1);
        distances.set(distance, (distances.get(distance) || 0) + 1);
      } else {
        hybridToken(RESIDUAL_CONFIG, value, token);
        literals[token[0]]++; raw += token[1];
      }
    }
    counts.push({literals, lengths, raw});
  }
  let length;
  for (const config of distances.size ? SCREEN_INTEGER_CONFIGS : [LZ77.lengthConfig]) {
    const codes = [], parameter = new BitWriter(16);
    writeUintConfig(parameter, config, 8);
    let bits = parameter.bitLength;
    for (const count of counts) {
      const freqs = count.literals.slice();
      let raw = count.raw;
      for (const [value, n] of count.lengths) {
        hybridToken(config, value, token);
        freqs[LZ77.minSymbol + token[0]] += n; raw += token[1] * n;
      }
      const price = screenIntegerPrice(freqs, RESIDUAL_CONFIG, raw);
      bits += price.bits; codes.push(price.code);
    }
    if (!length || bits < length.bits) length = {config, codes, bits};
  }
  let distance;
  const map = distances.size ? screenDistanceMap(Math.max(...models.map(model => model.width))) : null;
  // Generic and spatial representations compete using their actual codes. Nearby distances do not always
  // save bytes once a stream's histogram and repeating low bits are accounted for.
  if (map) for (const spatial of [false, true]) for (const config of SCREEN_INTEGER_CONFIGS) {
    const freqs = new Uint32Array(512);
    let raw = 0;
    for (const [d, n] of distances) {
      const value = spatial ? (map.get(d) ?? d + 119) : d === 1 ? 1 : d + 119;
      hybridToken(config, value, token);
      freqs[token[0]] += n; raw += token[1] * n;
    }
    const price = screenIntegerPrice(freqs, config, raw);
    if (!distance || price.bits < distance.bits) distance = {...price, config, spatial};
  }
  const offset = distance ? 1 : 0, contextMap = new Uint8Array(ordered.length + offset);
  for (const leaf of ordered) contextMap[leaf.context] = models.findIndex(model => model.leaf === leaf) + offset;
  writeHistograms(writer, {
    lz77: distance ? {...LZ77, lengthConfig: length.config} : null,
    contextMap,
    histograms: [
      ...(distance ? [{config: distance.config, code: distance.code}] : []),
      ...length.codes.map(code => ({config: RESIDUAL_CONFIG, code}))
    ]
  });
  return () => {
    for (let m = 0; m < models.length; m++) for (let i = 0; i < models[m].pieces.length; i += 2) {
      const value = models[m].pieces[i], d = models[m].pieces[i + 1];
      writeHybrid(writer, length.codes[m], d ? length.config : RESIDUAL_CONFIG, value, d ? LZ77.minSymbol : 0);
      if (d) writeHybrid(writer, distance.code, distance.config, distance.spatial ? (map.get(d) ?? d + 119) : d === 1 ? 1 : d + 119);
    }
  };
}
