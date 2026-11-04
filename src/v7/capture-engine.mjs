// SPDX-License-Identifier: MIT
import {CAPTURE_GPU} from '../capture-codec.mjs';
import {GPU_FROM} from './capture-levels.mjs';
import {fail} from './primitives.mjs';
import {untilAborted} from './rows.mjs';

export const engineAnswerer = (captureEngine, gpu) => async (coding, pixels) => {
  if ((coding.effort ?? 3) < GPU_FROM || coding.webgpu === false || pixels < gpu.pixels) return null;
  const engine = await untilAborted(captureEngine(coding.webgpu), coding.signal);
  if (!engine) return null;
  const required = coding.webgpu === 'required', signal = coding.signal;
  const ahead = new Map();
  const answer = value => {
    if (value.ahead) {
      const controller = new AbortController(), stop = () => controller.abort(signal.reason);
      if (signal?.aborted) stop(); else signal?.addEventListener('abort', stop, {once: true});
      const promise = engine(value.gpu, controller.signal).catch(() => null)
        .finally(() => signal?.removeEventListener('abort', stop));
      ahead.set(promise, controller);
      return promise;
    }
    if (value.await) ahead.delete(value.await);
    return Promise.resolve(value.await ?? engine(value.gpu, signal)).then(reply => {
      if (!reply && required) throw fail('JXL_WEBGPU', "webgpu: 'required', and the device could not answer. Leave webgpu out for the same file on WebAssembly.");
      return reply;
    });
  };
  const retire = () => { for (const controller of ahead.values()) controller.abort(); ahead.clear(); };
  return Object.assign(answer, {options: {[CAPTURE_GPU]: true}, retire});
};
