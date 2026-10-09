// SPDX-License-Identifier: MIT
// One checked photograph job shared by the prefix and optional ANS entry points.
import {PHOTO_LIMITS, part} from './bits.mjs';
import {admitEffort} from './effort-level.mjs';
import {losslessSteps, nativeSteps} from './lossless.mjs';
import {admitOptions, admitPixels, admitSampleFormat, job} from './admit.mjs';
import {photoCoefficientSteps} from './photo-dct.mjs';

export function photoJob(data, width, height, options, coefficients) {
  const {quality, colorSpace} = admitOptions(options, 90), effort = admitEffort(options);
  admitPixels(data, width, height, PHOTO_LIMITS);
  const samples = admitSampleFormat(data, options);
  if (!samples.native8) return job(nativeSteps(data, width, height, {quality, samples, effort}));
  return job(photoSteps(data, width, height, quality, colorSpace, effort, coefficients));
}

function* photoSteps(data, width, height, quality, colorSpace, effort, encodeCoefficients) {
  if (quality >= 100) return yield* losslessSteps(data, width, height, {colorSpace});
  const coefficients = yield* part(photoCoefficientSteps(data, width, height, quality, colorSpace), 0, 2);
  return yield* part(encodeCoefficients(coefficients, effort), 1, 2);
}
