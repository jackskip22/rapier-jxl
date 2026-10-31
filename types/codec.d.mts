import type {ImageInput, EncodeOptions, UploadOptions, CaptureOptions, AnimationInput, AnimationOptions, Bytes, CodecConfig, CodecStats, DecodeOptions, DecodedImage, JPEGOptions, JobOptions} from './types.mjs';
import type {FormatRequest, FormatOptions} from './format.mjs';
export type {EncodeOptions, UploadOptions, CaptureOptions, ImageInput, Bytes, CodecConfig, CodecStats} from './types.mjs';
/** A queue over one main module: progress, cancel, helpers and close. In browsers it runs the module's own complete
 * worker file; in Node, Deno and Bun the module in place. It writes the bytes the module writes for the same call. */
interface ModuleCodec {
  /** Refuses new work and cancels every queued and running job with JXL_CLOSED; resolves once the worker and helpers end. */
  close(): Promise<void>;
  readonly stats: CodecStats;
}
export interface StillCodec extends ModuleCodec {
  encode(input: ImageInput, options?: EncodeOptions): Promise<Bytes>;
  capture(input: ImageInput, options?: CaptureOptions): Promise<Bytes>;
  /** Starts the worker and loads the module, compiling its WebAssembly, with no job and no queue slot. */
  prepare(operation: 'encode' | 'capture'): Promise<void>;
}
export interface UploadCodec extends ModuleCodec {
  encode(input: ImageInput, options?: UploadOptions): Promise<Bytes>;
  capture(input: ImageInput, options?: CaptureOptions): Promise<Bytes>;
  prepare(operation: 'encode' | 'capture'): Promise<void>;
}
export interface AnimationCodec extends StillCodec {
  encode(input: AnimationInput, options?: AnimationOptions): Promise<Bytes>;
  encode(input: ImageInput, options?: EncodeOptions): Promise<Bytes>;
}
export interface FormatCodec extends StillCodec {
  format<R extends FormatRequest>(input: R, options?: FormatOptions<R['kind']>): Promise<Bytes>;
  prepare(operation: 'format' | 'encode' | 'capture'): Promise<void>;
}
export interface CaptureCodec extends ModuleCodec {
  capture(input: ImageInput, options?: CaptureOptions): Promise<Bytes>;
  prepare(operation: 'capture'): Promise<void>;
}
export interface DecodeCodec extends ModuleCodec {
  decode(input: Uint8Array | Blob, options?: DecodeOptions): Promise<DecodedImage>;
  prepare(operation: 'decode'): Promise<void>;
}
export interface JPEGCodec extends ModuleCodec {
  recompress(input: Uint8Array | Blob, options?: JPEGOptions): Promise<Bytes>;
  restore(input: Uint8Array | Blob, options?: JobOptions): Promise<Bytes>;
  prepare(operation: 'recompress' | 'restore'): Promise<void>;
}
type QueueConfig = CodecConfig;
/** `module` names the module by its import name (default rapier-jxl, the full still encoder). */
export function createCodec(config?: QueueConfig & {module?: 'rapier-jxl'}): StillCodec;
export function createCodec(config: QueueConfig & {module: 'rapier-jxl/upload'}): UploadCodec;
export function createCodec(config: QueueConfig & {module: 'rapier-jxl/animation'}): AnimationCodec;
export function createCodec(config: QueueConfig & {module: 'rapier-jxl/format'}): FormatCodec;
export function createCodec(config: Omit<QueueConfig, 'webgpu' | 'helpers'> & {module: 'rapier-jxl/capture'}): CaptureCodec;
export function createCodec(config: Omit<QueueConfig, 'webgpu' | 'helpers'> & {module: 'rapier-jxl/decode'}): DecodeCodec;
export function createCodec(config: Omit<QueueConfig, 'webgpu' | 'helpers'> & {module: 'rapier-jxl/jpeg'}): JPEGCodec;
