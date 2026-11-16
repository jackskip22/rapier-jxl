import kernels from './kernels.wasm';
import jpeg from './jpeg.wasm';
import general from './general.wasm';
import {provideWasm} from './wasm-modules.mjs';
provideWasm({kernels,jpeg,general});
export * from './jpeg.mjs';
