import {imageResult, missedResult} from './result.mjs';
// SPDX-License-Identifier: MIT
import {fail} from './primitives.mjs';
import {RESULT_REFERENCE} from './result-reference.mjs';

export async function preparedEncode(encode, picture, options) {
  const facts = {};
  const bytes = await encode(picture, {...options, [RESULT_REFERENCE]: (_picture, _source, reported) => {
    if (reported) Object.assign(facts, reported);
  }});
  return {bytes, ...facts};
}

export function preparedResult(bytes, fidelity, {width, height}, reconstruction) {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength) throw fail('JXL_INTERNAL', 'The encoder must return a nonempty Uint8Array.');
  return {fits: true, bytes, width, height, fidelity, ...(reconstruction && {reconstruction})};
}

export function finishPrepared(result, reference, options) {
  return result.bytes ? imageResult(result.bytes, reference, {...options, fidelity: result.fidelity,
    kept: result.kept ?? (result.reconstruction === 'jpeg' ? 'jpeg-bytes' : undefined), measurements: result.measurements, owned: true})
    : missedResult(reference, {...options, owned: true});
}
