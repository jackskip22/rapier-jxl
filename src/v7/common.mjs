import {fail, check, object} from './primitives.mjs';
import {encodeCaptureSteps, compileCaptureKernels, CAPTURE_TOOLS} from '../capture-codec.mjs';
import {screenPhotoSteps} from '../screen-photo-mixed.mjs';
export {encodeOptions, callOptions} from './encode-options.mjs';
import {gpuQueue} from '../gpu-queue.mjs';
import {exclusive, turn} from '../turn.mjs';
import {journalNext} from '../step-journal.mjs';
export function targetSource(data, ...descriptions) {
  if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray))
    throw fail('JXL_INPUT', 'Measured targets require 8-bit straight sRGB RGBA.');
  const compatible = {colorSpace: 'srgb', bitDepth: 8, sampleFormat: 'uint', transferFunction: 'srgb', alphaPremultiplied: false, intensityTarget: 255};
  for (const description of descriptions) {
    for (const [key, value] of Object.entries(compatible)) if (description[key] !== undefined && description[key] !== value)
      throw fail('JXL_INPUT', `Measured targets need 8-bit straight sRGB RGBA; ${key} is not.`);
    if (description.icc !== undefined)
      throw fail('JXL_INPUT', 'Measured targets do not accept ICC-tagged input.');
  }
}
export async function drain(iterator, hooks = {}, gpuAnswer) {
  const {signal, onProgress, journal} = hooks;
  check(signal);
  let last = 0, told = 0, reply, lastTurn = performance.now(), failed = false;
  const gpu = gpuAnswer ? gpuQueue(gpuAnswer) : () => null;
  try {
    for (;;) {
      check(signal);
      const step = await (journal ? journalNext(iterator, reply, journal) : iterator.next(reply));
      check(signal);
      if (step.done) { onProgress?.(1); check(signal); return step.value ?? iterator.bytes; }
      if (journal && (step.value?.unit !== undefined || step.value?.unitDone !== undefined || step.value?.unitFailed !== undefined)) { reply = await journal(step.value); continue; }
      if (step.value?.gpu) { reply = step.value.later ? gpu(step.value.gpu) : await gpu(step.value.gpu); continue; }
      if (step.value?.await !== undefined) { reply = await step.value.await; continue; }
      if (step.value?.capture) { const {data, width, height, colorSpace, effort, tools} = step.value.capture; await compileCaptureKernels(); reply = await exclusive(() => drain(encodeCaptureSteps(data, width, height, {colorSpace, effort, [CAPTURE_TOOLS]: tools}), {signal, journal}), signal); continue; }
      if (step.value?.screenPhoto) {
        try {
          await compileCaptureKernels();
          reply = await exclusive(() => drain(screenPhotoSteps(step.value.screenPhoto), {
            ...hooks, onProgress: fraction => onProgress?.(fraction * .95),
          }), signal);
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
    try { await iterator.return?.(); } catch (reason) { if (!failed) throw reason; }
  }
}
export async function driveSteps(steps, hooks, gpu, pixels, helpers, parallelJob) {
  const pool = parallelJob && helpers?.pool ? await helpers.pool(pixels) : null;
  if (pool) return drain(parallelJob(steps, {kept: pool, signal: hooks.signal, gpu}), hooks);
  return drain(steps, helpers?.split ? {...hooks, split: helpers.split} : hooks, gpu);
}
