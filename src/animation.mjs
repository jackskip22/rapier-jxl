// SPDX-License-Identifier: MIT
import {fault, guard} from './admit.mjs';
import {checkSignal} from './async-job.mjs';
import {ANIMATION_LIMITS, admitAnimation, animationSteps} from './animation-frames.mjs';

export {ANIMATION_LIMITS as LIMITS};

export function encodeAnimation(animation, options) {
  const steps = encodeAnimationSteps(animation, options), progress = options?.progress;
  if (progress !== undefined && typeof progress !== 'function') throw fault('JXL_INPUT', 'progress is a function.');
  for (const fraction of steps) if (progress && fraction < 1) progress(fraction);
  progress?.(1);
  return steps.bytes;
}

export function encodeAnimationSteps(animation, options = {}) {
  const admitted = admitAnimation(animation, options);
  const it = (function* () {
    const steps = animationSteps(admitted);
    let step, last;
    while (!(step = guard(() => steps.next(it.hurry))).done) { checkSignal(admitted.signal); yield last = step.value; }
    if (last < 1) yield 1;
    return it.bytes = step.value;
  })();
  it.bytes = null; it.hurry = false;
  return it;
}

