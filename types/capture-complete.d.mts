import type {ImageResult} from './result.mjs';
// rapier-jxl/capture-complete: every capture effort, 1-9, exact, bounded and photographic; its optional queue is rapier-jxl/codec.
import type {CaptureInput, Effort, CapturePhotoOptions, CaptureDecoder, PackageDecode, JpegRestore} from './types.mjs';
import type {WasmBundle} from './wasm.mjs';
export type {ImageInput, CaptureInput, CapturePixels, Bytes, MaxError, Effort} from './types.mjs';
export type {CapturePhotoFidelity, CapturePhotoOptions, CaptureRect, ExactRect, CaptureRecord, CaptureDecoder} from './types.mjs';
/** Photographic capture's options with efforts 8 and 9 too. */
export type CaptureCompleteOptions = Omit<CapturePhotoOptions, 'effort'> & {effort?: Effort};
/** The same name every capture module gives its capture's options. */
export type {CaptureCompleteOptions as CaptureOptions};
/** Exact, bounded and photographic capture at efforts 1-9 (rapier-jxl/capture's exact files at 1-5), GPU textures, and
 * efforts 7-9's GPU stages on a device where one answers (the same file without one); rapier-jxl captures the same.
 * rapier-jxl/upload carries its photographic capture at 1-3. */
export function capture(input: CaptureInput, options?: CaptureCompleteOptions): Promise<ImageResult>;
export function prepare(operation?: 'capture'): Promise<void>;
/** supported('webgpu'): this realm has a usable GPU for efforts 7-9. */
export function supported(feature?: 'webgpu'): Promise<boolean>;
export function configureWasm(bundle: WasmBundle): void;
/** The one setup step for measured capture (efforts 4-9) in Node, Deno, Bun and desktop apps: `configureDecoder(decode)`
 * with rapier-jxl/decode's decode (and rapier-jxl/jpeg's restore, which rapier-jxl/verify uses). One call serves every
 * rapier-jxl module in the realm. A browser that decodes JPEG XL is used first; null clears the decoder. */
export function configureDecoder(decode: PackageDecode | CaptureDecoder | null, restore?: JpegRestore | null): void;

export {resultJSON} from './result.mjs';
export type {ImageJob, ImageVerb, Digest, ResultSource, ResultReason, ResultTransform, ResultFidelity, ResultMeasurement, ImageResult, ImageResultJSON} from './result.mjs';
