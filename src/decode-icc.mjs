// SPDX-License-Identifier: MIT
import {requireDecode} from './decode-bits.mjs';
import {readEntropy, readEntropyModelSteps, entropyStream} from './decode-entropy.mjs';
import {journaling, journalTool} from './step-journal.mjs';
import {IccCursor, iccInverse} from './icc-profile.mjs';

function limit(value, maxBytes) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maxBytes)
    throw Object.assign(new RangeError('JPEG XL ICC profile exceeds its allocation limit.'), {code: 'JXL_LIMIT'});
}

function context(i, a, b) {
  if (i <= 128) return 0;
  const alpha = v => v >= 65 && v <= 90 || v >= 97 && v <= 122;
  const digit = v => v >= 48 && v <= 57 || v === 44 || v === 46;
  const first = alpha(a) ? 0 : digit(a) ? 1 : a < 2 ? 2 + a : a < 16 ? 4 : a === 255 ? 6 : a > 240 ? 5 : 7;
  const second = alpha(b) ? 0 : digit(b) ? 1 : b < 16 ? 2 : b > 240 ? 3 : 4;
  return 1 + first + 8 * second;
}

function iccLength(reader, maxBytes, maxProfileBytes) {
  limit(maxBytes, 0xffffffff);
  limit(maxProfileBytes, 0xffffffff);
  const start = reader.bit, size = reader.u64();
  limit(size, Math.min(maxBytes, maxProfileBytes + 65536));
  return {start, size, bit: reader.bit};
}
function entropyPart(reader, code, from, count, state, start) {
  const bytes = new Uint8Array(count); let {a, b} = state;
  for (let n = 0, i = from; n < count; n++, i++) {
    if (i >= 20 && (i & 65535) === 0) requireDecode(i <= (reader.bit - start) * 32, 'Invalid JPEG XL ICC expansion.', reader);
    const value = code.read(context(i, a, b)); requireDecode(value < 256, 'JPEG XL ICC entropy value exceeds one byte.', reader);
    bytes[n] = value; b = a; a = value;
  }
  return {bytes, a, b, bit: reader.bit};
}
function entropyPrefix(reader, code, head, maximum) {
  code.begin();
  const first = entropyPart(reader, code, 0, Math.min(head.size, 20), {a: 0, b: 0}, head.start);
  const preamble = new IccCursor(first.bytes, requireDecode), outputSize = preamble.integer(), commandSize = preamble.integer();
  limit(outputSize, maximum);
  requireDecode(commandSize <= head.size - preamble.at && head.size <= outputSize + 65536,
    'Invalid JPEG XL ICC preamble.', reader);
  return first;
}
export function readICC(reader, {maxBytes = 268435456, maxProfileBytes = maxBytes} = {}) {
  const head = iccLength(reader, maxBytes, maxProfileBytes), code = readEntropy(reader, 41, {values: head.size, byteHistory: true});
  let part = entropyPrefix(reader, code, head, maxProfileBytes);
  const bytes = new Uint8Array(head.size); bytes.set(part.bytes);
  for (let from = part.bytes.length; from < head.size; from += 65536) {
    part = entropyPart(reader, code, from, Math.min(65536, head.size - from), part, head.start); bytes.set(part.bytes, from);
  }
  code.finish();
  return decodeICC(bytes, {maxBytes: maxProfileBytes});
}
export function* readICCSteps(reader, {maxBytes = 268435456, maxProfileBytes = maxBytes} = {}) {
  if (!journaling()) return readICC(reader, {maxBytes, maxProfileBytes});
  return yield* journalTool('readICC')(reader, {maxBytes, maxProfileBytes}, {length: iccLength, model: readEntropyModelSteps,
    stream: entropyStream, prefix: entropyPrefix, part: entropyPart, decode: decodeICCSteps});
}

const sharedICC = /* @__PURE__ */ iccInverse(requireDecode, limit);
export const decodeICC = (bytes, {maxBytes = 268435456} = {}) => sharedICC.decode(bytes, maxBytes);
export function* decodeICCSteps(bytes, {maxBytes = 268435456} = {}) {
  if (!journaling()) return decodeICC(bytes, {maxBytes});
  return yield* journalTool('decodeICC')(bytes, {maxBytes}, sharedICC.owner);
}
