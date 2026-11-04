// SPDX-License-Identifier: MIT
import {fail} from './primitives.mjs';

export function preparedResult(bytes, fidelity, {width, height}, reconstruction) {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength) throw fail('JXL_INTERNAL', 'The encoder must return a nonempty Uint8Array.');
  return {fits: true, bytes, width, height, fidelity, ...(reconstruction && {reconstruction})};
}
