import wasm from './wasm.edge-light.mjs';
import {configureWasm} from './capture-complete.mjs';
configureWasm(wasm);
export * from './capture-complete.mjs';
