// SPDX-License-Identifier: MIT
import {fault} from './admit.mjs';
import {checkInteger, extraChannelType} from './format-fields.mjs';

export const channelPowers = [1]; for (let i = 1; i <= 32; i++) channelPowers.push(channelPowers[i - 1] * 2);
export const channelUpsampling = (value, name) => { if (![1, 2, 4, 8].includes(value)) throw fault('JXL_INPUT', name + ' is 1, 2, 4 or 8.'); return value; };
export const requireChannelObject = (value, name) => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw fault('JXL_INPUT', name + ' is an object.'); return value; };

export function admitChannelPrecision(data, options) {
  if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray || data instanceof Uint16Array || data instanceof Uint32Array || data instanceof Float32Array))
    throw fault('JXL_INPUT', 'Channel samples are unsigned typed arrays or Float32Array.');
  const sampleFormat = options.sampleFormat ?? (data instanceof Float32Array ? 'float32' : 'uint');
  if (!['uint', 'float', 'float16', 'float32'].includes(sampleFormat)) throw fault('JXL_INPUT', 'sampleFormat is uint, float16, float32 or float (raw words).');
  const bitDepth = options.bitDepth ?? (sampleFormat === 'float16' ? 16 : data.BYTES_PER_ELEMENT * 8);
  const exponentBits = sampleFormat === 'uint' ? 0 : options.exponentBits ?? (sampleFormat === 'float16' ? 5 : 8);
  if (sampleFormat === 'uint' && options.exponentBits !== undefined && options.exponentBits !== 0)
    throw fault('JXL_INPUT', 'Integer samples have no exponent bits.');
  if (sampleFormat === 'float16' && (bitDepth !== 16 || exponentBits !== 5) || sampleFormat === 'float32' && (bitDepth !== 32 || exponentBits !== 8))
    throw fault('JXL_INPUT', 'float16 and float32 use their IEEE sample precision; use float for other raw-word layouts.');
  checkInteger(bitDepth, 1, exponentBits ? 32 : 31, 'bitDepth');
  if (exponentBits) {
    checkInteger(exponentBits, 2, 8, 'exponentBits');
    checkInteger(bitDepth - exponentBits - 1, 2, 23, 'Mantissa precision');
  } else if (data instanceof Float32Array) throw fault('JXL_INPUT', 'Float32Array needs floating-point sample metadata.');
  if (data instanceof Float32Array && (bitDepth !== 32 || exponentBits !== 8)) throw fault('JXL_INPUT', 'Float32Array has 32 bits and eight exponent bits.');
  if (bitDepth > data.BYTES_PER_ELEMENT * 8) throw fault('JXL_INPUT', 'The channel array cannot hold the declared precision.');
  const words = data instanceof Float32Array ? new Int32Array(data.buffer, data.byteOffset, data.length) : data;
  const maximum = channelPowers[bitDepth] - 1;
  if (!(data instanceof Float32Array)) for (const value of words) if (value > maximum) throw fault('JXL_INPUT', 'A channel sample exceeds its declared precision.');
  return {data: words, bitDepth, exponentBits, sampleFormat};
}

export function admitExtraChannels(extraChannels, width, height, upsampling = 1) {
  if (!Array.isArray(extraChannels) || extraChannels.length > 256) throw fault('JXL_INPUT', 'An image has at most 256 extra channels.');
  return extraChannels.map((entry, index) => {
    requireChannelObject(entry, 'Extra channel ' + index);
    const kind = extraChannelType(new Map(Object.entries(entry)).get('type')), dimShift = checkInteger(entry.dimShift ?? 0, 0, 3, 'dimShift');
    if (entry.alphaPremultiplied !== undefined && kind !== 0 || entry.spotColor !== undefined && kind !== 2 || entry.cfaChannel !== undefined && kind !== 5)
      throw fault('JXL_INPUT', 'Alpha, spot and CFA fields belong to their corresponding channel type.');
    const factor = channelUpsampling(entry.upsampling ?? Math.max(1, upsampling / channelPowers[dimShift]), 'Extra-channel upsampling');
    const total = factor * channelPowers[dimShift];
    if (total < upsampling || total > 8) throw fault('JXL_INPUT', 'Combined extra-channel upsampling is at least the color factor and at most eight.');
    const name = entry.name ?? '';
    if (typeof name !== 'string' || new TextEncoder().encode(name).length > 1071) throw fault('JXL_INPUT', 'A channel name is at most 1071 UTF-8 bytes.');
    if (entry.alphaPremultiplied !== undefined && typeof entry.alphaPremultiplied !== 'boolean') throw fault('JXL_INPUT', 'alphaPremultiplied is boolean.');
    const spotColor = entry.spotColor ?? [0, 0, 0, 0];
    if (kind === 2 && (!Array.isArray(spotColor) || spotColor.length !== 4 || spotColor.some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)))
      throw fault('JXL_INPUT', 'spotColor is four normalized red, green, blue and solidity values.');
    const cfaChannel = kind === 5 ? checkInteger(entry.cfaChannel ?? 1, 0, 274, 'cfaChannel') : 1;
    const channel = {...admitChannelPrecision(entry.data, entry), width: Math.ceil(width / total), height: Math.ceil(height / total),
      shift: 31 - Math.clz32(total / upsampling), kind, dimShift, factor, name, alphaPremultiplied: !!entry.alphaPremultiplied, spotColor, cfaChannel};
    if (channel.data.length !== channel.width * channel.height) throw fault('JXL_INPUT', 'Extra channel ' + index + ' has the wrong number of samples.');
    return channel;
  });
}
