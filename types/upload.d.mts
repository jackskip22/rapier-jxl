import type {PackageDecode, JpegRestore, JpegRecompress} from './types.mjs';
import type {EncodedResult, ImageResult} from './result.mjs';
import type {UploadInput, UploadCaptureInput, UploadOptions, UploadCaptureOptions} from './types.mjs';
import type {UploadPreparationInput, UploadFitOptions, UploadVariantsOptions} from './preparation-upload.mjs';
import type {ResumableFunction} from './resumable.mjs';
import type {CodecConfig} from './types.mjs';
export type {UploadOptions, UploadInput, UploadCaptureInput, CapturePixels, MaxError, UploadInput as ImageInput, Bytes} from './types.mjs';
export type {ImagePreview, PreviewOptions} from './types.mjs';
export type {UploadCaptureOptions, CapturePhotoFidelity as CaptureFidelity} from './types.mjs';
export type {UploadPreparationInput, UploadFitOptions, UploadVariantRequest, UploadVariantsOptions, UploadPreparation} from './preparation-upload.mjs';
/** The upload encoder in one file: a page's calls run in its own worker; calls in a worker, Node and edge hosts run in place: a File, Blob, canvas or pixels in; efforts 1-3. An exact, unchanged
 * JPEG preserves the original file; jpeg: 'pixels' requires pixel encoding instead.
 * `encode` from `rapier-jxl` writes the same file at the same effort, and runs efforts 4-9 too.
 * For JPEG input in Node, Deno or Bun, the setup call is configureDecoder, exported here as from the root entry.
 * Efforts 4-9 refuse JXL_UNSUPPORTED; passing webgpu refuses JXL_OPTIONS. */
export function configureDecoder(decode: PackageDecode | null, restore?: JpegRestore | null, recompress?: JpegRecompress | null): void;
export const encode: ResumableFunction<(input: UploadInput, options?: UploadOptions) => Promise<EncodedResult>>;
export function capture(input: UploadCaptureInput, options?: UploadCaptureOptions): Promise<EncodedResult>;
/** Owned still preparation at the source depth. Efforts 1-3; no features, measured targets, textures or rows.
 * Exact float preparation preserves its samples; upload refuses lossy float encoding. */
export const fit: ResumableFunction<(input: UploadPreparationInput, options: UploadFitOptions) => Promise<ImageResult>>;
/** Every output is resampled independently from the owned original; an error rejects the whole call. */
export const variants: ResumableFunction<(input: UploadPreparationInput, options: UploadVariantsOptions) => Promise<ImageResult[]>>;
/** Compiles the kernels (and, for 'capture', warms the capture coder), with no job.
 * An operation other than 'encode' or 'capture' refuses JXL_OPTIONS. */
export function prepare(operation?: 'encode' | 'capture'): Promise<void>;
/** True when this realm runs these encoders. supported('webgpu') is false: this module runs on WebAssembly only. */
export function supported(feature?: 'webgpu'): Promise<boolean>;

export type {ImageJob, ImageVerb, Digest, ResultSource, ResultReason, ResultTransform, ResultFidelity, ResultMeasurement, ImageResult, EncodedResult} from './result.mjs';

/** This module's settings for the calls that follow. In a browser they are its queue's: the module runs in its own file's
 * worker, from a page or nested in a worker of the page's own; configure before the first call, or again once close() has
 * resolved. In place (Node, Deno, Bun, edge hosts, a page's own worker) it takes the same
 * keys: helpers and maxPixels, and maxPendingJobs bounding the calls pending at once; no worker starts and nothing is copied
 * there, so the worker settings and maxPendingBytes have nothing to act on. Configuring while a call runs refuses JXL_OPTIONS. */
export function configure(settings?: Omit<CodecConfig, 'webgpu'>): void;
/** Ends this module's worker and helpers; the next call starts them again. */
export function close(): Promise<void>;

/** Every refusal: a coded Error. */
export type {CodecError, ErrorCode} from './types.mjs';
