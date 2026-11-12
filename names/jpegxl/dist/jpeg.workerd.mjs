import wasm from './wasm.workerd.mjs';
import {configureWasm} from './jpeg.mjs';
configureWasm(wasm);
export * from './jpeg.mjs';
