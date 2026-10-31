import type {ImageInput, UploadOptions, CaptureOptions, Bytes} from './types.mjs';
import type {WasmBundle} from './wasm.mjs';
export type {UploadOptions, CaptureOptions, CaptureFidelity, MaxError, ImageInput, Bytes} from './types.mjs';
/** The upload encoder in one file, run in place: a File, Blob, canvas or pixels in; efforts 1-3; an exact JPEG carried.
 * `encode` from `rapier-jxl` writes the same bytes at the same effort, and runs efforts 4-9 too. */
export function encode(input: ImageInput, options?: UploadOptions): Promise<Bytes>;
export function capture(input: ImageInput, options?: CaptureOptions): Promise<Bytes>;
/** Compiles the kernels (and, for 'capture', warms the capture coder), with no job. */
export function prepare(operation?: 'encode' | 'capture'): Promise<void>;
/** True when this realm runs these encoders. supported('webgpu') is false: this module runs on WebAssembly only. */
export function supported(feature?: 'webgpu'): Promise<boolean>;
/** The precompiled WebAssembly for hosts that refuse run-time compilation (rapier-jxl/wasm). */
export function configureWasm(bundle: WasmBundle): void;
