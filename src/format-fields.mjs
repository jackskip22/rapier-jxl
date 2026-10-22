// SPDX-License-Identifier: MIT
import {BitWriter, float16Bits} from './bits.mjs';
import {fault} from './admit.mjs';

const LAYOUT_SIZE = [[9, 1], [13, 1], [18, 1], [30, 1]];
const LAYOUT_PREVIEW_SIZE = [[6, 1], [8, 65], [10, 321], [12, 1345]];
export const EXTRA_CHANNEL_TYPES = Object.freeze({alpha: 0, depth: 1, spot: 2, selection: 3, black: 4, cfa: 5, thermal: 6, optional: 16});
const extraTypes = new Map(Object.entries(EXTRA_CHANNEL_TYPES));
export const checkInteger = (value, min, max, name) => {
  if (!Number.isInteger(value) || value < min || value > max) throw fault('JXL_INPUT', name + ' is an integer from ' + min + ' to ' + max + '.');
  return value;
};

export function prepareImageFields({orientation = 1, intrinsicSize, preview} = {}) {
  checkInteger(orientation, 1, 8, 'orientation');
  if (intrinsicSize === undefined && preview === undefined && orientation === 1) return undefined;
  const writer = new BitWriter(32);
  writer.write(3, orientation - 1);
  writer.write(1, intrinsicSize === undefined ? 0 : 1);
  if (intrinsicSize !== undefined) {
    if (!intrinsicSize || typeof intrinsicSize !== 'object') throw fault('JXL_INPUT', 'intrinsicSize is {width, height}.');
    const width = checkInteger(intrinsicSize.width, 1, 1073741824, 'Intrinsic width');
    const height = checkInteger(intrinsicSize.height, 1, 1073741824, 'Intrinsic height');
    writer.write(1, 0); writer.writeU32(LAYOUT_SIZE, height); writer.write(3, 0); writer.writeU32(LAYOUT_SIZE, width);
  }
  writer.write(1, preview === undefined ? 0 : 1);
  if (preview !== undefined) {
    const width = checkInteger(preview.width, 1, 5440, 'Preview width');
    const height = checkInteger(preview.height, 1, 5440, 'Preview height');
    writer.write(1, 0); writer.writeU32(LAYOUT_PREVIEW_SIZE, height); writer.write(3, 0); writer.writeU32(LAYOUT_PREVIEW_SIZE, width);
  }
  writer.write(1, 0);
  return writer;
}

export function writeDepth(writer, bits, exponent) {
  writer.write(1, exponent ? 1 : 0);
  writer.writeU32(exponent ? [[0, 32], [0, 16], [0, 24], [6, 1]] : [[0, 8], [0, 10], [0, 12], [6, 1]], bits);
  if (exponent) writer.write(4, exponent - 1);
}

export function extraChannelType(name) {
  if (!extraTypes.has(name)) throw fault('JXL_INPUT', 'Extra channel type is alpha, depth, spot, selection, black, cfa, thermal or optional.');
  return extraTypes.get(name);
}

export function prepareExtraChannels(channels) {
  const writer = new BitWriter(128);
  writer.writeU32([[0, 0], [0, 1], [4, 2], [12, 1]], channels.length);
  for (const channel of channels) {
    writer.write(1, 0);
    writer.writeU32([[0, 0], [0, 1], [4, 2], [6, 18]], channel.kind);
    writeDepth(writer, channel.bitDepth, channel.exponentBits);
    writer.writeU32([[0, 0], [0, 3], [0, 4], [3, 1]], channel.dimShift);
    const name = new TextEncoder().encode(channel.name);
    writer.writeU32([[0, 0], [4, 0], [5, 16], [10, 48]], name.length);
    for (const value of name) writer.write(8, value);
    if (channel.kind === 0) writer.write(1, channel.alphaPremultiplied ? 1 : 0);
    if (channel.kind === 2) for (const value of channel.spotColor) writer.write(16, float16Bits(value));
    if (channel.kind === 5) writer.writeU32([[0, 1], [2, 0], [4, 3], [8, 19]], channel.cfaChannel);
  }
  return writer;
}

export function prepareUpsamplingWeights(weights, {xyb = false} = {}) {
  if (weights === undefined) return undefined;
  if (!weights || typeof weights !== 'object' || Array.isArray(weights)) throw fault('JXL_INPUT', 'upsamplingWeights maps 2, 4 or 8 to its symmetric kernel coefficients.');
  const entries = new Map(Object.entries(weights)), counts = new Map([['2', 15], ['4', 55], ['8', 210]]);
  if (!entries.size || [...entries.keys()].some(key => !counts.has(key))) throw fault('JXL_INPUT', 'Custom upsampling factors are 2, 4 and 8.');
  let mask = 0;
  for (const [key, count] of counts) if (entries.has(key)) {
    const values = entries.get(key);
    if (!(Array.isArray(values) || ArrayBuffer.isView(values)) || values.length !== count ||
        Array.from(values).some(value => typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 65504))
      throw fault('JXL_INPUT', 'Factor ' + key + ' needs ' + count + ' finite binary16 kernel coefficients.');
    mask |= Number(key) / 2;
  }
  const writer = new BitWriter(1024); writer.write(1, 0);
  if (xyb) writer.write(1, 1);
  writer.write(3, mask);
  for (const key of counts.keys()) if (entries.has(key)) for (const value of entries.get(key)) writer.write(16, float16Bits(value));
  return writer;
}
