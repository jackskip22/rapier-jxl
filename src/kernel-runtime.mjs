// SPDX-License-Identifier: MIT
import {KERNELS, SIMD_PROBE} from './kernels-bytes.mjs';
import {wasmBytes} from './wasm-text.mjs';
import {wasmModule, compileWasm, hasWasmModule, suppliedWasm} from './wasm-modules.mjs';

export const kernelsSupported = () => typeof WebAssembly === 'object' &&
  new Uint8Array(new Uint32Array([1]).buffer)[0] === 1 &&
  (hasWasmModule('kernels') || !suppliedWasm() && WebAssembly.validate(wasmBytes(SIMD_PROBE)));
export const kernelModule = () => wasmModule('kernels', () => wasmBytes(KERNELS));
export const compileKernels = () => compileWasm('kernels', () => wasmBytes(KERNELS));
