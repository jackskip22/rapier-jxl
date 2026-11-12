import wasm from './wasm.workerd.mjs';
import {configureWasm} from './upload.mjs';
configureWasm(wasm);
export * from './upload.mjs';
