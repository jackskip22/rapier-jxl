// SPDX-License-Identifier: MIT
import {captureAnswer, screenPhotoAnswer} from './screen-floor.mjs';
import {answer, guard} from './admit.mjs';
import {gpuQueue} from './gpu-queue.mjs';

export async function* driven(steps, signal, it, gpu, offload) {
  const settle = promise => !signal ? promise : new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, {once: true});
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); });
  });
  let step, reply, last, done = false;
  const device = gpu ? gpuQueue(gpu) : () => null;
  try {
    while (!(step = guard(() => {
      signal?.throwIfAborted();
      return offload ? offload.step(steps, reply) : steps.next(reply);
    })).done) {
      const value = step.value;
      reply = undefined;
      if (typeof value === 'number') { yield last = value; reply = it.hurry; }
      else if (value?.capture) reply = await settle(captureAnswer(value.capture));
      else if (value?.screenPhoto) reply = await settle(screenPhotoAnswer(value.screenPhoto));
      else if (value?.gpu) reply = value.later ? device(value.gpu) : await settle(device(value.gpu));
      else if (value?.await !== undefined) reply = value.await ? await settle(value.await) : value.await;
      else if (value?.offload === 'prefetch') offload.prefetch(value.tasks, value.after);
      else if (value?.offload === 'placed') offload.placed(value.image);
      else if (value?.offload === 'groups') reply = await settle(offload.groups(value));
      else if (value?.offload === 'run') reply = await settle(offload.run(value.task));
    }
    done = true;
    if (last < 1) yield 1;
    it.bytes = answer(step.value);
  } finally {
    offload?.end();
    if (!done) try { steps.return?.(); } catch {}
  }
}

export function serialJob(steps, {signal, gpu} = {}) {
  const it = (async function* () { yield* driven(steps, signal, it, gpu); })();
  it.bytes = null; it.hurry = false;
  return it;
}
