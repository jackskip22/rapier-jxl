import wasm from './wasm.workerd.mjs';
import {configureWasm} from './capture-complete.mjs';
configureWasm(wasm);
export * from './capture-complete.mjs';
