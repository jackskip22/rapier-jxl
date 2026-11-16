import kernels from './kernels.wasm';
import jpeg from './jpeg.wasm';
import rebuild from './rebuild.wasm';
import general from './general.wasm';
import {provideWasm} from './wasm-modules.mjs';
provideWasm({kernels,jpeg,rebuild,general});
export * from './animation.mjs';
