import {fail, check, object, abortable} from './primitives.mjs';
import {captureRefused} from '../fault.mjs';
import {encodeCaptureSteps, compileCaptureKernels, captureBusy, CAPTURE_TOOLS, CAPTURE_SIZES, CAPTURE_FLOOR, frameCapture, CAPTURE_LIMIT} from '../capture-codec.mjs';
import {screenPhotoSteps} from '../screen-photo-mixed.mjs';
export {encodeOptions, callOptions} from './encode-options.mjs';
import {gpuQueue} from '../gpu-queue.mjs';
import {exclusive, exclusiveActive, turn} from '../turn.mjs';
import {journalNext} from '../step-journal.mjs';
import {deviceTrials} from '../device-trial.mjs';
import {deferRetirement} from '../call-scope.mjs';
export function targetSource(data, ...descriptions) {
  if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray))
    throw fail('JXL_INPUT', 'measured fidelity: 8-bit straight sRGB RGBA, or use exact');
  const compatible = {colorSpace: 'srgb', bitDepth: 8, sampleFormat: 'uint', transferFunction: 'srgb', alphaPremultiplied: false, intensityTarget: 255};
  for (const description of descriptions) {
    for (const [key, value] of Object.entries(compatible)) if (description[key] !== undefined && description[key] !== value)
      throw fail('JXL_INPUT', `${key}: not with measured fidelity`);
    if (description.icc !== undefined)
      throw fail('JXL_INPUT', 'icc: not with measured fidelity');
  }
}
export async function drain(iterator, hooks = {}, gpuAnswer) {
  const {signal, onProgress, journal} = hooks;
  check(signal);
  let last = 0, told = 0, reply, lastTurn = performance.now(), failed = false;
  let gpu = gpuAnswer ? gpuQueue(gpuAnswer) : null;
  try {
    const warm = gpuAnswer?.warm?.();
    if (warm !== undefined) await abortable(warm, signal);
    for (;;) {
      check(signal);
      deviceTrials(gpu?.trials, gpu?.generation, gpu?.phoneRequired);
      const step = await (journal ? journalNext(iterator, reply, journal) : iterator.next(reply));
      const asked = !step.done ? step.value?.await : undefined;
      const pending = typeof asked?.then === 'function' ? (gpu ??= gpuQueue(() => null)).watch(asked) : asked;
      check(signal);
      if (step.done) { onProgress?.(1); check(signal); return step.value ?? iterator.bytes; }
      if (journal && (step.value?.unit !== undefined || step.value?.unitDone !== undefined || step.value?.unitFailed !== undefined)) { reply = await journal(step.value); continue; }
      if (step.value?.gpu) { const answer = gpuAnswer ? gpu(step.value.gpu) : null; reply = step.value.later ? answer : await abortable(answer, signal); continue; }
      if (asked !== undefined) { reply = await abortable(pending, signal); continue; }
      if (step.value?.capture) { const {data, width, height, colorSpace, effort, tools, sizes, floor, frame, limit, small} = step.value.capture; await compileCaptureKernels(); reply = await exclusive(() => drain(encodeCaptureSteps(data, width, height, {colorSpace, effort, small, [CAPTURE_TOOLS]: tools, [CAPTURE_SIZES]: sizes, [CAPTURE_FLOOR]: floor, ...frameCapture(frame, floor), [CAPTURE_LIMIT]: limit}), {signal, journal}), signal); continue; }
      if (step.value?.screenPhoto) {
        try {
          await compileCaptureKernels();
          reply = await exclusive(() => drain(screenPhotoSteps(step.value.screenPhoto), {
            ...hooks, onProgress: fraction => onProgress?.(fraction * .95),
          }), signal);
        } catch (error) {
          check(signal);
          if (error?.name === 'AbortError') throw error;
          if (!captureRefused(error)) throw error;
          reply = null;
        }
        continue;
      }
      if (step.value?.split) { reply = hooks.split ? await hooks.split(step.value.split) : undefined; continue; }
      reply = undefined;
      if (typeof step.value === 'number' && Number.isFinite(step.value)) last = Math.max(last, Math.min(0.999999, step.value));
      const due = performance.now() - lastTurn >= 8;
      if (last > told && (due || !told)) { told = last; onProgress?.(last); check(signal); }
      const waiting = step.value === 0 && (captureBusy() || exclusiveActive());
      if (due || waiting) {
        if (signal || waiting) await turn();
        lastTurn = performance.now();
      }
    }
  } catch (reason) { failed = true; throw reason; }
  finally {
    try { await deferRetirement(gpu?.end(), () => iterator.return?.()); } catch (reason) { if (!failed) throw reason; }
  }
}
export async function driveSteps(steps, hooks, gpu, pixels, helpers, parallelJob, stage = null, jobBytes, geometry, floor) {
  check(hooks.signal);
  await abortable(gpu?.warm?.(), hooks.signal);
  const pool = parallelJob && helpers?.pool ? await helpers.pool(pixels, jobBytes, geometry, floor) : null;
  if (pool) return drain(parallelJob(steps, {kept: pool, signal: hooks.signal, gpu, stage}), hooks);
  return drain(steps, helpers?.split ? {...hooks, split: helpers.split} : hooks, gpu);
}
