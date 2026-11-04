// rapier-jxl/capture-complete: every capture effort, 1-9, exact, bounded and photographic; its optional queue is rapier-jxl/codec.
import type {CaptureInput, Effort, Bytes, CapturePhotoOptions} from './types.mjs';
import type {WasmBundle} from './wasm.mjs';
export type {ImageInput, CaptureInput, CapturePixels, Bytes, MaxError, Effort} from './types.mjs';
export type {CapturePhotoFidelity, CapturePhotoOptions, CaptureRect, ExactRect, CaptureRecord} from './types.mjs';
/** Photographic capture's options with efforts 8 and 9 too. */
export type CaptureCompleteOptions = Omit<CapturePhotoOptions, 'effort'> & {effort?: Effort};
/** The same name every capture module gives its capture's options. */
export type {CaptureCompleteOptions as CaptureOptions};
/** Exact, bounded and photographic capture at efforts 1-9 (rapier-jxl/capture's exact files at 1-5), GPU textures, and
 * efforts 7-9's GPU stages on a device where one answers (the same file without one); rapier-jxl captures the same.
 * rapier-jxl/upload carries its photographic capture at 1-3. */
export function capture(input: CaptureInput, options?: CaptureCompleteOptions): Promise<Bytes>;
export function prepare(operation?: 'capture'): Promise<void>;
/** supported('webgpu'): this realm has a usable GPU for efforts 7-9. */
export function supported(feature?: 'webgpu'): Promise<boolean>;
export function configureWasm(bundle: WasmBundle): void;
