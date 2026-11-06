// SPDX-License-Identifier: MIT
import {CAPTURE_GPU} from '../capture-codec.mjs';
import {captureBlockRequest} from '../gpu-capture-blocks.mjs';
import {GPU_FROM} from './capture-levels.mjs';
import {fail} from './primitives.mjs';
import {untilAborted} from './rows.mjs';

export const engineAnswerer = (captureEngine, gpu) => async (coding, pixels) => {
  if (coding.webgpu === false) return null;
  const exact = (coding.effort ?? 3) >= GPU_FROM && pixels >= gpu.pixels;
  const photo = (coding.photoBlockEffort ?? 0) >= GPU_FROM || (coding.wholePhotoRoute?.effort ?? 0) >= GPU_FROM;
  if (!exact && !photo) return null;
  const engine = exact ? await untilAborted(captureEngine(coding.webgpu), coding.signal) : null;
  if (!engine && !photo) return null;
  const required = coding.webgpu === 'required', signal = coding.signal;
  const dispatch = async (request, jobSignal) => {
    if (photo && (request?.kind === 'photo-block-costs' || request?.kind === 'photo-block-levels')) {
      return captureBlockRequest(coding.webgpu, request, jobSignal);
    }
    return engine && request ? engine(request, jobSignal) : null;
  };
  const ahead = new Map();
  const answer = value => {
    if (!value.gpu && !value.await) return null;
    if (value.ahead) {
      const controller = new AbortController(), stop = () => controller.abort(signal.reason);
      if (signal?.aborted) stop(); else signal?.addEventListener('abort', stop, {once: true});
      const promise = dispatch(value.gpu, controller.signal).catch(() => null)
        .finally(() => signal?.removeEventListener('abort', stop));
      ahead.set(promise, controller);
      return promise;
    }
    if (value.await) ahead.delete(value.await);
    return Promise.resolve(value.await ?? dispatch(value.gpu, signal)).then(reply => {
      if (!reply && required) throw fail('JXL_WEBGPU', "webgpu: 'required', and the device could not answer. Leave webgpu out for the same file on WebAssembly.");
      return reply;
    });
  };
  const retire = () => { for (const controller of ahead.values()) controller.abort(); ahead.clear(); };
  return Object.assign(answer, {options: {[CAPTURE_GPU]: !!engine}, retire});
};
