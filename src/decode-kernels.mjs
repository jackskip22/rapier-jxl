// SPDX-License-Identifier: MIT
import {wasmModule} from './wasm-modules.mjs';
import {wasmBytes} from './wasm-text.mjs';
import {DECODE_KERNELS} from './decode-kernels-bytes.mjs';
import {createKernelEngine} from './kernel-engine.mjs';

let kernelEngine, streamEngine;
const module = () => wasmModule('decode', () => wasmBytes(DECODE_KERNELS));
export function decodeKernels() { return kernelEngine ??= createKernelEngine(module); }
export function streamKernels() { decodeKernels(); return streamEngine ??= createKernelEngine(module); }
