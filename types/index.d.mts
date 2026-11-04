import type {WasmBundle} from './wasm.mjs';
import type {ImageInput, CaptureInput, EncodeOptions, Bytes, PreparationInput, FitOptions, VariantsOptions, PreparationResult, PixelFidelity} from './types.mjs';
import type {CaptureCompleteOptions as CaptureOptions} from './capture-complete.mjs';
export type * from './types.mjs';
export type {CaptureCompleteOptions as CaptureOptions, CapturePhotoFidelity as CaptureFidelity, CaptureRecord} from './capture-complete.mjs';
export type {WasmBundle} from './wasm.mjs';
/** rapier-jxl: the full still encoder in one file, run in place: efforts 1-9, exact or lossy, measured fidelity, WebGPU
 * at lossy efforts 7-9, HDR and deeper samples, ICC, codestream features and the exact JPEG carry. An animation is
 * encoded by rapier-jxl/animation; a file's header and metadata are rapier-jxl/metadata's; a worker and queue over any
 * module is rapier-jxl/codec. */
export function encode(input: ImageInput, options?: EncodeOptions): Promise<Bytes>;
export function capture(input: CaptureInput, options?: CaptureOptions): Promise<Bytes>;
/** Fit the same oriented dimensions to maxBytes within explicit fidelity bounds. No fit is an ordinary result. */
export function fit(input: PreparationInput, options: FitOptions): Promise<PreparationResult<PixelFidelity>>;
/** Acquire/orient once and encode each explicitly sized output independently. No partial results on cancellation. */
export function variants(input: PreparationInput, options: VariantsOptions): Promise<PreparationResult[]>;
/** The kernels compiled (and, for 'capture', the capture coder warmed), with no job. */
export function prepare(operation?: 'encode' | 'capture' | 'fit' | 'variants'): Promise<void>;
/** Whether this realm compiles the WebAssembly kernels with SIMD; with 'webgpu', whether this realm offers a usable WebGPU
 * adapter; a job may still run on WebAssembly. */
export function supported(feature?: 'webgpu'): Promise<boolean>;
/** Installs the bundle from `rapier-jxl/wasm` in this realm, before the first encode. */
export function configureWasm(bundle: WasmBundle): void;
