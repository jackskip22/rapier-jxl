import kernels from './kernels.wasm';
import jpeg from './jpeg.wasm';
import {provideWasm} from './wasm-modules.mjs';
provideWasm({kernels,jpeg});
export * from './capture-complete.mjs';
