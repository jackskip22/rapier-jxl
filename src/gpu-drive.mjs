// SPDX-License-Identifier: MIT
import {guard, answer} from './admit.mjs';
import {captureAnswer, screenPhotoAnswer} from './screen-floor.mjs';
import {gpuOffered} from './gpu-gate.mjs';
import {FAST_EFFORT} from './effort-level.mjs';
import {gpuQueue} from './gpu-queue.mjs';

export const gpuWanted = (options, width, height) => options?.gpu !== false && (!!options?.gpu || gpuOffered(width, height, options?.effort ?? FAST_EFFORT) && !!globalThis.navigator?.gpu);

async function gpuAnswer(request, given) {
  const core = await import('./gpu-core.mjs').catch(() => null), device = core && ((typeof given === 'object' && given) || await core.gpuCoreDevice());
  return device ? await core.gpuCoreImage(device, request) : null;
}

export async function driveGpu(it, given) {
  let step, reply;
  const gpu = gpuQueue(request => gpuAnswer(request, given));
  while (!(step = guard(() => it.next(reply))).done) {
    const v = step.value;
    reply = v?.gpu ? (v.later ? gpu(v.gpu) : await gpu(v.gpu)) : v?.await !== undefined ? await v.await
      : v?.capture ? await captureAnswer(v.capture) : v?.screenPhoto ? await screenPhotoAnswer(v.screenPhoto) : undefined;
  }
  return answer(step.value);
}

export function gpuJob(steps, device) {
  const it = (async function* () {
    let step, last, reply;
    const gpu = device ? gpuQueue(request => gpuAnswer(request, device)) : () => null;
    while (!(step = guard(() => steps.next(reply))).done) {
      if (step.value?.gpu) reply = step.value.later ? gpu(step.value.gpu) : await gpu(step.value.gpu);
      else if (step.value?.await !== undefined) reply = await step.value.await;
      else if (step.value?.capture) reply = await captureAnswer(step.value.capture);
      else if (step.value?.screenPhoto) reply = await screenPhotoAnswer(step.value.screenPhoto);
      else if (step.value?.split) reply = undefined;
      else { yield last = step.value; reply = it.hurry; }
    }
    if (last < 1) yield 1;
    return it.bytes = answer(step.value);
  })();
  it.bytes = null; it.hurry = false;
  return it;
}
