// SPDX-License-Identifier: MIT
import {BitWriter, packSigned} from './bits.mjs';
import {buildCode, priceCode, canonicalCodes, writePrefixCode, writeHistograms, uintConfig, hybridToken, countToken, writeHybrid, writeUintConfig} from './prefix.mjs';
import {ALPHABET, LZ77, RESIDUAL_CONFIG, leaf, channelTree, writeTree} from './modular.mjs';
import {kernelHooks} from './kernel-hooks.mjs';
import {SCREEN_INTEGER_CONFIGS, screenDistanceMap} from './screen-codes.mjs';
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

export function screenMatches(values, emit, depth = 4, minLength = 7) {
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
    if (i + minLength <= values.length) {
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
    if (length >= minLength) {
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
    const lz77 = {...LZ77, minLength: options.minLength ?? 7};
    const distances = options.distances instanceof Uint32Array && options.distances.length === 64
      ? options.distances : new Uint32Array(64);
    let distanceCode = options.distanceCode;
    return {
      code(writer, target, plane, width, height, leaf) {
        if (leaf.offset !== 0 || leaf.multiplier !== 1) throw new Error('screen LZ77 is lossless only');
        screenMatches(screenResiduals(plane, width, height, leaf.predictor), (value, length, distance) => {
          if (length) {
            const d = distance === 1 ? 1 : distance + 119;
            if (writer) {
              writeHybrid(writer, target, lz77.lengthConfig, length - lz77.minLength, lz77.minSymbol);
              writeHybrid(writer, distanceCode, SCREEN_DISTANCE_CONFIG, d);
            } else {
              countToken(lz77.lengthConfig, length - lz77.minLength, target, lz77.minSymbol);
              countToken(SCREEN_DISTANCE_CONFIG, d, distances);
            }
          } else if (writer) writeHybrid(writer, target, RESIDUAL_CONFIG, value);
          else countToken(RESIDUAL_CONFIG, value, target);
        }, 4, lz77.minLength);
      },
      histograms(writer, ordered, freqs, histogramOf) {
        const contextMap = new Uint8Array(ordered.length + 1);
        for (const l of ordered) contextMap[l.context] = histogramOf(l) + 1;
        distanceCode = buildCode(distances);
        const histograms = [{config: SCREEN_DISTANCE_CONFIG, code: distanceCode}];
        for (let i = 0; i < Math.max(...contextMap); i++)
          histograms.push({config: RESIDUAL_CONFIG, code: buildCode(freqs[i])});
        writeHistograms(writer, {lz77, contextMap, histograms});
        return histograms;
      }
    };
  }
};

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

function screenRowMatches(values, width, emit, depth, minLength) {
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
  let i = 0, length = 0, distance = 0;
  const probe = at => {
    if (at < 0 || at >= i || values[at] !== values[i]) return;
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
    if (i + minLength <= values.length) {
      const row = rows[(i / width) | 0];
      if (row >= 0) probe(row + (i % width));
      for (let at = head[hash(i)], n = 0; at >= 0 && n < depth && i + length < values.length; at = previous[at], n++) probe(at);
    }
    if (length >= minLength) {
      emit(0, length, distance);
      for (let n = 0; n < length; n++) insert(i + n);
      i += length;
    } else { emit(values[i], 0, 0); insert(i++); }
  }
}

export function screenModel(plane, width, height, depth = 4, minLength = 7, predictors = [0, 1, 2, 5]) {
  let best;
  for (const predictor of predictors) {
    const pieces = [], freqs = new Uint32Array(ALPHABET), distances = new Uint32Array(64), token = [0, 0, 0];
    let raw = 0;
    const count = (config, value, target, base = 0) => {
      hybridToken(config, value, token); target[base + token[0]]++; raw += token[1];
    };
    const emit = (value, length, distance) => {
      if (length) {
        pieces.push(length - minLength, distance);
        count(LZ77.lengthConfig, length - minLength, freqs, LZ77.minSymbol);
        count(SCREEN_DISTANCE_CONFIG, distance === 1 ? 1 : distance + 119, distances);
      } else { pieces.push(value, 0); count(RESIDUAL_CONFIG, value, freqs); }
    };
    if (!kernelHooks.screen?.(plane, width, height, predictor, depth, emit, minLength))
      screenRowMatches(screenResiduals(plane, width, height, predictor), width, emit, depth, minLength);
    const code = buildCode(freqs), distance = buildCode(distances), writer = new BitWriter(256);
    writePrefixCode(writer, code); writePrefixCode(writer, distance);
    let bits = writer.bitLength + raw;
    for (let s = 0; s < freqs.length; s++) if (freqs[s]) bits += freqs[s] * code.lengths[s];
    for (let s = 0; s < distances.length; s++) if (distances[s]) bits += distances[s] * distance.lengths[s];
    if (!best || bits < best.bits) best = {leaf: leaf(predictor), code, distances, pieces, bits, width, minLength};
  }
  return best;
}

function screenIntegerPrice(freqs, config, raw) {
  const code = priceCode(freqs), writer = new BitWriter(256);
  writeHistograms(writer, {contextMap: new Uint8Array(1), histograms: [{config, code}]});
  let bits = writer.bitLength + raw;
  for (let s = 0; s < freqs.length; s++) if (freqs[s]) bits += freqs[s] * code.lengths[s];
  return {code, bits};
}

export function writeScreenModel(writer, models, codeBudget = 15) {
  const minLength = models[0].minLength;
  if (models.some(model => model.minLength !== minLength)) throw new Error('A screen stream has one copy minimum.');
  const configs = codeBudget >= SCREEN_INTEGER_CONFIGS.length ? SCREEN_INTEGER_CONFIGS : SCREEN_INTEGER_CONFIGS.slice(0, codeBudget);
  const ordered = writeTree(writer, channelTree(models.map(model => model.leaf))),
    counts = [], distances = new Map(), token = [0, 0, 0];
  for (const model of models) {
    const values = new Map(), lengths = new Map();
    for (let i = 0; i < model.pieces.length; i += 2) {
      const value = model.pieces[i], distance = model.pieces[i + 1];
      if (distance) {
        lengths.set(value, (lengths.get(value) || 0) + 1);
        distances.set(distance, (distances.get(distance) || 0) + 1);
      } else values.set(value, (values.get(value) || 0) + 1);
    }
    const literals = configs.map(config => {
      const freqs = new Uint32Array(512); let raw = 0;
      for (const [value, n] of values) { hybridToken(config, value, token); if (token[0] >= LZ77.minSymbol) return null; freqs[token[0]] += n; raw += token[1] * n; }
      return {config, freqs, raw};
    }).filter(Boolean);
    counts.push({literals, lengths});
  }
  const cheapest = (count, config) => {
    let best, lengthRaw = 0;
    const lengthFreqs = new Map();
    if (config) for (const [value, n] of count.lengths) {
      hybridToken(config, value, token);
      const symbol = LZ77.minSymbol + token[0];
      lengthFreqs.set(symbol, (lengthFreqs.get(symbol) || 0) + n); lengthRaw += token[1] * n;
    }
    const key = lengthRaw + ':' + [...lengthFreqs].sort((a, b) => a[0] - b[0]).join(';');
    count.priced ||= new Map();
    if (count.priced.has(key)) return count.priced.get(key);
    for (const literal of count.literals) {
      const freqs = literal.freqs.slice();
      for (const [symbol, n] of lengthFreqs) freqs[symbol] += n;
      const price = screenIntegerPrice(freqs, literal.config, literal.raw + lengthRaw);
      if (!best || price.bits < best.bits) best = {...price, config: literal.config};
    }
    count.priced.set(key, best);
    return best;
  };
  for (const count of counts) count.fixed = count.lengths.size ? null : cheapest(count);
  let length;
  for (const config of distances.size ? configs : [LZ77.lengthConfig]) {
    const codes = [], configs = [], parameter = new BitWriter(16);
    writeUintConfig(parameter, config, 8);
    let bits = parameter.bitLength;
    for (const count of counts) {
      const best = count.fixed || cheapest(count, config);
      bits += best.bits; codes.push(best.code); configs.push(best.config);
    }
    if (!length || bits < length.bits) length = {config, codes, configs, bits};
  }
  let distance;
  const map = distances.size ? screenDistanceMap(Math.max(...models.map(model => model.width))) : null;
  if (map) for (const spatial of [false, true]) for (const config of configs) {
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
  for (const code of distance ? [distance.code, ...length.codes] : length.codes) code.codes ||= canonicalCodes(code.lengths);
  const offset = distance ? 1 : 0, contextMap = new Uint8Array(ordered.length + offset);
  for (const leaf of ordered) contextMap[leaf.context] = models.findIndex(model => model.leaf === leaf) + offset;
  writeHistograms(writer, {
    lz77: distance ? {...LZ77, minLength, lengthConfig: length.config} : null,
    contextMap,
    histograms: [
      ...(distance ? [{config: distance.config, code: distance.code}] : []),
      ...length.codes.map((code, m) => ({config: length.configs[m], code}))
    ]
  });
  return () => {
    for (let m = 0; m < models.length; m++) for (let i = 0; i < models[m].pieces.length; i += 2) {
      const value = models[m].pieces[i], d = models[m].pieces[i + 1];
      writeHybrid(writer, length.codes[m], d ? length.config : length.configs[m], value, d ? LZ77.minSymbol : 0);
      if (d) writeHybrid(writer, distance.code, distance.config, distance.spatial ? (map.get(d) ?? d + 119) : d === 1 ? 1 : d + 119);
    }
  };
}
