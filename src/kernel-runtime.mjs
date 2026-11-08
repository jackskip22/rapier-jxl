// SPDX-License-Identifier: MIT
import {KERNELS, SIMD_PROBE} from './kernels-bytes.mjs';
import {wasmBytes} from './wasm-text.mjs';
import {wasmModule, compileWasm, hasWasmModule, suppliedWasm} from './wasm-modules.mjs';

export const kernelsSupported = () => typeof WebAssembly === 'object' &&
  new Uint8Array(new Uint32Array([1]).buffer)[0] === 1 &&
  (hasWasmModule('kernels') || !suppliedWasm() && WebAssembly.validate(wasmBytes(SIMD_PROBE)));
export const kernelModule = () => wasmModule('kernels', () => wasmBytes(KERNELS));
export const compileKernels = () => compileWasm('kernels', () => wasmBytes(KERNELS));

const PAGES = 640;
let instance = null, holder = null;
const holders = [];
export function kernelInstance() {
  if (!instance) {
    const memory = new WebAssembly.Memory({initial: 48, maximum: PAGES});
    instance = {memory, exports: new WebAssembly.Instance(kernelModule(), {env: {memory}}).exports};
  }
  return instance;
}
export function arenaHolder(lose, refresh = null, gain = null) {
  const h = {lose, refresh, gain};
  holders.push(h);
  return h;
}
export function takeArena(h) {
  if (holder === h) return;
  const was = holder;
  holder = h;
  for (const other of holders) if (other !== h) other.lose();
  if (was) h.gain?.();
}
export function heldExports(exports, h) {
  const out = {};
  for (const [name, value] of Object.entries(exports)) out[name] = typeof value === 'function' ? (...args) => { takeArena(h); return value(...args); } : value;
  return out;
}
export function growArena(bytes) {
  const memory = kernelInstance().memory, have = memory.buffer.byteLength;
  if (bytes <= have) return;
  memory.grow(Math.ceil((bytes - have) / 65536));
  for (const h of holders) h.refresh?.();
}
