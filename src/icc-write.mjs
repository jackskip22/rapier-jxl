// SPDX-License-Identifier: MIT
import {BitWriter, packSigned} from './bits.mjs';
import {fault} from './fault.mjs';
import {writeHeaderFields} from './frame.mjs';
import {buildCode, priceCode, canonicalCodes, countToken, uintConfig, writeHistograms, writeHybrid, smallCoding, setSmallCoding} from './prefix.mjs';
import {screenMatches} from './screen-lz77.mjs';
import {inspectICC, inspectICCSteps, predictICC, predictICCPlan, predictICCPart} from './icc-profile.mjs';
import {profileFields} from './icc-transform.mjs';
import {journaling, journalTool} from './step-journal.mjs';

const ICC_LEVEL5_BYTES = 4 * 1024 * 1024, ICC_WINDOW = 1 << 20;
const LITERAL = /* @__PURE__ */ uintConfig(8), LENGTH = /* @__PURE__ */ uintConfig(4), DISTANCE = /* @__PURE__ */ uintConfig(4);
const MIN_LENGTH = 7, MIN_SYMBOL = 256;
const CONTEXT_LITERAL = /* @__PURE__ */ uintConfig(7, 7), SHARED = /* @__PURE__ */ uintConfig(0), ONE_CONTEXT = /* @__PURE__ */ new Uint8Array(1);

function iccHistograms(writer, model) {
  const saved = smallCoding();
  setSmallCoding(false);
  try { writeHistograms(writer, model); } finally { setSmallCoding(saved); }
}

function iccContext(data, i) {
  if (i <= 128) return 0;
  const a = data[i - 1], b = data[i - 2];
  const letter = v => v >= 65 && v <= 90 || v >= 97 && v <= 122;
  const digit = v => v >= 48 && v <= 57 || v === 44 || v === 46;
  const first = letter(a) ? 0 : digit(a) ? 1 : a < 2 ? 2 + a : a < 16 ? 4 : a === 255 ? 6 : a > 240 ? 5 : 7;
  const second = letter(b) ? 0 : digit(b) ? 1 : b < 16 ? 2 : b > 240 ? 3 : 4;
  return 1 + first + 8 * second;
}

function transformedICC(profile, whole = true) {
  const {prefix} = predictICCPlan(profile, false);
  if (!whole) return prefix;
  const out = new Uint8Array(prefix.length + profile.length - 128);
  out.set(prefix); out.set(profile.subarray(128), prefix.length);
  return out;
}

export function writeLength(writer, value) {
  if (!value) { writer.write(2, 0); return; }
  if (value <= 16) { writer.write(2, 1); writer.write(4, value - 1); return; }
  if (value <= 272) { writer.write(2, 2); writer.write(8, value - 17); return; }
  writer.write(2, 3); writer.write(12, value % 4096); value = Math.floor(value / 4096);
  while (value) { writer.write(1, 1); writer.write(8, value % 256); value = Math.floor(value / 256); }
  writer.write(1, 0);
}

function iccModel(size, frequencies, distances) {
  const code = buildCode(frequencies), distanceCode = distances ? buildCode(distances) : null;
  const writer = new BitWriter(Math.min(size + 128, 65536)), contextMap = new Uint8Array(distances ? 42 : 41);
  if (distances) contextMap[41] = 1;
  writeLength(writer, size);
  iccHistograms(writer, {contextMap,
    ...(distances && {lz77: {minSymbol: MIN_SYMBOL, minLength: MIN_LENGTH, lengthConfig: LENGTH}}),
    histograms: [{config: LITERAL, code}, ...(distances ? [{config: DISTANCE, code: distanceCode}] : [])]});
  return {writer, code, distanceCode};
}
function iccSymbol(writer, model, value, length, distance, context = 0) {
  const code = writer ? model.codes ? model.codes[model.contextMap[context]] : model.code : null;
  const frequencies = writer ? null : model.clustered ? model.frequencies[context] : model.frequencies;
  if (length) {
    if (writer) {
      writeHybrid(writer, code, model.shared ? SHARED : LENGTH, length - (model.minLength ?? MIN_LENGTH), model.shared ? 512 : MIN_SYMBOL);
      writeHybrid(writer, model.distanceCode, model.shared ? SHARED : DISTANCE, distance - 1);
    } else {
      countToken(model.shared ? SHARED : LENGTH, length - (model.minLength ?? MIN_LENGTH), frequencies, model.shared ? 512 : MIN_SYMBOL);
      countToken(model.shared ? SHARED : DISTANCE, distance - 1, model.shared ? frequencies : model.distances);
    }
  } else if (writer) writeHybrid(writer, code, model.literal ?? LITERAL, value);
  else if (model.shared) countToken(SHARED, value, frequencies);
  else frequencies[value]++;
}
function iccMatch(data, emit, position, value, length, distance, minLength = MIN_LENGTH) {
  if (length && distance > ICC_WINDOW) {
    const bytes = data.subarray(position, position + length);
    for (const value of bytes) emit(value, 0, 0);
  } else if (length && data.length > 65536) {
    let done = 0;
    while (length - done >= minLength) {
      const count = Math.min(256, length - done); emit(0, count, distance); done += count;
    }
    while (done < length) emit(data[position + done++], 0, 0);
  } else emit(value, length, distance);
}
function matches(data, emit, minLength = MIN_LENGTH, depth = 4) {
  let position = 0;
  screenMatches(data, (value, length, distance) => {
    iccMatch(data, emit, position, value, length, distance, minLength);
    position += length || 1;
  }, depth, minLength);
}
function plainICC(data) {
  const frequencies = new Uint32Array(256);
  for (const value of data) frequencies[value]++;
  const model = iccModel(data.length, frequencies);
  for (const value of data) iccSymbol(model.writer, model, value, 0, 0);
  return model.writer;
}
export function lzICC(data) {
  const frequencies = new Uint32Array(320), distances = new Uint32Array(64);
  const counts = {frequencies, distances};
  matches(data, (value, length, distance) => iccSymbol(null, counts, value, length, distance));
  const model = iccModel(data.length, frequencies, distances);
  matches(data, (value, length, distance) => iccSymbol(model.writer, model, value, length, distance));
  return model.writer;
}

function histogramPrice(freqs, config = CONTEXT_LITERAL) {
  const code = priceCode(freqs), counter = {bitLength: 0, write(n) { this.bitLength += n; }};
  iccHistograms(counter, {contextMap: ONE_CONTEXT, histograms: [{config, code}]});
  let payload = 0;
  for (let s = 0; s < freqs.length; s++) if (freqs[s]) payload += freqs[s] * code.lengths[s];
  return {code, payload, cost: counter.bitLength - 2 + payload};
}

function iccContextModel(size, frequencies, distances, minLength = 7) {
  const width = distances ? MIN_SYMBOL + 64 : 256, clusters = [];
  for (let ctx = 0; ctx < 41; ctx++) {
    const row = frequencies[ctx];
    if (row.some(Boolean)) {
      const freqs = Float64Array.from(row);
      clusters.push({freqs, contexts: [ctx], ...histogramPrice(freqs)});
    }
  }
  if (!clusters.length) {
    const freqs = new Float64Array(width);
    clusters.push({freqs, contexts: [0], ...histogramPrice(freqs)});
  }
  const distance = distances ? histogramPrice(distances, DISTANCE) : null;
  const n = clusters.length, pairs = new Float64Array(n * n), merged = new Float64Array(width);
  const pairPrice = (a, b) => {
    const left = clusters[a], right = clusters[b];
    for (let s = 0; s < width; s++) merged[s] = left.freqs[s] + right.freqs[s];
    return histogramPrice(merged).cost - left.cost - right.cost;
  };
  const model = () => {
    const contextMap = new Uint8Array(distances ? 42 : 41).fill(255), codes = [];
    let payload = 0;
    for (const cluster of clusters) if (cluster) {
      const id = codes.length; codes.push(cluster.code); payload += cluster.payload;
      for (const ctx of cluster.contexts) contextMap[ctx] = id;
    }
    for (let ctx = 0; ctx < 41; ctx++) if (contextMap[ctx] === 255) contextMap[ctx] = ctx ? contextMap[ctx - 1] : 0;
    const histograms = codes.map(code => ({config: CONTEXT_LITERAL, code}));
    if (distance) {
      contextMap[41] = histograms.length;
      histograms.push({config: DISTANCE, code: distance.code}); payload += distance.payload;
    }
    const writer = new BitWriter(Math.min(size + 128, 65536));
    writeLength(writer, size);
    iccHistograms(writer, {contextMap, histograms,
      ...(distance && {lz77: {minSymbol: MIN_SYMBOL, minLength, lengthConfig: LENGTH}})});
    return {writer, codes, contextMap, distanceCode: distance?.code ?? null, bits: writer.bitLength + payload};
  };
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) pairs[a * n + b] = pairPrice(a, b);
  let best = model();
  for (let remaining = n; remaining > 1; remaining--) {
    let left = -1, right = -1, smallest = Infinity;
    for (let a = 0; a < n; a++) if (clusters[a]) for (let b = a + 1; b < n; b++) if (clusters[b]) {
      const delta = pairs[a * n + b];
      if (delta < smallest) { smallest = delta; left = a; right = b; }
    }
    const a = clusters[left], b = clusters[right];
    for (let s = 0; s < width; s++) a.freqs[s] += b.freqs[s];
    a.contexts.push(...b.contexts); Object.assign(a, histogramPrice(a.freqs)); clusters[right] = null;
    for (let i = 0; i < n; i++) if (i !== left && clusters[i]) pairs[Math.min(i, left) * n + Math.max(i, left)] = pairPrice(Math.min(i, left), Math.max(i, left));
    const candidate = model();
    if (candidate.bits < best.bits) best = candidate;
  }
  for (const code of best.codes) code.codes = canonicalCodes(code.lengths);
  if (best.distanceCode) best.distanceCode.codes = canonicalCodes(best.distanceCode.lengths);
  return {...best, minLength, literal: CONTEXT_LITERAL};
}


function iccCounts(lz, clustered = false, minLength = MIN_LENGTH, shared = false) {
  const width = shared ? 576 : lz ? 320 : 256;
  return {frequencies: clustered ? Array.from({length: 41}, () => new Uint32Array(width)) : new Uint32Array(width),
    distances: lz && !shared ? new Uint32Array(64) : null, clustered, minLength, shared};
}
function iccSharedModel(size, frequencies, distances, minLength) {
  const code = buildCode(frequencies), writer = new BitWriter(Math.min(size + 128, 65536));
  writeLength(writer, size);
  iccHistograms(writer, {contextMap: new Uint8Array(42),
    lz77: {minSymbol: 512, minLength, lengthConfig: SHARED}, histograms: [{config: SHARED, code}]});
  return {writer, code, distanceCode: code, minLength, literal: SHARED, shared: true};
}
function iccProgress(bits, position, count = 1) {
  const boundary = Math.max(65536, Math.ceil(position / 65536) * 65536);
  if (boundary < position + count && boundary > bits * 32) throw fault('JXL_SIZE', 'icc: entropy expansion');
}
function contextICC(data, minLength = 0, shared = false, depth = 4) {
  const counts = iccCounts(!!minLength, !shared, minLength, shared);
  let position = 0;
  const run = emit => {
    if (minLength) matches(data, emit, minLength, depth);
    else for (const value of data) emit(value, 0, 0);
  };
  run((value, length, distance) => {
    iccSymbol(null, counts, value, length, distance, shared ? 0 : iccContext(data, position)); position += length || 1;
  });
  const model = (shared ? iccSharedModel : iccContextModel)(data.length, counts.frequencies, counts.distances, minLength); position = 0;
  run((value, length, distance) => {
    const count = length || 1;
    if (data.length > 65536) iccProgress(model.writer.bitLength, position);
    iccSymbol(model.writer, model, value, length, distance, shared ? 0 : iccContext(data, position));
    if (data.length > 65536 && count > 1) iccProgress(model.writer.bitLength, position + 1, count - 1);
    position += count;
  });
  return model.writer;
}

const ICC_SEARCH = [[0, false, 4], [7, false, 4], [9, false, 4], [3, true, 16], [7, true, 4]];
function iccCandidates(compression) {
  return ICC_SEARCH.filter(([minLength]) => compression === 'auto' || (compression === 'lz77') === !!minLength);
}

function iccOptions({level, compression = 'auto'} = {}) {
  if (level !== undefined && level !== 5 && level !== 10) throw fault('JXL_INPUT', 'level: 5 or 10');
  if (!['auto', 'prefix', 'lz77'].includes(compression)) throw fault('JXL_INPUT', 'compression: auto, prefix or lz77');
  return compression;
}
function iccFields(profile, {level, colorSpace, colorEncoding} = {}, colorChannels) {
  let space = colorChannels === 3 ? 0 : 1;
  if (colorEncoding !== undefined) {
    if (!colorEncoding || typeof colorEncoding !== 'object' || Array.isArray(colorEncoding) ||
        Object.entries(colorEncoding).some(([key, value]) => key !== 'space' && value !== undefined))
      throw fault('JXL_INPUT', 'colorEncoding: space only with icc');
    space = new Map([['rgb', 0], ['gray', 1], ['xyb', 2], ['unknown', 3]]).get(colorEncoding.space);
    if (space === undefined || (space === 1) !== (colorChannels === 1))
      throw fault('JXL_INPUT', 'colorEncoding.space: channel mismatch');
  }
  const selectedLevel = level ?? (colorSpace === 'cmyk' || profile.length > ICC_LEVEL5_BYTES ? 10 : 5);
  const colorData = new BitWriter(16);
  colorData.write(2, 2);
  colorData.writeU32([[0, 0], [0, 1], [4, 2], [6, 18]], space);
  return {colorData, colorChannels, level: selectedLevel};
}
export function prepareICC(profile, options = {}) {
  const compression = iccOptions(options), fields = iccFields(profile, options, inspectICC(profile, options.level, options.colorSpace));
  const bytes = Uint8Array.from(profile), transformed = transformedICC(bytes);
  let iccData = null, capacityError;
  if (compression !== 'lz77') {
    try { iccData = plainICC(transformed); }
    catch (error) { if (compression !== 'auto' || error.code !== 'JXL_SIZE') throw error; capacityError = error; }
  }
  if (compression !== 'prefix') {
    try {
      const candidate = lzICC(transformed);
      if (!iccData || candidate.bitLength < iccData.bitLength) iccData = candidate;
    } catch (error) { if (!iccData || error.code !== 'JXL_SIZE') throw error; }
  }
  if (!iccData) throw capacityError;
  const predicted = predictICC(bytes, true);
  for (const [minLength, shared, depth] of iccCandidates(compression)) {
    try {
      const candidate = contextICC(predicted, minLength, shared, depth);
      if (candidate.bitLength < iccData.bitLength) iccData = candidate;
    } catch (error) { if (error.code !== 'JXL_SIZE') throw error; }
  }
  return {...fields, iccData};
}

export function* prepareICCSteps(profile, options = {}) {
  if (!journaling()) return prepareICC(profile, options);
  return yield* journalTool('prepareICC')(profile, options, {BitWriter, options: iccOptions, fields: iccFields, inspect: inspectICCSteps,
    transform: transformedICC, predict: profile => predictICCPlan(profile, true, true), predictPart: predictICCPart, matches: screenMatches, match: iccMatch,
    model: iccModel, contextModel: iccContextModel, sharedModel: iccSharedModel, candidates: iccCandidates, counts: iccCounts, context: iccContext, progress: iccProgress, symbol: iccSymbol});
}


const prepared = /* @__PURE__ */ new WeakMap();
export function iccSpace(profile, {level, compression} = {}, made) {
  const space = {icc: profile, level, compression, colorChannels: made?.colorChannels};
  if (made) prepared.set(space, made);
  return space;
}
export function headerOf(space, xyb = false) {
  if (space.header) return space.header;
  if (xyb && !(typeof __RAPIER_JXL_JPEG__ !== 'undefined' && __RAPIER_JXL_JPEG__ === true)) {
    if (!named.has(space)) named.set(space, namedHeader(profileFields(space.icc)));
    const made = named.get(space);
    if (made) return made;
  }
  let made = prepared.get(space);
  if (!made) prepared.set(space, made = prepareICC(space.icc, {level: space.level, compression: space.compression}));
  return made;
}

const named = /* @__PURE__ */ new WeakMap(), ICC_ENUM = [[0, 0], [0, 1], [4, 2], [6, 18]], ICC_XY = [[19, 0], [19, 524288], [20, 1048576], [21, 2097152]];
function namedHeader(fields) {
  if (!fields) return null;
  const colorData = new BitWriter(64), xy = pair => { for (const v of pair) colorData.writeU32(ICC_XY, packSigned(Math.round(v * 1e6))); };
  colorData.write(2, 0);
  colorData.writeU32(ICC_ENUM, fields.gray ? 1 : 0);
  colorData.writeU32(ICC_ENUM, fields.white.enum);
  if (fields.white.enum === 2) xy(fields.white.xy);
  if (!fields.gray) {
    colorData.writeU32(ICC_ENUM, fields.primaries.enum);
    if (fields.primaries.enum === 2) fields.primaries.xy.forEach(xy);
  }
  colorData.write(1, fields.gamma ? 1 : 0);
  if (fields.gamma) colorData.write(24, Math.round(fields.gamma * 1e7)); else colorData.writeU32(ICC_ENUM, fields.transfer);
  colorData.writeU32(ICC_ENUM, fields.intent);
  return {colorData, iccData: null};
}

const noProfile = () => { throw fault('JXL_INTERNAL', 'icc-write:capture'); };
export function writeImageHeader(w, width, height, colour, alpha, options = {}) {
  return writeHeaderFields(w, width, height, colour, alpha, options,
    (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) ? noProfile : headerOf);
}
