// SPDX-License-Identifier: MIT
export const KEY = 77;
export const storedWasmByte = byte => byte === 65 ? 119 : byte === 119 ? 65 : byte;

export function storedWasmText(bytes) {
  if (bytes[0] !== 0) throw new Error('A Wasm module must start with a zero byte');
  const stored = new Uint8Array(bytes.length);
  let left = 0, right = bytes.length - 1, grouped = false;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    stored[left++] = storedWasmByte(byte);
    if (byte >= 32 && byte <= 34 && i + 1 < bytes.length) {
      stored[right--] = storedWasmByte(bytes[++i]);
      grouped = true;
    }
  }
  const clean = key => stored.every((b, i) => b !== key || i + 1 === stored.length ||
    (stored[i + 1] ^ key) < 48 || (stored[i + 1] ^ key) > 57);
  const key = clean(KEY) ? KEY : Array.from({length: 95}, (_, i) => 32 + i).find(k => k !== 34 && k !== 92 && clean(k));
  if (key === undefined) throw new Error('The stored Wasm has a NUL before a digit under every key');
  for (let i = 0; i < stored.length; i++) stored[i] ^= key;
  if (grouped) stored[0] |= 128;
  return Buffer.from(stored).toString('latin1');
}

export const wasmBytes = text => {
  const n = text.length, bytes = new Uint8Array(n), tag = text.charCodeAt(0), key = tag & 127;
  if (tag < 128) {
    for (let i = 0; i < n; i++) bytes[i] = storedWasmByte(text.charCodeAt(i) ^ key);
    return bytes;
  }
  const table = new Uint16Array(256);
  for (let i = 0; i < table.length; i++) {
    const byte = storedWasmByte(i);
    table[i ^ key] = byte | (byte >= 32 && byte <= 34 ? 256 : 0);
  }
  let out = 1, left = 1, right = n - 1;
  while (left < right) {
    const entry = table[text.charCodeAt(left++)], take = entry >>> 8;
    bytes[out] = entry;
    bytes[out + 1] = table[text.charCodeAt(right)];
    out += 1 + take;
    right -= take;
  }
  if (left === right) bytes[out] = table[text.charCodeAt(left)];
  return bytes;
};
export const interfaceOf = exports => { let h = 2166136261; for (const c of exports.map(e => e.name + ':' + e.kind).sort().join(' ')) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return (h >>> 0).toString(36); };
