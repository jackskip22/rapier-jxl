// SPDX-License-Identifier: MIT
import {BitWriter} from './bits.mjs';
import {buildCode, priceCode, canonicalCodes, uintConfig, hybridToken, writeHistograms, writeContextMap} from './prefix.mjs';

const MAP_LITERAL = uintConfig(8), MAP_LENGTH = uintConfig(4), MAP_DISTANCE = uintConfig(0), MAP_MIN_SYMBOL = 224;
const ONE_HIST_MAP = new Uint8Array(1), TWO_HIST_MAP = new Uint8Array([1, 0]);
const MTF_LIST = new Uint8Array(256);

function mapMoveToFront(map) {
  const list = MTF_LIST, out = new Uint8Array(map.length);
  for (let i = 0; i < 256; i++) list[i] = i;
  for (let i = 0; i < map.length; i++) {
    const v = map[i];
    let at = 0;
    while (list[at] !== v) at++;
    out[i] = at;
    if (at > 0) {
      for (let k = at; k > 0; k--) list[k] = list[k - 1];
      list[0] = v;
    }
  }
  return out;
}

const HEAD = new Int32Array(1 << 15).fill(-1);
let PREV = new Int32Array(0);
let RUNS = new Uint16Array(0);
let PIECE_VAL = new Uint8Array(4096);
let PIECE_LEN = new Uint16Array(4096);
let PIECE_DIST = new Uint16Array(4096);
let TOK_L0 = new Uint8Array(4096);
let TOK_L1 = new Uint8Array(4096);
let TOK_L2 = new Uint16Array(4096);
let TOK_D0 = new Uint8Array(4096);
let TOK_D1 = new Uint8Array(4096);
let TOK_D2 = new Uint16Array(4096);
const LITERALS_SCRATCH = new Uint32Array(MAP_MIN_SYMBOL + 40);
const DISTANCES_SCRATCH = new Uint32Array(40);
const mapSlots = [0, 0, 0];

function mapParseFlat(values, minLength, chain = 64) {
  const n = values.length, head = HEAD;
  if (PREV.length < n) PREV = new Int32Array(n);
  if (RUNS.length < n) RUNS = new Uint16Array(n);
  if (PIECE_VAL.length < n) {
    PIECE_VAL = new Uint8Array(n);
    PIECE_LEN = new Uint16Array(n);
    PIECE_DIST = new Uint16Array(n);
    TOK_L0 = new Uint8Array(n);
    TOK_L1 = new Uint8Array(n);
    TOK_L2 = new Uint16Array(n);
    TOK_D0 = new Uint8Array(n);
    TOK_D1 = new Uint8Array(n);
    TOK_D2 = new Uint16Array(n);
  }
  const prev = PREV, runs = RUNS, pVal = PIECE_VAL, pLen = PIECE_LEN, pDist = PIECE_DIST;
  if (n > 0) {
    runs[n - 1] = 0;
    for (let i = n - 2; i >= 0; i--) runs[i] = values[i] === values[i + 1] ? runs[i + 1] + 1 : 0;
  }
  const key = i => ((values[i] * 31 + values[i + 1]) * 31 + values[i + 2]) & 32767;
  const insert = i => { if (i + 2 < n) { const k = key(i); prev[i] = head[k]; head[k] = i; } };
  let count = 0;
  try {
    for (let i = 0; i < n;) {
      let bestLength = 0, bestDistance = 0;
      const run = runs[i];
      if (i + 2 < n) {
        for (let j = head[key(i)], tries = 0; j >= 0 && tries < chain; j = prev[j], tries++) {
          const rj = runs[j];
          let length;
          if (rj !== run) {
            length = (rj < run ? rj : run) + 1;
          } else {
            length = run + 1;
            while (i + length < n && values[j + length] === values[i + length]) length++;
          }
          if (length > bestLength) { bestLength = length; bestDistance = i - j; }
        }
      }
      if (run >= minLength && run + 1 > bestLength) {
        pVal[count] = values[i]; pLen[count] = 0; pDist[count++] = 0;
        insert(i); i++; bestLength = run; bestDistance = 1;
      }
      if (bestLength >= minLength) {
        pVal[count] = 0; pLen[count] = bestLength; pDist[count++] = bestDistance;
        for (let k = 0; k < bestLength; k++) insert(i + k);
        i += bestLength;
      } else {
        pVal[count] = values[i]; pLen[count] = 0; pDist[count++] = 0;
        insert(i); i++;
      }
    }
    return count;
  } finally {
    for (let i = 0; i + 2 < n; i++) head[key(i)] = -1;
  }
}

export function codedMap(map, mtf, minLength, moved, limitBits = Infinity) {
  const values = mtf ? moved ?? mapMoveToFront(map) : map, w = new BitWriter(256);
  w.write(1, 0); w.write(1, mtf ? 1 : 0);
  if (!minLength) {
    let widest = 0;
    for (let i = 0; i < values.length; i++) if (values[i] > widest) widest = values[i];
    const freqs = LITERALS_SCRATCH.subarray(0, widest + 1);
    freqs.fill(0);
    for (let i = 0; i < values.length; i++) freqs[values[i]]++;
    const code = priceCode(freqs);
    let dataBits = 0;
    for (let s = 0; s <= widest; s++) if (freqs[s]) dataBits += freqs[s] * code.lengths[s];
    if (2 + 12 + dataBits >= limitBits) return null;
    code.codes = canonicalCodes(code.lengths);
    writeHistograms(w, {contextMap: ONE_HIST_MAP, histograms: [{config: MAP_LITERAL, code}]});
    if (w.bitLength + dataBits >= limitBits) return null;
    const lengths = code.lengths, codes = code.codes;
    for (let i = 0; i < values.length; i++) { const v = values[i]; w.write(lengths[v], codes[v]); }
    return w;
  }
  const count = mapParseFlat(values, minLength);
  const literals = LITERALS_SCRATCH, distances = DISTANCES_SCRATCH;
  literals.fill(0); distances.fill(0);
  const pVal = PIECE_VAL, pLen = PIECE_LEN, pDist = PIECE_DIST;
  const tl0 = TOK_L0, tl1 = TOK_L1, tl2 = TOK_L2, td0 = TOK_D0, td1 = TOK_D1, td2 = TOK_D2;
  let extraBits = 0;
  for (let i = 0; i < count; i++) {
    const length = pLen[i];
    if (!length) { literals[pVal[i]]++; continue; }
    hybridToken(MAP_LENGTH, length - minLength, mapSlots);
    const l0 = mapSlots[0], l1 = mapSlots[1], l2 = mapSlots[2];
    tl0[i] = l0; tl1[i] = l1; tl2[i] = l2;
    hybridToken(MAP_DISTANCE, pDist[i] - 1, mapSlots);
    const d0 = mapSlots[0], d1 = mapSlots[1], d2 = mapSlots[2];
    td0[i] = d0; td1[i] = d1; td2[i] = d2;
    literals[MAP_MIN_SYMBOL + l0]++; distances[d0]++;
    extraBits += l1 + d1;
  }
  const literal = priceCode(literals), distance = priceCode(distances);
  let payloadBits = extraBits;
  for (let s = 0; s < literal.alphabetSize; s++) if (literals[s]) payloadBits += literals[s] * literal.lengths[s];
  for (let s = 0; s < distance.alphabetSize; s++) if (distances[s]) payloadBits += distances[s] * distance.lengths[s];
  if (2 + 20 + payloadBits >= limitBits) return null;
  literal.codes = canonicalCodes(literal.lengths);
  distance.codes = canonicalCodes(distance.lengths);
  writeHistograms(w, {lz77: {minSymbol: MAP_MIN_SYMBOL, minLength, lengthConfig: MAP_LENGTH}, contextMap: TWO_HIST_MAP,
    histograms: [{config: MAP_DISTANCE, code: distance}, {config: MAP_LITERAL, code: literal}]});
  if (w.bitLength + payloadBits >= limitBits) return null;
  const litLengths = literal.lengths, litCodes = literal.codes, distLengths = distance.lengths, distCodes = distance.codes;
  for (let i = 0; i < count; i++) {
    if (!pLen[i]) { const v = pVal[i]; w.write(litLengths[v], litCodes[v]); continue; }
    const s = MAP_MIN_SYMBOL + tl0[i], l1 = tl1[i], d0 = td0[i], d1 = td1[i];
    w.write(litLengths[s], litCodes[s]); if (l1) w.write(l1, tl2[i]);
    w.write(distLengths[d0], distCodes[d0]); if (d1) w.write(d1, td2[i]);
  }
  return w;
}

export function writeSmallestContextMap(w, map) {
  let best = new BitWriter(256);
  writeContextMap(best, map);
  const moved = map.length >= 16 ? mapMoveToFront(map) : null;
  if (map.length >= 16) for (const mtf of [false, true]) for (const minLength of [0, 3, 5]) {
    const candidate = codedMap(map, mtf, minLength, moved, best.bitLength);
    if (candidate && candidate.bitLength < best.bitLength) best = candidate;
  }
  w.append(best);
}
