import wasm from './wasm.edge-light.mjs';
import {configureWasm} from './decode.mjs';
configureWasm(wasm);
export * from './decode.mjs';
