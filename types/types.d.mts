import type {EncodeOptions as CodecOptions, ColorSpace} from './codec/index.mjs';
import type {AdvancedPhotoOptions} from './codec/photo-advanced.mjs';
import type {ScoreTarget} from './codec/score.mjs';
import type {DecodedImage, DecodeOptions as CodecDecodeOptions} from './codec/decode.mjs';
import type {Animation} from './codec/animation.mjs';
import type {FormatRequest, FormatOptions} from './format.mjs';

export type Samples = Uint8Array | Uint8ClampedArray | Uint16Array | Float32Array;
export type Bytes = Uint8Array<ArrayBuffer>;
export type Effort = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
export interface Pixels { data: Samples; width: number; height: number; colorSpace?: ColorSpace; }
export interface CanvasSurface {
  readonly width: number; readonly height: number;
  getContext(contextId: '2d', options?: {willReadFrequently?: boolean}): unknown;
}
export interface BitmapSurface { readonly width: number; readonly height: number; close(): void; }
export type ImageInput = Pixels | CanvasSurface | BitmapSurface | Blob;
export interface JobOptions { signal?: AbortSignal; onProgress?: (fraction: number) => void; }
export type Acceleration = 'js' | 'wasm' | 'webgpu' | 'auto';
export type FormatFeatures = Pick<AdvancedPhotoOptions, 'extraChannels' | 'level' | 'upsampling' | 'upsamplingWeights' |
  'transforms' | 'quantization' | 'coefficientOrders' | 'progressive' | 'noise' | 'lfFrames' | 'orientation'>;
type PixelEncodingOptions = Omit<CodecOptions, 'quality'> & JobOptions & {
  effort?: Effort; acceleration?: Acceleration; losslessProfile?: 'painting' | 'painting-search';
} & (
  {lossless: true; quality?: never; target?: never; format?: FormatFeatures} |
  /** quality: 1 to 100; 100 is lossless. Lossy XYB photo quantization caps at 99.9 (a quality above it quantizes as 99.9). */
  {lossless?: false; quality?: number; target?: never; format?: FormatFeatures}
);
export type TargetEncodeOptions = JobOptions & {
  target: ScoreTarget; effort?: Effort; acceleration?: Acceleration;
  lossless?: false; quality?: never; format?: never;
  colorSpace?: 'srgb'; bitDepth?: 8; sampleFormat?: 'uint'; transferFunction?: 'srgb';
  alphaPremultiplied?: false; intensityTarget?: 255;
  icc?: never; iccCompression?: never; photo?: never; filter?: never; losslessProfile?: never;
};
export type EncodeOptions = PixelEncodingOptions | TargetEncodeOptions;
export type AnimationOptions = PixelEncodingOptions & {format?: never};
export interface CaptureOptions extends JobOptions {
  maxError?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  colorSpace?: ColorSpace; acceleration?: 'js' | 'wasm' | 'auto';
}
export interface JPEGOptions extends JobOptions {
  effort?: Effort; icc?: 'preserve'; iccCompression?: 'auto' | 'prefix' | 'lz77';
  acceleration?: 'js' | 'wasm' | 'auto';
}
export type DecodeOptions = CodecDecodeOptions & JobOptions;
export type {DecodedImage, Animation};
export interface WorkerLike {
  postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
  terminate(): void | Promise<number>;
  addEventListener?(type: string, listener: (event: any) => void): void;
  removeEventListener?(type: string, listener: (event: any) => void): void;
  on?(type: string, listener: (...args: any[]) => void): unknown;
  off?(type: string, listener: (...args: any[]) => void): unknown;
}
export interface EncoderConfig {
  worker?: false;
  workerFactory?: () => WorkerLike;
  workerStartupTimeout?: number;
  maxInputBytes?: number;
  maxPixels?: number;
  maxQueuedJobs?: number;
  /**
   * Helper workers granted only from this reservation: at most `count` helpers (0–16) inside `memoryBytes`, kept from
   * their first job until close(). Jobs waiting together run at once, up to `count + 1`, the others whole on
   * the helpers; a lossy job alone uses them all at effort 7 and above on half a megapixel or more. None by default; the CPU
   * count grants nothing. The bytes are the same with any number of helpers.
   */
  helpers?: { count: number; memoryBytes: number };
}
export interface EncoderStats {
  readonly queuedJobs: number; readonly queuedBytes: number;
  readonly activeJobs: number; readonly activeBytes: number;
  readonly closed: boolean; readonly workerGeneration: number;
}
export interface Encoder {
  encode(input: ImageInput, options?: EncodeOptions): Promise<Bytes>;
  capture(input: ImageInput, options?: CaptureOptions): Promise<Bytes>;
  recompress(input: Uint8Array | Blob, options?: JPEGOptions): Promise<Bytes>;
  restore(input: Uint8Array | Blob, options?: JobOptions): Promise<Bytes>;
  decode(input: Uint8Array | Blob, options?: DecodeOptions): Promise<DecodedImage>;
  animate(input: Animation, options?: AnimationOptions): Promise<Bytes>;
  format(input: FormatRequest, options?: FormatOptions): Promise<Bytes>;
  /** Starts the worker with no job; resolves when it is ready (at once in place). */
  prepare(): Promise<void>;
  close(): void;
  readonly stats: EncoderStats;
}
