// SPDX-License-Identifier: MIT
import {fault} from './admit.mjs';
import {checkInteger, extraChannelType} from './format-fields.mjs';

export const channelPowers = [1]; for (let i = 1; i <= 32; i++) channelPowers.push(channelPowers[i - 1] * 2);
export const channelUpsampling = (value, name) => { if (![1, 2, 4, 8].includes(value)) throw fault('JXL_INPUT', name + ': 1|2|4|8'); return value; };
export const requireChannelObject = (value, name) => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw fault('JXL_INPUT', name + ': object'); return value; };

export function admitChannelPrecision(data, options) {
  const float16 = typeof Float16Array === 'function' && data instanceof Float16Array;
  if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray || data instanceof Uint16Array || data instanceof Uint32Array || data instanceof Float32Array || float16))
    throw fault('JXL_INPUT', 'samples: unsigned typed|Float16Array|Float32Array');
  const sampleFormat = options.sampleFormat ?? (data instanceof Float32Array ? 'float32' : float16 ? 'float16' : 'uint');
  if (!['uint', 'float', 'float16', 'float32'].includes(sampleFormat)) throw fault('JXL_INPUT', 'sampleFormat: uint|float16|float32|float');
  const bitDepth = options.bitDepth ?? (sampleFormat === 'float16' ? 16 : data.BYTES_PER_ELEMENT * 8);
  const exponentBits = sampleFormat === 'uint' ? 0 : options.exponentBits ?? (sampleFormat === 'float16' ? 5 : 8);
  if (sampleFormat === 'uint' && options.exponentBits !== undefined && options.exponentBits !== 0)
    throw fault('JXL_INPUT', 'integer samples: exponentBits 0');
  if (sampleFormat === 'float16' && (bitDepth !== 16 || exponentBits !== 5) || sampleFormat === 'float32' && (bitDepth !== 32 || exponentBits !== 8))
    throw fault('JXL_INPUT', 'sampleFormat: float for non-IEEE words');
  checkInteger(bitDepth, 1, exponentBits ? 32 : 31, 'bitDepth');
  if (exponentBits) {
    checkInteger(exponentBits, 2, 8, 'exponentBits');
    checkInteger(bitDepth - exponentBits - 1, 2, 23, 'Mantissa precision');
  } else if (data instanceof Float32Array || float16) throw fault('JXL_INPUT', 'Float32Array: floating metadata');
  if (data instanceof Float32Array && (bitDepth !== 32 || exponentBits !== 8)) throw fault('JXL_INPUT', 'Float32Array: bitDepth 32, exponentBits 8');
  if (float16 && (bitDepth !== 16 || exponentBits !== 5)) throw fault('JXL_INPUT', 'Float16Array: bitDepth 16, exponentBits 5');
  if (bitDepth > data.BYTES_PER_ELEMENT * 8) throw fault('JXL_INPUT', 'channel array: precision too large');
  const words = data instanceof Float32Array ? new Int32Array(data.buffer, data.byteOffset, data.length)
    : float16 ? new Uint16Array(data.buffer, data.byteOffset, data.length) : data;
  const maximum = channelPowers[bitDepth] - 1;
  if (!(data instanceof Float32Array || float16)) for (const value of words) if (value > maximum) throw fault('JXL_INPUT', 'channel sample: bitDepth exceeded');
  return {data: words, bitDepth, exponentBits, sampleFormat};
}

export function admitExtraChannels(extraChannels, width, height, upsampling = 1) {
  if (!Array.isArray(extraChannels) || extraChannels.length > 256) throw fault('JXL_INPUT', 'extraChannels: array <=256');
  return extraChannels.map((entry, index) => {
    requireChannelObject(entry, 'Extra channel ' + index);
    const kind = extraChannelType(new Map(Object.entries(entry)).get('type')), dimShift = checkInteger(entry.dimShift ?? 0, 0, 3, 'dimShift');
    if (entry.alphaPremultiplied !== undefined && kind !== 0 || entry.spotColor !== undefined && kind !== 2 || entry.cfaChannel !== undefined && kind !== 5)
      throw fault('JXL_INPUT', 'alpha/spot/CFA: matching channel type');
    const factor = channelUpsampling(entry.upsampling ?? Math.max(1, upsampling / channelPowers[dimShift]), 'Extra-channel upsampling');
    const total = factor * channelPowers[dimShift];
    if (total < upsampling || total > 8) throw fault('JXL_INPUT', 'extra upsampling: color factor..8');
    const name = entry.name ?? '';
    if (typeof name !== 'string' || new TextEncoder().encode(name).length > 1071) throw fault('JXL_INPUT', 'channel name: <=1071 UTF-8 bytes');
    if (entry.alphaPremultiplied !== undefined && typeof entry.alphaPremultiplied !== 'boolean') throw fault('JXL_INPUT', 'alphaPremultiplied: boolean');
    const spotColor = entry.spotColor ?? [0, 0, 0, 0];
    if (kind === 2 && (!Array.isArray(spotColor) || spotColor.length !== 4 || spotColor.some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)))
      throw fault('JXL_INPUT', 'spotColor: red,green,blue,solidity 0-1');
    const cfaChannel = kind === 5 ? checkInteger(entry.cfaChannel ?? 1, 0, 274, 'cfaChannel') : 1;
    const channel = {...admitChannelPrecision(entry.data, entry), width: Math.ceil(width / total), height: Math.ceil(height / total),
      shift: 31 - Math.clz32(total / upsampling), kind, dimShift, factor, name, alphaPremultiplied: !!entry.alphaPremultiplied, spotColor, cfaChannel};
    if (channel.data.length !== channel.width * channel.height) throw fault('JXL_INPUT', 'extra channel ' + index + ': samples width*height');
    return channel;
  });
}
