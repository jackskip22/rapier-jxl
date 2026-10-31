import {fault} from './fault.mjs';
export const wasmRequired = () => fault('JXL_WASM', "rapier-jxl requires WebAssembly with SIMD. If a Content Security Policy blocks it, add 'wasm-unsafe-eval' to your script-src directive. A host that refuses run-time compilation resolves the package's workerd or edge-light condition.");
