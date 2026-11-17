import type {EncodedResult, ImageResult} from './result.mjs';
import type {JPEGOptions, JobOptions} from './types.mjs';
import type {ResumableFunction} from './resumable.mjs';
import type {CodecConfig} from './types.mjs';
export type {JPEGOptions, JobOptions};
/** In one file: a page's calls run in its own worker; calls in a worker, Node and edge hosts run in place. A JPEG's coefficients coded as JPEG XL with no loss, with what restore needs to write the same JPEG back. The input
 * and options are taken at the call; effort is 7 unless given; maxPixels (no default) bounds the JPEG's size, and
 * restore's (JXL_DIMENSIONS); an input the host cannot hold refuses JXL_MEMORY. Combined APP, COM, inter-marker and inline-tail
 * reconstruction payload above 64 MiB refuses JXL_JPEG. Caller bytes use plain Uint8Array;
 * SharedArrayBuffer backing is refused at runtime with JXL_INPUT. Invalid options refuse JXL_OPTIONS, oversize pictures JXL_DIMENSIONS, and unavailable SIMD JXL_WASM. */
export interface RecompressOptions extends JPEGOptions {
  /** A phone's HDR photo (Ultra HDR, ISO 21496-1) keeps its gain map where every decoder that shows HDR reads it: the
   * jhgm box, its metadata in ISO 21496-1 form. restore still returns the exact JPEG; facts.otherDecoders counts the
   * bytes another decoder's JPEG leaves out (the gain map JPEG). A photo without one is recompressed as without the option. */
  gainMap?: boolean; }
export const recompress: ResumableFunction<(input: Uint8Array | Blob, options?: RecompressOptions) => Promise<EncodedResult>>;
/** The JPEG a recompressed file was made from, restored exactly. A file with no reconstruction data refuses
 * JXL_RECONSTRUCTION. jpegxl/metadata header(bytes).reconstruction says, without a decode, whether the bytes hold a
 * reconstruction box; restore alone says whether the JPEG comes back.
 * Unknown restore options refuse JXL_OPTIONS. */
export const restore: ResumableFunction<(input: Uint8Array | Blob, options?: JobOptions) => Promise<EncodedResult>>;
/** Compiles the WebAssembly kernels recompress needs; restore needs none. */
export function prepare(): Promise<void>;
/** Whether this realm compiles the WebAssembly kernels with SIMD, which recompress needs. supported('webgpu') is false. */
export function supported(feature?: 'webgpu'): Promise<boolean>;

export type {ImageJob, ImageVerb, Digest, ResultSource, ResultReason, ResultTransform, ResultFidelity, ResultMeasurement, ResultOtherDecoders, ImageResult, EncodedResult} from './result.mjs';

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
