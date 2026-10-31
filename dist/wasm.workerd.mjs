import capture from './capture.wasm';
import simd from './simd.wasm';
import jpeg from './jpeg.wasm';
import decode from './decode.wasm';
import {wasmBundle} from './wasm-modules.mjs';
export default wasmBundle({capture,simd,jpeg,decode});
