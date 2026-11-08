// SPDX-License-Identifier: MIT
import {BitWriter, packSigned} from './bits.mjs';
import {fault} from './fault.mjs';
import {writeHeaderFields} from './frame.mjs';
import {buildCode, countToken, uintConfig, writeHistograms, writeHybrid} from './prefix.mjs';
import {screenMatches} from './screen-lz77.mjs';
import {inspectICC, inspectICCSteps} from './icc-profile.mjs';
import {profileFields} from './icc-transform.mjs';
import {journaling, journalTool} from './step-journal.mjs';

const ICC_LEVEL5_BYTES = 4 * 1024 * 1024, ICC_WINDOW = 1 << 20;
const LITERAL = /* @__PURE__ */ uintConfig(8), LENGTH = /* @__PURE__ */ uintConfig(4), DISTANCE = /* @__PURE__ */ uintConfig(4);
const MIN_LENGTH = 7, MIN_SYMBOL = 256;

function varint(out, value) {
  do { const byte = value % 128; value = Math.floor(value / 128); out.push(byte + (value ? 128 : 0)); } while (value);
}

function transformedICC(profile, whole = true) {
  const commands = [0, 1];
  varint(commands, profile.length - 128);
  const preamble = [];
  varint(preamble, profile.length); varint(preamble, commands.length);
  const start = preamble.length + commands.length, out = new Uint8Array(start + (whole ? profile.length : 128));
  out.set(preamble); out.set(commands, preamble.length);
  const prediction = new Uint8Array(128);
  prediction.set(profile.subarray(0, 4)); prediction[8] = 4;
  for (const [at, text] of [[12, 'mntrRGB XYZ '], [36, 'acsp']])
    for (let i = 0; i < text.length; i++) prediction[at + i] = text.charCodeAt(i);
  prediction.set([0, 0, 246, 214, 0, 1, 0, 0, 0, 0, 211, 45], 68);
  prediction.set(profile.subarray(4, 8), 80);
  const platform = profile[40] === 65 ? 'PPL' : profile[40] === 77 ? 'SFT' : null;
  if (platform) for (let i = 0; i < 3; i++) prediction[41 + i] = platform.charCodeAt(i);
  if (profile[40] === 83 && (profile[41] === 71 || profile[41] === 85)) {
    prediction[42] = profile[41] === 71 ? 73 : 78;
    prediction[43] = profile[41] === 71 ? 32 : 87;
  }
  for (let i = 0; i < 128; i++) out[start + i] = (profile[i] - prediction[i]) & 255;
  if (whole) out.set(profile.subarray(128), start + 128);
  return out;
}

function writeLength(writer, value) {
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
  writeHistograms(writer, {contextMap,
    ...(distances && {lz77: {minSymbol: MIN_SYMBOL, minLength: MIN_LENGTH, lengthConfig: LENGTH}}),
    histograms: [{config: LITERAL, code}, ...(distances ? [{config: DISTANCE, code: distanceCode}] : [])]});
  return {writer, code, distanceCode};
}
function iccSymbol(writer, model, value, length, distance) {
  if (length) {
    if (writer) {
      writeHybrid(writer, model.code, LENGTH, length - MIN_LENGTH, MIN_SYMBOL);
      writeHybrid(writer, model.distanceCode, DISTANCE, distance - 1);
    } else {
      countToken(LENGTH, length - MIN_LENGTH, model.frequencies, MIN_SYMBOL);
      countToken(DISTANCE, distance - 1, model.distances);
    }
  } else if (writer) writeHybrid(writer, model.code, LITERAL, value);
  else model.frequencies[value]++;
}
function iccMatch(data, emit, position, value, length, distance) {
  if (length && distance > ICC_WINDOW) {
    const bytes = data.subarray(position, position + length);
    for (const value of bytes) emit(value, 0, 0);
  } else if (length && data.length > 65536) {
    let done = 0;
    while (length - done >= MIN_LENGTH) {
      const count = Math.min(256, length - done); emit(0, count, distance); done += count;
    }
    while (done < length) emit(data[position + done++], 0, 0);
  } else emit(value, length, distance);
}
function matches(data, emit) {
  let position = 0;
  screenMatches(data, (value, length, distance) => {
    iccMatch(data, emit, position, value, length, distance);
    position += length || 1;
  }, 4, MIN_LENGTH);
}
function plainICC(data) {
  const frequencies = new Uint32Array(256);
  for (const value of data) frequencies[value]++;
  const model = iccModel(data.length, frequencies);
  for (const value of data) iccSymbol(model.writer, model, value, 0, 0);
  return model.writer;
}
function lzICC(data) {
  const frequencies = new Uint32Array(320), distances = new Uint32Array(64);
  const counts = {frequencies, distances};
  matches(data, (value, length, distance) => iccSymbol(null, counts, value, length, distance));
  const model = iccModel(data.length, frequencies, distances);
  matches(data, (value, length, distance) => iccSymbol(model.writer, model, value, length, distance));
  return model.writer;
}

function iccOptions({level, compression = 'auto'} = {}) {
  if (level !== undefined && level !== 5 && level !== 10) throw fault('JXL_INPUT', 'JPEG XL level is 5 or 10.');
  if (!['auto', 'prefix', 'lz77'].includes(compression)) throw fault('JXL_INPUT', 'ICC compression is auto, prefix or lz77.');
  return compression;
}
function iccFields(profile, {level, colorSpace, colorEncoding} = {}, colorChannels) {
  let space = colorChannels === 3 ? 0 : 1;
  if (colorEncoding !== undefined) {
    if (!colorEncoding || typeof colorEncoding !== 'object' || Array.isArray(colorEncoding) ||
        Object.entries(colorEncoding).some(([key, value]) => key !== 'space' && value !== undefined))
      throw fault('JXL_INPUT', 'With ICC, colorEncoding gives only space.');
    space = new Map([['rgb', 0], ['gray', 1], ['xyb', 2], ['unknown', 3]]).get(colorEncoding.space);
    if (space === undefined || (space === 1) !== (colorChannels === 1))
      throw fault('JXL_INPUT', 'ICC colorEncoding.space does not match the channel count.');
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
  return {...fields, iccData};
}

export function* prepareICCSteps(profile, options = {}) {
  if (!journaling()) return prepareICC(profile, options);
  return yield* journalTool('prepareICC')(profile, options, {options: iccOptions, fields: iccFields, inspect: inspectICCSteps,
    transform: transformedICC, matches: screenMatches, match: iccMatch, model: iccModel, symbol: iccSymbol});
}


const prepared = new WeakMap();
export function iccSpace(profile, {level, compression} = {}, made) {
  const space = {icc: profile, level, compression, colorChannels: made?.colorChannels};
  if (made) prepared.set(space, made);
  return space;
}
export function headerOf(space, xyb = false) {
  if (xyb && !(typeof __RAPIER_JXL_JPEG__ !== 'undefined' && __RAPIER_JXL_JPEG__ === true)) {
    if (!named.has(space)) named.set(space, namedHeader(profileFields(space.icc)));
    const made = named.get(space);
    if (made) return made;
  }
  let made = prepared.get(space);
  if (!made) prepared.set(space, made = prepareICC(space.icc, {level: space.level, compression: space.compression}));
  return made;
}

const named = new WeakMap(), ICC_ENUM = [[0, 0], [0, 1], [4, 2], [6, 18]], ICC_XY = [[19, 0], [19, 524288], [20, 1048576], [21, 2097152]];
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

const noProfile = () => { throw fault('JXL_INTERNAL', 'A page capture carries no ICC profile.'); };
export function writeImageHeader(w, width, height, colour, alpha, options = {}) {
  return writeHeaderFields(w, width, height, colour, alpha, options,
    (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) ? noProfile : headerOf);
}
