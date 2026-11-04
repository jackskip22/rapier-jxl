import {fault} from './fault.mjs';
export const wasmRequired = () => fault('JXL_WASM', "rapier-jxl needs WebAssembly SIMD. Under a CSP, add 'wasm-unsafe-eval' to script-src; without run-time compilation, use the workerd or edge-light condition.");
