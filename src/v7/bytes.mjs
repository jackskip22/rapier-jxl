import {fail as error} from './primitives.mjs';
const bufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get;
const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype);
export const typedFields = Object.fromEntries(['buffer', 'byteOffset', 'byteLength'].map(key => [key, Object.getOwnPropertyDescriptor(typedPrototype, key).get]));
export const typedName = Object.getOwnPropertyDescriptor(typedPrototype, Symbol.toStringTag).get;
export function arrayBufferBytes(value) {
  try { return bufferLength.call(value); } catch { return null; }
}
export function encodedByteLength(value, allowEmpty = false) {
  if (typedName.call(value) !== 'Uint8Array' || arrayBufferBytes(typedFields.buffer.call(value)) === null ||
      !allowEmpty && typedFields.byteLength.call(value) === 0)
    throw error('JXL_INPUT', 'Encoded input must be a nonempty Uint8Array with an ordinary ArrayBuffer.');
  return typedFields.byteLength.call(value);
}
export function copyBytes(value, allowEmpty = false) {
  encodedByteLength(value, allowEmpty);
  return new Uint8Array(value);
}
