// SPDX-License-Identifier: MIT
export type Pixels = Uint8Array | Uint8ClampedArray | Uint16Array | Float32Array;
/** Encoded bytes use an ArrayBuffer compatible with Blob and worker transfer. */
export type Bytes = Uint8Array<ArrayBuffer>;
export type ColorSpace = 'srgb' | 'display-p3' | 'rec2020';
export type SampleFormat = 'uint' | 'float16' | 'float32';
export type TransferFunction = 'srgb' | 'linear' | 'pq' | 'hlg';
export interface Limits { readonly pixels: number; readonly edge: number; }
/** Core limits: 24 million pixels and 16,384 pixels per side. Encoded output is bounded by available memory. */
export const LIMITS: Limits;
export interface EncodeOptions {
  /** 1 to 100; 100 is exact. Lossy XYB photo quantization caps at 99.9 (a quality above it quantizes as 99.9). */ quality?: number | undefined;
  /** Photographic coding for non-palette straight RGBA8 below quality 100; default true.
   * Set false for Modular lossy coding. Palette, native-precision and exact inputs keep their existing path. */
  photo?: boolean | undefined;
  /** "auto" (default) or "off" for photographic paths outside V6.
   * The ordinary V6 photo path always uses its own filters; this option does not disable them. Alpha remains exact. */
  filter?: 'auto' | 'off' | undefined;
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
  /** Original defined three-component ICC.1 profile or GRAY, retained byte-for-byte without color conversion. Mutually exclusive
   * with colorSpace and transferFunction. Eight-bit samples below quality 100 are coded as photographs (a matrix/TRC profile through its own
   * primaries and curves in XYB; a gray one, or one that needs a color engine, as the samples are) and are decoded back into the profile;
   * deeper samples use Modular coding. Gray needs identical RGB words.
   * Profiles above 4 MiB select level 10. The complete profile and encoded output must fit available memory. */
  icc?: Uint8Array | undefined;
  /** Default auto compares exact prefix and LZ77 bit lengths. Requires icc. */
  iccCompression?: 'auto' | 'prefix' | 'lz77' | undefined;
}
export type ErrorCode = 'JXL_INPUT' | 'JXL_DIMENSIONS' | 'JXL_SIZE' | 'JXL_MEMORY' | 'JXL_JPEG' | 'JXL_RECONSTRUCTION' | 'JXL_TARGET';
/** Encoding entry points throw these codes. Low-level writers do not validate preconditions. */
export interface EncoderError extends Error { code: ErrorCode; }
/** Encode row-major RGBA as JPEG XL. Quality 100 (default) preserves all samples exactly.
 * Ordinary non-palette RGBA8 below quality 100 uses photographic coding at effort 1 unless photo is false.
 * Native precision quantizes RGB code values or mantissa bits; alpha remains exact on every path. */
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
/** The same bytes as `encode` for every input. A photograph of about a megapixel or more runs its forward stages on
 * WebGPU when the page has it; `gpu: false` keeps the CPU, `gpu: true` or a `GPUDevice` passed in uses the GPU at any size. With no adapter, a lost device
 * or any GPU error it runs on the CPU. */
export function encodeAsync(data: Pixels, width: number, height: number, options?: EncodeOptions & {gpu?: boolean | object}): Promise<Bytes>;
