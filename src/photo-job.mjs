// SPDX-License-Identifier: MIT
// One checked photograph job shared by the prefix and optional ANS entry points.
import {PHOTO_LIMITS, part} from './bits.mjs';
import {admitEffort} from './effort-level.mjs';
import {losslessSteps, nativeSteps} from './lossless.mjs';
import {admitOptions, admitPixels, admitSampleFormat, job} from './admit.mjs';
import {photoCoefficientSteps} from './photo-dct.mjs';
import {quantisationSteps} from './photo-quant.mjs';

export function photoJob(data, width, height, options, coefficients) {
  const {quality, colorSpace} = admitOptions(options, 90), effort = admitEffort(options);
  admitPixels(data, width, height, PHOTO_LIMITS);
  const samples = admitSampleFormat(data, options);
  if (!samples.native8) return job(nativeSteps(data, width, height, {quality, samples, effort}));
  return job(photoSteps(data, width, height, quality, colorSpace, effort, coefficients));
}

function* photoSteps(data, width, height, quality, colorSpace, effort, encodeCoefficients) {
  if (quality >= 100) return yield* losslessSteps(data, width, height, {colorSpace});
  if (effort < 5) return yield* part(encodeCoefficients(yield* part(photoCoefficientSteps(data, width, height, quality, colorSpace), 0, 2), effort), 1, 2);
  const coefficients = yield* part(photoCoefficientSteps(data, width, height, quality, colorSpace), 0, 4);
  let best = yield* part(encodeCoefficients(coefficients, 4), 1, 4);
  if (yield 0.5) return best;
  try {
    const chosen = yield* part(quantisationSteps(data, coefficients, best.byteLength), 2, 4);
    if (chosen) best = yield* part(encodeCoefficients(chosen, 4, best), 3, 4);
  } catch (error) { if (!(error instanceof RangeError && !error.code) && error.code !== 'JXL_SIZE') throw error; }
  return best;
}
