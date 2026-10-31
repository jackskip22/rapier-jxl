import {fail, check, object} from './primitives.mjs';
import {captureAnswer} from '../screen-floor.mjs';
export {encodeOptions, callOptions} from './encode-options.mjs';
import {gpuQueue} from '../gpu-queue.mjs';
export function targetSource(data, ...descriptions) {
  if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray))
    throw fail('JXL_INPUT', 'Measured targets require 8-bit straight sRGB RGBA.');
  const compatible = {colorSpace: 'srgb', bitDepth: 8, sampleFormat: 'uint', transferFunction: 'srgb', alphaPremultiplied: false, intensityTarget: 255};
  for (const description of descriptions) {
    for (const [key, value] of Object.entries(compatible)) if (description[key] !== undefined && description[key] !== value)
      throw fail('JXL_INPUT', `Measured targets require 8-bit straight sRGB RGBA; ${key} is incompatible.`);
    if (description.icc !== undefined)
      throw fail('JXL_INPUT', 'Measured targets do not accept ICC-tagged input.');
  }
}
export async function drain(iterator, hooks = {}, gpuAnswer) {
  const {signal, onProgress} = hooks;
  check(signal);
  let last = 0, told = 0, reply, lastTurn = performance.now(), failed = false, channel = typeof MessageChannel === 'function' ? undefined : false,
    immediate = typeof setImmediate === 'function';
  const turn = () => new Promise(resolve => {
    if (immediate) try { setImmediate(resolve); return; } catch { immediate = false; }
    if (channel !== false) try {
      channel ||= new MessageChannel();
      channel.port1.onmessage = resolve;
      channel.port2.postMessage(0);
      return;
    } catch { channel = false; }
    setTimeout(resolve, 0);
  });
  const gpu = gpuAnswer ? gpuQueue(gpuAnswer) : () => null;
  try {
    for (;;) {
      check(signal);
      const step = await iterator.next(reply);
      check(signal);
      if (step.done) { onProgress?.(1); check(signal); return step.value ?? iterator.bytes; }
      if (step.value?.gpu) { reply = step.value.later ? gpu(step.value.gpu) : await gpu(step.value.gpu); continue; }
      if (step.value?.await !== undefined) { reply = await step.value.await; continue; }
      if (step.value?.capture) { reply = await captureAnswer(step.value.capture); continue; }
      if (step.value?.screenPhoto) {
        try {
          const {screenPhotoSteps, compileCaptureKernels} = await import('../screen-photo-mixed.mjs');
          await compileCaptureKernels();
          reply = await drain(screenPhotoSteps(step.value.screenPhoto), {
            ...hooks, onProgress: fraction => onProgress?.(fraction * .95),
          });
        } catch (error) {
          check(signal);
          if (error?.name === 'AbortError' || error?.code === 'JXL_ABORTED') throw error;
          if (typeof error?.code !== 'string' || !error.code.startsWith('JXL_')) throw error;
          reply = null;
        }
        continue;
      }
      if (step.value?.split) { reply = hooks.split ? await hooks.split(step.value.split) : undefined; continue; }
      reply = undefined;
      if (typeof step.value === 'number' && Number.isFinite(step.value)) last = Math.max(last, Math.min(0.999999, step.value));
      const due = performance.now() - lastTurn >= 8;
      if (last > told && (due || !told)) { told = last; onProgress?.(last); check(signal); }
      if (due) {
        if (signal) await turn();
        lastTurn = performance.now();
      }
    }
  } catch (reason) { failed = true; throw reason; }
  finally {
    if (channel) { channel.port1.close(); channel.port2.close(); }
    try { await iterator.return?.(); } catch (reason) { if (!failed) throw reason; }
  }
}
export async function driveSteps(steps, hooks, gpu, pixels, helpers, parallelJob) {
  const pool = parallelJob && helpers?.pool ? await helpers.pool(pixels) : null;
  if (pool) return drain(parallelJob(steps, {kept: pool, signal: hooks.signal, gpu}), hooks);
  return drain(steps, helpers?.split ? {...hooks, split: helpers.split} : hooks, gpu);
}
