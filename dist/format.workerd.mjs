import wasm from './wasm.workerd.mjs';
import {configureWasm} from './format.mjs';
configureWasm(wasm);
export * from './format.mjs';
