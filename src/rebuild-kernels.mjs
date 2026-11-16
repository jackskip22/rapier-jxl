// SPDX-License-Identifier: MIT
import {wasmModule, hasWasmModule, compileWasm} from './wasm-modules.mjs';
import {wasmBytes} from './wasm-text.mjs';
import {REBUILD_KERNELS} from './rebuild-kernels-bytes.mjs';
import {createKernelEngine} from './kernel-engine.mjs';
import {fault} from './fault.mjs';

export const REBUILD_EXPORTS = Object.freeze(['memory', 'dequant', 'cfl', 'cfl64', 'llf', 'lfPrepare',
  'idct', 'idct8', 'small', 'store', 'block8', 'gabRows', 'epf', 'upsample', 'xyb', 'srgb8Build', 'srgb8', 'rgba']);
let engine;
export const prepareRebuildKernels = () => hasWasmModule('decode') || compileWasm('rebuild', () => wasmBytes(REBUILD_KERNELS));
export const rebuildKernels = () => engine ??= createKernelEngine(() => hasWasmModule('decode')
  ? wasmModule('decode', () => { throw fault('JXL_INTERNAL', 'unreachable'); }) : wasmModule('rebuild', () => wasmBytes(REBUILD_KERNELS)));
