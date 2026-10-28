// SPDX-License-Identifier: MIT
import {PHOTO_LIMITS} from './limits.mjs';
import {part} from './bits.mjs';
import {admitEffort} from './effort-level.mjs';
import {losslessSteps, nativeSteps, iccShape} from './lossless.mjs';
import {spaceTransform, P3_TRANSFORM} from './icc-transform.mjs';
import {admitOptions, admitPixels, admitSampleFormat, job, fault} from './admit.mjs';
import {photoCoefficientSteps} from './photo-dct.mjs';
import {photoXYBSteps, preferXYB} from './photo-xyb.mjs';
import {photoV6Steps} from './photo-v6.mjs';

export function photoJob(data, width, height, options, coefficients, search) {
  return job(photoJobSteps(data, width, height, options, coefficients, search));
}

export function photoJobSteps(data, width, height, options, coefficients, search, gpu) {
  const {quality, colorSpace} = admitOptions(options, 90), effort = admitEffort(options);
  const filter = admitPhotoFilter(options);
  admitPixels(data, width, height, PHOTO_LIMITS);
  const samples = admitSampleFormat(data, options);
  if (samples.iccSpace) return iccShape(data, samples.iccSpace, photoSteps(data, width, height, quality, samples.iccSpace, effort, coefficients, filter, search, undefined, options?.memory));
  if (!samples.native8) return nativeSteps(data, width, height, {quality, samples, effort});
  return photoSteps(data, width, height, quality, colorSpace, effort, coefficients, filter, search, gpu, options?.memory);
}

export function admitPhotoFilter(options) {
  if (options?.photo !== undefined && typeof options.photo !== 'boolean') throw fault('JXL_INPUT', 'Photo is a boolean.');
  const filter = options?.filter;
  if (filter !== undefined && filter !== 'auto' && filter !== 'off') throw fault('JXL_INPUT', 'Photo filter is "auto" or "off".');
  return filter;
}

export function* photoSteps(data, width, height, quality, colorSpace, effort, encodeCoefficients, filter, search, gpu, memory) {
  if (quality >= 100) return yield* losslessSteps(data, width, height, {colorSpace, fast: effort < 2});
  if (colorSpace === 'srgb' && preferXYB(data, width, height)) return yield* photoV6Steps(data, width, height, quality, effort, encodeCoefficients, search, undefined, gpu, memory);
  if (colorSpace === 'display-p3' && preferXYB(data, width, height)) return yield* photoV6Steps(data, width, height, quality, effort, encodeCoefficients, search, {transform: P3_TRANSFORM, space: colorSpace}, undefined, memory);
  if (colorSpace && typeof colorSpace === 'object' && colorSpace.colorChannels !== 1) {
    const transform = spaceTransform(colorSpace);
    if (transform && preferXYB(data, width, height)) return yield* photoV6Steps(data, width, height, quality, effort, encodeCoefficients, search, {transform, space: colorSpace}, undefined, memory);
  }
  const coefficients = yield* part(photoProducer(data, width, height, quality, colorSpace, filter), 0, 2);
  return yield* part(encodeCoefficients(coefficients, effort), 1, 2);
}

export function photoProducer(data, width, height, quality, colorSpace, filter) {
  if (colorSpace && typeof colorSpace === 'object') {
    const transform = spaceTransform(colorSpace);
    if (colorSpace.colorChannels === 1) return photoCoefficientSteps(data, width, height, quality, colorSpace, true);
    if (transform && preferXYB(data, width, height)) return photoXYBSteps(data, width, height, quality, {filter, transform, space: colorSpace});
    return photoCoefficientSteps(data, width, height, quality, colorSpace);
  }
  if (colorSpace === 'display-p3' && preferXYB(data, width, height)) return photoXYBSteps(data, width, height, quality, {filter, transform: P3_TRANSFORM, space: colorSpace});
  return colorSpace === 'srgb' && preferXYB(data, width, height) ? photoXYBSteps(data, width, height, quality, {filter}) : photoCoefficientSteps(data, width, height, quality, colorSpace);
}
