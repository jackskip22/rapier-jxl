// SPDX-License-Identifier: MIT
import {admitSampleDomain} from './sample-domain.mjs';
import {prepareICC, iccSpace} from './icc-write.mjs';
import {encodingSpace} from './icc-transform.mjs';
import {prepareColorEncoding} from './color-info.mjs';

export function admitSampleFormat(data, options = {}) {
  const samples = admitSampleDomain(data, options);
  if (!(typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) && options.icc !== undefined) {
    const profile = prepareICC(options.icc, {level: options.level, compression: options.iccCompression});
    Object.assign(samples, profile);
    const space = String.fromCharCode(...options.icc.subarray(16, 20));
    if ((space === 'RGB ' || space === 'GRAY') && samples.bitDepth === 8 && !samples.exponentBits && !samples.alphaPremultiplied &&
        samples.intensityTarget === 255 && profile.level === 5 && options.level !== 10)
      samples.iccSpace = iccSpace(options.icc, {level: 5, compression: options.iccCompression}, profile);
  }
  return samples;
}

const stateds = new WeakMap();
export function statedSpace(samples) {
  if (samples.native8 || samples.bitDepth !== 8 || samples.exponentBits || samples.sampleFormat !== 'uint' || samples.iccSpace || samples.iccData || samples.icc ||
      samples.alphaPremultiplied || samples.intensityTarget !== 255 || (samples.colorChannels ?? 3) !== 3) return null;
  const encoding = samples.colorEncoding ?? {space: 'rgb', whitePoint: 'd65', primaries: samples.colorSpace, transferFunction: samples.transferFunction, renderingIntent: 'relative'};
  const colorData = samples.colorData ?? prepareColorEncoding(encoding).colorData;
  if (!stateds.has(samples)) stateds.set(samples, encodingSpace(encoding, colorData));
  return stateds.get(samples);
}
