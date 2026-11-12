import wasm from './wasm.edge-light.mjs';
import {configureWasm} from './verify.mjs';
configureWasm(wasm);
export * from './verify.mjs';
