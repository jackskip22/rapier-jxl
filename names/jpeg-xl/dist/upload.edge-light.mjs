import wasm from './wasm.edge-light.mjs';
import {configureWasm} from './upload.mjs';
configureWasm(wasm);
export * from './upload.mjs';
