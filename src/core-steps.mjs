// SPDX-License-Identifier: MIT
import {hostShort} from './fault.mjs';
import {exactSignal, signalSpace} from './color-signal.mjs';
import {inspectPixels, losslessSteps, nativeSteps, iccShape, inspectPixelsSteps} from './lossless.mjs';
import {lossySteps} from './lossy.mjs';
import {smallPalette, SMALL_SCREEN} from './small-palette.mjs';
import {photoSteps, admitPhotoFilter} from './photo-job.mjs';
import {varDCTSteps} from './vardct.mjs';
import {LIMITS} from './limits.mjs';
import {complete, part} from './bits.mjs';
import {admitOptions, admitPixels, job} from './admit.mjs';
import {admitSampleFormat, statedSpace} from './admit-samples.mjs';
import {captureFillClear} from './capture-kernels.mjs';
import {journaling, unit} from './step-journal.mjs';
import {recall, spaceKey} from './call-memo.mjs';
import {softPicture} from './v7/intent-quality.mjs';

export {LIMITS};

export function encode(data, width, height, options) { return complete(encodeSteps(data, width, height, options)); }

export function encodeSteps(data, width, height, options, hdr = null) { return job(coreSteps(data, width, height, options, false, hdr)); }
export function coreSteps(data, width, height, options, gpu, hdr = null) {
  const {quality, colorSpace} = admitOptions(options), filter = admitPhotoFilter(options);
  admitPixels(data, width, height);
  const samples = admitSampleFormat(data, options);
  if (samples.iccSpace) return iccShape(data, samples.iccSpace, pixelSteps(data, width, height, quality, samples.iccSpace, options?.photo !== false, filter));
  if (!samples.native8 && quality >= 100 && exactSignal(samples)) return pixelSteps(data, width, height, 100, signalSpace(samples), false, filter, gpu);
  const stated = quality < 100 && statedSpace(samples);
  if (stated) return iccShape(data, stated, pixelSteps(data, width, height, quality, stated, options?.photo !== false, filter));
  if (!samples.native8) return hdr?.route(data, samples, quality) ? hdr.steps(data, width, height, quality, 1, samples, () => nativeSteps(data, width, height, {quality: 100, samples, effort: 1}), hdr.report) : nativeSteps(data, width, height, {quality, samples, report: hdr?.report});
  return pixelSteps(data, width, height, quality, colorSpace, options?.photo !== false, filter, gpu);
}

export function* filledClear(data, width, height) {
  if (!journaling()) return yield* recall(data, 'fill-clear', function* () { return captureFillClear(data, width, height); });
  const filled = yield* unit('fill-clear', () => { const out = captureFillClear(data, width, height); return out === data ? null : out; }, undefined, false, true);
  return filled ?? data;
}

function* pixelSteps(data, width, height, quality, colorSpace, photo, filter, gpu) {
  const shape = yield* inspectPixelsSteps(data, width, height);
  const exactStream = () => recall(data, spaceKey(colorSpace) && `fast:${spaceKey(colorSpace)}`, () => losslessSteps(data, width, height, {shape, colorSpace, fast: true, units: true}));
  if (quality >= 100) return yield* exactStream();
  if (!shape.palette) {
    const pixels = shape.alpha ? yield* filledClear(data, width, height) : data;
    return yield* (photo ? photoSteps(pixels, width, height, quality, colorSpace, 1, coefficients => varDCTSteps(coefficients, {fast: true}), filter, undefined, gpu)
      : lossySteps(pixels, width, height, {quality, shape, colorSpace}));
  }
  const small = smallPalette(data, width, height, colorSpace);
  const exact = yield* part(exactStream(), 0, 2);
  if (small) {
    if (small === SMALL_SCREEN || !photo || typeof colorSpace === 'object') return exact;
    const file = yield* part(photoSteps(data, width, height, quality, colorSpace, 1, coefficients => varDCTSteps(coefficients, {fast: true}), filter, undefined, gpu), 1, 2);
    return file.length < exact.length ? file : exact;
  }
  let bytes;
  try { bytes = yield* part(lossySteps(data, width, height, {quality, shape, colorSpace}), 1, 2); }
  catch (error) { if (error.code !== 'JXL_SIZE' && error.code !== 'JXL_MEMORY' || hostShort(error)) throw error; bytes = exact; }
  let best = exact.length <= bytes.length ? exact : bytes;
  if (photo && typeof colorSpace !== 'object' && !journaling() && softPicture(data, width, height)) {
    const file = yield* photoSteps(data, width, height, quality, colorSpace, 1, coefficients => varDCTSteps(coefficients, {fast: true}), filter, undefined, gpu);
    if (file.length < best.length) best = file;
  }
  return best;
}
