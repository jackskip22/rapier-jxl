import kernels from './kernels.wasm?module';
import {provideWasm} from './wasm-modules.mjs';
provideWasm({kernels});
export * from './capture.precompiled.mjs';
