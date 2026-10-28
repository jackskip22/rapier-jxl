// SPDX-License-Identifier: MIT
import {LIMITS} from './limits.mjs';
import {complete} from './bits.mjs';
import {admitOptions, admitPixels, fault, job} from './admit.mjs';
import {admitSampleFormat} from './admit-samples.mjs';
import {nativeSteps} from './lossless.mjs';
import {prepareColorEncoding, prepareToneMapping} from './color-info.mjs';
import {prepareICC} from './icc-write.mjs';

export {LIMITS, prepareICC};

function admitGray(data) {
  const words = data instanceof Float32Array ? new Uint32Array(data.buffer, data.byteOffset, data.length) : data;
  for (let i = 0; i < words.length; i += 4)
    if (words[i] !== words[i + 1] || words[i] !== words[i + 2]) throw fault('JXL_INPUT', 'A GRAY profile requires identical R, G and B sample words in every RGBA pixel.');
}

export function encodeProfile(data, width, height, options) { return complete(encodeProfileSteps(data, width, height, options)); }

export function encodeProfileSteps(data, width, height, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw fault('JXL_INPUT', 'Profile options are an object.');
  const {icc, iccCompression, colorEncoding, toneMapping, ...sampleOptions} = options;
  const {quality} = admitOptions(sampleOptions);
  admitPixels(data, width, height);
  const effort = options.effort ?? 1;
  if (effort !== 1 && effort !== 2) throw fault('JXL_INPUT', 'Profile encoding effort is 1 or 2.');
  const samples = admitSampleFormat(data, sampleOptions);
  if (options.level !== undefined && options.level !== 5 && options.level !== 10) throw fault('JXL_INPUT', 'JPEG XL level is 5 or 10.');
  const nativeLevel = samples.bitDepth > 12 || samples.exponentBits ? 10 : 5;
  if (options.level === 5 && nativeLevel === 10) throw fault('JXL_INPUT', 'These sample depths require JPEG XL level 10.');
  if (icc !== undefined) {
    if (options.colorSpace !== undefined || options.transferFunction !== undefined)
      throw fault('JXL_INPUT', 'An ICC profile supplies the color encoding; omit other color declarations.');
    Object.assign(samples, prepareICC(icc, {level: options.level, compression: options.iccCompression, colorEncoding}));
  } else {
    if (options.iccCompression !== undefined) throw fault('JXL_INPUT', 'iccCompression requires an ICC profile.');
    if (colorEncoding?.space === 'xyb' && (options.colorSpace !== undefined || options.transferFunction !== undefined))
      throw fault('JXL_INPUT', 'Original XYB color has implicit color fields; omit colorSpace and transferFunction.');
    Object.assign(samples, prepareColorEncoding(colorEncoding, samples));
  }
  samples.level = Math.max(nativeLevel, samples.level ?? options.level ?? 5);
  if (samples.colorChannels === 1) admitGray(data);
  const transfer = samples.transferFunction;
  const intensityTarget = options.intensityTarget ?? (transfer === 'pq' ? 10000 : transfer === 'hlg' ? 1000 : 255);
  if (toneMapping !== undefined) {
    const tone = prepareToneMapping(toneMapping, intensityTarget);
    if (options.intensityTarget !== undefined && toneMapping.intensityTarget !== undefined && options.intensityTarget !== toneMapping.intensityTarget)
      throw fault('JXL_INPUT', 'intensityTarget and toneMapping.intensityTarget must agree.');
    Object.assign(samples, tone);
  } else samples.intensityTarget = intensityTarget;
  samples.native8 = false;
  return job(nativeSteps(data, width, height, {samples, quality, effort}));
}
