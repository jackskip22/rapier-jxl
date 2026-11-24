import type {EncodedResult, ImageResult} from './result.mjs';
import type {JPEGOptions, JobOptions, EncodedInput} from './types.mjs';
import type {ResumableFunction} from './resumable.mjs';
import type {CodecConfig} from './types.mjs';
export type {JPEGOptions, JobOptions, EncodedInput};
/** In one file: a page's calls run in its own worker. Calls in a worker, Node and edge hosts run in place. A JPEG's coefficients coded as JPEG XL with no loss, with what restore needs to write the same JPEG back. The input
 * and options are taken at the call. effort is 7 unless given. maxPixels (no default) bounds the JPEG's size, and
 * restore's (JXL_DIMENSIONS). An input the host cannot hold refuses JXL_MEMORY. Combined APP, COM, inter-marker and inline-tail
 * reconstruction payload above 64 MiB refuses JXL_JPEG. Caller bytes use an ArrayBuffer or any view of one.
 * SharedArrayBuffer backing is refused at runtime with JXL_INPUT. Invalid options refuse JXL_OPTIONS, oversize pictures JXL_DIMENSIONS, and unavailable SIMD JXL_WASM. */
export interface RecompressOptions extends JPEGOptions {
  /** False unless true is passed: the gain map stays inside jbrd, so every decoder restores the whole JPEG. With true, a phone's HDR photo (Ultra HDR, ISO 21496-1) keeps its gain map where every decoder
   * that shows HDR reads it: the jhgm box, its metadata in ISO 21496-1 form. restore still returns the exact JPEG,
   * gain map included. djxl and other decoders restore the primary JPEG alone; otherDecoders counts the bytes they
   * leave out. A photo without
   * one is unchanged. */
  gainMap?: boolean; }
/** @example const {bytes} = await recompress(jpeg); // restores the original JPEG exactly */
export const recompress: ResumableFunction<(input: EncodedInput | Blob, options?: RecompressOptions) => Promise<EncodedResult>>;
/** The JPEG a recompressed file was made from, restored exactly. A file with no reconstruction data refuses
 * JXL_RECONSTRUCTION. jpegxl/metadata header(bytes).reconstruction says, without a decode, whether the bytes hold a
 * reconstruction box. restore alone says whether the JPEG comes back.
 * Unknown restore options refuse JXL_OPTIONS.
 * @example const {bytes: original} = await restore(jxl); */
export const restore: ResumableFunction<(input: EncodedInput | Blob, options?: JobOptions) => Promise<EncodedResult>>;
/** Compiles the WebAssembly kernels recompress needs. restore needs none.
 * @example await prepare(); */
export function prepare(): Promise<void>;
/** Whether this realm compiles the WebAssembly kernels with SIMD, which recompress needs. supported('webgpu') is false.
 * @example const gpu = await supported('webgpu'); */
export function supported(feature?: 'webgpu'): Promise<boolean>;

export type {ImageJob, ImageVerb, Digest, ResultSource, ResultReason, ResultTransform, ResultFidelity, ResultMeasurement, ResultOtherDecoders, ImageResult, EncodedResult} from './result.mjs';

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
