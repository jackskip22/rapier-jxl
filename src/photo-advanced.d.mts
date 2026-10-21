// SPDX-License-Identifier: MIT
import type {Pixels, Bytes, Job, Limits} from './index.mjs';
import type {PhotoOptions} from './photo.mjs';
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
  /** Omit to retain the ordinary photo route. Auto chooses DCT8 or DCT16 from coefficient-rate estimates.
   * Explicit names are used wherever their tiles fit; DCT8 fills borders. Names give rows before columns. */
  transforms?: 'auto' | TransformName | readonly TransformName[] | undefined;
  quantization?: Quantization | undefined;
  /** True means spectral. Final coefficients sum exactly to the nonprogressive reconstruction. */
  progressive?: boolean | 'spectral' | 'successive' | 'responsive' | ProgressivePlan | undefined;
  /** Eight synthesis strengths from 0 through 1023/1024, quantized to 1/1024, or the full-frame photon model.
   * Photon defaults to ISO 800. Source grain is neither estimated nor removed. */
  noise?: Noise | undefined;
  /** Low-frequency frames at successive 1/8 scales; true means one level. Requires eight-bit sRGB pixels.
   * Alpha, explicit transforms and raw or compact custom tables are supported. XYB uses an exact Modular
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
