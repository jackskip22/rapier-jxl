// SPDX-License-Identifier: MIT
import {BitWriter, float16Bits, packSigned} from './bits.mjs';
import {fault} from './admit.mjs';
import {inspectICC} from './icc-profile.mjs';

export {inspectICC};

const COLOR_ENUM = [[0, 0], [0, 1], [4, 2], [6, 18]];
const XY = [[19, 0], [19, 524288], [20, 1048576], [21, 2097152]];
const WHITE = {d65: 1, e: 10, dci: 11};
const PRIMARIES = {srgb: 1, 'display-p3': 11, rec2020: 9};
const TRANSFER = {bt709: 1, linear: 8, srgb: 13, pq: 16, dci: 17, hlg: 18};
const INTENT = {perceptual: 0, relative: 1, saturation: 2, absolute: 3};

function record(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fault('JXL_INPUT', name + ' is an object.');
}

function enumeration(value, choices, name) {
  if (typeof value !== 'string' || !Object.hasOwn(choices, value)) throw fault('JXL_INPUT', 'Unsupported ' + name + ': ' + value + '.');
  return choices[value];
}

function chromaticity(value) {
  if (!Array.isArray(value) || value.length !== 2) throw fault('JXL_INPUT', 'A chromaticity is [x, y].');
  const out = value.map(v => {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw fault('JXL_INPUT', 'Chromaticity coordinates are finite numbers.');
    const scaled = Math.round(v * 1000000);
    if (scaled < -2097152 || scaled > 2097151) throw fault('JXL_INPUT', 'Chromaticity coordinates must fit the signed JPEG XL field, in millionths.');
    return scaled;
  });
  if (!out[1]) throw fault('JXL_INPUT', 'A chromaticity y coordinate must remain nonzero in millionths.');
  return out;
}

function writeXY(writer, value) { for (const coordinate of value) writer.writeU32(XY, packSigned(coordinate)); }

export function prepareColorEncoding(info = {}, samples = {}) {
  record(info, 'colorEncoding');
  const space = info.space ?? 'rgb';
  if (space !== 'rgb' && space !== 'gray') throw fault('JXL_INPUT', 'colorEncoding.space is rgb or gray.');
  const colorChannels = space === 'gray' ? 1 : 3;
  const white = info.whitePoint ?? 'd65', whiteXY = Array.isArray(white) ? chromaticity(white) : null;
  const whiteEnum = whiteXY ? 2 : enumeration(white, WHITE, 'white point');
  const primaries = info.primaries ?? samples.colorSpace ?? 'srgb';
  let primaryXY = null, primaryEnum = 1;
  if (colorChannels === 1 && info.primaries !== undefined) throw fault('JXL_INPUT', 'Gray color encoding has no RGB primaries.');
  if (colorChannels === 3) {
    if (Array.isArray(primaries)) {
      if (primaries.length !== 3) throw fault('JXL_INPUT', 'Custom primaries are three [x, y] chromaticities: red, green and blue.');
      primaryXY = primaries.map(chromaticity);
      const [r, g, b] = primaryXY;
      if ((r[0] - b[0]) * (g[1] - b[1]) === (g[0] - b[0]) * (r[1] - b[1]))
        throw fault('JXL_INPUT', 'RGB primaries must define a nonzero color triangle.');
      primaryEnum = 2;
    } else primaryEnum = enumeration(primaries, PRIMARIES, 'RGB primaries');
  }
  const haveGamma = info.gamma !== undefined;
  if (haveGamma && info.transferFunction !== undefined) throw fault('JXL_INPUT', 'Declare either gamma or transferFunction, not both.');
  let gamma = 0, transferEnum = 13;
  const transferFunction = info.transferFunction ?? samples.transferFunction ?? 'srgb';
  if (haveGamma) {
    if (typeof info.gamma !== 'number' || !Number.isFinite(info.gamma) || info.gamma < 1 / 8192 || info.gamma > 1)
      throw fault('JXL_INPUT', 'Gamma is the encoding exponent, from 1/8192 to 1 (for example 1/2.2).');
    gamma = Math.round(info.gamma * 10000000);
    if (gamma * 8192 < 10000000) throw fault('JXL_INPUT', 'Gamma is too small after codestream rounding.');
  } else transferEnum = enumeration(transferFunction, TRANSFER, 'transfer function');
  const intent = enumeration(info.renderingIntent ?? 'relative', INTENT, 'rendering intent');
  const colorData = new BitWriter(64);
  colorData.write(2, 0);
  colorData.writeU32(COLOR_ENUM, colorChannels === 3 ? 0 : 1);
  colorData.writeU32(COLOR_ENUM, whiteEnum);
  if (whiteXY) writeXY(colorData, whiteXY);
  if (colorChannels === 3) {
    colorData.writeU32(COLOR_ENUM, primaryEnum);
    if (primaryXY) for (const xy of primaryXY) writeXY(colorData, xy);
  }
  colorData.write(1, haveGamma ? 1 : 0);
  if (haveGamma) colorData.write(24, gamma); else colorData.writeU32(COLOR_ENUM, transferEnum);
  colorData.writeU32(COLOR_ENUM, intent);
  return {colorData, colorChannels, transferFunction: haveGamma ? undefined : transferFunction};
}

export function prepareToneMapping(info = {}, fallback = 255) {
  record(info, 'toneMapping');
  const intensityTarget = info.intensityTarget ?? fallback, minNits = info.minNits ?? 0;
  const relativeToMaxDisplay = info.relativeToMaxDisplay ?? false, linearBelow = info.linearBelow ?? 0;
  if (typeof intensityTarget !== 'number' || !Number.isFinite(intensityTarget) || intensityTarget < 1 / 16777216 || intensityTarget >= 65520)
    throw fault('JXL_INPUT', 'Tone-mapping intensityTarget is positive and representable below 65520 nits.');
  if (typeof minNits !== 'number' || !Number.isFinite(minNits) || minNits < 0 || minNits > intensityTarget)
    throw fault('JXL_INPUT', 'Tone-mapping minNits is between zero and intensityTarget.');
  if (typeof relativeToMaxDisplay !== 'boolean') throw fault('JXL_INPUT', 'relativeToMaxDisplay is a boolean.');
  if (typeof linearBelow !== 'number' || !Number.isFinite(linearBelow) || linearBelow < 0 || linearBelow >= 65520 || relativeToMaxDisplay && linearBelow > 1)
    throw fault('JXL_INPUT', 'linearBelow is a nonnegative binary16 luminance, or a fraction from zero to one when relativeToMaxDisplay is true.');
  const toneData = new BitWriter(16);
  const allDefault = intensityTarget === 255 && minNits === 0 && !relativeToMaxDisplay && linearBelow === 0;
  toneData.write(1, allDefault ? 1 : 0);
  if (!allDefault) {
    toneData.write(16, float16Bits(intensityTarget));
    toneData.write(16, float16Bits(minNits));
    toneData.write(1, relativeToMaxDisplay ? 1 : 0);
    toneData.write(16, float16Bits(linearBelow));
  }
  return {toneData, intensityTarget};
}
