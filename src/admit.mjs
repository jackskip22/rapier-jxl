// Input validation, limits, errors, and incremental jobs. MIT (images/jxl/LICENSE).
import {isSignal} from './color-signal.mjs';
import {LIMITS} from './limits.mjs';

import {fault, outOfMemory, hostWords} from './fault.mjs';

export {fault};

export function admitOptions(options = {}, quality = 100) {
  if (options === null || typeof options !== 'object') throw fault('JXL_INPUT', 'options: object');
  if (options.quality !== undefined) quality = options.quality;
  if (typeof quality !== 'number' || !Number.isFinite(quality) || quality < 1 || quality > 100) throw fault('JXL_INPUT', 'quality: number 1-100');
  const colorSpace = options.colorSpace === undefined ? 'srgb' : options.colorSpace;
  if (colorSpace !== 'srgb' && colorSpace !== 'display-p3' && colorSpace !== 'rec2020' && !isSignal(colorSpace)) throw fault('JXL_INPUT', 'colorSpace: srgb, display-p3 or rec2020');
  return {quality, colorSpace};
}

export function admitSize(width, height, limits = LIMITS) {
  if (typeof limits === 'number') limits = {edge: LIMITS.edge, pixels: limits};
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw fault('JXL_INPUT', 'width, height: positive integers');
  if (width > limits.edge || height > limits.edge) throw fault('JXL_DIMENSIONS', 'side: max ' + limits.edge);
  if (width * height > limits.pixels) throw fault('JXL_DIMENSIONS', 'pixels: max ' + limits.pixels.toLocaleString('en-US') + ' (maxPixels)');
}

export function admitPixels(data, width, height, limits) {
  admitSize(width, height, limits);
  const float16 = typeof Float16Array === 'function' && data instanceof Float16Array;
  if (!(data instanceof Uint8Array) && !(data instanceof Uint8ClampedArray) && !(data instanceof Uint16Array) && !(data instanceof Float32Array) && !float16) throw fault('JXL_INPUT', 'data: Uint8Array, Uint8ClampedArray, Uint16Array, Float16Array or Float32Array');
  if (data.length !== width * height * 4) throw fault('JXL_INPUT', 'data: width * height * 4 RGBA samples');
}

export function admitOutputSize(length) {
  if (!Number.isSafeInteger(length) || length < 0) throw fault('JXL_MEMORY', 'output: too large');
}

export function answer(bytes) {
  admitOutputSize(bytes.length);
  return bytes;
}

export function guard(work) {
  try { return work(); }
  catch (error) { if (outOfMemory(error)) throw Object.assign(fault('JXL_MEMORY', `out of memory${hostWords(error)}`), {cause: error}); throw error; }
}

export function job(steps, captures = false) {
  const it = (function* () {
    let step, last, reply;
    try { while (!(step = guard(() => steps.next(reply))).done) {
      if (captures && step.value?.capture) { reply = yield step.value; continue; }
      if (step.value?.capture || step.value?.split || step.value?.gpu) { reply = undefined; continue; }
      if (step.value?.unit !== undefined || step.value?.unitDone !== undefined || step.value?.unitFailed !== undefined) { reply = yield step.value; continue; }
      yield last = step.value; reply = it.hurry;
    } } finally { if (!step?.done) steps.return?.(); }
    if (last < 1) yield 1;
    return it.bytes = answer(step.value);
  })();
  it.bytes = null; it.hurry = false;
  return it;
}
