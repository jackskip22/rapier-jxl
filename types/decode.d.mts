import type {DecodeOptions, DecodedImage, DecodedImageOf} from './types.mjs';
import type {CodecConfig} from './types.mjs';
export type {DecodeOptions, DecodedImage, DecodedImageOf};
/** The whole picture decoded: a page's calls run in its own worker; calls in a worker, Node and edge hosts run in place. Every decoder part and the Brotli dictionary are in this module, so nothing
 * loads after its import. A cut or malformed file refuses JXL_DECODE or JXL_INPUT; an invalid option JXL_OPTIONS, a limit JXL_LIMIT, unsupported HDR conversion JXL_UNSUPPORTED, and unavailable memory JXL_MEMORY.
 * Decoded frames are in `result.frames`. `result.animation` gives the tick rate and loop count. A literal `format` types
 * `result.data`: `{format: 'uint8'}` gives a Uint8ClampedArray. */
export function decode<F extends NonNullable<DecodeOptions['format']> = 'auto'>(input: Uint8Array | Blob,
  options?: DecodeOptions & {format?: F}): Promise<DecodedImageOf<F>>;
/** Compiles the WebAssembly kernels before the first decode. Decoding requires WebAssembly with SIMD; without it this
 * and decode() reject with JXL_WASM. */
export function prepare(): Promise<void>;
/** Whether this realm decodes: WebAssembly with SIMD compiles here. supported('webgpu') is false: the decoder runs
 * nothing on WebGPU.
 * Other feature names refuse JXL_OPTIONS. */
export function supported(feature?: 'webgpu'): Promise<boolean>;

/** This module's settings for the calls that follow. In a browser they are its queue's: the module runs in its own file's
 * worker, from a page or nested in a worker of the page's own; configure before the first call, or again once close() has
 * resolved. In place (Node, Deno, Bun, edge hosts, a page's own worker) it takes the same keys: maxPixels, and
 * maxPendingJobs bounding the calls pending at once; no worker starts and nothing is copied there, so the worker settings
 * and maxPendingBytes have nothing to act on. Configuring while a call runs refuses JXL_OPTIONS. */
export function configure(settings?: Omit<CodecConfig, 'webgpu' | 'helpers'>): void;
/** Ends this module's worker and helpers; the next call starts them again. */
export function close(): Promise<void>;

/** Every refusal: a coded Error. */
export type {CodecError, ErrorCode} from './types.mjs';
