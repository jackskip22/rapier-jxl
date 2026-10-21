// SPDX-License-Identifier: MIT
import {PHOTO_LIMITS, part} from './bits.mjs';
import {admitEffort} from './effort-level.mjs';
import {losslessSteps, nativeSteps} from './lossless.mjs';
import {admitOptions, admitPixels, admitSampleFormat, job, fault} from './admit.mjs';
import {photoCoefficientSteps} from './photo-dct.mjs';
import {photoXYBSteps, preferXYB} from './photo-xyb.mjs';

export function photoJob(data, width, height, options, coefficients) {
  const {quality, colorSpace} = admitOptions(options, 90), effort = admitEffort(options);
  const filter = admitPhotoFilter(options);
  admitPixels(data, width, height, PHOTO_LIMITS);
  const samples = admitSampleFormat(data, options);
  if (!samples.native8) return job(nativeSteps(data, width, height, {quality, samples, effort}));
  return job(photoSteps(data, width, height, quality, colorSpace, effort, coefficients, filter));
}

export function admitPhotoFilter(options) {
  if (options?.photo !== undefined && typeof options.photo !== 'boolean') throw fault('JXL_INPUT', 'Photo is a boolean.');
  const filter = options?.filter;
  if (filter !== undefined && filter !== 'auto' && filter !== 'off') throw fault('JXL_INPUT', 'Photo filter is "auto" or "off".');
  return filter;
}

export function* photoSteps(data, width, height, quality, colorSpace, effort, encodeCoefficients, filter) {
  if (quality >= 100) return yield* losslessSteps(data, width, height, {colorSpace});
  const coefficients = yield* part(colorSpace === 'srgb' && preferXYB(data, width, height) ? photoXYBSteps(data, width, height, quality, {filter})
    : photoCoefficientSteps(data, width, height, quality, colorSpace), 0, 2);
  return yield* part(encodeCoefficients(coefficients, effort), 1, 2);
}
