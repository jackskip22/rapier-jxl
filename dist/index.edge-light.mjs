import kernels from './kernels.wasm?module';
import jpeg from './jpeg.wasm?module';
import rebuild from './rebuild.wasm?module';
import {provideWasm} from './wasm-modules.mjs';
provideWasm({kernels,jpeg,rebuild});
export * from './index.precompiled.mjs';
