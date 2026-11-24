// SPDX-License-Identifier: MIT
import {withinCall} from '../call-scope.mjs';
import {imageResult} from './result.mjs';
import {DRIVE} from './drive.mjs';
import {check, fail, snapshotOptions, progressOf, declared} from './primitives.mjs';
import {own} from './ownership.mjs';
import {isPlainRecord} from './records.mjs';
import {CAPTURE_RECORD} from './capture-facts.mjs';
import {publicVocabulary} from './encode-options.mjs';

import {RESULT_REFERENCE, RAW_OPERATION, PROFILE_NAMED, DEVICE_RAN, keptOf} from './result-reference.mjs';
export {RESULT_REFERENCE, RAW_OPERATION, resultReference, resultFacts} from './result-reference.mjs';

const CALL_FIELDS = ['fidelity', 'effort', 'progressive', 'firstRegion', 'readAs', 'jpeg', 'webgpu', 'maxPixels', 'maxBytes', 'icc',
  'signal', 'onProgress', 'onPreview', 'exactRects', 'photoRects', 'textComplete', 'withoutText', 'outputs'];
function snapshotFidelity(value) {
  if (!isPlainRecord(value)) return value;
  const fid = snapshotOptions(value, 'fidelity', [], true);
  if (isPlainRecord(fid.quality)) fid.quality = snapshotOptions(fid.quality, 'quality', [], true);
  return fid;
}
export function completionOptions(given, capture = false) {
  let options = snapshotOptions(given, undefined, [...CALL_FIELDS, 'features']);
  if ('features' in options) throw fail('JXL_OPTIONS', 'unknown option: features');
  if ('fidelity' in options) options.fidelity = snapshotFidelity(options.fidelity);
  options = publicVocabulary(options);
  const {signal, onProgress, onPreview} = options;
  if (onProgress !== undefined && typeof onProgress !== 'function') throw fail('JXL_OPTIONS', 'onProgress: function');
  if (onPreview !== undefined && typeof onPreview !== 'function') throw fail('JXL_OPTIONS', 'onPreview: function');
  const progress = progressOf(onProgress, signal);
  let encoded;
  if (onProgress) options.onProgress = fraction => { if (fraction < 1) progress(Math.min(0.999, fraction)); };
  if (capture) options[CAPTURE_RECORD] = record => { encoded = record; };
  return {options, get encoded() { return encoded; }, finish() {
    check(signal);
    progress?.(1); check(signal);
    return progress?.finish();
  }};
}

export const resultOperation = (typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) ? null : (raw, options) => resultOperationWith(imageResult, raw, options);
export function resultOperationWith(record, raw, {format = 'jxl', fidelity: defaultFidelity = {quality: 90}, kept, capture = false, preview: previewCall, device = false} = {}) {
  const invoke = async (input, completion, helpers) => {
    const options = completion.options, readAs = options.readAs;
    let reference, readSpace;
    const facts = {...(kept && {kept}), ...(device && {usedWebGPU: false})};
    const preview = previewCall?.(options, () => { const {width, height, orientation} = reference ?? {}; return {width, height, orientation}; });
    options[RESULT_REFERENCE] = (picture, _original, recorded) => {
      if (picture !== undefined) {
        if (picture?.colorSpace === 'srgb' || picture?.colorSpace === 'display-p3') readSpace = picture.colorSpace;
        reference = Number.isSafeInteger(picture.width) && Number.isSafeInteger(picture.height)
          ? {width: picture.width, height: picture.height, ...(picture.orientation !== undefined && {orientation: picture.orientation})} : picture;
      }
      if (recorded) Object.assign(facts, recorded);
    };
    if (device) options[DEVICE_RAN] = () => { facts.usedWebGPU = true; };
    try {
      const run = helpers && raw[DRIVE];
      const bytes = await (run ? run(input, options, helpers) : raw(input, options));
      const fidelity = own(options.fidelity ?? defaultFidelity);
      check(options.signal);
      if (!reference) throw fail('JXL_INTERNAL', 'result-operation:dimensions');
      if (capture) {
        facts.kept = completion.encoded?.exact ? 'pixels' : 'lossy';
        if (completion.encoded?.textMarks) facts.textMarks = completion.encoded.textMarks;
      }
      if (facts.kept !== undefined) facts.kept = keptOf(facts);
      delete facts[PROFILE_NAMED];
      const result = await record(bytes, reference, {fidelity, format, readAs: readAs && (readSpace ?? readAs), ...facts, signal: options.signal, owned: true});
      if (result.bytes) preview?.offer(bytes, {width: result.width, height: result.height, measurements: result.measurements});
      await completion.finish();
      await preview?.finish();
      return result;
    } finally { preview?.close(); }
  };
  const settle = (input, given, helpers) => {
    let completion;
    return withinCall(() => invoke(input, completion = completionOptions(given, capture), helpers))
      .then(result => { check(completion.options.signal); return result; }, error => {
        let reason; try { reason = completion?.options?.signal?.reason; } catch {}
        throw error !== undefined && error === reason ? error : declared(error);
      });
  };
  const operation = (input, options) => settle(input, options);
  operation[RAW_OPERATION] = raw;
  operation[DRIVE] = (input, options, helpers) => settle(input, options, helpers);
  return operation;
}
