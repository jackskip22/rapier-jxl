import decode from './decode.wasm?module';
import {provideWasm} from './wasm-modules.mjs';
provideWasm({decode});
export * from './decode.precompiled.mjs';
