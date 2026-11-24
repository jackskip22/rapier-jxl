// SPDX-License-Identifier: MIT
import {ansTranscodeSteps} from '../jpeg-ans-effort.mjs';
import {longTail} from '../jpeg-tail.mjs';
import {JOURNAL_FILE} from '../step-journal.mjs';
import {jpegInfo, jpegBlobInfo, jpegDimensions} from './input-native.mjs';
import {jpegDisplayDimensions, jpegReconstruction} from './preparation-jpeg.mjs';
import {kernelsReady} from './kernels-ready.mjs';
import {drain} from './common.mjs';
import {resultReference, RESULT_REFERENCE} from './result-reference.mjs';
import {check, isCaller, progressOf, blobBytes, isBlob} from './primitives.mjs';
import {jpegChoiceMode, jpegWins, jpegRequestedIntent} from './jpeg-choice-policy.mjs';
import {PREVIEW} from './preview.mjs';
import {jpegPixelsReady} from './jpeg-pixels.mjs';
import {withArenaLease} from '../call-scope.mjs';

export {JPEG_SOURCE} from './jpeg-choice-policy.mjs';

export function jpegSource(input, supplied) {
  if (supplied?.bytes !== undefined) return supplied.bytes;
  if (isBlob(input)) return input;
  return input?.[JOURNAL_FILE];
}

export async function readJpegSource(source, {signal, maxPixels} = {}) {
  if (!source) return null;
  check(signal);
  const blob = isBlob(source);
  const head = blob ? await blobBytes(source, signal, 0, 2) : source.subarray?.(0, 2);
  check(signal);
  if (!(head instanceof Uint8Array) || head[0] !== 255 || head[1] !== 216) return null;
  let info;
  try { info = blob ? await jpegBlobInfo(source, maxPixels, signal) : jpegInfo(source, maxPixels); }
  catch (error) { check(signal); if (error?.code !== 'JXL_JPEG') throw error; }
  return {source, info, originalBytes: blob ? source.size : source.byteLength ?? source.length};
}

async function carryJpeg(bytes, effort, hooks, belowBytes = 0) {
  check(hooks.signal);
  jpegDimensions(bytes, hooks.maxPixels);
  return withArenaLease(hooks.signal, async () => {
    await kernelsReady(); check(hooks.signal);
    const out = await drain(ansTranscodeSteps(bytes, {effort, maxPixels: hooks.maxPixels, tails: longTail, outside: hooks.outside, ...(belowBytes > 0 && {belowBytes})}), hooks);
    return belowBytes > 0 && !out.byteLength ? null : out;
  });
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
  let original = jpeg.source, exact, refused, otherDecoders;
  const carrying = {...hooks, outside: missing => { otherDecoders = {missing, reason: 'past-jbrd'}; },
    ...(progress && {onProgress: fraction => progress(split ? fraction * share : fraction)})};
  const kept = () => {
    const display = jpegDisplayDimensions(original, hooks.maxPixels);
    resultReference(options, display, original,
      {fidelity: 'exact', kept: jpegReconstruction(exact) ? 'jpeg-bytes' : 'pixels', meetsTarget: true,
        measurements: [], originalBytes: jpeg.originalBytes, ...(otherDecoders && {otherDecoders})});
    options[PREVIEW]?.(exact, {...display, measurements: []});
    progress?.(1); check(hooks.signal);
    return exact;
  };
  const facts = {}, reference = options[RESULT_REFERENCE];
  const settings = {...options, [RESULT_REFERENCE]: (picture, input, value) => {
    if (value) Object.assign(facts, value);
    reference?.(picture, input, value);
  }, ...(progress && split && {onProgress: hooks.probes ? progress : fraction => progress(share + fraction * (1 - share))})};
  const intent = jpegRequestedIntent(codec);
  if (mode === 'weigh' && !hooks.carry && hooks.maxBytes === undefined && !progress && !options[PREVIEW] && !hooks.journal) {
    try {
      if (!(original instanceof Uint8Array)) original = isBlob(original)
        ? await blobBytes(original, hooks.signal) : original.subarray(0, original.length);
      check(hooks.signal);
      jpegDimensions(original, hooks.maxPixels);
    } catch (error) {
      check(hooks.signal);
      if (isCaller(error) || error?.code !== 'JXL_JPEG') throw error;
      refused = error;
    }
    let pixels, pixelError, hasError = false;
    try { pixels = await encodePixels(settings, jpeg.info, 1); }
    catch (error) { check(hooks.signal); pixelError = error; hasError = true; }
    if (!refused) {
      const cap = !hasError && !jpegWins({byteLength: pixels.byteLength + 1}, pixels, facts, undefined, intent) ? pixels.byteLength : 0;
      try { exact = await carryJpeg(original, codec.effort, carrying, cap); }
      catch (error) {
        check(hooks.signal);
        if (isCaller(error) || error?.code !== 'JXL_JPEG') throw error;
        refused = error;
      }
    }
    if (hasError) {
      if (exact && !isCaller(pixelError) && pixelError?.code === 'JXL_TARGET') return kept();
      if (refused && pixelError?.code === 'JXL_UNSUPPORTED' && !isCaller(pixelError)) throw Object.assign(pixelError, {cause: refused});
      if (refused && !isCaller(pixelError) && typeof pixelError?.code === 'string' && pixelError.code.startsWith('JXL_'))
        throw Object.assign(refused, {cause: pixelError});
      throw pixelError;
    }
    return jpegWins(exact, pixels, facts, undefined, intent) ? kept() : pixels;
  }
  try {
    if (!(original instanceof Uint8Array)) original = isBlob(original)
      ? await blobBytes(original, hooks.signal) : original.subarray(0, original.length);
    check(hooks.signal);
    exact = await (hooks.carry ?? carryJpeg)(original, codec.effort, carrying);
  } catch (error) {
    check(hooks.signal);
    if (isCaller(error) || error?.code !== 'JXL_JPEG') throw error;
    refused = error;
  }
  if (mode === 'jpeg' && exact && (hooks.maxBytes === undefined || exact.byteLength <= hooks.maxBytes)) return kept();
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
  return jpegWins(exact, pixels, facts, hooks.maxBytes, intent) ? kept() : pixels;
}
