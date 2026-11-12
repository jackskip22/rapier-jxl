import type {ImageResult} from './result.mjs';
import type {WasmBundle} from './wasm.mjs';
import type {ImageInput, EncodeOptions, PreparationInput, FitOptions, VariantsOptions} from './types.mjs';
import type {ResumableFunction} from './resumable.mjs';
export type * from './types.mjs';
// Types only: page capture's options keep their names here; the function is rapier-jxl/capture-complete's.
export type {CaptureCompleteOptions as CaptureOptions, CapturePhotoFidelity as CaptureFidelity, CaptureRecord} from './capture-complete.mjs';
export type {WasmBundle} from './wasm.mjs';
/** rapier-jxl: the full still encoder in one file, run in place: efforts 1-9, exact or lossy, measured fidelity, WebGPU
 * at lossy efforts 7-9, HDR and deeper samples, ICC and codestream features. It encodes pixels. For reversible JPEG
 * storage, use rapier-jxl/jpeg's recompress; an exact JPEG Blob here refuses with that name. An animation is
 * encoded by rapier-jxl/animation; a file's header and metadata are rapier-jxl/metadata's; a worker and queue over any
 * module is rapier-jxl/codec. Page capture is rapier-jxl/capture and rapier-jxl/capture-complete. */
export const encode: ResumableFunction<(input: ImageInput, options?: EncodeOptions) => Promise<ImageResult>>;
/** Fit the same oriented dimensions to maxBytes within explicit fidelity bounds. No fit is an ordinary result. */
export const fit: ResumableFunction<(input: PreparationInput, options: FitOptions) => Promise<ImageResult>>;
/** Acquire/orient once and encode each explicitly sized output independently. No partial results on cancellation. */
export const variants: ResumableFunction<(input: PreparationInput, options: VariantsOptions) => Promise<ImageResult[]>>;
/** The kernels compiled, with no job. */
export function prepare(operation?: 'encode' | 'fit' | 'variants'): Promise<void>;
/** Whether this realm compiles the WebAssembly kernels with SIMD; with 'webgpu', whether this realm offers a usable WebGPU
 * adapter; a job may still run on WebAssembly. */
export function supported(feature?: 'webgpu'): Promise<boolean>;
/** Installs the bundle from `rapier-jxl/wasm` in this realm, before the first encode. */
export function configureWasm(bundle: WasmBundle): void;

export {resultJSON} from './result.mjs';
