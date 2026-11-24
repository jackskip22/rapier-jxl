import type {EncodedResult, ImageResult} from './result.mjs';
import type {CaptureInput as FullCaptureInput, TextureInput, CaptureOptions} from './types.mjs';
import type {ResumableFunction} from './resumable.mjs';
import type {CodecConfig} from './types.mjs';
export type {CaptureOptions, CaptureFidelity, MaxError, ImageInput, CapturePixels, Bytes} from './types.mjs';
/** Input admitted by the lean screenshot encoder. GPU textures belong to capture-complete. */
export type CaptureInput = Exclude<FullCaptureInput, TextureInput>;
export type {ImagePreview, PreviewOptions} from './types.mjs';
/** The screenshot encoder in one file: a page's calls run in its own worker. Calls in a worker, Node and edge hosts run in place. 8-bit sRGB or Display P3 RGBA, exact or within maxError.
 * Efforts 1-5. `jpegxl/capture-complete` adds photographic fidelity, efforts 6-9 and WebGPU. Invalid options refuse JXL_OPTIONS, unsupported efforts and textures JXL_UNSUPPORTED, and unreadable canvas data JXL_PLATFORM.
 * @example const {bytes} = await capture(canvas); // exact */
export const capture: ResumableFunction<(input: CaptureInput, options?: CaptureOptions) => Promise<EncodedResult>>;
/** Compiles the kernels and warms the coder, with no job.
 * @example await prepare(); */
export function prepare(): Promise<void>;
/** True when this realm runs the capture encoder. supported('webgpu') is false: captures run on WebAssembly only.
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
export function configure(settings?: Omit<CodecConfig, 'webgpu' | 'helpers'>): void;
/** Ends this module's worker and helpers. The next call starts them again.
 * Cancels cold calls still waiting to start. Calls already running in place are neither canceled nor awaited.
 * @example await close(); */
export function close(): Promise<void>;

/** Codes for refusals raised by rapier-jxl. Caller callback errors and abort reasons pass through unchanged. */
export type {CodecError, ErrorCode} from './types.mjs';
