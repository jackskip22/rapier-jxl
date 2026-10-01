// SPDX-License-Identifier: MIT
// Rapier JXL's photograph door: pixels through the carrier's VarDCT writer, sRGB to YCbCr, forward DCT8, quantisation,
// then the carrier's contexts and prefix codes. Its own door, so the core carries none of it.
import {PHOTO_LIMITS, complete, part} from './bits.mjs';
import {coefficientEffortSteps} from './coefficient-effort.mjs';
import {admitEffort} from './effort-level.mjs';
import {losslessSteps} from './lossless.mjs';
import {admitOptions, admitPixels, job} from './admit.mjs';
import {photoCoefficientSteps} from './photo-dct.mjs';
import {quantisationSteps} from './photo-quant.mjs';

// This door's unchanged 40 MP admission; the optional quantisation search admits its scratch memory separately.
export {PHOTO_LIMITS as LIMITS};

// Quality 90 by default, 1 to 99 photographic, on libjxl's quality-to-distance curve; 100 is the core's exact stream,
// including RGB beneath transparent pixels. Alpha is always exact; the colour space is declared as the core declares
// it. The options are read before any work.
export function encodePhoto(data, width, height, options) { return complete(encodePhotoSteps(data, width, height, options)); }

// The same work as a job (admit.mjs): the coefficients a row of groups per step, then the VarDCT writer's steps.
export function encodePhotoSteps(data, width, height, options) {
  const {quality, colorSpace} = admitOptions(options, 90), effort = admitEffort(options);
  admitPixels(data, width, height, PHOTO_LIMITS);
  return job(photoSteps(data, width, height, quality, colorSpace, effort));
}

function* photoSteps(data, width, height, quality, colorSpace, effort) {
  if (quality >= 100) return yield* losslessSteps(data, width, height, {colorSpace});
  if (effort < 5) return yield* part(coefficientEffortSteps(yield* part(photoCoefficientSteps(data, width, height, quality, colorSpace), 0, 2), effort), 1, 2);
  const coefficients = yield* part(photoCoefficientSteps(data, width, height, quality, colorSpace), 0, 4);
  let best = yield* part(coefficientEffortSteps(coefficients, 4), 1, 4);
  if (yield 0.5) return best;
  try {
    const chosen = yield* part(quantisationSteps(data, coefficients, best.byteLength), 2, 4);
    if (chosen) best = yield* part(coefficientEffortSteps(chosen, 4, best), 3, 4);
  } catch (error) { if (!(error instanceof RangeError && !error.code) && error.code !== 'JXL_SIZE') throw error; }
  return best;
}
