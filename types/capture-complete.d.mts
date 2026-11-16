import type {EncodedResult, ImageResult} from './result.mjs';
// rapier-jxl/capture-complete: every capture effort, 1-9, exact, bounded and photographic
import type {CaptureInput, Effort, CapturePhotoOptions, CaptureDecoder, PackageDecode, JpegRestore, JpegRecompress} from './types.mjs';
import type {ResumableFunction} from './resumable.mjs';
import type {CodecConfig} from './types.mjs';
export type {ImageInput, CaptureInput, CapturePixels, Bytes, MaxError, Effort} from './types.mjs';
export type {ImagePreview, PreviewOptions} from './types.mjs';
export type {CapturePhotoFidelity, CapturePhotoOptions, CaptureRect, ExactRect, CaptureDecoder} from './types.mjs';
/** Photographic capture's options with efforts 8 and 9 too. */
export type CaptureCompleteOptions = Omit<CapturePhotoOptions, 'effort'> & {
  /** 1 (fastest) to 9 (smallest file); default 3. Efforts 1-5 predict the look, 6-9 measure it. */
  effort?: Effort};
/** In one file: a page's calls run in its own worker; calls in a worker, Node and edge hosts run in place. Exact, bounded and photographic capture at efforts 1-9 (rapier-jxl/capture's exact files at 1-5), GPU textures, and
 * efforts 7-9's GPU stages on a device where one answers (the same file without one).
 * The root still encoder has no capture() export. rapier-jxl/upload carries photographic capture at 1-3. Invalid options refuse JXL_OPTIONS, oversized rectangle work JXL_LIMIT, required GPU failure JXL_WEBGPU, and unavailable decoding JXL_PLATFORM. */
export const capture: ResumableFunction<(input: CaptureInput, options?: CaptureCompleteOptions) => Promise<EncodedResult>>;
export function prepare(): Promise<void>;
/** supported('webgpu'): this realm has a usable GPU for efforts 7-9. */
export function supported(feature?: 'webgpu'): Promise<boolean>;
/** The one setup step for measured capture (efforts 6-9) in Node, Deno, Bun and desktop apps: `configureDecoder(decode)`
 * with rapier-jxl/decode's decode (and rapier-jxl/jpeg's restore, which rapier-jxl/verify uses). One call serves every
 * rapier-jxl module in the realm. Browser-native decoding is preferred; null alone clears it, while null with helpers keeps them. */
export function configureDecoder(decode: PackageDecode | CaptureDecoder | null, restore?: JpegRestore | null, recompress?: JpegRecompress | null): void;

export type {ImageJob, ImageVerb, Digest, ResultSource, ResultReason, ResultTransform, ResultFidelity, ResultMeasurement, ImageResult, EncodedResult} from './result.mjs';

/** This module's settings for the calls that follow. In a browser they are its queue's: the module runs in its own file's
 * worker, from a page or nested in a worker of the page's own; configure before the first call, or again once close() has
 * resolved. In place (Node, Deno, Bun, edge hosts, a page's own worker) it takes the same
 * keys: helpers (where the module has them), webgpu and maxPixels, and maxPendingJobs bounding the calls pending at once; no worker starts and nothing is copied
 * there, so the worker settings and maxPendingBytes have nothing to act on. Configuring while a call runs refuses JXL_OPTIONS. */
export function configure(settings?: CodecConfig): void;
/** Ends this module's worker and helpers; the next call starts them again. */
export function close(): Promise<void>;

/** Every refusal: a coded Error. */
export type {CodecError, ErrorCode} from './types.mjs';
