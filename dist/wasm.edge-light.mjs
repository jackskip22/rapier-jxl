import kernels from './kernels.wasm?module';
import jpeg from './jpeg.wasm?module';
import decode from './decode.wasm?module';
import {wasmBundle} from './wasm-modules.mjs';
export default wasmBundle({kernels,jpeg,decode});
