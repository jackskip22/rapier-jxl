// SPDX-License-Identifier: MIT
import {JxlBits, requireDecode} from './decode-bits.mjs';
import {journaling, journalTool, sliceBytes} from './step-journal.mjs';
import {readPrefixCode, readPrefixSymbol} from './decode-entropy.mjs';
import {brotliReader} from './brotli-read.mjs';

const readerAt = (bytes, bit = 0) => { const r = new JxlBits(sliceBytes(bytes, 0), true); r.bit = bit; return r; };
function settings(bytes, {maxOutput = Number.MAX_SAFE_INTEGER, maxBlocks = Number.MAX_SAFE_INTEGER, dictionary} = {}) {
  requireDecode(bytes instanceof Uint8Array && Number.isSafeInteger(maxOutput) && maxOutput >= 0 &&
    Number.isSafeInteger(maxBlocks) && maxBlocks > 0, 'Brotli input or limit');
  let words;
  return {maxOutput, maxBlocks, dictionary() {
    if (words) return words;
    if (dictionary === undefined) throw Object.assign(new Error('needs RFC 7932 dictionary'), {code: 'JXL_DICTIONARY'});
    words = typeof dictionary === 'function' ? dictionary() : dictionary;
    requireDecode(words instanceof Uint8Array && words.length === 122784, 'dictionary: 122784-byte Uint8Array');
    return words;
  }};
}
const sharedBrotli = /* @__PURE__ */ brotliReader(readPrefixCode, readPrefixSymbol, requireDecode, blocks => {
  throw Object.assign(blocks ? new RangeError('Brotli: over maxBlocks') : new Error('Brotli: over maxOutput'), {code: 'JXL_LIMIT'});
}, readerAt, settings);

export const decompressBrotli = (bytes, options = {}) => sharedBrotli.read(bytes, options);
export function* decompressBrotliSteps(bytes, options = {}) {
  if (!journaling()) return decompressBrotli(bytes, options);
  return yield* journalTool('decodeBrotli')(bytes, options, sharedBrotli.owner);
}
