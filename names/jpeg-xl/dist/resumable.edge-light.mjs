import wasm from './wasm.edge-light.mjs';
import {configureWasm} from './resumable.node.mjs';
configureWasm(wasm);
export * from './resumable.node.mjs';
