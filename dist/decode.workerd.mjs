import decode from './decode.wasm';
import {provideWasm} from './wasm-modules.mjs';
provideWasm({decode});
export * from './decode.precompiled.mjs';
