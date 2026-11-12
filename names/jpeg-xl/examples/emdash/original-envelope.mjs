// An ordinary JPEG XL container with one private UUID box after its file-type box.
// Removing that box returns the independently verified payload byte-for-byte, including
// a final zero-length box. Ownership never depends on a filename or MIME claim alone.
const SIGNATURE = Uint8Array.of(0, 0, 0, 12, 74, 88, 76, 32, 13, 10, 135, 10);
const UUID = Uint8Array.of(0x65, 0x6d, 0x64, 0x61, 0x73, 0x68, 0x4a, 0x58, 0x8c, 0xb9, 0x2b, 0x8c, 0x77, 0x10, 0x83, 0x01);
export const ENVELOPE_BYTES = 40;
export const ENVELOPE_PREFIX_BYTES = 4096;
const equal = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);
const fail = () => Object.assign(new Error('Expected a JPEG XL container with a bounded file-type box.'), {code: 'JXL_INPUT'});
function insertion(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 20 || !equal(bytes.subarray(0, 12), SIGNATURE) ||
      String.fromCharCode(...bytes.subarray(16, 20)) !== 'ftyp') throw fail();
  const length = new DataView(bytes.buffer, bytes.byteOffset + 12, 4).getUint32(0);
  if (length < 16 || length > ENVELOPE_PREFIX_BYTES - 12 - ENVELOPE_BYTES || length + 12 > bytes.length) throw fail();
  return length + 12;
}
export function envelopeIdentity(prefix) {
  let offset;
  try { offset = insertion(prefix); } catch { return null; }
  const marker = prefix.subarray(offset, offset + ENVELOPE_BYTES);
  if (marker.length !== ENVELOPE_BYTES || new DataView(marker.buffer, marker.byteOffset, 4).getUint32(0) !== ENVELOPE_BYTES ||
      String.fromCharCode(...marker.subarray(4, 8)) !== 'uuid' || !equal(marker.subarray(8, 24), UUID)) return null;
  return {id: [...marker.subarray(24)].map(value => value.toString(16).padStart(2, '0')).join(''), offset};
}
export function wrapOriginal(payload, id) {
  if (!/^[a-f0-9]{32}$/.test(id ?? '') || envelopeIdentity(payload)) throw fail();
  const offset = insertion(payload), bytes = new Uint8Array(payload.length + ENVELOPE_BYTES);
  bytes.set(payload.subarray(0, offset));
  new DataView(bytes.buffer, offset, 4).setUint32(0, ENVELOPE_BYTES);
  bytes.set([117, 117, 105, 100], offset + 4);
  bytes.set(UUID, offset + 8);
  bytes.set(id.match(/../g).map(value => parseInt(value, 16)), offset + 24);
  bytes.set(payload.subarray(offset), offset + ENVELOPE_BYTES);
  return bytes;
}
export function unwrapOriginal(bytes, id, payloadBytes) {
  const marker = envelopeIdentity(bytes);
  if (!marker || marker.id !== id || bytes.length !== payloadBytes + ENVELOPE_BYTES)
    throw Object.assign(new Error('The stored original does not match its ownership record.'), {code: 'JXL_INPUT'});
  const payload = new Uint8Array(payloadBytes);
  payload.set(bytes.subarray(0, marker.offset));
  payload.set(bytes.subarray(marker.offset + ENVELOPE_BYTES), marker.offset);
  return payload;
}
