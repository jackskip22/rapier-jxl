// SPDX-License-Identifier: MIT
export type Pixels = Uint8Array | Uint8ClampedArray | Uint16Array | Float32Array;
/** Encoded bytes own an ordinary ArrayBuffer: accepted by Blob and transferable to a worker. */
export type Bytes = Uint8Array<ArrayBuffer>;
export type ColorSpace = 'srgb' | 'display-p3' | 'rec2020';
export type SampleFormat = 'uint' | 'float16' | 'float32';
export type TransferFunction = 'srgb' | 'linear' | 'pq' | 'hlg';
export interface Limits { readonly bytes: number; readonly pixels: number; readonly edge: number; }
/** The core's limits: the 16 MiB codestream, 24 million pixels, 16,384 on a side; a larger ask is refused before any
 * work. The photo door takes 40 million pixels and the JPEG carrier 64 million, each by its memory. */
export const LIMITS: Limits;
export interface EncodeOptions {
  /** 1 to 100; 100 is exact. */ quality?: number | undefined;
  /** The samples' colour space, declared in the header; 'srgb' by default. */ colorSpace?: ColorSpace | undefined;
  /** Integer code-value depth: 8 for bytes; 10, 12 or 16 for Uint16Array (default 16).
   * Floating-point depth is fixed by the sample format: 16 or 32. */ bitDepth?: 8 | 10 | 12 | 16 | 32 | undefined;
  /** Inferred as uint for integer arrays or float32 for Float32Array. float16 uses raw IEEE binary16 words in Uint16Array. */
  sampleFormat?: SampleFormat | undefined;
  /** Declares the samples' existing transfer function. Defaults to srgb for integers, linear for floats; no colour conversion. */
  transferFunction?: TransferFunction | undefined;
  /** Positive peak luminance in nits, stored as binary16. Defaults to 10000 for PQ, 1000 for HLG, otherwise 255. */
  intensityTarget?: number | undefined;
  /** The source already contains associated RGB, as in OpenEXR; default false. Values are never unpremultiplied. */
  alphaPremultiplied?: boolean | undefined;
}
export type ErrorCode = 'JXL_INPUT' | 'JXL_DIMENSIONS' | 'JXL_SIZE' | 'JXL_MEMORY' | 'JXL_JPEG';
/** Checked encoding entries refuse with one of these codes. Low-level writer preconditions are unchecked. */
export interface EncoderError extends Error { code: ErrorCode; }
/** Straight RGBA samples, row by row, to a bare JPEG XL codestream; quality 100 (the default) is exact.
 * Native precision below quality 100 rounds RGB code values or mantissa bits; alpha remains bit-exact. */
export function encode(data: Pixels, width: number, height: number, options?: EncodeOptions): Bytes;
/** Iterate progress in (0, 1], ending at 1. Exhaust the iterator to set `bytes`; a final yielded 1 alone is not
 * completion. Leaving the loop cancels. `hurry` asks a search to finish with a completed candidate. A cancelled or
 * already finished iterator returns undefined. */
export interface Job<Output extends Uint8Array = Bytes> extends Generator<number, Output | undefined, undefined> {
  bytes: Output | null;
  hurry: boolean;
  return(value?: Output): IteratorResult<number, Output | undefined>;
  [Symbol.iterator](): this;
}
/** encode's work and bytes, a group of one pass per step; the call is admitted at once. */
export function encodeSteps(data: Pixels, width: number, height: number, options?: EncodeOptions): Job;
