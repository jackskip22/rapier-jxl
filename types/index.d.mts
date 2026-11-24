import type {PackageDecode, JpegRestore, JpegRecompress} from './types.mjs';
import type {EncodedResult, ImageResult} from './result.mjs';
import type {ImageInput, EncodeOptions, PreparationInput, FitOptions, VariantsOptions} from './types.mjs';
import type {ResumableFunction} from './resumable.mjs';
import type {CodecConfig} from './types.mjs';
export type * from './types.mjs';
// Types only: page capture's options; the function is jpegxl/capture-complete's.
export type {CaptureCompleteOptions, CapturePhotoFidelity as CaptureFidelity} from './capture-complete.mjs';
/** jpegxl: the full still encoder in one file: a page's calls run in its own worker. Calls in a worker, Node and edge hosts run in place. Efforts 1-9, exact or lossy. Measured fidelity, WebGPU
 * at lossy efforts 7-9, HDR and deeper samples, ICC and codestream features. An exact, unchanged JPEG File or Blob
 * preserves the original JPEG. At efforts 6-9, a JPEG look request compares the pixel result's size with reversible
 * recompression. jpeg: 'pixels' requires pixel encoding. A preserved JPEG reports fidelity: 'exact', kept: 'jpeg-bytes'
 * and measurements: [], with no measured score. An animation is
 * encoded by jpegxl/animation. A file's header and metadata are jpegxl/metadata's. In a browser each module's own name is
 * its worker queue (configure sets it). Page capture is jpegxl/capture and jpegxl/capture-complete.
 * Invalid fidelity, effort or readAs refuses JXL_OPTIONS. For effort 10, import encode from jpegxl/max.
 * A required WebGPU device or job that cannot run refuses JXL_WEBGPU.
 * @example const {bytes} = await encode(file, {fidelity: {quality: 90}}); */
export const encode: ResumableFunction<(input: ImageInput, options?: EncodeOptions) => Promise<EncodedResult>>;
/** Fit the same oriented dimensions to maxBytes within explicit fidelity bounds. No fit is an ordinary result.
 * @example const {bytes, meetsTarget} = await fit(file, {maxBytes: 100_000}); // bytes is null when nothing fits */
export const fit: ResumableFunction<(input: PreparationInput, options: FitOptions) => Promise<ImageResult>>;
/** Acquire/orient once and encode each explicitly sized output independently. No partial results on cancellation.
 * @example const [small, large] = await variants(file, {outputs: [{width: 480}, {width: 1440}]}); */
export const variants: ResumableFunction<(input: PreparationInput, options: VariantsOptions) => Promise<ImageResult[]>>;
/** The kernels compiled, with no job.
 * @example await prepare(); */
export function prepare(): Promise<void>;
/** Whether this realm compiles the WebAssembly kernels with SIMD. With 'webgpu', whether this realm offers a usable WebGPU
 * adapter. A job may still run on WebAssembly.
 * @example const gpu = await supported('webgpu'); */
export function supported(feature?: 'webgpu'): Promise<boolean>;

/** Where the host reads no JPEG (Node, Deno, Bun), the one setup step for a JPEG input: `configureDecoder(decode, restore,
 * recompress)` with jpegxl/decode's decode and jpegxl/jpeg's recompress (restore may be null). Without it a JPEG
 * refuses JXL_PLATFORM. One call serves every jpegxl module in the realm. null alone clears it, while null with helpers keeps them.
 * @example configureDecoder((await import('jpegxl/decode')).decode, null, (await import('jpegxl/jpeg')).recompress); */
export function configureDecoder(decode: PackageDecode | null, restore?: JpegRestore | null, recompress?: JpegRecompress | null): void;

/** Settings for following calls. Configure before the first call or after close() resolves.
 * A browser import on a page uses this module's worker. Inside your own worker it runs in place without
 * a nested queue worker. Cold calls copy plain pixels and options and read 2D canvases before the module loads.
 * maxPendingJobs includes these calls. maxPendingBytes bounds their total retained snapshot bytes until they settle.
 * Loaded in-place calls, including Node, Deno, Bun, and edge calls, make no queue copy. workerFactory,
 * workerStartupTimeout, and maxPendingBytes have no effect there. maxPendingJobs still applies.
 * Configuring during a configured call refuses JXL_OPTIONS. An unconfigured call keeps running unchanged.
 * @example configure({helpers: {count: 3, memoryBytes: 1 << 30}}); */
export function configure(settings?: CodecConfig): void;
/** Ends this module's worker and helpers. The next call starts them again.
 * Cancels cold calls still waiting to start. Calls already running in place are neither canceled nor awaited.
 * @example await close(); */
export function close(): Promise<void>;

