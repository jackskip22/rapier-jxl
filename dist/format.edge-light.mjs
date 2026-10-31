import wasm from './wasm.edge-light.mjs';
import {configureWasm} from './format.mjs';
configureWasm(wasm);
export * from './format.mjs';
