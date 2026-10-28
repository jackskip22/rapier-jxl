// SPDX-License-Identifier: MIT
import {BitWriter} from './bits.mjs';
import {buildCode, uintConfig, hybridToken, writeHistograms, writeContextMap} from './prefix.mjs';

const MAP_LITERAL = uintConfig(8), MAP_LENGTH = uintConfig(4), MAP_DISTANCE = uintConfig(0), MAP_MIN_SYMBOL = 224;

function mapMoveToFront(map) {
  const list = Uint8Array.from({length: 256}, (_, i) => i), out = new Uint8Array(map.length);
  for (let i = 0; i < map.length; i++) {
    const v = map[i];
    let at = 0;
    while (list[at] !== v) at++;
    out[i] = at;
    list.copyWithin(1, 0, at); list[0] = v;
  }
  return out;
}

const HEAD = new Int32Array(1 << 15).fill(-1);
let PREV = new Int32Array(0);
function mapParse(values, minLength, chain = 64) {
  const n = values.length, head = HEAD, pieces = [];
  if (PREV.length < n) PREV = new Int32Array(n);
  const prev = PREV;
  const key = i => ((values[i] * 31 + values[i + 1]) * 31 + values[i + 2]) & 32767;
  const insert = i => { if (i + 2 < n) { const k = key(i); prev[i] = head[k]; head[k] = i; } };
  try { return parse(values, n, minLength, chain, head, prev, pieces, key, insert); }
  finally { for (let i = 0; i + 2 < n; i++) head[key(i)] = -1; }
}
function parse(values, n, minLength, chain, head, prev, pieces, key, insert) {
  for (let i = 0; i < n;) {
    let bestLength = 0, bestDistance = 0;
    if (i + 2 < n) for (let j = head[key(i)], tries = 0; j >= 0 && tries < chain; j = prev[j], tries++) {
      let length = 0;
      while (i + length < n && values[j + length] === values[i + length]) length++;
      if (length > bestLength) { bestLength = length; bestDistance = i - j; }
    }
    let run = 0;
    while (i + 1 + run < n && values[i + 1 + run] === values[i]) run++;
    if (run >= minLength && run + 1 > bestLength) { pieces.push([values[i], 0, 0]); insert(i); i++; bestLength = run; bestDistance = 1; }
    if (bestLength >= minLength) {
      pieces.push([0, bestLength, bestDistance]);
      for (let k = 0; k < bestLength; k++) insert(i + k);
      i += bestLength;
    } else { pieces.push([values[i], 0, 0]); insert(i); i++; }
  }
  return pieces;
}

const mapSlots = [0, 0, 0];
function mapToken(config, value) { hybridToken(config, value, mapSlots); return [mapSlots[0], mapSlots[1], mapSlots[2]]; }

export function codedMap(map, mtf, minLength, moved) {
  const values = mtf ? moved ?? mapMoveToFront(map) : map, w = new BitWriter(256);
  w.write(1, 0); w.write(1, mtf ? 1 : 0);
  if (!minLength) {
    let widest = 0;
    for (const v of values) widest = Math.max(widest, v);
    const freqs = new Uint32Array(widest + 1);
    for (const v of values) freqs[v]++;
    const code = buildCode(freqs);
    writeHistograms(w, {contextMap: new Uint8Array(1), histograms: [{config: MAP_LITERAL, code}]});
    for (const v of values) w.write(code.lengths[v], code.codes[v]);
    return w;
  }
  const pieces = mapParse(values, minLength), literals = new Uint32Array(MAP_MIN_SYMBOL + 40), distances = new Uint32Array(40);
  const tokens = pieces.map(([value, length, distance]) => {
    if (!length) { literals[value]++; return null; }
    const l = mapToken(MAP_LENGTH, length - minLength), d = mapToken(MAP_DISTANCE, distance - 1);
    literals[MAP_MIN_SYMBOL + l[0]]++; distances[d[0]]++;
    return [l, d];
  });
  const literal = buildCode(literals), distance = buildCode(distances);
  writeHistograms(w, {lz77: {minSymbol: MAP_MIN_SYMBOL, minLength, lengthConfig: MAP_LENGTH}, contextMap: new Uint8Array([1, 0]),
    histograms: [{config: MAP_DISTANCE, code: distance}, {config: MAP_LITERAL, code: literal}]});
  pieces.forEach(([value, length], i) => {
    if (!length) { w.write(literal.lengths[value], literal.codes[value]); return; }
    const [l, d] = tokens[i], s = MAP_MIN_SYMBOL + l[0];
    w.write(literal.lengths[s], literal.codes[s]); if (l[1]) w.write(l[1], l[2]);
    w.write(distance.lengths[d[0]], distance.codes[d[0]]); if (d[1]) w.write(d[1], d[2]);
  });
  return w;
}

export function writeSmallestContextMap(w, map) {
  let best = new BitWriter(256);
  writeContextMap(best, map);
  const moved = map.length >= 16 ? mapMoveToFront(map) : null;
  if (map.length >= 16) for (const mtf of [false, true]) for (const minLength of [0, 3, 5]) {
    const candidate = codedMap(map, mtf, minLength, moved);
    if (candidate.bitLength < best.bitLength) best = candidate;
  }
  w.append(best);
}
