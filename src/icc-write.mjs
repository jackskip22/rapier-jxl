// SPDX-License-Identifier: MIT
import {BitWriter, packSigned} from './bits.mjs';
import {fault} from './fault.mjs';
import {buildCode, countToken, uintConfig, writeHistograms, writeHybrid} from './prefix.mjs';
import {screenMatches} from './screen-lz77.mjs';
import {inspectICC} from './icc-profile.mjs';
import {profileFields} from './icc-transform.mjs';

const ICC_LEVEL5_BYTES = 4 * 1024 * 1024, ICC_WINDOW = 1 << 20;
const LITERAL = uintConfig(8), LENGTH = uintConfig(4), DISTANCE = uintConfig(4);
const MIN_LENGTH = 7, MIN_SYMBOL = 256;

function varint(out, value) {
  do { const byte = value % 128; value = Math.floor(value / 128); out.push(byte + (value ? 128 : 0)); } while (value);
}

function transformedICC(profile) {
  const commands = [0, 1];
  varint(commands, profile.length - 128);
  const preamble = [];
  varint(preamble, profile.length); varint(preamble, commands.length);
  const start = preamble.length + commands.length, out = new Uint8Array(start + profile.length);
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
  out.set(profile.subarray(128), start + 128);
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

function plainICC(data) {
  const frequencies = new Uint32Array(256);
  for (const value of data) frequencies[value]++;
  const code = buildCode(frequencies), writer = new BitWriter(Math.min(data.length + 128, 65536));
  writeLength(writer, data.length);
  writeHistograms(writer, {contextMap: new Uint8Array(41), histograms: [{config: LITERAL, code}]});
  for (const value of data) writeHybrid(writer, code, LITERAL, value);
  return writer;
}

function matches(data, emit) {
  let position = 0;
  screenMatches(data, (value, length, distance) => {
    if (length && distance > ICC_WINDOW) {
      for (let i = 0; i < length; i++) emit(data[position + i], 0, 0);
    } else if (length && data.length > 65536) {
      let done = 0;
      while (length - done >= MIN_LENGTH) {
        const count = Math.min(256, length - done); emit(0, count, distance); done += count;
      }
      while (done < length) emit(data[position + done++], 0, 0);
    } else emit(value, length, distance);
    position += length || 1;
  }, 4, MIN_LENGTH);
}

function lzICC(data) {
  const frequencies = new Uint32Array(320), distances = new Uint32Array(64);
  matches(data, (value, length, distance) => {
    if (length) {
      countToken(LENGTH, length - MIN_LENGTH, frequencies, MIN_SYMBOL);
      countToken(DISTANCE, distance - 1, distances);
    } else frequencies[value]++;
  });
  const code = buildCode(frequencies), distanceCode = buildCode(distances);
  const writer = new BitWriter(Math.min(data.length + 128, 65536)), contextMap = new Uint8Array(42);
  contextMap[41] = 1;
  writeLength(writer, data.length);
  writeHistograms(writer, {lz77: {minSymbol: MIN_SYMBOL, minLength: MIN_LENGTH, lengthConfig: LENGTH}, contextMap,
    histograms: [{config: LITERAL, code}, {config: DISTANCE, code: distanceCode}]});
  matches(data, (value, length, distance) => {
    if (length) {
      writeHybrid(writer, code, LENGTH, length - MIN_LENGTH, MIN_SYMBOL);
      writeHybrid(writer, distanceCode, DISTANCE, distance - 1);
    } else writeHybrid(writer, code, LITERAL, value);
  });
  return writer;
}

export function prepareICC(profile, {level, compression = 'auto', colorSpace, colorEncoding} = {}) {
  if (level !== undefined && level !== 5 && level !== 10) throw fault('JXL_INPUT', 'JPEG XL level is 5 or 10.');
  if (!['auto', 'prefix', 'lz77'].includes(compression)) throw fault('JXL_INPUT', 'ICC compression is auto, prefix or lz77.');
  const colorChannels = inspectICC(profile, level, colorSpace);
  let space = colorChannels === 3 ? 0 : 1;
  if (colorEncoding !== undefined) {
    if (!colorEncoding || typeof colorEncoding !== 'object' || Array.isArray(colorEncoding) ||
        Object.entries(colorEncoding).some(([key, value]) => key !== 'space' && value !== undefined))
      throw fault('JXL_INPUT', 'An ICC colorEncoding declares only its explicit space. The profile supplies all other color fields.');
    space = new Map([['rgb', 0], ['gray', 1], ['xyb', 2], ['unknown', 3]]).get(colorEncoding.space);
    if (space === undefined || (space === 1) !== (colorChannels === 1))
      throw fault('JXL_INPUT', 'ICC colorEncoding.space must agree with its one- or three-component channel context.');
  }
  const selectedLevel = level ?? (colorSpace === 'cmyk' || profile.length > ICC_LEVEL5_BYTES ? 10 : 5);
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
  const colorData = new BitWriter(16);
  colorData.write(2, 2);
  colorData.writeU32([[0, 0], [0, 1], [4, 2], [6, 18]], space);
  return {colorData, iccData, colorChannels, level: selectedLevel};
}


const prepared = new WeakMap();
export function iccSpace(profile, {level, compression} = {}, made) {
  const space = {icc: profile, level, compression, colorChannels: made?.colorChannels};
  if (made) prepared.set(space, made);
  return space;
}
export function headerOf(space, xyb = false) {
  if (xyb) {
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
