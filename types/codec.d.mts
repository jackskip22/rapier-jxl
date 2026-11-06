import type {ImageResult} from './result.mjs';
import type {ImageInput, TextureInput, UploadInput, CaptureInput, UploadCaptureInput, CapturePhotoOptions, UploadCaptureOptions, EncodeOptions, UploadOptions, CaptureOptions, AnimationInput, AnimationOptions, CodecConfig, CodecStats, DecodeOptions, DecodedImage, JPEGOptions, JobOptions} from './types.mjs';
import type {PreparationInput, FitOptions, VariantsOptions} from './types.mjs';
import type {UploadPreparationInput, UploadFitOptions, UploadVariantsOptions} from './preparation-upload.mjs';
import type {CaptureCompleteOptions} from './capture-complete.mjs';
export type {EncodeOptions, UploadOptions, ImageInput, CaptureInput, Bytes, CodecConfig, CodecStats} from './types.mjs';
export type {CapturePhotoOptions} from './types.mjs';
export type {CaptureCompleteOptions} from './capture-complete.mjs';
/** rapier-jxl/capture-complete's capture options, as a codec over it takes them (rapier-jxl/capture's own are its CaptureOptions). */
export type {CaptureCompleteOptions as CaptureOptions} from './capture-complete.mjs';
/** A queue over one main module: progress, cancel, helpers and close. In browsers it runs the module's own complete
 * worker file; in Node, Deno and Bun the module in place. It writes the bytes the module writes for the same call. */
/** transfer: true hands the pixels' ArrayBuffer to the codec instead of a copy; the caller's buffer is detached by the call. */
type Handed = {transfer?: true};
interface ModuleCodec {
  /** Refuses new work and cancels every queued and running job with JXL_CLOSED; resolves once the worker and helpers end. */
  close(): Promise<void>;
  readonly stats: CodecStats;
}
interface EncodingCodec extends ModuleCodec {
  encode(input: ImageInput, options?: EncodeOptions & Handed): Promise<ImageResult>;
  capture(input: CaptureInput, options?: CaptureCompleteOptions & Handed): Promise<ImageResult>;
  /** Starts the worker and loads the module, compiling its WebAssembly, with no job and no queue slot. */
  prepare(operation: 'encode' | 'capture'): Promise<void>;
}
/** The default codec, over rapier-jxl: pictures in. Page capture is a codec over rapier-jxl/capture or capture-complete. */
export interface StillCodec extends ModuleCodec {
  encode(input: ImageInput, options?: EncodeOptions & Handed): Promise<ImageResult>;
  fit(input: PreparationInput, options: FitOptions & Handed): Promise<ImageResult>;
  variants(input: PreparationInput, options: VariantsOptions & Handed): Promise<ImageResult[]>;
  prepare(operation: 'encode' | 'fit' | 'variants'): Promise<void>;
}
export interface UploadCodec extends ModuleCodec {
  encode(input: UploadInput, options?: UploadOptions & Handed): Promise<ImageResult>;
  capture(input: UploadCaptureInput, options?: UploadCaptureOptions & Handed): Promise<ImageResult>;
  fit(input: UploadPreparationInput, options: UploadFitOptions & Handed): Promise<ImageResult>;
  variants(input: UploadPreparationInput, options: UploadVariantsOptions & Handed): Promise<ImageResult[]>;
  prepare(operation: 'encode' | 'capture' | 'fit' | 'variants'): Promise<void>;
}
export interface AnimationCodec extends EncodingCodec {
  encode(input: AnimationInput, options?: AnimationOptions & Handed): Promise<ImageResult>;
  encode(input: ImageInput, options?: EncodeOptions & Handed): Promise<ImageResult>;
}
export interface FormatCodec extends EncodingCodec {
  format: typeof import('./format.mjs').format;
  prepare(operation: 'format' | 'encode' | 'capture'): Promise<void>;
}
export interface CaptureCodec extends ModuleCodec {
  capture(input: Exclude<CaptureInput, TextureInput>, options?: CaptureOptions & Handed): Promise<ImageResult>;
  prepare(operation: 'capture'): Promise<void>;
}
export interface CaptureCompleteCodec extends ModuleCodec {
  capture(input: CaptureInput, options?: CaptureCompleteOptions & Handed): Promise<ImageResult>;
  prepare(operation: 'capture'): Promise<void>;
}
export interface DecodeCodec extends ModuleCodec {
  decode(input: Uint8Array | Blob, options?: DecodeOptions): Promise<DecodedImage>;
  prepare(operation: 'decode'): Promise<void>;
}
export interface JPEGCodec extends ModuleCodec {
  recompress(input: Uint8Array | Blob, options?: JPEGOptions): Promise<ImageResult>;
  restore(input: Uint8Array | Blob, options?: JobOptions): Promise<ImageResult>;
  prepare(operation: 'recompress' | 'restore'): Promise<void>;
}
type QueueConfig = CodecConfig;
/** `module` names the module by its import name (default rapier-jxl, the full still encoder). */
export function createCodec(config?: QueueConfig & {module?: 'rapier-jxl'}): StillCodec;
export function createCodec(config: QueueConfig & {module: 'rapier-jxl/upload'}): UploadCodec;
export function createCodec(config: QueueConfig & {module: 'rapier-jxl/animation'}): AnimationCodec;
export function createCodec(config: QueueConfig & {module: 'rapier-jxl/format'}): FormatCodec;
export function createCodec(config: Omit<QueueConfig, 'webgpu' | 'helpers'> & {module: 'rapier-jxl/capture'; webgpu?: never; helpers?: never}): CaptureCodec;
/** helpers: one capture's color groups written in parallel; captures in one codec still run one at a time. webgpu: every
 * capture's default, as encode's (a call's own wins). */
export function createCodec(config: QueueConfig & {module: 'rapier-jxl/capture-complete'}): CaptureCompleteCodec;
export function createCodec(config: Omit<QueueConfig, 'webgpu' | 'helpers'> & {module: 'rapier-jxl/decode'; webgpu?: never; helpers?: never}): DecodeCodec;
export function createCodec(config: Omit<QueueConfig, 'webgpu' | 'helpers'> & {module: 'rapier-jxl/jpeg'; webgpu?: never; helpers?: never}): JPEGCodec;
type Codecs = {'rapier-jxl': StillCodec; 'rapier-jxl/upload': UploadCodec; 'rapier-jxl/animation': AnimationCodec; 'rapier-jxl/format': FormatCodec;
  'rapier-jxl/capture': CaptureCodec; 'rapier-jxl/capture-complete': CaptureCompleteCodec; 'rapier-jxl/decode': DecodeCodec; 'rapier-jxl/jpeg': JPEGCodec};
type Plain = 'rapier-jxl/capture' | 'rapier-jxl/decode' | 'rapier-jxl/jpeg';
/** A module chosen at run time (`module: wide ? 'rapier-jxl/capture-complete' : 'rapier-jxl/capture'`): the codec of
 * either, so a call takes what both take; webgpu and helpers only when every choice takes them. */
export function createCodec<M extends keyof Codecs>(config: ([Extract<M, Plain>] extends [never] ? QueueConfig :
  Omit<QueueConfig, 'webgpu' | 'helpers'> & {webgpu?: never; helpers?: never}) & {module: M}): Codecs[M];

export type {ImageJob, ImageVerb, Digest, ResultSource, ResultReason, ResultTransform, ResultFidelity, ResultMeasurement, ImageResult, ImageResultJSON} from './result.mjs';
