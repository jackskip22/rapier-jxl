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
/** The upload encoder in one file: a page's calls run in its own worker. Calls in a worker, Node and edge hosts run in place: a File, Blob, canvas or pixels in. Efforts 1-3. An exact, unchanged
 * JPEG preserves the original file. jpeg: 'pixels' requires pixel encoding instead.
 * `encode` from `jpegxl` writes the same file at the same effort, and runs efforts 4-9 too.
 * For JPEG input in Node, Deno, Bun or a Worker, the setup call is configureDecoder, exported here as from the root entry.
 * Efforts 4-9 refuse JXL_UNSUPPORTED. Passing webgpu refuses JXL_OPTIONS.
 * @example configureDecoder((await import('jpegxl/decode')).decode, null, (await import('jpegxl/jpeg')).recompress); */
export function configureDecoder(decode: PackageDecode | null, restore?: JpegRestore | null, recompress?: JpegRecompress | null): void;
/** @example const {bytes} = await encode(file, {fidelity: {quality: 82}}); */
export const encode: ResumableFunction<(input: UploadInput, options?: UploadOptions) => Promise<EncodedResult>>;
/** @example const {bytes} = await capture(canvas); */
export function capture(input: UploadCaptureInput, options?: UploadCaptureOptions): Promise<EncodedResult>;
/** Owned still preparation at the source depth. Efforts 1-3. No features, measured targets, textures or rows.
 * Exact float preparation preserves its samples. Upload refuses lossy float encoding.
 * @example const {bytes, meetsTarget} = await fit(file, {maxBytes: 100_000}); // bytes is null when nothing fits */
export const fit: ResumableFunction<(input: UploadPreparationInput, options: UploadFitOptions) => Promise<ImageResult>>;
/** Every output is resampled independently from the owned original. An error rejects the whole call.
 * @example const [small, large] = await variants(file, {outputs: [{width: 480}, {width: 1440}]}); */
export const variants: ResumableFunction<(input: UploadPreparationInput, options: UploadVariantsOptions) => Promise<ImageResult[]>>;
/** Compiles the kernels (and, for 'capture', warms the capture coder), with no job.
 * An operation other than 'encode' or 'capture' refuses JXL_OPTIONS.
 * @example await prepare('capture'); */
export function prepare(operation?: 'encode' | 'capture'): Promise<void>;
/** True when this realm runs these encoders. supported('webgpu') is false: this module runs on WebAssembly only.
 * @example const gpu = await supported('webgpu'); */
export function supported(feature?: 'webgpu'): Promise<boolean>;

export type {ImageJob, ImageVerb, Digest, ResultSource, ResultReason, ResultTransform, ResultFidelity, ResultMeasurement, ImageResult, EncodedResult} from './result.mjs';

/** Settings for following calls. Configure before the first call or after close() resolves.
 * A browser import on a page uses this module's worker. Inside your own worker it runs in place without
 * a nested queue worker. Cold calls copy plain pixels and options and read 2D canvases before the module loads.
 * maxPendingJobs includes these calls. maxPendingBytes bounds their total retained snapshot bytes until they settle.
 * Loaded in-place calls, including Node, Deno, Bun, and edge calls, make no queue copy. workerFactory,
 * workerStartupTimeout, and maxPendingBytes have no effect there. maxPendingJobs still applies.
 * Configuring during a configured call refuses JXL_OPTIONS. An unconfigured call keeps running unchanged.
 * @example configure({maxPendingJobs: 4}); */
export function configure(settings?: Omit<CodecConfig, 'webgpu'>): void;
/** Ends this module's worker and helpers. The next call starts them again.
 * Cancels cold calls still waiting to start. Calls already running in place are neither canceled nor awaited.
 * @example await close(); */
export function close(): Promise<void>;

/** Codes for refusals raised by rapier-jxl. Caller callback errors and abort reasons pass through unchanged. */
export type {CodecError, ErrorCode} from './types.mjs';
