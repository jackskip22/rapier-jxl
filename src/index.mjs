// SPDX-License-Identifier: MIT
// Core pixel encoder: lossless or lossy JPEG XL, with exact alpha and no runtime dependencies.
import {inspectPixels, losslessSteps, nativeSteps} from './lossless.mjs';
import {lossySteps} from './lossy.mjs';
import {LIMITS, complete, part} from './bits.mjs';
import {admitOptions, admitPixels, admitSampleFormat, job} from './admit.mjs';

// Shared core limits; admission rejects oversized input before encoding.
export {LIMITS};

// Typed RGBA to JPEG XL file bytes. Quality 100 preserves every sample; lower quality preserves alpha.
// Color declarations describe the input without converting it.
export function encode(data, width, height, options) { return complete(encodeSteps(data, width, height, options)); }

// Validate immediately, then yield one group of one pass per step.
export function encodeSteps(data, width, height, options) {
  const {quality, colorSpace} = admitOptions(options);
  admitPixels(data, width, height);
  const samples = admitSampleFormat(data, options);
  if (!samples.native8) return job(nativeSteps(data, width, height, {quality, samples}));
  return job(pixelSteps(data, width, height, quality, colorSpace));
}

function* pixelSteps(data, width, height, quality, colorSpace) {
  const shape = inspectPixels(data, width, height);
  if (quality >= 100) return yield* losslessSteps(data, width, height, {shape, colorSpace});
  if (!shape.palette) return yield* lossySteps(data, width, height, {quality, shape, colorSpace});
  // Retain an exact palette candidate before the lossy attempt so size or allocation failure preserves a result.
  const exact = yield* part(losslessSteps(data, width, height, {shape, colorSpace}), 0, 2);
  let bytes;
  try { bytes = yield* part(lossySteps(data, width, height, {quality, shape, colorSpace}), 1, 2); }
  catch (error) { if (error.code !== 'JXL_SIZE' && (!(error instanceof RangeError) || error.code)) throw error; bytes = exact; }
  return exact.length <= bytes.length ? exact : bytes;
}
