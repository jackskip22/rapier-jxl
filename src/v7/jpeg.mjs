import {ansTranscodeSteps} from '../jpeg-ans-effort.mjs';
import {restoreJPEG} from '../jpeg-reconstruction.mjs';
import {brotliDictionary} from '../brotli-dictionary.mjs';
import {configureKernels, prepareKernels} from '../kernels.mjs';
import {kernelHooks} from '../kernel-hooks.mjs';
import {wasmRequired} from '../capture-wasm-error.mjs';
import {jpegDimensions} from './input.mjs';
import {admitEffort} from '../effort-level.mjs';
import {copyBytes, encodedByteLength} from './bytes.mjs';
import {bytes, check, fail, declared, object, callers, dimensions} from './primitives.mjs';
import {header} from './inspect.mjs';
export {configureWasm} from '../wasm-modules.mjs';

function pixelBound(value) {
  if (value === undefined) return 40000000;
  if (!Number.isSafeInteger(value) || value < 1 || value > 40000000) throw fail('JXL_OPTIONS', 'maxPixels is a positive whole number, at most 40,000,000.');
  return value;
}
const settle = (run, options) => run.catch(error => { throw error === options?.signal?.reason ? error : declared(error); });
async function kernels() {
  if (!await prepareKernels() || configureKernels('auto') === 'off' || !kernelHooks.channel) throw wasmRequired();
}
export async function prepare() { try { await kernels(); } catch (error) { throw declared(error); } }
export async function supported(feature) {
  if (feature === 'webgpu') return false;
  if (feature !== undefined) throw fail('JXL_OPTIONS', "supported takes nothing, or 'webgpu'.");
  try { await kernels(); return true; } catch { return false; }
}

function hooks(options) {
  const {signal, onProgress} = options;
  if (onProgress !== undefined && typeof onProgress !== 'function') throw fail('JXL_OPTIONS', 'onProgress is a function.');
  return {signal, progress: fraction => { if (onProgress) try { onProgress(fraction); } catch (error) { throw callers(error); } }};
}
async function drain(steps, {signal, progress}) {
  let told = 0, turn = performance.now(), failed = false;
  try {
    for (;;) {
      check(signal);
      const step = steps.next();
      if (step.done) { progress(1); check(signal); return step.value ?? steps.bytes; }
      if (typeof step.value === 'number' && step.value > told && step.value < 1) { told = step.value; progress(told); check(signal); }
      if (performance.now() - turn >= 8) { await new Promise(resolve => setTimeout(resolve, 0)); turn = performance.now(); }
    }
  } catch (error) { failed = true; throw error; }
  finally { try { steps.return?.(); } catch (error) { if (!failed) throw error; } }
}
const MAX_INPUT_BYTES = 256 * 1024 * 1024;
async function owned(input, signal) {
  if (typeof Blob !== 'undefined' && input instanceof Blob) {
    if (input.size > MAX_INPUT_BYTES) throw fail('JXL_LIMIT', 'Encoded input exceeds 256 MiB.');
    const read = new Uint8Array(await input.arrayBuffer()); check(signal); return bytes(read);
  }
  if (encodedByteLength(input) > MAX_INPUT_BYTES) throw fail('JXL_LIMIT', 'Encoded input exceeds 256 MiB.');
  return copyBytes(input);
}

export const recompress = (input, options) => settle(recompressHere(input, options), options);
function recompressHere(input, options) {
  try {
    const settings = {...object(options)};
    for (const key of Object.keys(settings)) if (!['effort', 'icc', 'maxPixels', 'signal', 'onProgress'].includes(key))
      throw fail('JXL_OPTIONS', `Unknown JPEG option: ${key}.`);
    const {signal, icc} = settings, run = hooks(settings), effort = admitEffort(settings, 7), maxPixels = pixelBound(settings.maxPixels);
    if (icc !== undefined && icc !== 'preserve') throw fail('JXL_INPUT', 'JPEG ICC mode is preserve, or omitted for named-profile compatibility.');
    const coding = {effort, ...(icc !== undefined && {icc})};
    check(signal);
    const pending = owned(input, signal);
    return (async () => {
      const jpeg = await pending;
      jpegDimensions(jpeg, maxPixels);
      await kernels();
      check(signal);
      return drain(ansTranscodeSteps(jpeg, coding), run);
    })();
  } catch (error) { return Promise.reject(error); }
}

export const restore = (input, options) => settle(restoreHere(input, options), options);
async function restoreHere(input, options) {
  const settings = {...object(options)};
  for (const key of Object.keys(settings)) if (!['maxPixels', 'signal', 'onProgress'].includes(key)) throw fail('JXL_OPTIONS', `Unknown restore option: ${key}.`);
  const {signal} = settings, run = hooks(settings), maxPixels = pixelBound(settings.maxPixels);
  check(signal);
  input = await owned(input, signal);
  let size = null;
  try { size = header(input); } catch {}
  if (size) dimensions(size.width, size.height, maxPixels);
  if (input[0] === 255 && input[1] === 10) throw fail('JXL_RECONSTRUCTION', 'The file contains no JPEG reconstruction data.');
  const result = restoreJPEG(input, brotliDictionary, {maxPixels});
  if (!result) throw fail('JXL_RECONSTRUCTION', 'The file contains no JPEG reconstruction data.');
  check(signal); run.progress(1); check(signal);
  return result;
}
