import {fail, check, object} from './primitives.mjs';
import {captureAnswer} from '../screen-floor.mjs';
const rawKeys = new Set(['quality','lossless','effort','colorSpace','bitDepth','sampleFormat','transferFunction',
  'intensityTarget','alphaPremultiplied','icc','iccCompression','photo','filter','losslessProfile','format','target',
  'signal','onProgress','acceleration']);
export function encodeOptions(value) {
  const options = object(value);
  for (const key of Object.keys(options)) if (!rawKeys.has(key)) throw fail('JXL_OPTIONS', `Unknown encode option: ${key}.`);
  if (options.onProgress !== undefined && typeof options.onProgress !== 'function') throw fail('JXL_OPTIONS', 'onProgress must be a function.');
  if (options.signal !== undefined && typeof options.signal?.throwIfAborted !== 'function') throw fail('JXL_OPTIONS', 'signal must be an AbortSignal.');
  if (options.lossless !== undefined && typeof options.lossless !== 'boolean') throw fail('JXL_OPTIONS', 'lossless must be boolean.');
  if (options.lossless === true && (options.quality !== undefined || options.target !== undefined))
    throw fail('JXL_OPTIONS', 'Choose lossless, quality, or a measured target.');
  if (options.target !== undefined && (options.quality !== undefined || options.format !== undefined))
    throw fail('JXL_OPTIONS', 'A measured target supplies its own quality and format search.');
  if (options.target !== undefined) {
    object(options.target, 'target');
    for (const key of ['photo', 'filter', 'losslessProfile']) if (options[key] !== undefined)
      throw fail('JXL_OPTIONS', `Measured targets do not accept ${key}.`);
  }
  const quality = options.lossless === true ? 100 : options.quality ?? 90, effort = options.effort ?? 7;
  if (!Number.isFinite(quality) || quality < 1 || quality > 100 || !Number.isInteger(effort) || effort < 1 || effort > 9)
    throw fail('JXL_OPTIONS', 'quality must be 1–100 and effort an integer 1–9.');
  if (!['js','wasm','webgpu','auto'].includes(options.acceleration ?? 'js'))
    throw fail('JXL_OPTIONS', 'acceleration must be js, wasm, webgpu, or auto.');
  if (options.format !== undefined) {
    object(options.format, 'format');
    const allowed = new Set(['extraChannels','level','upsampling','upsamplingWeights','transforms','quantization',
      'coefficientOrders','progressive','noise','lfFrames','orientation']);
    for (const key of Object.keys(options.format)) if (!allowed.has(key)) throw fail('JXL_OPTIONS', `Unknown format option: ${key}.`);
  }
  const {lossless, signal, onProgress, acceleration, format, target, ...codec} = options;
  return {...codec, quality, effort};
}
export function targetSource(data, ...descriptions) {
  if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray))
    throw fail('JXL_INPUT', 'Measured targets require 8-bit straight sRGB RGBA.');
  const compatible = {colorSpace: 'srgb', bitDepth: 8, sampleFormat: 'uint', transferFunction: 'srgb', alphaPremultiplied: false, intensityTarget: 255};
  for (const description of descriptions) {
    for (const [key, value] of Object.entries(compatible)) if (description[key] !== undefined && description[key] !== value)
      throw fail('JXL_INPUT', `Measured targets require 8-bit straight sRGB RGBA; ${key} is incompatible.`);
    if (description.icc !== undefined || description.iccCompression !== undefined)
      throw fail('JXL_INPUT', 'Measured targets do not accept ICC-tagged input.');
  }
}
export async function drain(iterator, hooks = {}, gpuAnswer) {
  const {signal, onProgress} = hooks;
  check(signal);
  let last = 0, reply, lastTurn = performance.now(), failed = false;
  try {
    for (;;) {
      check(signal);
      const step = await iterator.next(reply);
      check(signal);
      if (step.done) { onProgress?.(1); check(signal); return step.value ?? iterator.bytes; }
      if (step.value?.gpu) { reply = gpuAnswer ? await gpuAnswer(step.value.gpu) : null; continue; }
      if (step.value?.capture) { reply = await captureAnswer(step.value.capture); continue; }
      if (step.value?.split) { reply = hooks.split ? await hooks.split(step.value.split) : undefined; continue; }
      reply = undefined;
      if (typeof step.value === 'number' && Number.isFinite(step.value)) {
        last = Math.max(last, Math.min(0.999999, step.value));
        onProgress?.(last); check(signal);
      }
      if (signal && performance.now() - lastTurn >= 8) {
        await new Promise(resolve => typeof setImmediate === 'function' ? setImmediate(resolve) : setTimeout(resolve, 0));
        lastTurn = performance.now();
      }
    }
  } catch (reason) { failed = true; throw reason; }
  finally {
    try { await iterator.return?.(); } catch (reason) { if (!failed) throw reason; }
  }
}
