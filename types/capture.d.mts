import type {ImageResult} from './result.mjs';
import type {CaptureInput, TextureInput, CaptureOptions} from './types.mjs';
import type {WasmBundle} from './wasm.mjs';
import type {ResumableFunction} from './resumable.mjs';
export type {CaptureOptions, CaptureRecord, CaptureFidelity, MaxError, ImageInput, CaptureInput, CapturePixels, Bytes} from './types.mjs';
/** The screenshot encoder in one file, run in place: 8-bit sRGB or Display P3 RGBA, exact or within maxError.
 * Efforts 1-5. `rapier-jxl/capture-complete` adds photographic fidelity, efforts 6-9 and WebGPU. */
export const capture: ResumableFunction<(input: Exclude<CaptureInput, TextureInput>, options?: CaptureOptions) => Promise<ImageResult>>;
/** Compiles the kernels and warms the coder, with no job. */
export function prepare(): Promise<void>;
/** True when this realm runs the capture encoder. supported('webgpu') is false: captures run on WebAssembly only. */
export function supported(feature?: 'webgpu'): Promise<boolean>;
/** The precompiled WebAssembly for hosts that refuse run-time compilation (rapier-jxl/wasm). */
export function configureWasm(bundle: WasmBundle): void;

export {resultJSON} from './result.mjs';
export type {ImageJob, ImageVerb, Digest, ResultSource, ResultReason, ResultTransform, ResultFidelity, ResultMeasurement, ImageResult, ImageResultJSON} from './result.mjs';
