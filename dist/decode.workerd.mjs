import wasm from './wasm.workerd.mjs';
import {configureWasm} from './decode.mjs';
configureWasm(wasm);
export * from './decode.mjs';
