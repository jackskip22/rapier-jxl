import {fail as error} from './primitives.mjs';
const bufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get;
const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype);
export const typedFields = Object.fromEntries(['buffer', 'byteOffset', 'byteLength'].map(key => [key, Object.getOwnPropertyDescriptor(typedPrototype, key).get]));
export const typedName = Object.getOwnPropertyDescriptor(typedPrototype, Symbol.toStringTag).get;
export function arrayBufferBytes(value) {
  if (ArrayBuffer.isView(value)) return null;
  try { return bufferLength.call(value); } catch { return null; }
}
export function encodedByteLength(value, allowEmpty = false) {
  if (typedName.call(value) !== 'Uint8Array' || arrayBufferBytes(typedFields.buffer.call(value)) === null ||
      !allowEmpty && typedFields.byteLength.call(value) === 0)
    throw error('JXL_INPUT', "Invalid encoded input; pass a nonempty Uint8Array on an attached ArrayBuffer.");
  return typedFields.byteLength.call(value);
}
const BOX = [0, 0, 0, 12, 74, 88, 76, 32, 13, 10, 135, 10];
export function admitSignature(bytes, code) {
  if (!(bytes[0] === 255 && bytes[1] === 10) && !(bytes.length >= 12 && BOX.every((byte, i) => bytes[i] === byte))) throw error(code, "Invalid JPEG XL signature; pass a JPEG XL file.");
}
export function copyBytes(value, allowEmpty = false) {
  encodedByteLength(value, allowEmpty);
  try { return new Uint8Array(value); }
  catch { throw error('JXL_INPUT', "Invalid encoded input; pass a Uint8Array on an attached ArrayBuffer."); }
}
export function viewBytes(value, allowEmpty = false) {
  const length = encodedByteLength(value, allowEmpty);
  try { return new Uint8Array(typedFields.buffer.call(value), typedFields.byteOffset.call(value), length); }
  catch { throw error('JXL_INPUT', "Input buffer is detached; pass bytes from an attached ArrayBuffer."); }
}
