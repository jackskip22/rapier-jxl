// Input validation, limits, errors, and incremental jobs. MIT (images/jxl/LICENSE).
import {LIMITS} from './limits.mjs';

import {fault} from './fault.mjs';

export {fault};

export function admitColorRoute(options) {
  if (options.colorEncoding !== undefined || options.toneMapping !== undefined)
    throw fault('JXL_INPUT', 'Custom color metadata requires encodeProfile from rapier-jxl/icc.');
}

export function admitOptions(options = {}, quality = 100) {
  if (options === null || typeof options !== 'object') throw fault('JXL_INPUT', 'Options are an object: {quality, colorSpace}.');
  admitColorRoute(options);
  if (options.quality !== undefined) quality = options.quality;
  if (typeof quality !== 'number' || !Number.isFinite(quality) || quality < 1 || quality > 100) throw fault('JXL_INPUT', 'Quality is a number from 1 to 100.');
  const colorSpace = options.colorSpace === undefined ? 'srgb' : options.colorSpace;
  if (colorSpace !== 'srgb' && colorSpace !== 'display-p3' && colorSpace !== 'rec2020') throw fault('JXL_INPUT', 'The color space is srgb, display-p3 or rec2020.');
  return {quality, colorSpace};
}

export function admitSize(width, height, limits = LIMITS) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw fault('JXL_INPUT', 'A picture is at least one pixel wide and high, in whole pixels.');
  if (width > limits.edge || height > limits.edge) throw fault('JXL_DIMENSIONS', 'A picture is at most ' + limits.edge + ' pixels on a side.');
  if (width * height > limits.pixels) throw fault('JXL_DIMENSIONS', 'A picture is at most ' + limits.pixels.toLocaleString('en-US') + ' pixels.');
}

export function admitPixels(data, width, height, limits) {
  admitSize(width, height, limits);
  if (!(data instanceof Uint8Array) && !(data instanceof Uint8ClampedArray) && !(data instanceof Uint16Array) && !(data instanceof Float32Array)) throw fault('JXL_INPUT', 'Pixels are Uint8Array, Uint8ClampedArray, Uint16Array or Float32Array samples.');
  if (data.length !== width * height * 4) throw fault('JXL_INPUT', 'Pixels are width * height * 4 samples: straight (not premultiplied) RGBA, row by row.');
}

export function admitOutputSize(length) {
  if (!Number.isSafeInteger(length) || length < 0) throw fault('JXL_MEMORY', 'The encoded picture cannot be allocated.');
}

export function answer(bytes) {
  admitOutputSize(bytes.length);
  return bytes;
}

export function guard(work) {
  try { return work(); }
  catch (error) { if (error instanceof RangeError && !error.code) throw fault('JXL_MEMORY', 'Not enough memory for this picture.'); throw error; }
}

export function job(steps) {
  const it = (function* () {
    let step, last, reply;
    while (!(step = guard(() => steps.next(reply))).done) {
      if (step.value?.capture || step.value?.split) { reply = undefined; continue; }
      yield last = step.value; reply = it.hurry;
    }
    if (last < 1) yield 1;
    return it.bytes = answer(step.value);
  })();
  it.bytes = null; it.hurry = false;
  return it;
}
