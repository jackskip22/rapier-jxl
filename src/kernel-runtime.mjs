// SPDX-License-Identifier: MIT
import {fault} from './fault.mjs';
import {KERNELS, SIMD_PROBE} from './kernels-bytes.mjs';
import {wasmBytes} from './wasm-text.mjs';
import {wasmModule, compileWasm, hasWasmModule} from './wasm-modules.mjs';

const validates = bytes => { try { return WebAssembly.validate(bytes); } catch { return false; } };
export const kernelsSupported = () => typeof WebAssembly === 'object' &&
  new Uint8Array(new Uint32Array([1]).buffer)[0] === 1 &&
  (hasWasmModule('kernels') || validates(wasmBytes(SIMD_PROBE)));
export const kernelModule = () => wasmModule('kernels', () => wasmBytes(KERNELS));
export const compileKernels = () => compileWasm('kernels', () => wasmBytes(KERNELS));

let instance = null, holder = null;

export const SH_ARGS = 65536, SH_LOG2 = SH_ARGS + 64, SH_SYM = SH_LOG2 + 4097 * 8, SH_LOGLEN = SH_SYM + 4097 * 8,
  SH_REPEATS = SH_LOGLEN + 64, SH_FREQS = SH_REPEATS + 64, SH_SCRATCH = SH_FREQS + 2048, SH_BEST = SH_SCRATCH + 24576,
  SHAPE_END = SH_SCRATCH + 28672;
const holders = [];
export function kernelInstance() {
  if (!instance) {
    const memory = new WebAssembly.Memory({initial: 48});
    instance = {memory, exports: new WebAssembly.Instance(kernelModule(), {env: {memory}}).exports};
  }
  return instance;
}
export const kernelFlat = () => { const i = kernelInstance(); return i.flat ??= {...i.exports, memory: i.memory}; };
export const kernelBuffer = () => instance?.memory.buffer ?? null;
export function arenaHolder(lose, refresh = null, gain = null, retire = null) {
  const h = {lose, refresh, gain, retire};
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
export function retireKernels() {
  if (!instance) return;
  for (const h of holders) { h.lose(); h.retire?.(); }
  instance = null; holder = null;
}
export function growArena(bytes) {
  const memory = kernelInstance().memory, have = memory.buffer.byteLength;
  if (bytes <= have) return;
  try { memory.grow(Math.ceil((bytes - have) / 65536)); }
  catch (cause) { throw Object.assign(fault('JXL_MEMORY', 'kernel arena: grow failed'), {cause}); }
  for (const h of holders) h.refresh?.();
}
export function tryGrowArena(bytes) {
  try { growArena(bytes); return true; } catch (error) { if (error?.code === 'JXL_MEMORY') return false; throw error; }
}
