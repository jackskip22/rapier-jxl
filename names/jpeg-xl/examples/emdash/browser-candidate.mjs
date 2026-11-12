// SPDX-License-Identifier: MIT
import {digest} from './digest.mjs';

const PART_BYTES = 1024 * 1024, MAX_BYTES = 8 * PART_BYTES;
const fail = (code, message) => Object.assign(new Error(message), {code});

// Upload storage is separate from evidence. Only the public verifier may turn these untrusted candidate bytes
// and claims into a publication receipt; neither a browser receipt nor a hash proves image preservation.
export async function stageCandidate(store, result, {signal} = {}) {
  signal?.throwIfAborted();
  if (!store || typeof store.write !== 'function' || !(result?.bytes instanceof Uint8Array) ||
      result.bytes.byteLength < 2 || result.bytes.byteLength > MAX_BYTES || result.fits !== true || result.format !== 'jxl')
    throw fail('JXL_INPUT', 'Expected a JPEG XL candidate of at most 8 MiB.');
  const {bytes, verification: ignoredReceipt, ...metadata} = result;
  const record = JSON.parse(JSON.stringify(metadata));
  const parts = [];
  for (let offset = 0; offset < bytes.byteLength; offset += PART_BYTES) {
    signal?.throwIfAborted();
    const part = bytes.slice(offset, offset + PART_BYTES), ref = {hash: await digest(part), length: part.byteLength};
    await store.write(ref, part);
    parts.push(ref);
  }
  signal?.throwIfAborted();
  return {parts, byteLength: bytes.byteLength, result: record};
}
