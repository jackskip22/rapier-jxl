import wasm from './wasm.workerd.mjs';
import {configureWasm} from './resumable.node.mjs';
configureWasm(wasm);
export * from './resumable.node.mjs';
