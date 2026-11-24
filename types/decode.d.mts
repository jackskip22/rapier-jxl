import type {DecodeOptions, DecodedImage, DecodedImageOf, EncodedInput} from './types.mjs';
import type {CodecConfig} from './types.mjs';
export type {DecodeOptions, DecodedImage, DecodedImageOf, EncodedInput};
/** The whole picture decoded: a page's calls run in its own worker. Calls in a worker, Node and edge hosts run in place. Every decoder part and the Brotli dictionary are in this module, so nothing
 * loads after its import. A cut or malformed file refuses JXL_DECODE or JXL_INPUT. An invalid option JXL_OPTIONS, a limit JXL_LIMIT, unsupported HDR conversion JXL_UNSUPPORTED, and unavailable memory JXL_MEMORY.
 * Decoded frames are in `result.frames`. `result.animation` gives the tick rate and loop count. A literal `format` types
 * the result, frames and preview: `{format: 'uint8'}` gives Uint8ClampedArray data throughout.
 * @example const {data, width, height} = await decode(jxl); */
export function decode<F extends NonNullable<DecodeOptions['format']> = 'auto'>(input: EncodedInput | Blob,
  options?: DecodeOptions & {format?: F}): Promise<DecodedImageOf<F>>;
/** Compiles the WebAssembly kernels before the first decode. Decoding requires WebAssembly with SIMD. Without it this
 * and decode() reject with JXL_WASM.
 * @example await prepare(); */
export function prepare(): Promise<void>;
/** Whether this realm decodes: WebAssembly with SIMD compiles here. supported('webgpu') is false: the decoder runs
 * nothing on WebGPU.
 * Other feature names refuse JXL_OPTIONS.
 * @example const gpu = await supported('webgpu'); */
export function supported(feature?: 'webgpu'): Promise<boolean>;

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
