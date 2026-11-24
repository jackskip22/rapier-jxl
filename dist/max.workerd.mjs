import kernels from './kernels.wasm';
import jpeg from './jpeg.wasm';
import rebuild from './rebuild.wasm';
import {provideWasm} from './wasm-modules.mjs';
provideWasm({kernels,jpeg,rebuild});
export * from './max.precompiled.mjs';
