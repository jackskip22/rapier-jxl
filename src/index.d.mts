// SPDX-License-Identifier: MIT
export type Pixels = Uint8Array | Uint8ClampedArray | Uint16Array | Float32Array;
/** Encoded bytes use an ArrayBuffer compatible with Blob and worker transfer. */
export type Bytes = Uint8Array<ArrayBuffer>;
export type ColorSpace = 'srgb' | 'display-p3' | 'rec2020';
export type SampleFormat = 'uint' | 'float16' | 'float32';
export type TransferFunction = 'srgb' | 'linear' | 'pq' | 'hlg';
export interface Limits { readonly bytes: number; readonly pixels: number; readonly edge: number; }
/** Core limits: 16 MiB output, 24 million pixels, and 16,384 pixels per side. Input limits apply before encoding. */
export const LIMITS: Limits;
export interface EncodeOptions {
  /** 1 to 100; 100 is exact. */ quality?: number | undefined;
  /** Source color space, declared without conversion; default 'srgb'. */ colorSpace?: ColorSpace | undefined;
  /** Integer code-value depth: 8 for bytes; 10, 12, or 16 for Uint16Array (default 16).
   * Floating-point depth is fixed by the sample format: 16 or 32. */ bitDepth?: 8 | 10 | 12 | 16 | 32 | undefined;
  /** Inferred as uint for integer arrays or float32 for Float32Array. float16 uses raw IEEE binary16 words in Uint16Array. */
  sampleFormat?: SampleFormat | undefined;
  /** Declares the samples' existing transfer function. Defaults to srgb for integers, linear for floats; no color conversion. */
  transferFunction?: TransferFunction | undefined;
  /** Positive peak luminance in nits, stored as binary16. Defaults to 10000 for PQ, 1000 for HLG, otherwise 255. */
  intensityTarget?: number | undefined;
  /** Source RGB is premultiplied by alpha; default false. Values are never unpremultiplied. */
  alphaPremultiplied?: boolean | undefined;
}
export type ErrorCode = 'JXL_INPUT' | 'JXL_DIMENSIONS' | 'JXL_SIZE' | 'JXL_MEMORY' | 'JXL_JPEG';
/** Encoding entry points throw these codes. Low-level writers do not validate preconditions. */
export interface EncoderError extends Error { code: ErrorCode; }
/** Encode row-major RGBA as JPEG XL. Quality 100 (default) preserves all samples exactly.
 * Below quality 100, native precision quantizes RGB code values or mantissa bits; alpha remains exact. */
export function encode(data: Pixels, width: number, height: number, options?: EncodeOptions): Bytes;
/** Yields progress in (0, 1]. Exhaust the iterator to set `bytes`; yielding 1 does not complete the job.
 * Leaving the loop cancels. `hurry` finishes a search with a completed candidate.
 * Canceled or completed iterators return undefined. */
export interface Job<Output extends Uint8Array = Bytes> extends Generator<number, Output | undefined, undefined> {
  bytes: Output | null;
  hurry: boolean;
  return(value?: Output): IteratorResult<number, Output | undefined>;
  [Symbol.iterator](): this;
}
/** Validate input immediately, then yield one group of one pass per step. */
export function encodeSteps(data: Pixels, width: number, height: number, options?: EncodeOptions): Job;
