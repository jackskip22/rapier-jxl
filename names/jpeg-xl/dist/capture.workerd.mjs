import wasm from './wasm.workerd.mjs';
import {configureWasm} from './capture.mjs';
configureWasm(wasm);
export * from './capture.mjs';
