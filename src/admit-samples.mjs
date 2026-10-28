// SPDX-License-Identifier: MIT
import {admitColorRoute, fault} from './admit.mjs';
import {prepareICC, iccSpace} from './icc-write.mjs';

export function admitSampleFormat(data, options = {}) {
  admitColorRoute(options);
  const float32 = data instanceof Float32Array, wide = data instanceof Uint16Array;
  const sampleFormat = options.sampleFormat ?? (float32 ? 'float32' : 'uint');
  if (!['uint', 'float16', 'float32'].includes(sampleFormat) || (sampleFormat === 'float32') !== float32 || sampleFormat === 'float16' && !wide)
    throw fault('JXL_INPUT', 'Use uint with integer arrays, float16 with Uint16Array bit patterns, or float32 with Float32Array.');
  const exponentBits = sampleFormat === 'float32' ? 8 : sampleFormat === 'float16' ? 5 : 0;
  const bitDepth = options.bitDepth ?? (float32 ? 32 : wide ? 16 : 8);
  if (exponentBits ? bitDepth !== (float32 ? 32 : 16) : wide ? ![10, 12, 16].includes(bitDepth) : bitDepth !== 8)
    throw fault('JXL_INPUT', 'Byte samples use 8 bits; Uint16Array integers use 10, 12 or 16; floating samples use their native 16 or 32 bits.');
  const colorSpace = options.colorSpace ?? 'srgb';
  if (!['srgb', 'display-p3', 'rec2020'].includes(colorSpace)) throw fault('JXL_INPUT', 'The color space is srgb, display-p3 or rec2020.');
  const transferFunction = options.transferFunction ?? (exponentBits ? 'linear' : 'srgb');
  if (!['srgb', 'linear', 'pq', 'hlg'].includes(transferFunction)) throw fault('JXL_INPUT', 'The transfer function is srgb, linear, pq or hlg.');
  const intensityTarget = options.intensityTarget ?? (transferFunction === 'pq' ? 10000 : transferFunction === 'hlg' ? 1000 : 255);
  if (!Number.isFinite(intensityTarget) || intensityTarget < 1 / 16777216 || intensityTarget >= 65520)
    throw fault('JXL_INPUT', 'The intensity target is a positive finite luminance representable by the JPEG XL header (below 65520 nits).');
  const alphaPremultiplied = options.alphaPremultiplied ?? false;
  if (typeof alphaPremultiplied !== 'boolean') throw fault('JXL_INPUT', 'alphaPremultiplied is a boolean describing the source samples.');
  if (!exponentBits && bitDepth < 16 && wide) {
    const max = (1 << bitDepth) - 1;
    for (const value of data) if (value > max) throw fault('JXL_INPUT', 'A sample exceeds the declared bitDepth; declare the source depth instead of truncating it.');
  }
  const samples = {sampleFormat, bitDepth, exponentBits, colorSpace, transferFunction, intensityTarget, alphaPremultiplied,
    native8: bitDepth === 8 && transferFunction === 'srgb' && colorSpace !== 'rec2020' && intensityTarget === 255 && !alphaPremultiplied};
  if (options.icc !== undefined) {
    if (options.colorSpace !== undefined || options.transferFunction !== undefined)
      throw fault('JXL_INPUT', 'An ICC profile supplies the color encoding; omit other color declarations.');
    if (options.level === 5 && (bitDepth > 12 || exponentBits)) throw fault('JXL_INPUT', 'These sample depths require JPEG XL level 10.');
    const profile = prepareICC(options.icc, {level: options.level, compression: options.iccCompression});
    if (profile.colorChannels === 1) {
      const words = float32 ? new Uint32Array(data.buffer, data.byteOffset, data.length) : data;
      for (let i = 0; i < words.length; i += 4)
        if (words[i] !== words[i + 1] || words[i] !== words[i + 2]) throw fault('JXL_INPUT', 'A GRAY profile requires identical R, G and B sample words in every RGBA pixel.');
    }
    Object.assign(samples, profile, {native8: false});
    if (bitDepth === 8 && !exponentBits && !alphaPremultiplied && intensityTarget === 255 && profile.level === 5 && options.level !== 10)
      samples.iccSpace = iccSpace(options.icc, {level: 5, compression: options.iccCompression}, profile);
  } else if (options.iccCompression !== undefined) throw fault('JXL_INPUT', 'iccCompression requires an ICC profile.');
  return samples;
}

