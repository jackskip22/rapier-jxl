// SPDX-License-Identifier: MIT
import {guard} from './admit.mjs';
import {checkSignal} from './async-job.mjs';
import {admitAnimation, animationSteps} from './animation-frames.mjs';

export function encodeAnimationJob(animation, options = {}) {
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

