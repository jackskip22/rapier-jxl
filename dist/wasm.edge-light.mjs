import capture from './capture.wasm?module';
import simd from './simd.wasm?module';
import jpeg from './jpeg.wasm?module';
import decode from './decode.wasm?module';
import {wasmBundle} from './wasm-modules.mjs';
export default wasmBundle({capture,simd,jpeg,decode});
