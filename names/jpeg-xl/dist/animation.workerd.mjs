import wasm from './wasm.workerd.mjs';
import {configureWasm} from './animation.mjs';
configureWasm(wasm);
export * from './animation.mjs';
