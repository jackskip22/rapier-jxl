// SPDX-License-Identifier: MIT
import {admitColorRoute, fault} from './admit.mjs';
import {inspectICC} from './icc-profile.mjs';
import {prepareColorEncoding} from './color-info.mjs';

export function admitSampleDomain(data, options = {}) {
  admitColorRoute(options);
  const float32 = data instanceof Float32Array, wide = data instanceof Uint16Array;
  const sampleFormat = options.sampleFormat ?? (float32 ? 'float32' : 'uint');
  if (!['uint', 'float16', 'float32'].includes(sampleFormat) || (sampleFormat === 'float32') !== float32 || sampleFormat === 'float16' && !wide)
    throw fault('JXL_INPUT', 'Use uint with integer arrays, float16 with Uint16Array bits, or float32 with Float32Array.');
  const exponentBits = sampleFormat === 'float32' ? 8 : sampleFormat === 'float16' ? 5 : 0;
  const bitDepth = options.bitDepth ?? (float32 ? 32 : wide ? 16 : 8);
  if (exponentBits ? bitDepth !== (float32 ? 32 : 16) : wide ? ![10, 12, 16].includes(bitDepth) : bitDepth !== 8)
    throw fault('JXL_INPUT', 'Bit depth: 8 for bytes; 10, 12 or 16 for Uint16Array; 16 or 32 for floats.');
  const encoding = options.colorEncoding === undefined ? null : described(options);
  const colorSpace = encoding ? undefined : options.colorSpace ?? 'srgb';
  if (!encoding && !['srgb', 'display-p3', 'rec2020'].includes(colorSpace)) throw fault('JXL_INPUT', 'The color space is srgb, display-p3 or rec2020.');
  const transferFunction = encoding ? undefined : options.transferFunction ?? (exponentBits ? 'linear' : 'srgb');
  if (!encoding && !['srgb', 'linear', 'pq', 'hlg'].includes(transferFunction)) throw fault('JXL_INPUT', 'The transfer function is srgb, linear, pq or hlg.');
  const curve = encoding ? options.colorEncoding.transferFunction : transferFunction;
  const intensityTarget = options.intensityTarget ?? (curve === 'pq' ? 10000 : curve === 'hlg' ? 1000 : 255);
  if (!Number.isFinite(intensityTarget) || intensityTarget < 1 / 16777216 || intensityTarget >= 65520)
    throw fault('JXL_INPUT', 'intensityTarget is a positive number below 65520 nits.');
  const alphaPremultiplied = options.alphaPremultiplied ?? false;
  if (typeof alphaPremultiplied !== 'boolean') throw fault('JXL_INPUT', 'alphaPremultiplied is a boolean.');
  if (!exponentBits && bitDepth < 16 && wide) {
    const max = (1 << bitDepth) - 1;
    for (const value of data) if (value > max) throw fault('JXL_INPUT', 'A sample exceeds bitDepth; declare the source depth.');
  }
  const samples = {sampleFormat, bitDepth, exponentBits, colorSpace, transferFunction, intensityTarget, alphaPremultiplied,
    native8: bitDepth === 8 && transferFunction === 'srgb' && colorSpace !== 'rec2020' && intensityTarget === 255 && !alphaPremultiplied};
  if (options.icc !== undefined) {
    if (options.colorSpace !== undefined || options.transferFunction !== undefined)
      throw fault('JXL_INPUT', 'An ICC profile sets the color; omit other color fields.');
    if (options.level === 5 && (bitDepth > 12 || exponentBits)) throw fault('JXL_INPUT', 'These sample depths require JPEG XL level 10.');
    const profile = {colorChannels: inspectICC(options.icc, options.level)};
    if (profile.colorChannels === 1) {
      const words = float32 ? new Uint32Array(data.buffer, data.byteOffset, data.length) : data;
      for (let i = 0; i < words.length; i += 4)
        if (words[i] !== words[i + 1] || words[i] !== words[i + 2]) throw fault('JXL_INPUT', 'A GRAY profile needs equal R, G and B in every pixel.');
    }
    Object.assign(samples, profile, {native8: false});

  } else if (options.iccCompression !== undefined) throw fault('JXL_INPUT', 'iccCompression requires an ICC profile.');
  if (encoding) {
    if (encoding.colorChannels === 1) {
      const words = float32 ? new Uint32Array(data.buffer, data.byteOffset, data.length) : data;
      for (let i = 0; i < words.length; i += 4)
        if (words[i] !== words[i + 1] || words[i] !== words[i + 2]) throw fault('JXL_INPUT', 'GRAY color needs equal R, G and B in every pixel.');
    }
    Object.assign(samples, {colorData: encoding.colorData, colorChannels: encoding.colorChannels, native8: false});
  }
  return samples;
}

function described(options) {
  if (options.icc !== undefined || options.colorSpace !== undefined || options.transferFunction !== undefined)
    throw fault('JXL_INPUT', 'colorEncoding sets the color; omit other color fields.');
  if (options.colorEncoding?.space !== 'rgb' && options.colorEncoding?.space !== 'gray') throw fault('JXL_INPUT', 'A sample color encoding is rgb or gray.');
  return prepareColorEncoding(options.colorEncoding);
}
