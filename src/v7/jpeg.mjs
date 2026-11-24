import './engines.mjs';
import {decodeJpegPixels, JPEG_PIXELS_SYMBOL} from '../jpeg-scaled-decode.mjs';
import {resultOperation, resultReference, resultFacts} from './result-operation.mjs';
import {ansTranscodeSteps} from '../jpeg-ans-effort.mjs';
import {restoreJPEG} from '../jpeg-reconstruction.mjs';
import {longTail} from '../jpeg-tail.mjs';
import {promotedGainMap} from '../gain-map-xmp.mjs';
import {brotliDictionary} from '../brotli-dictionary.mjs';
import {ensureKernels, prepareKernels} from '../kernels.mjs';
import {kernelHooks} from '../kernel-hooks.mjs';
import {wasmRequired} from '../capture-wasm-error.mjs';
import {jpegDimensions, jpegBlobDimensions} from './input.mjs';
import {LIMITS} from '../limits.mjs';
import {copyBytes, encodedByteLength, viewBytes, admitSignature} from './bytes.mjs';
import {bytes, check, fail, declared, snapshotOptions, dimensions, pixelLimit, NO_JPEG, admitKeys, callHooks, blobBytes, preparedAlone, isBlob} from './primitives.mjs';
import {pictureSize} from './jpeg-size.mjs';
import {recompressSteps, restoreSteps, STEPS, jpegSettings} from './jpeg-steps.mjs';
import {withArenaLease} from '../call-scope.mjs';
import './preparation-jpeg.mjs';

const pixelBound = pixelLimit;
const settle = run => run.catch(error => { throw declared(error); });
async function kernels() {
  if (!await prepareKernels() || !ensureKernels() || !kernelHooks.acGroup) throw wasmRequired();
}
const prepare = preparedAlone(async () => { try { await kernels(); } catch (error) { throw declared(error); } });
export async function supported(feature) {
  if (feature === 'webgpu') return false;
  if (feature !== undefined) throw fail('JXL_OPTIONS', "supported(): no argument or 'webgpu'");
  try { await kernels(); return true; } catch { return false; }
}

async function drain(steps, {signal, progress}) {
  let told = 0, turn = performance.now(), failed = false;
  try {
    for (;;) {
      check(signal);
      const step = steps.next();
      if (step.done) { progress(1); await progress.finish?.(); check(signal); return step.value ?? steps.bytes; }
      if (typeof step.value === 'number' && step.value > told && step.value < 1) { told = step.value; progress(told); check(signal); }
      if (performance.now() - turn >= 8) { await new Promise(resolve => setTimeout(resolve, 0)); turn = performance.now(); }
    }
  } catch (error) { failed = true; throw error; }
  finally { try { steps.return?.(); } catch (error) { if (!failed) throw error; } }
}
async function owned(input, signal, admit, maxPixels) {
  if (isBlob(input)) {
    if (maxPixels !== undefined) await jpegBlobDimensions(input, maxPixels, signal, LIMITS.edge);
    const read = await blobBytes(input, signal); admit(bytes(read)); return read;
  }
  encodedByteLength(input);
  admit(viewBytes(input));
  return copyBytes(input);
}

const recompress = resultOperation((input, options) => settle(recompressHere(input, options)), {fidelity: 'exact', kept: 'jpeg-bytes'});
Object.defineProperty(recompress, STEPS, {value: recompressSteps(kernels)});
function recompressHere(input, options) {
  try {
    const settings = snapshotOptions(options);
    admitKeys(settings, ['effort', 'maxPixels', 'gainMap', 'signal', 'onProgress']);
    if (settings.gainMap !== undefined && typeof settings.gainMap !== 'boolean')
      throw fail('JXL_OPTIONS', 'gainMap: boolean');
    const {signal} = settings, run = callHooks(settings), effort = jpegSettings(settings), maxPixels = pixelBound(settings.maxPixels);
    let otherDecoders;
    const coding = {effort, maxPixels, ...(settings.gainMap === true && {gainMap: promotedGainMap}), tails: longTail, outside: missing => { otherDecoders = {missing, reason: 'past-jbrd'}; }};
    check(signal);
    const pending = owned(input, signal, view => jpegDimensions(view, maxPixels, LIMITS.edge), maxPixels);
    return (async () => {
      const jpeg = await pending;
      resultReference(settings, jpeg);
      jpegDimensions(jpeg, maxPixels, LIMITS.edge);
      const file = await withArenaLease(signal, async () => {
        await kernels();
        check(signal);
        return drain(ansTranscodeSteps(jpeg, coding), run);
      });
      if (otherDecoders) resultFacts(settings, {otherDecoders});
      return file;
    })();
  } catch (error) { return Promise.reject(error); }
}

const restore = resultOperation((input, options) => settle(restoreHere(input, options)), {format: 'jpeg', fidelity: 'exact', kept: 'jpeg-bytes'});
Object.defineProperty(restore, STEPS, {value: restoreSteps});
Object.defineProperty(restore, Symbol.for('rapier-jxl.verify.source'), {value: recompress[STEPS]});
Object.defineProperty(recompress, JPEG_PIXELS_SYMBOL, {value: decodeJpegPixels});
async function restoreHere(input, options) {
  const settings = snapshotOptions(options);
  admitKeys(settings, ['maxPixels', 'signal', 'onProgress']);
  const {signal} = settings, run = callHooks(settings), maxPixels = pixelBound(settings.maxPixels);
  check(signal);
  input = await owned(input, signal, view => {
    admitSignature(view, 'JXL_INPUT');
    const size = pictureSize(view);
    if (size) dimensions(size.width, size.height, maxPixels);
    if (view[0] === 255 && view[1] === 10) throw fail('JXL_RECONSTRUCTION', NO_JPEG);
  });
  resultReference(settings, input);
  const result = await withArenaLease(signal, () => restoreJPEG(input, brotliDictionary, {maxPixels}));
  if (!result) throw fail('JXL_RECONSTRUCTION', NO_JPEG);
  check(signal); run.progress(1); await run.progress.finish?.(); check(signal);
  return result;
}

import * as self from './jpeg.mjs';
import {serveRole} from './module-roles.mjs';
import {moduleRuntime} from './module-runtime.mjs';
import {install, workerPort} from './worker-runtime.mjs';
serveRole('rapier-jxl/jpeg', {worker: () => install(workerPort(), [], moduleRuntime(self, {name: 'rapier-jxl/jpeg'}))});

import {inPlace} from './module-roles.mjs';
const here = inPlace('rapier-jxl/jpeg', {recompress, restore, prepare}, {url: () => new URL(import.meta.url)});
const recompressIn = here.wrap('recompress'), restoreIn = here.wrap('restore'), prepareIn = here.wrap('prepare');
export {recompressIn as recompress, restoreIn as restore, prepareIn as prepare};
export const {configure, close} = here;
