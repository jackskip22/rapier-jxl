import type {EncodedResult, ImageResult} from './result.mjs';
// jpegxl/capture-complete: every capture effort, 1-9, exact, bounded and photographic
import type {CaptureInput, Effort, CapturePhotoOptions, CaptureDecoder, PackageDecode, JpegRestore, JpegRecompress} from './types.mjs';
import type {ResumableFunction} from './resumable.mjs';
import type {CodecConfig} from './types.mjs';
export type {ImageInput, CaptureInput, CapturePixels, Bytes, MaxError, Effort} from './types.mjs';
export type {ImagePreview, PreviewOptions} from './types.mjs';
export type {CapturePhotoFidelity, CapturePhotoOptions, CaptureRect, ExactRect, CaptureDecoder} from './types.mjs';
/** Photographic capture's options with efforts 8 and 9 too. */
export type CaptureCompleteOptions = Omit<CapturePhotoOptions, 'effort'> & {
  /** 1 (fastest) to 9 (smallest file). Default 3. Efforts 1-5 predict the look, 6-9 measure it. */
  effort?: Effort};
/** In one file: a page's calls run in its own worker. Calls in a worker, Node and edge hosts run in place. Exact, bounded and photographic capture at efforts 1-9 (jpegxl/capture's exact files at 1-5), GPU textures, and
 * efforts 7-9's GPU stages on a device where one answers (the same file without one).
 * The root still encoder has no capture() export. jpegxl/upload carries photographic capture at 1-3. Invalid options refuse JXL_OPTIONS, oversized rectangle work JXL_LIMIT, required GPU failure JXL_WEBGPU, and unavailable decoding JXL_PLATFORM.
 * @example const {bytes} = await capture(canvas, {fidelity: {quality: 92}}); */
export const capture: ResumableFunction<(input: CaptureInput, options?: CaptureCompleteOptions) => Promise<EncodedResult>>;
/** @example await prepare(); */
export function prepare(): Promise<void>;
/** supported('webgpu'): this realm has a usable GPU for efforts 7-9.
 * @example const gpu = await supported('webgpu'); */
export function supported(feature?: 'webgpu'): Promise<boolean>;
/** Measured capture (efforts 6-9) needs no decoder: it scores the picture each file shows, rebuilt by the decoder's own
 * steps, so every host writes the same file. `configureDecoder(decode)` with jpegxl/decode's decode (and jpegxl/jpeg's
 * restore) serves jpegxl/verify and a JPEG where the host reads none. One call serves every jpegxl module in the realm.
 * null alone clears it, while null with helpers keeps them.
 * @example configureDecoder((await import('jpegxl/decode')).decode); */
export function configureDecoder(decode: PackageDecode | CaptureDecoder | null, restore?: JpegRestore | null, recompress?: JpegRecompress | null): void;

export type {ImageJob, ImageVerb, Digest, ResultSource, ResultReason, ResultTransform, ResultFidelity, ResultMeasurement, ImageResult, EncodedResult} from './result.mjs';

/** Settings for following calls. Configure before the first call or after close() resolves.
 * A browser import on a page uses this module's worker. Inside your own worker it runs in place without
 * a nested queue worker. Cold calls copy plain pixels and options and read 2D canvases before the module loads.
 * maxPendingJobs includes these calls. maxPendingBytes bounds their total retained snapshot bytes until they settle.
 * Loaded in-place calls, including Node, Deno, Bun, and edge calls, make no queue copy. workerFactory,
 * workerStartupTimeout, and maxPendingBytes have no effect there. maxPendingJobs still applies.
 * Configuring during a configured call refuses JXL_OPTIONS. An unconfigured call keeps running unchanged.
 * @example configure({maxPendingJobs: 4}); */
export function configure(settings?: CodecConfig): void;
/** Ends this module's worker and helpers. The next call starts them again.
 * Cancels cold calls still waiting to start. Calls already running in place are neither canceled nor awaited.
 * @example await close(); */
export function close(): Promise<void>;

/** Codes for refusals raised by rapier-jxl. Caller callback errors and abort reasons pass through unchanged. */
export type {CodecError, ErrorCode} from './types.mjs';
