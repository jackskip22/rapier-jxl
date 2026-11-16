// SPDX-License-Identifier: MIT
import {ansTranscodeSteps} from '../jpeg-ans-effort.mjs';
import {longTail} from '../jpeg-tail.mjs';
import {JOURNAL_FILE} from '../step-journal.mjs';
import {jpegInfo, jpegBlobInfo, jpegDimensions} from './input-native.mjs';
import {jpegDisplayDimensions, jpegReconstruction} from './preparation-jpeg.mjs';
import {kernelsReady} from './kernels-ready.mjs';
import {drain} from './common.mjs';
import {resultReference, RESULT_REFERENCE} from './result-reference.mjs';
import {check, isCaller, progressOf, blobBytes} from './primitives.mjs';
import {jpegChoiceMode, jpegWins, jpegRequestedIntent} from './jpeg-choice-policy.mjs';
import {PREVIEW} from './preview.mjs';
import {jpegPixelsReady} from './jpeg-pixels.mjs';

export {JPEG_SOURCE} from './jpeg-choice-policy.mjs';

export function jpegSource(input, supplied) {
  if (supplied?.bytes !== undefined) return supplied.bytes;
  if (typeof Blob === 'function' && input instanceof Blob) return input;
  return input?.[JOURNAL_FILE];
}

export async function readJpegSource(source, {signal, maxPixels} = {}) {
  if (!source) return null;
  check(signal);
  const blob = typeof Blob === 'function' && source instanceof Blob;
  const head = blob ? await blobBytes(source, signal, 0, 2) : source.subarray?.(0, 2);
  check(signal);
  if (!(head instanceof Uint8Array) || head[0] !== 255 || head[1] !== 216) return null;
  let info;
  try { info = blob ? await jpegBlobInfo(source, maxPixels, signal) : jpegInfo(source, maxPixels); }
  catch (error) { check(signal); if (error?.code !== 'JXL_JPEG') throw error; }
  return {source, info, originalBytes: blob ? source.size : source.byteLength ?? source.length};
}

async function carryJpeg(bytes, effort, hooks) {
  check(hooks.signal);
  jpegDimensions(bytes, hooks.maxPixels);
  await kernelsReady(); check(hooks.signal);
  return drain(ansTranscodeSteps(bytes, {effort, maxPixels: hooks.maxPixels, tails: longTail}), hooks);
}

export async function chooseJpeg(source, codec, options, hooks, encodePixels) {
  const jpeg = await readJpegSource(source, hooks);
  if (!jpeg) return encodePixels(options);
  const mode = hooks.preserve === false ? 'pixels' : jpegChoiceMode(jpeg.info, codec, options);
  resultReference(options, undefined, undefined, {originalBytes: jpeg.originalBytes});
  if (mode === 'pixels') return encodePixels(options, jpeg.info);
  if (mode === 'weigh' && hooks.readsSource) jpegPixelsReady();
  const progress = progressOf(options.onProgress, hooks.signal);
  const split = mode === 'weigh' || hooks.maxBytes !== undefined;
  const share = hooks.probes ? 1 / hooks.probes : .25;
  const carrying = {...hooks, ...(progress && {onProgress: fraction => progress(split ? fraction * share : fraction)})};
  let original = jpeg.source, exact, refused;
  try {
    if (!(original instanceof Uint8Array)) original = typeof Blob === 'function' && original instanceof Blob
      ? await blobBytes(original, hooks.signal) : original.subarray(0, original.length);
    check(hooks.signal);
    exact = await (hooks.carry ?? carryJpeg)(original, codec.effort, carrying);
  } catch (error) {
    check(hooks.signal);
    if (isCaller(error) || error?.code !== 'JXL_JPEG') throw error;
    refused = error;
  }
  const kept = () => {
    const display = jpegDisplayDimensions(original, hooks.maxPixels);
    resultReference(options, display, original,
      {fidelity: 'exact', kept: jpegReconstruction(exact) ? 'jpeg-bytes' : 'pixels', meetsTarget: true,
        measurements: [], originalBytes: jpeg.originalBytes});
    options[PREVIEW]?.(exact, {...display, measurements: []});
    progress?.(1); check(hooks.signal);
    return exact;
  };
  if (mode === 'jpeg' && exact && (hooks.maxBytes === undefined || exact.byteLength <= hooks.maxBytes)) return kept();
  const facts = {}, reference = options[RESULT_REFERENCE];
  const settings = {...options, [RESULT_REFERENCE]: (picture, input, value) => {
    if (value) Object.assign(facts, value);
    reference?.(picture, input, value);
  }, ...(progress && split && {onProgress: hooks.probes ? progress : fraction => progress(share + fraction * (1 - share))})};
  let pixels;
  try { pixels = await encodePixels(settings, jpeg.info, 1); }
  catch (error) {
    check(hooks.signal);
    if (exact && (hooks.maxBytes === undefined || exact.byteLength <= hooks.maxBytes) && !isCaller(error) &&
        error?.code === 'JXL_TARGET') return kept();
    if (refused && error?.code === 'JXL_UNSUPPORTED' && !isCaller(error)) throw Object.assign(error, {cause: refused});
    if (refused && !isCaller(error) && typeof error?.code === 'string' && error.code.startsWith('JXL_'))
      throw Object.assign(refused, {cause: error});
    throw error;
  }
  return jpegWins(exact, pixels, facts, hooks.maxBytes, jpegRequestedIntent(codec)) ? kept() : pixels;
}
