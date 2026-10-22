// SPDX-License-Identifier: MIT
import type {Pixels, Bytes, Job, Limits} from './index.mjs';
import type {PhotoOptions} from './photo.mjs';
import type {ExtraChannel} from './channels.mjs';
export type {Pixels, Bytes, ColorSpace, SampleFormat, TransferFunction, Limits, ErrorCode, EncoderError, Job} from './index.mjs';
export type {PhotoOptions} from './photo.mjs';

export type TransformName = 'dct8' | 'identity' | 'dct2' | 'dct4' | 'dct16' | 'dct32'
  | 'dct16x8' | 'dct8x16' | 'dct32x8' | 'dct8x32' | 'dct32x16' | 'dct16x32' | 'dct4x8' | 'dct8x4'
  | 'afv0' | 'afv1' | 'afv2' | 'afv3' | 'dct64' | 'dct64x32' | 'dct32x64' | 'dct128'
  | 'dct128x64' | 'dct64x128' | 'dct256' | 'dct256x128' | 'dct128x256';
export interface Transform {
  readonly name: TransformName;
  readonly id: number;
  /** Coded tile dimensions. Small and special strategies each occupy one 8 by 8 tile. */
  readonly width: number;
  readonly height: number;
  /** Shared quantization family; transposed strategies and AFV variants share their respective families. */
  readonly table: number;
}
export const TRANSFORMS: readonly Transform[];
export type CoefficientOrderBucketName = 'dct8' | 'small' | 'dct16' | 'dct32' | 'dct16x8' | 'dct32x8'
  | 'dct32x16' | 'dct64' | 'dct64x32' | 'dct128' | 'dct128x64' | 'dct256' | 'dct256x128';
export interface CoefficientOrderBucket {
  readonly name: CoefficientOrderBucketName;
  readonly id: number;
  /** Canonical coefficient layout: the longer dimension is the row width. */
  readonly width: number;
  readonly height: number;
  readonly lowFrequencyCount: number;
  readonly strategies: readonly TransformName[];
}
/** The 13 standard buckets shared by the 27 transform strategies. */
export const COEFFICIENT_ORDER_BUCKETS: readonly CoefficientOrderBucket[];
/** Each array is a permutation of natural-scan ranks 0 through width*height-1, with every rank before
 * lowFrequencyCount fixed in place. Null keeps the natural order. Tuples use JPEG XL frame channel order:
 * Cb/Y/Cr for YCbCr, X/Y/B for XYB. Arrays and numeric array-like inputs are copied at admission. */
export type CoefficientOrderChannels = readonly [ArrayLike<number> | null, ArrayLike<number> | null, ArrayLike<number> | null];
export type CoefficientOrderMap = Partial<Record<CoefficientOrderBucketName, CoefficientOrderChannels>>;
/** A map applies to all main-frame passes; the passes form has exactly one map per progressive pass.
 * Missing buckets and null channels use natural order. Explicit authoring overrides ordinary learned orders
 * without changing transform coefficients. LF pyramid frames retain their existing orders. */
export type CoefficientOrders = CoefficientOrderMap | {passes: readonly CoefficientOrderMap[]};
export const LIMITS: Limits;
export interface ProgressivePass { downsample: 1 | 2 | 4 | 8; shift: 0 | 1 | 2 | 3; }
/** Two through eleven passes. Resolution divisors and shifts never increase; the final pass is 1, 0. */
export interface ProgressivePlan { passes: readonly ProgressivePass[]; }
export type QuantizationVectors = readonly [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>];
/** Compact tables use positive inverse-step weights: larger weights retain finer detail. Each vector is in
 * Y/Cb/Cr order. Distance bands have one through sixteen entries, the first a positive weight and later
 * entries signed relative changes. Explicit parameters round through their actual binary16 wire fields.
 * Library selects the format's predefined table for that transform family. */
export type CompactQuantization =
  | {mode: 'library'}
  | {mode: 'identity'; weights: QuantizationVectors}
  | {mode: 'dct2'; weights: QuantizationVectors}
  | {mode: 'dct4'; bands: QuantizationVectors; multipliers: QuantizationVectors}
  | {mode: 'dct4x8'; bands: QuantizationVectors; multipliers: ArrayLike<number>}
  | {mode: 'afv'; weights: QuantizationVectors; bands4x8: QuantizationVectors; bands4x4: QuantizationVectors}
  | {mode: 'dct'; bands: QuantizationVectors};
/** Raw matrices contain one positive coefficient step per canonical coefficient in Y, Cb, Cr order.
 * Canonical rows use the longer dimension as their width; supply each shared family only once.
 * Raw steps are from 1/16 through 4095 and round to a multiple of 1/16. Compact modes identity/dct2/dct4/
 * dct4x8/afv require an 8 by 8 table family. Identity weights have three entries, DCT2 six, AFV nine;
 * DCT4 multipliers have two per channel, DCT4x8 one. jxl-oxide0.12.6 has documented compact ID/DCT2 and
 * predefined 128 by 256 table discrepancies; raw matrices retain cross-decoder interoperability. */
export type Quantization = Partial<Record<TransformName, QuantizationVectors | CompactQuantization>>
  & {dc?: ArrayLike<number> | undefined};
export type Noise = false | 'photon' | {iso: number} | readonly number[] | Float32Array | Float64Array;
export interface AdvancedPhotoOptions extends PhotoOptions {
  /** Exact typed planes beside photographic color. Lossy VarDCT color uses eight-bit samples; quality 100
   * delegates all admitted color precisions and alpha words to the shared exact encodeChannels owner.
   * Uses the same sample-word, metadata,
   * dimShift and upsampling contract as encodeChannels. If RGBA has transparency, its alpha is prepended;
   * the combined count is at most 256. Caller sample buffers are borrowed until the job completes and are
   * never modified. Extra planes are exact even when color is lossy. LF frames require channel upsampling
   * 1 and retain their own reduced auxiliary planes; the final frame retains the full authored words.
   * Quality 100 preserves color/sample/ICC/orientation metadata and ignores lossy transform controls. */
  extraChannels?: readonly ExtraChannel[] | undefined;
  /** Requested level for authored extra planes. Omission chooses 5, or 10 when their count, type or
   * precision requires it. Explicit 5 refuses planes requiring 10. LF frames always declare 10. */
  level?: 5 | 10 | undefined;
  /** Decoder reconstruction factor. Width/height are the canvas before Exif orientation; supply exactly
   * ceil(width/factor) by ceil(height/factor) RGBA samples. No source resampling is performed.
   * Color and RGBA alpha share the factor; authored extra planes choose their own valid factors.
   * Nonunit factors require eight-bit lossy input and cannot combine
   * with lfFrames. Omission or 1 keeps the ordinary geometry. */
  upsampling?: 1 | 2 | 4 | 8 | undefined;
  /** Explicit symmetric reconstruction kernels: 15, 55 or 210 finite weights for factors 2, 4 or 8.
   * Values are copied and rounded to binary16 at admission; magnitude is at most 65504.
   * Requires quality below 100. The default inverse opsin matrix remains unchanged. */
  upsamplingWeights?: Partial<Record<2 | 4 | 8, readonly number[] | Float32Array | Float64Array>> | undefined;
  /** Omit to retain the ordinary photo route. Auto chooses DCT8 or DCT16 from coefficient-rate estimates.
   * Explicit names are used wherever their tiles fit; DCT8 fills borders. Names give rows before columns. */
  transforms?: 'auto' | TransformName | readonly TransformName[] | undefined;
  quantization?: Quantization | undefined;
  coefficientOrders?: CoefficientOrders | undefined;
  /** True means spectral. Final coefficients sum exactly to the nonprogressive reconstruction. */
  progressive?: boolean | 'spectral' | 'successive' | 'responsive' | ProgressivePlan | undefined;
  /** Eight synthesis strengths from 0 through 1023/1024, quantized to 1/1024, or the full-frame photon model.
   * Photon defaults to ISO 800. Source grain is neither estimated nor removed. */
  noise?: Noise | undefined;
  /** Low-frequency frames at successive 1/8 scales; true means one level. Requires eight-bit sRGB pixels.
   * Alpha, typed auxiliary planes, explicit transforms and raw or compact custom tables are supported. XYB uses an exact Modular
   * deepest frame when its common DC unit is normal binary16; other cases use fine VarDCT.
   * Intermediate levels use fine quantization. The final
   * alpha is exact, and HF progressive passes preserve the resulting final coefficients. Declares Level10. */
  lfFrames?: boolean | 1 | 2 | 3 | 4 | undefined;
  /** Exif orientation for the lossy codestream; default 1. */
  orientation?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | undefined;
}
/** Synthesis LUT for a full-frame camera at the requested ISO (1 through 1e9, default 800). */
export function photonNoise(width: number, height: number, iso?: number): Float64Array;
/** Encode optional JPEG XL format features. Quality defaults to 90; 100 preserves every source sample.
 * Format controls below quality 100 require eight-bit samples with sRGB transfer. */
export function encodePhoto(data: Pixels, width: number, height: number, options?: AdvancedPhotoOptions): Bytes;
/** Incremental encodePhoto with eager option admission. Hurry retains a completed entropy candidate. */
export function encodePhotoSteps(data: Pixels, width: number, height: number, options?: AdvancedPhotoOptions): Job;
