import wasm from './wasm.edge-light.mjs';
import {configureWasm} from './capture.mjs';
configureWasm(wasm);
export * from './capture.mjs';
