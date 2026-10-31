import type {WasmBundle} from './wasm.mjs';
import type {DecodeOptions, DecodedImage} from './types.mjs';
export type {DecodeOptions, DecodedImage, WasmBundle};
/** The whole picture decoded on this thread: every decoder part and the Brotli dictionary are in this module, so nothing
 * loads after its import. A file that is cut or malformed refuses (JXL_DECODE, JXL_INPUT); up to 40 megapixels. */
export function decode(input: Uint8Array | Blob, options?: DecodeOptions): Promise<DecodedImage>;
/** Compiles the optional WebAssembly kernels before the first decode. Without WebAssembly the same samples come from
 * JavaScript. */
export function prepare(): Promise<void>;
/** true: every realm with JavaScript decodes. supported('webgpu') is false: the decoder runs nothing on WebGPU. */
export function supported(feature?: 'webgpu'): Promise<boolean>;
/** Installs the bundle from `rapier-jxl/wasm` in this realm, before the first decode. */
export function configureWasm(bundle: WasmBundle): void;
