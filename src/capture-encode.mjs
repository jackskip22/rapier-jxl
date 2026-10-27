// SPDX-License-Identifier: MIT
import {LIMITS} from './bits.mjs';
import {admitPixels, fault} from './admit.mjs';
import {encodeLossless, inspectPixels} from './lossless.mjs';
import {screenLike, screenPlan, screenFrameSteps} from './screen.mjs';
import {patchSteps} from './screen-patches.mjs';
import {screenLZ77} from './screen-lz77.mjs';

export {LIMITS};

function finish(steps) {
  let step = steps.next();
  while (!step.done) step = steps.next(false);
  return step.value;
}

function deep(rgba, width, height, shape, mode) {
  const plan = screenPlan(rgba, width, height, shape, mode);
  if (!plan) return null;
  return finish(screenFrameSteps(rgba, width, height, shape, 'srgb', plan, {search: {}, minLength: 7}));
}

function smaller(current, next) {
  return next && (!current || next.length < current.length) ? next : current;
}

export function encodeCaptureBytes(data, width, height, options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw fault('JXL_INPUT', 'Capture options are an object.');
  if (options.signal?.aborted) throw fault('JXL_ABORTED', 'JPEG XL encoding was canceled.');
  admitPixels(data, width, height, LIMITS);
  if (!(data instanceof Uint8Array) && !(data instanceof Uint8ClampedArray))
    throw fault('JXL_INPUT', 'A capture is 8-bit straight RGBA. Native precision and HDR use the full encoder.');
  const shape = inspectPixels(data, width, height);
  // Effort 7's screen win, without the rest of that ladder. Frequency context-modelling is the pass effort 3
  // never runs; patch matching is the pass that wins on repeated text. Keep the smaller finished file.
  let best = smaller(null, deep(data, width, height, shape, 'frequency'));
  best = smaller(best, finish(patchSteps(data, width, height, shape, 'srgb', {tokenCodec: screenLZ77, minLength: 7})));
  if (!best && screenLike(data, width, height)) best = smaller(best, deep(data, width, height, shape, 'direct'));
  const exact = encodeLossless(data, width, height, {shape});
  if (options.signal?.aborted) throw fault('JXL_ABORTED', 'JPEG XL encoding was canceled.');
  return best && best.length < exact.length ? best : exact;
}
