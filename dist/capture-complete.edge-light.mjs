import kernels from './kernels.wasm?module';
import jpeg from './jpeg.wasm?module';
import {provideWasm} from './wasm-modules.mjs';
provideWasm({kernels,jpeg});
export * from './capture-complete.mjs';
