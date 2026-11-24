// SPDX-License-Identifier: MIT
import {captureAnswer, screenPhotoAnswer} from './screen-floor.mjs';
import {answer, guard} from './admit.mjs';
import {gpuQueue} from './gpu-queue.mjs';
import {deviceTrials} from './device-trial.mjs';
import {deferRetirement} from './call-scope.mjs';

export async function* driven(steps, signal, it, gpu, offload, queued) {
  const device = queued ?? (gpu ? gpuQueue(gpu) : () => null);
  const settle = value => {
    const promise = device.watch ? device.watch(value) : value;
    return !signal || typeof promise?.then !== 'function' ? promise : new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      if (signal.aborted) return abort();
      signal.addEventListener('abort', abort, {once: true});
      promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); },
        error => { signal.removeEventListener('abort', abort); reject(error); });
    });
  };
  let step, reply, last, done = false;
  try {
    while (!(step = guard(() => {
      signal?.throwIfAborted();
      deviceTrials(device.trials, device.generation, device.phoneRequired);
      return offload ? offload.step(steps, reply) : steps.next(reply);
    })).done) {
      const value = step.value;
      reply = undefined;
      if (typeof value === 'number') { yield last = value; reply = it.hurry; }
      else if (value?.capture) reply = await captureAnswer(value.capture, signal);
      else if (value?.screenPhoto) reply = await screenPhotoAnswer(value.screenPhoto, signal);
      else if (value?.gpu) reply = value.later ? device(value.gpu) : await settle(device(value.gpu));
      else if (value?.await !== undefined) reply = value.await ? await settle(value.await) : value.await;
      else if (value?.offload === 'prefetch') offload.prefetch(value.tasks, value.after);
      else if (value?.offload === 'placed') offload.placed(value.image);
      else if (value?.offload === 'groups') reply = await settle(offload.groups(value));
      else if (value?.offload === 'capture-groups') reply = await settle(offload.captureGroups(value));
      else if (value?.offload === 'capture-single') reply = await settle(offload.captureSingle(value));
      else if (value?.offload === 'run') reply = await settle(offload.run(value.task));
    }
    done = true;
    if (last < 1) yield 1;
    it.bytes = answer(step.value);
  } finally {
    offload?.end();
    try { deferRetirement(device.end?.(), () => !done ? steps.return?.() : undefined); } catch {}
  }
}

export function serialJob(steps, {signal, gpu} = {}) {
  const it = (async function* () { yield* driven(steps, signal, it, gpu); })();
  it.bytes = null; it.hurry = false;
  return it;
}
