// SPDX-License-Identifier: MIT
export const KEY = 77;
export const storedWasmByte = byte => byte === 65 ? 119 : byte === 119 ? 65 : byte;
export const wasmBytes = text => Uint8Array.from(text, c => storedWasmByte(c.charCodeAt(0) ^ KEY));
