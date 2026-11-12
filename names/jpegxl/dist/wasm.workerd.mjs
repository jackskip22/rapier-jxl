import kernels from './kernels.wasm';
import jpeg from './jpeg.wasm';
import decode from './decode.wasm';
import {wasmBundle} from './wasm-modules.mjs';
export default wasmBundle({kernels,jpeg,decode});
