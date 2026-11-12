import wasm from './wasm.workerd.mjs';
import {configureWasm} from './index.mjs';
configureWasm(wasm);
export * from './index.mjs';
