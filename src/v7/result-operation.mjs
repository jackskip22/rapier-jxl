// SPDX-License-Identifier: MIT
import {imageResult} from './result.mjs';
import {DRIVE} from './drive.mjs';
import {check, fail, object, progressOf, callers, declared} from './primitives.mjs';
import {own} from './ownership.mjs';

import {RESULT_REFERENCE, RAW_OPERATION} from './result-reference.mjs';
export {RESULT_REFERENCE, RAW_OPERATION, resultReference, resultFacts} from './result-reference.mjs';

const CALL_FIELDS = ['fidelity', 'effort', 'features', 'readAs', 'webgpu', 'maxPixels', 'maxBytes', 'icc',
  'signal', 'onProgress', 'onPreview', 'onEncoded', 'exactRects', 'photoRects', 'textComplete', 'outputs'];
export function completionOptions(given, capture = false) {
  const supplied = object(given), options = {...supplied};
  for (const key of CALL_FIELDS) if (!Object.hasOwn(options, key) && key in supplied) options[key] = supplied[key];
  const {signal, onProgress, onPreview, onEncoded} = options;
  if (onProgress !== undefined && typeof onProgress !== 'function') throw fail('JXL_OPTIONS', 'onProgress must be a function.');
  if (onPreview !== undefined && typeof onPreview !== 'function') throw fail('JXL_OPTIONS', 'onPreview must be a function.');
  if (onEncoded !== undefined && typeof onEncoded !== 'function') throw fail('JXL_OPTIONS', 'onEncoded must be a function.');
  const progress = progressOf(onProgress, signal);
  let encoded;
  if (onProgress) options.onProgress = fraction => { if (fraction < 1) progress(Math.min(0.999, fraction)); };
  if (onEncoded || capture) options.onEncoded = record => { encoded = record; };
  return {options, get encoded() { return encoded; }, finish() {
    check(signal);
    if (onEncoded && encoded !== undefined) { try { onEncoded(encoded); } catch (error) { throw callers(error); } }
    check(signal); progress?.(1); check(signal);
  }};
}

export const resultOperation = (raw, options) => resultOperationWith(imageResult, raw, options);
export function resultOperationWith(record, raw, {format = 'jxl', fidelity: defaultFidelity = {quality: 90}, kept, capture = false, preview: previewCall} = {}) {
  const invoke = async (input, given, helpers, call) => {
    const completion = completionOptions(given, capture), options = completion.options;
    call.signal = options.signal;
    const fidelity = own(options.fidelity ?? defaultFidelity), readAs = options.readAs;
    let reference;
    const facts = {...(kept && {kept})};
    const preview = previewCall?.(options, () => { const {width, height, orientation} = reference ?? {}; return {width, height, orientation}; });
    options[RESULT_REFERENCE] = (picture, _original, recorded) => {
      if (picture !== undefined) {
        reference = Number.isSafeInteger(picture.width) && Number.isSafeInteger(picture.height)
          ? {width: picture.width, height: picture.height, ...(picture.orientation !== undefined && {orientation: picture.orientation})} : picture;
      }
      if (recorded) Object.assign(facts, recorded);
    };
    try {
      const run = helpers && raw[DRIVE];
      const bytes = await (run ? run(input, options, helpers) : raw(input, options));
      check(options.signal);
      if (!reference) throw fail('JXL_INTERNAL', 'The image job did not retain its admitted dimensions.');
      if (capture) facts.kept = completion.encoded?.exact ? 'pixels' : 'lossy';
      const result = await record(bytes, reference, {fidelity, format, readAs, ...facts, signal: options.signal, owned: true});
      if (result.bytes) preview?.offer(bytes, {width: result.width, height: result.height, measurements: result.measurements});
      completion.finish();
      return result;
    } finally { preview?.close(); }
  };
  const settle = (input, options, helpers) => {
    const call = {};
    return invoke(input, options, helpers, call).catch(error => {
      throw call.signal?.aborted && error === call.signal.reason ? error : declared(error);
    });
  };
  const operation = (input, options) => settle(input, options);
  operation[RAW_OPERATION] = raw;
  operation[DRIVE] = (input, options, helpers) => settle(input, options, helpers);
  return operation;
}
