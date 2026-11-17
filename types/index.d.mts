import type {PackageDecode, JpegRestore, JpegRecompress} from './types.mjs';
import type {EncodedResult, ImageResult} from './result.mjs';
import type {ImageInput, EncodeOptions, PreparationInput, FitOptions, VariantsOptions} from './types.mjs';
import type {ResumableFunction} from './resumable.mjs';
import type {CodecConfig} from './types.mjs';
export type * from './types.mjs';
// Types only: page capture's options; the function is jpegxl/capture-complete's.
export type {CaptureCompleteOptions, CapturePhotoFidelity as CaptureFidelity} from './capture-complete.mjs';
/** jpegxl: the full still encoder in one file: a page's calls run in its own worker; calls in a worker, Node and edge hosts run in place. Efforts 1-9, exact or lossy, measured fidelity, WebGPU
 * at lossy efforts 7-9, HDR and deeper samples, ICC and codestream features. An exact, unchanged JPEG File or Blob
 * preserves the original JPEG. At efforts 6-9, a JPEG look request compares the pixel result's size with reversible
 * recompression. jpeg: 'pixels' requires pixel encoding. A preserved JPEG reports fidelity: 'exact', kept: 'jpeg-bytes'
 * and measurements: [], with no measured score. An animation is
 * encoded by jpegxl/animation; a file's header and metadata are jpegxl/metadata's. In a browser each module's own name is
 * its worker queue (configure sets it). Page capture is jpegxl/capture and jpegxl/capture-complete.
 * Invalid fidelity, effort or readAs refuses JXL_OPTIONS; a required WebGPU device or job that cannot run refuses JXL_WEBGPU. */
export const encode: ResumableFunction<(input: ImageInput, options?: EncodeOptions) => Promise<EncodedResult>>;
/** Fit the same oriented dimensions to maxBytes within explicit fidelity bounds. No fit is an ordinary result. */
export const fit: ResumableFunction<(input: PreparationInput, options: FitOptions) => Promise<ImageResult>>;
/** Acquire/orient once and encode each explicitly sized output independently. No partial results on cancellation. */
export const variants: ResumableFunction<(input: PreparationInput, options: VariantsOptions) => Promise<ImageResult[]>>;
/** The kernels compiled, with no job. */
export function prepare(): Promise<void>;
/** Whether this realm compiles the WebAssembly kernels with SIMD; with 'webgpu', whether this realm offers a usable WebGPU
 * adapter; a job may still run on WebAssembly. */
export function supported(feature?: 'webgpu'): Promise<boolean>;

/** Where the host reads no JPEG (Node, Deno, Bun), the one setup step for a JPEG input: `configureDecoder(decode, restore,
 * recompress)` with jpegxl/decode's decode and jpegxl/jpeg's recompress (restore may be null). Without it a JPEG
 * refuses JXL_PLATFORM. One call serves every jpegxl module in the realm; null alone clears it, while null with helpers keeps them. */
export function configureDecoder(decode: PackageDecode | null, restore?: JpegRestore | null, recompress?: JpegRecompress | null): void;

/** This module's settings for the calls that follow. In a browser they are its queue's: the module runs in its own file's
 * worker, from a page or nested in a worker of the page's own; configure before the first call, or again once close() has
 * resolved. In place (Node, Deno, Bun, edge hosts, a page's own worker) it takes the same
 * keys: helpers (where the module has them), webgpu and maxPixels, and maxPendingJobs bounding the calls pending at once; no worker starts and nothing is copied
 * there, so the worker settings and maxPendingBytes have nothing to act on. Configuring while a call runs refuses JXL_OPTIONS. */
export function configure(settings?: CodecConfig): void;
/** Ends this module's worker and helpers; the next call starts them again. */
export function close(): Promise<void>;
