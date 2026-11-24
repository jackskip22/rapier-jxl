import {imageResult, missedResult} from './result.mjs';
// SPDX-License-Identifier: MIT
import {fail} from './primitives.mjs';
import {RESULT_REFERENCE, keptOf} from './result-reference.mjs';
import {PREVIEW} from './preview.mjs';

export async function preparedEncode(encode, picture, options) {
  const facts = {};
  const preview = options[PREVIEW];
  const bytes = await encode(picture, {...options, [RESULT_REFERENCE]: (_picture, _source, reported) => {
    if (reported) Object.assign(facts, reported);
  }, ...(preview && {[PREVIEW]: (bytes, details) => preview(bytes, {width: picture.width, height: picture.height, ...details})})});
  preview?.(bytes, {width: picture.width, height: picture.height, measurements: facts.measurements ?? []});
  return {bytes, ...facts};
}

export function preparedResult(bytes, fidelity, {width, height}, reconstruction) {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength) throw fail('JXL_INTERNAL', 'preparation-result:empty');
  return {meetsTarget: true, bytes, width, height, fidelity, ...(reconstruction && {reconstruction})};
}

export function finishPrepared(result, reference, options) {
  const settings = {...options, originalBytes: result.originalBytes ?? options.originalBytes};
  return result.bytes ? imageResult(result.bytes, reference, {...settings, fidelity: result.fidelity,
    kept: keptOf(result) ?? (result.reconstruction === 'jpeg' ? 'jpeg-bytes' : undefined), measurements: result.measurements,
    ...(result.otherDecoders && {otherDecoders: result.otherDecoders}), owned: true})
    : missedResult(reference, {...settings, owned: true});
}
