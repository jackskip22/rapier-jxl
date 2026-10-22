// SPDX-License-Identifier: MIT
import {inspectPixels, losslessSteps, nativeSteps} from './lossless.mjs';
import {lossySteps} from './lossy.mjs';
import {photoSteps, admitPhotoFilter} from './photo-job.mjs';
import {varDCTSteps} from './vardct.mjs';
import {LIMITS, complete, part} from './bits.mjs';
import {admitOptions, admitPixels, admitSampleFormat, job} from './admit.mjs';

export {LIMITS};

export function encode(data, width, height, options) { return complete(encodeSteps(data, width, height, options)); }

export function encodeSteps(data, width, height, options) {
  const {quality, colorSpace} = admitOptions(options), filter = admitPhotoFilter(options);
  admitPixels(data, width, height);
  const samples = admitSampleFormat(data, options);
  if (!samples.native8) return job(nativeSteps(data, width, height, {quality, samples}));
  return job(pixelSteps(data, width, height, quality, colorSpace, options?.photo !== false, filter));
}

function* pixelSteps(data, width, height, quality, colorSpace, photo, filter) {
  const shape = inspectPixels(data, width, height);
  if (quality >= 100) return yield* losslessSteps(data, width, height, {shape, colorSpace});
  if (!shape.palette) return yield* (photo ? photoSteps(data, width, height, quality, colorSpace, 1, coefficients => varDCTSteps(coefficients), filter)
    : lossySteps(data, width, height, {quality, shape, colorSpace}));
  const exact = yield* part(losslessSteps(data, width, height, {shape, colorSpace}), 0, 2);
  let bytes;
  try { bytes = yield* part(lossySteps(data, width, height, {quality, shape, colorSpace}), 1, 2); }
  catch (error) { if (error.code !== 'JXL_SIZE' && error.code !== 'JXL_MEMORY' && (!(error instanceof RangeError) || error.code)) throw error; bytes = exact; }
  return exact.length <= bytes.length ? exact : bytes;
}
