// SPDX-License-Identifier: MIT
import {wasmModule} from './wasm-modules.mjs';
import {wasmBytes} from './wasm-text.mjs';
import {DECODE_KERNELS} from './decode-kernels-bytes.mjs';
import {createKernelEngine} from './kernel-engine.mjs';

let kernelEngine, streamEngine;
const module = () => wasmModule('decode', () => wasmBytes(DECODE_KERNELS));
export function decodeKernels() { return kernelEngine ??= createKernelEngine(module); }
export function streamKernels() {
  decodeKernels();
  if (!streamEngine) {
    const engine = createKernelEngine(module), reserve = engine.reserve;
    engine.epoch = 0; engine.reserve = (sizes, from) => (engine.epoch++, reserve(sizes, from));
    streamEngine = engine;
  }
  return streamEngine;
}
export function trimDecodeKernels() {
  const held = (kernelEngine?.buffer.byteLength ?? 0) + (streamEngine?.buffer.byteLength ?? 0);
  if (held > 16777216 * 2) kernelEngine = streamEngine = undefined;
}
