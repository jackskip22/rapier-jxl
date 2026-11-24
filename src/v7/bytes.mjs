import {fail as error, typedName, typedFields, arrayBufferBytes} from './primitives.mjs';
export {typedName, typedFields, arrayBufferBytes};
const DATA_VIEW = ['buffer', 'byteOffset', 'byteLength'].map(key => Object.getOwnPropertyDescriptor(DataView.prototype, key).get);
const typedAt = Object.getPrototypeOf(Uint8Array.prototype).at;
export function liveView(value) {
  try {
    if (!typedName.call(value)) return DATA_VIEW.map(get => get.call(value));
    typedAt.call(value, 0);
    return [typedFields.buffer, typedFields.byteOffset, typedFields.byteLength].map(get => get.call(value));
  } catch { return null; }
}
function region(value) {
  if (!ArrayBuffer.isView(value)) { const length = arrayBufferBytes(value); return length === null ? null : [value, 0, length]; }
  return liveView(value);
}
const NOT_BYTES = "encoded bytes: nonempty attached ArrayBuffer or view";
export function encodedByteLength(value, allowEmpty = false) {
  const bytes = region(value);
  if (!bytes || arrayBufferBytes(bytes[0]) === null || !allowEmpty && bytes[2] === 0) throw error('JXL_INPUT', NOT_BYTES);
  return bytes[2];
}
const BOX = [0, 0, 0, 12, 74, 88, 76, 32, 13, 10, 135, 10];
export function admitSignature(bytes, code) {
  if (!(bytes[0] === 255 && bytes[1] === 10) && !(bytes.length >= 12 && BOX.every((byte, i) => bytes[i] === byte))) throw error(code, "not JPEG XL: invalid signature");
}
export function copyBytes(value, allowEmpty = false) {
  const length = encodedByteLength(value, allowEmpty), [buffer, offset] = region(value);
  try { return new Uint8Array(buffer, offset, length).slice(); }
  catch { throw error('JXL_INPUT', "encoded bytes: attached ArrayBuffer or view"); }
}
export function viewBytes(value, allowEmpty = false) {
  const length = encodedByteLength(value, allowEmpty), [buffer, offset] = region(value);
  try { return new Uint8Array(buffer, offset, length); }
  catch { throw error('JXL_INPUT', "buffer: attached ArrayBuffer"); }
}
