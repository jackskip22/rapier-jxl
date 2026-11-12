import wasm from './wasm.workerd.mjs';
import {configureWasm} from './verify.mjs';
configureWasm(wasm);
export * from './verify.mjs';
