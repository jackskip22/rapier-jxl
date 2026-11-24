import {fault, hostWords, outOfMemory} from './fault.mjs';
import {wasmFailure} from './wasm-modules.mjs';
const EMPTY = [0, 97, 115, 109, 1, 0, 0, 0];
export const wasmRefused = () => {
  try { new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.of(...EMPTY))); return false; } catch { return typeof WebAssembly === 'object'; }
};
const simdMissing = () => {
  try { return !WebAssembly.validate(Uint8Array.of(...EMPTY, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 23, 1, 21, 0, 253, 12, ...Array(16).fill(0), 26, 11)); }
  catch { return true; }
};
export const wasmRequired = (cause = wasmFailure()) => Object.assign(outOfMemory(cause) ? fault('JXL_MEMORY', `out of memory${hostWords(cause)}`) : fault('JXL_WASM', wasmRefused()
  ? "allow 'wasm-unsafe-eval' or use workerd/edge-light"
  : simdMissing() ? 'WebAssembly SIMD required'
  : `The WebAssembly module failed${hostWords(cause)}; check the host's memory.`),
  cause ? {cause} : {});
