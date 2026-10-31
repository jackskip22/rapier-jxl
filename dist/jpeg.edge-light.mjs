import wasm from './wasm.edge-light.mjs';
import {configureWasm} from './jpeg.mjs';
configureWasm(wasm);
export * from './jpeg.mjs';
