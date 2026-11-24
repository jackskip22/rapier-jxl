// SPDX-License-Identifier: MIT
import {fault} from './admit.mjs';
import {inspectICC} from './icc-profile.mjs';
import {prepareColorEncoding} from './color-info.mjs';

export function admitSampleDomain(data, options = {}) {
  if (options.colorEncoding?.transferFunction === undefined && options.colorEncoding !== undefined && options.transferFunction !== undefined && options.icc === undefined && options.colorSpace === undefined)
    options = {...options, colorEncoding: {...options.colorEncoding, transferFunction: options.transferFunction}, transferFunction: undefined};
  const float16 = typeof Float16Array === 'function' && data instanceof Float16Array;
  const float32 = data instanceof Float32Array, wide = data instanceof Uint16Array || float16;
  const sampleFormat = options.sampleFormat ?? (float32 ? 'float32' : float16 ? 'float16' : 'uint');
  if (!['uint', 'float16', 'float32'].includes(sampleFormat) || (sampleFormat === 'float32') !== float32 || float16 && sampleFormat !== 'float16' || sampleFormat === 'float16' && !wide)
    throw fault('JXL_INPUT', 'sampleFormat: uint integer arrays; float16 Float16Array/Uint16Array; float32 Float32Array');
  const exponentBits = sampleFormat === 'float32' ? 8 : sampleFormat === 'float16' ? 5 : 0;
  const bitDepth = options.bitDepth ?? (float32 ? 32 : wide ? 16 : 8);
  if (exponentBits ? bitDepth !== (float32 ? 32 : 16) : wide ? ![10, 12, 16].includes(bitDepth) : bitDepth !== 8)
    throw fault('JXL_INPUT', 'bitDepth: 8 bytes; 10|12|16 uint16; 16|32 floats');
  const encoding = ((typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) || options.colorEncoding === undefined) ? null : described(options);
  const colorSpace = encoding ? undefined : options.colorSpace ?? 'srgb';
  if (!encoding && !['srgb', 'display-p3', 'rec2020'].includes(colorSpace)) throw fault('JXL_INPUT', 'colorSpace: srgb|display-p3|rec2020');
  const transferFunction = encoding ? undefined : options.transferFunction ?? (exponentBits ? 'linear' : 'srgb');
  if (!encoding && !['srgb', 'linear', 'pq', 'hlg'].includes(transferFunction)) throw fault('JXL_INPUT', 'transferFunction: srgb|linear|pq|hlg');
  const curve = encoding ? options.colorEncoding.transferFunction : transferFunction;
  const intensityTarget = options.intensityTarget ?? (curve === 'pq' ? 10000 : curve === 'hlg' ? 1000 : 255);
  if (!Number.isFinite(intensityTarget) || intensityTarget < 1 / 16777216 || intensityTarget >= 65520)
    throw fault('JXL_INPUT', 'intensityTarget: [2^-24,65520) nits');
  const alphaPremultiplied = options.alphaPremultiplied ?? false;
  if (typeof alphaPremultiplied !== 'boolean') throw fault('JXL_INPUT', 'alphaPremultiplied: boolean');
  if (!exponentBits && bitDepth < 16 && wide) {
    const max = (1 << bitDepth) - 1;
    for (const value of data) if (value > max) throw fault('JXL_INPUT', 'sample: bitDepth exceeded');
  }
  const samples = {sampleFormat, bitDepth, exponentBits, colorSpace, transferFunction, intensityTarget, alphaPremultiplied,
    native8: bitDepth === 8 && transferFunction === 'srgb' && colorSpace !== 'rec2020' && intensityTarget === 255 && !alphaPremultiplied};
  if (!(typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) && options.icc !== undefined) {
    if (options.colorSpace !== undefined || options.transferFunction !== undefined)
      throw fault('JXL_INPUT', 'ICC: omit colorSpace/transferFunction');
    if (options.level === 5 && (bitDepth > 12 || exponentBits)) throw fault('JXL_INPUT', 'level: 10 required');
    const profile = {colorChannels: inspectICC(options.icc, options.level), iccGiven: true};
    if (profile.colorChannels === 1) {
      const words = float32 ? new Uint32Array(data.buffer, data.byteOffset, data.length) : data;
      for (let i = 0; i < words.length; i += 4)
        if (words[i] !== words[i + 1] || words[i] !== words[i + 2]) throw fault('JXL_INPUT', 'GRAY: R=G=B each pixel');
    }
    Object.assign(samples, profile, {native8: false});

  } else if (options.iccCompression !== undefined) throw fault('JXL_INPUT', 'iccCompression: ICC required');
  if (encoding) {
    if (encoding.colorChannels === 1) {
      const words = float32 ? new Uint32Array(data.buffer, data.byteOffset, data.length) : data;
      for (let i = 0; i < words.length; i += 4)
        if (words[i] !== words[i + 1] || words[i] !== words[i + 2]) throw fault('JXL_INPUT', 'GRAY: R=G=B each pixel');
    }
    Object.assign(samples, {colorData: encoding.colorData, colorChannels: encoding.colorChannels, colorEncoding: options.colorEncoding, native8: false});
  }
  return samples;
}

function described(options) {
  if (options.icc !== undefined || options.colorSpace !== undefined || options.transferFunction !== undefined)
    throw fault('JXL_INPUT', 'colorEncoding: omit ICC/colorSpace/transferFunction');
  if (options.colorEncoding?.space !== 'rgb' && options.colorEncoding?.space !== 'gray') throw fault('JXL_INPUT', 'colorEncoding.space: rgb|gray');
  return prepareColorEncoding(options.colorEncoding);
}
