import type {WasmBundle} from './wasm.mjs';
import type {Bytes, JPEGOptions, JobOptions} from './types.mjs';
export type {JPEGOptions, JobOptions, WasmBundle};
/** A JPEG's coefficients coded as JPEG XL with no loss, with what restore needs to write the same JPEG back. The input
 * and options are taken at the call; inputs over 256 MiB refuse (JXL_LIMIT); maxPixels (at most and by default
 * 40,000,000) bounds the JPEG's size, and restore's (JXL_DIMENSIONS). */
export function recompress(input: Uint8Array | Blob, options?: JPEGOptions & {maxPixels?: number}): Promise<Bytes>;
/** The JPEG a recompressed file was made from, byte for byte. A file with no reconstruction data refuses
 * JXL_RECONSTRUCTION. rapier-jxl/metadata header(bytes).reconstruction says, without a decode, whether the bytes hold a
 * reconstruction box; restore alone says whether the JPEG comes back. Inputs over 256 MiB refuse (JXL_LIMIT). */
export function restore(input: Uint8Array | Blob, options?: JobOptions & {maxPixels?: number}): Promise<Bytes>;
/** Compiles the WebAssembly kernels recompress needs; restore needs none. */
export function prepare(): Promise<void>;
/** Whether this realm compiles the WebAssembly kernels with SIMD, which recompress needs. supported('webgpu') is false. */
export function supported(feature?: 'webgpu'): Promise<boolean>;
/** Installs the bundle from `rapier-jxl/wasm` in this realm, before the first job. */
export function configureWasm(bundle: WasmBundle): void;
