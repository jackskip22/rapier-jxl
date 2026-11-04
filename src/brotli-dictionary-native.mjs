// SPDX-License-Identifier: MIT
import {fault} from './fault.mjs';

const BITS = [0, 0, 0, 0, 10, 10, 11, 11, 10, 10, 10, 10, 10, 9, 9, 8, 7, 7, 8, 7, 7, 6, 6, 5, 5];
const COPY_BASE = [2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 18, 22], COPY_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 3];
const SIZE = 122784, FNV = 0xcdde6419;

function stream() {
  const bytes = new Uint8Array(24576);
  let size = 0, held = 0, pending = 0, at = 0;
  const put = (value, count) => {
    pending |= value << held; held += count;
    for (; held >= 8; held -= 8) { bytes[size++] = pending & 255; pending >>>= 8; }
  };
  put(1, 1); put(7, 3);
  for (let length = 4; length <= 24; length++) {
    let code = COPY_BASE.length - 1;
    while (COPY_BASE[code] > length) code--;
    const words = 1 << BITS[length], copy = length - COPY_BASE[code], copyBits = COPY_EXTRA[code], command = code < 8 ? 128 + code : 184 + code;
    for (let index = 0; index < words;) {
      const x = at + index + 4, extra = 30 - Math.clz32(x), high = (x >> extra) & 1, base = (2 + high) << extra;
      const count = Math.min(words - index, Math.ceil((base + (1 << extra) - x) / (length + 1)));
      const block = count * length, last = length === 24 && index + count === words;
      const nibbles = Math.max(4, Math.ceil((32 - Math.clz32(block - 1)) / 4));
      put(last ? 1 : 0, 1); if (last) put(0, 1);
      put(nibbles - 4, 2); put(block - 1, nibbles * 4);
      if (!last) put(0, 1);
      put(0, 1); put(0, 1); put(0, 1); put(0, 6); put(0, 2); put(0, 1); put(0, 1);
      put(1, 2); put(0, 2); put(0, 8); put(1, 2); put(0, 2); put(command, 10); put(1, 2); put(0, 2); put(16 + 2 * (extra - 1) + high, 6);
      for (let i = 0; i < count; i++, index++, at += length) { put(copy, copyBits); put(at + index + 4 - base, extra); }
    }
  }
  if (held) bytes[size++] = pending;
  return bytes.subarray(0, size);
}

let words;
export function brotliDictionary() {
  if (words) return words;
  let bytes;
  try {
    const inflate = globalThis.process?.getBuiltinModule?.('node:zlib')?.brotliDecompressSync;
    if (typeof inflate !== 'function') throw new Error('no node:zlib brotliDecompressSync');
    bytes = new Uint8Array(inflate(stream(), {maxOutputLength: SIZE}));
  } catch (cause) {
    throw Object.assign(fault('JXL_DICTIONARY', 'This runtime has no Brotli decoder for RFC 7932\'s dictionary.'), {cause});
  }
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) hash = Math.imul(hash ^ bytes[i], 16777619) >>> 0;
  if (bytes.length !== SIZE || hash !== FNV) throw fault('JXL_DICTIONARY', 'This runtime\'s Brotli decoder returned a different dictionary.');
  return words = bytes;
}
