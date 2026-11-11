// SPDX-License-Identifier: MIT
import {wasmModule, hasWasmModule} from './wasm-modules.mjs';
import {wasmBytes} from './wasm-text.mjs';
import {REBUILD_KERNELS} from './rebuild-kernels-bytes.mjs';
import {createKernelEngine} from './kernel-engine.mjs';

export const REBUILD_EXPORTS = Object.freeze(['memory', 'dequant', 'cfl', 'cfl64', 'llf', 'lfPrepare',
  'idct', 'idct8', 'small', 'store', 'block8', 'gabRows', 'epf', 'xyb', 'srgb8Build', 'srgb8', 'rgba']);
let engine;
export const rebuildKernels = () => engine ??= createKernelEngine(() => hasWasmModule('decode')
  ? wasmModule('decode', () => { throw new Error('unreachable'); }) : wasmModule('rebuild', () => wasmBytes(REBUILD_KERNELS)));
