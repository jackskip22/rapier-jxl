import kernels from './kernels.wasm?module';
import jpeg from './jpeg.wasm?module';
import general from './general.wasm?module';
import {provideWasm} from './wasm-modules.mjs';
provideWasm({kernels,jpeg,general});
export * from './jpeg.mjs';
