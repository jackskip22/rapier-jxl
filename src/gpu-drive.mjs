// SPDX-License-Identifier: MIT
import {guard, answer} from './admit.mjs';

export const GPU_PIXELS = 1 << 20;
export const gpuWanted = (options, width, height) => options?.gpu !== false && (!!options?.gpu || width * height >= GPU_PIXELS && !!globalThis.navigator?.gpu);

async function gpuAnswer(request, given) {
  const core = await import('./gpu-core.mjs').catch(() => null), device = core && ((typeof given === 'object' && given) || await core.gpuCoreDevice());
  return device ? await core.gpuCoreImage(device, request) : null;
}

export async function driveGpu(it, given) {
  let step, reply;
  while (!(step = guard(() => it.next(reply))).done) reply = step.value?.gpu ? await gpuAnswer(step.value.gpu, given) : undefined;
  return answer(step.value);
}

export function gpuJob(steps, device) {
  const it = (async function* () {
    let step, last, reply;
    while (!(step = guard(() => steps.next(reply))).done) {
      if (step.value?.gpu) reply = await gpuAnswer(step.value.gpu, device);
      else { yield last = step.value; reply = it.hurry; }
    }
    if (last < 1) yield 1;
    return it.bytes = answer(step.value);
  })();
  it.bytes = null; it.hurry = false;
  return it;
}
