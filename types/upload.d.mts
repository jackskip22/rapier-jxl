import type {ImageResult} from './result.mjs';
import type {UploadInput, UploadCaptureInput, UploadOptions, UploadCaptureOptions as CaptureOptions} from './types.mjs';
import type {UploadPreparationInput, UploadFitOptions, UploadVariantsOptions} from './preparation-upload.mjs';
import type {WasmBundle} from './wasm.mjs';
import type {ResumableFunction} from './resumable.mjs';
export type {UploadOptions, UploadInput, UploadCaptureInput, CapturePixels, MaxError, UploadInput as ImageInput, Bytes} from './types.mjs';
export type {UploadCaptureOptions as CaptureOptions, CapturePhotoFidelity as CaptureFidelity, CaptureRecord} from './types.mjs';
export type {UploadPreparationInput, UploadFitOptions, UploadVariantRequest, UploadVariantsOptions, UploadPreparation} from './preparation-upload.mjs';
/** The upload encoder in one file, run in place: a File, Blob, canvas or pixels in; efforts 1-3; an exact JPEG carried.
 * `encode` from `rapier-jxl` writes the same bytes at the same effort, and runs efforts 4-9 too. */
export const encode: ResumableFunction<(input: UploadInput, options?: UploadOptions) => Promise<ImageResult>>;
export function capture(input: UploadCaptureInput, options?: CaptureOptions): Promise<ImageResult>;
/** Owned still preparation at the source depth, at most 40 MP. Efforts 1-3; no features, measured targets, textures or rows.
 * Exact float preparation preserves its samples; upload refuses lossy float encoding. */
export const fit: ResumableFunction<(input: UploadPreparationInput, options: UploadFitOptions) => Promise<ImageResult>>;
/** Every output is resampled independently from the owned original; an error rejects the whole call. */
export const variants: ResumableFunction<(input: UploadPreparationInput, options: UploadVariantsOptions) => Promise<ImageResult[]>>;
/** Compiles the kernels (and, for 'capture', warms the capture coder), with no job. */
export function prepare(operation?: 'encode' | 'capture' | 'fit' | 'variants'): Promise<void>;
/** True when this realm runs these encoders. supported('webgpu') is false: this module runs on WebAssembly only. */
export function supported(feature?: 'webgpu'): Promise<boolean>;
/** The precompiled WebAssembly for hosts that refuse run-time compilation (rapier-jxl/wasm). */
export function configureWasm(bundle: WasmBundle): void;

export {resultJSON} from './result.mjs';
export type {ImageJob, ImageVerb, Digest, ResultSource, ResultReason, ResultTransform, ResultFidelity, ResultMeasurement, ImageResult, ImageResultJSON} from './result.mjs';
