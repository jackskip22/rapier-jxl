// SPDX-License-Identifier: MIT
import {admitSampleDomain} from './sample-domain.mjs';
import {admitPixels} from './admit.mjs';
import {nativeEncoding} from './color-encoding.mjs';
import {fault} from './fault.mjs';
import {EDGE} from './limits.mjs';

const INTENTS = ['perceptual', 'relative', 'saturation', 'absolute'];

export const photoLimits = maxPixels => {
  if (maxPixels !== undefined && (!Number.isSafeInteger(maxPixels) || maxPixels < 1))
    throw fault('JXL_INPUT', 'A photo domain pixel limit is a positive whole number.');
  return maxPixels === undefined ? undefined : {pixels: maxPixels, edge: EDGE};
};
export function photoDomain(picture, {maxPixels} = {}) {
  admitPixels(picture.data, picture.width, picture.height, photoLimits(maxPixels));
  const data = picture.data, source = picture.rgbaColorEncoding ?? picture.colorEncoding;
  const icc = Object.hasOwn(picture, 'rgbaICC') ? picture.rgbaICC : picture.icc;
  const description = {
    sampleFormat: picture.sampleFormat ?? (data instanceof Float32Array ? 'float32' : 'uint'),
    bitDepth: picture.bitDepth ?? (data instanceof Float32Array ? 32 : data instanceof Uint16Array ? 16 : 8),
    alphaPremultiplied: picture.alphaPremultiplied ?? false,
    intensityTarget: picture.intensityTarget ?? picture.header?.toneMapping?.intensityTarget,
  };
  if (icc) description.icc = icc;
  else if (source) {
    const {space = 'rgb', whitePoint, primaries, transferFunction, gamma, renderingIntent} = source;
    description.colorEncoding = {space,
      ...(whitePoint !== undefined && {whitePoint}), ...(space !== 'gray' && primaries !== undefined && {primaries}),
      ...(gamma !== undefined ? {gamma} : transferFunction !== undefined && {transferFunction}),
      ...(renderingIntent !== undefined && {renderingIntent: typeof renderingIntent === 'number' ? INTENTS[renderingIntent] : renderingIntent})};
  } else {
    if (picture.colorSpace !== undefined) description.colorSpace = picture.colorSpace;
    if (picture.transferFunction !== undefined) description.transferFunction = picture.transferFunction;
  }
  const samples = admitSampleDomain(data, description);
  const encoding = icc ? nativeEncoding({colorEncoding: {space: samples.colorChannels === 1 ? 'gray' : 'rgb', wantICC: true}, icc})
    : source ? {space: 'rgb', whitePoint: 'd65', primaries: 'srgb', ...source, wantICC: false, renderingIntent: typeof source.renderingIntent === 'string'
      ? INTENTS.indexOf(source.renderingIntent) : source.renderingIntent ?? 1,
      transferFunction: source.gamma !== undefined ? 'gamma' : source.transferFunction ?? 'srgb'}
    : {space: 'rgb', wantICC: false, whitePoint: 'd65', primaries: samples.colorSpace,
      transferFunction: samples.transferFunction, renderingIntent: 1};
  return {samples, encoding, icc, intensityTarget: samples.intensityTarget,
    maximum: samples.exponentBits ? 1 : 2 ** samples.bitDepth - 1};
}

export function nativePhotoRGB8(picture, domain) {
  const {samples, encoding, icc} = domain;
  return (picture.data instanceof Uint8Array || picture.data instanceof Uint8ClampedArray) && !icc &&
    samples.sampleFormat === 'uint' && samples.bitDepth === 8 && !samples.alphaPremultiplied &&
    samples.intensityTarget === 255 && ['rgb', 'gray'].includes(encoding.space) &&
    encoding.whitePoint === 'd65' && encoding.primaries === 'srgb' && encoding.transferFunction === 'srgb';
}

