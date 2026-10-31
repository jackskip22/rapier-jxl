import type {ImageInput, CaptureOptions, Bytes} from './types.mjs';
import type {WasmBundle} from './wasm.mjs';
export type {CaptureOptions, CaptureFidelity, MaxError, ImageInput, Bytes} from './types.mjs';
/** The screenshot encoder in one file, run in place: 8-bit sRGB or Display P3 RGBA, exact or within maxError.
 * `capture` from `rapier-jxl` and `rapier-jxl/upload` is the same encoder. */
export function capture(input: ImageInput, options?: CaptureOptions): Promise<Bytes>;
/** Compiles the kernels and warms the coder, with no job. */
export function prepare(): Promise<void>;
/** True when this realm runs the capture encoder. supported('webgpu') is false: captures run on WebAssembly only. */
export function supported(feature?: 'webgpu'): Promise<boolean>;
/** The precompiled WebAssembly for hosts that refuse run-time compilation (rapier-jxl/wasm). */
export function configureWasm(bundle: WasmBundle): void;
