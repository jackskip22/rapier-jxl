// SPDX-License-Identifier: MIT
export const KEY = 77;
export const storedWasmByte = byte => byte === 65 ? 119 : byte === 119 ? 65 : byte;
export const wasmBytes = text => Uint8Array.from(text, c => storedWasmByte(c.charCodeAt(0) ^ KEY));
export const interfaceOf = exports => { let h = 2166136261; for (const c of exports.map(e => e.name + ':' + e.kind).sort().join(' ')) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return (h >>> 0).toString(36); };
