// SPDX-License-Identifier: MIT
import {inspectPixels, losslessSteps, nativeSteps, iccShape, inspectPixelsSteps} from './lossless.mjs';
import {lossySteps} from './lossy.mjs';
import {smallPalette, SMALL_SCREEN} from './small-palette.mjs';
import {photoSteps, admitPhotoFilter} from './photo-job.mjs';
import {varDCTSteps} from './vardct.mjs';
import {LIMITS} from './limits.mjs';
import {complete, part} from './bits.mjs';
import {admitOptions, admitPixels, job} from './admit.mjs';
import {admitSampleFormat} from './admit-samples.mjs';

export {LIMITS};

export function encode(data, width, height, options) { return complete(encodeSteps(data, width, height, options)); }

export function encodeSteps(data, width, height, options) { return job(coreSteps(data, width, height, options, false)); }
export function coreSteps(data, width, height, options, gpu) {
  const {quality, colorSpace} = admitOptions(options), filter = admitPhotoFilter(options);
  admitPixels(data, width, height);
  const samples = admitSampleFormat(data, options);
  if (samples.iccSpace) return iccShape(data, samples.iccSpace, pixelSteps(data, width, height, quality, samples.iccSpace, options?.photo !== false, filter));
  if (!samples.native8) return nativeSteps(data, width, height, {quality, samples});
  return pixelSteps(data, width, height, quality, colorSpace, options?.photo !== false, filter, gpu);
}

function* pixelSteps(data, width, height, quality, colorSpace, photo, filter, gpu) {
  const shape = yield* inspectPixelsSteps(data, width, height);
  if (quality >= 100) return yield* losslessSteps(data, width, height, {shape, colorSpace, fast: true, units: true});
  if (!shape.palette) return yield* (photo ? photoSteps(data, width, height, quality, colorSpace, 1, coefficients => varDCTSteps(coefficients, {fast: true}), filter, undefined, gpu)
    : lossySteps(data, width, height, {quality, shape, colorSpace}));
  const small = smallPalette(data, width, height, colorSpace);
  const exact = yield* part(losslessSteps(data, width, height, {shape, colorSpace, fast: true, units: true}), 0, 2);
  if (small) {
    if (small === SMALL_SCREEN || !photo || typeof colorSpace === 'object') return exact;
    const file = yield* part(photoSteps(data, width, height, quality, colorSpace, 1, coefficients => varDCTSteps(coefficients, {fast: true}), filter, undefined, gpu), 1, 2);
    return file.length < exact.length ? file : exact;
  }
  let bytes;
  try { bytes = yield* part(lossySteps(data, width, height, {quality, shape, colorSpace}), 1, 2); }
  catch (error) { if (error.code !== 'JXL_SIZE' && error.code !== 'JXL_MEMORY' && (!(error instanceof RangeError) || error.code)) throw error; bytes = exact; }
  return exact.length <= bytes.length ? exact : bytes;
}
