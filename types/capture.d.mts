import type {EncodedResult, ImageResult} from './result.mjs';
import type {CaptureInput as FullCaptureInput, TextureInput, CaptureOptions} from './types.mjs';
import type {ResumableFunction} from './resumable.mjs';
import type {CodecConfig} from './types.mjs';
export type {CaptureOptions, CaptureFidelity, MaxError, ImageInput, CapturePixels, Bytes} from './types.mjs';
/** Input admitted by the lean screenshot encoder; GPU textures belong to capture-complete. */
export type CaptureInput = Exclude<FullCaptureInput, TextureInput>;
export type {ImagePreview, PreviewOptions} from './types.mjs';
/** The screenshot encoder in one file: a page's calls run in its own worker; calls in a worker, Node and edge hosts run in place. 8-bit sRGB or Display P3 RGBA, exact or within maxError.
 * Efforts 1-5. `rapier-jxl/capture-complete` adds photographic fidelity, efforts 6-9 and WebGPU. Invalid options refuse JXL_OPTIONS, unsupported efforts and textures JXL_UNSUPPORTED, and unreadable canvas data JXL_PLATFORM. */
export const capture: ResumableFunction<(input: CaptureInput, options?: CaptureOptions) => Promise<EncodedResult>>;
/** Compiles the kernels and warms the coder, with no job. */
export function prepare(): Promise<void>;
/** True when this realm runs the capture encoder. supported('webgpu') is false: captures run on WebAssembly only. */
export function supported(feature?: 'webgpu'): Promise<boolean>;

export type {ImageJob, ImageVerb, Digest, ResultSource, ResultReason, ResultTransform, ResultFidelity, ResultMeasurement, ImageResult, EncodedResult} from './result.mjs';

/** This module's settings for the calls that follow. In a browser they are its queue's: the module runs in its own file's
 * worker, from a page or nested in a worker of the page's own; configure before the first call, or again once close() has
 * resolved. In place (Node, Deno, Bun, edge hosts, a page's own worker) it takes the same
 * keys: maxPixels, and maxPendingJobs bounding the calls pending at once; no worker starts and nothing is copied
 * there, so the worker settings and maxPendingBytes have nothing to act on. Configuring while a call runs refuses JXL_OPTIONS. */
export function configure(settings?: Omit<CodecConfig, 'webgpu' | 'helpers'>): void;
/** Ends this module's worker and helpers; the next call starts them again. */
export function close(): Promise<void>;

/** Every refusal: a coded Error. */
export type {CodecError, ErrorCode} from './types.mjs';
