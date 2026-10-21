// SPDX-License-Identifier: MIT
import type {Bytes, Job} from './index.mjs';
export type SplinePoint = readonly [number, number];
export interface QuantizedSpline {
  /** At least two integer-coordinate points. Adjacent points differ; the first curve starts at nonnegative x and y. */
  controlPoints: readonly SplinePoint[];
  /** Three arrays of 32 signed quantized coefficients: X, Y, then B minus its default Y correlation. */
  colorDct: readonly [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>];
  /** 32 signed quantized coefficients for Gaussian width in pixels. */
  sigmaDct: ArrayLike<number>;
  /** Optional declaration used by splineStroke. Every curve in the frame uses the same adjustment. */
  quantizationAdjustment?: number;
}
export interface SplineStrokeOptions {
  /** Constant additive amplitude in normalized XYB; these are not RGB channel values. */
  colorXYB: readonly [number, number, number];
  /** Positive Gaussian width in pixels. */
  sigma: number;
  /** Integer precision adjustment. Nonnegative q multiplies precision by 1 + q / 8. Default 0. */
  quantizationAdjustment?: number;
}
export interface SplineOptions {
  splines: readonly QuantizedSpline[];
  /** Defaults to the first curve's adjustment, or zero. All curve declarations must match. */
  quantizationAdjustment?: number;
  /** Base photograph quality, from 1 up to but excluding 100; default 90. */
  quality?: number;
  /** Integer from 1 to 9, default 1. Entropy search does not change the authored curves. */
  effort?: number;
  filter?: 'auto' | 'off';
  orientation?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  /** Default 5, compatible with Chrome 155's spline area budget. Explicit 10 permits the larger
   * independent-decoder area budget and declares it in a container; Chrome rejects those broad curves. */
  level?: 5 | 10;
}
/** Quantize a constant-color, constant-width stroke. Input points and options are not mutated. */
export function splineStroke(controlPoints: readonly SplinePoint[], options: SplineStrokeOptions): QuantizedSpline;
/** Add authored curves over an sRGB base. This is not automatic curve extraction. Alpha stays exact.
 * At most floor(pixels/4) curves and min(1048576, floor(pixels/2)) total control points.
 * Coordinates and adjacent deltas have magnitude below 8388608; coefficients exclude -2147483648.
 * Decoder area budgets are checked before encoding. One-point curves are rejected: libjxl 0.12 skips them,
 * while jxl-oxide 0.12.6 renders them differently. */
export function encodeSplines(data: Uint8Array | Uint8ClampedArray, width: number, height: number, options: SplineOptions): Bytes;
/** Same output as encodeSplines; cancelling leaves bytes null, and hurry retains complete output. */
export function encodeSplinesSteps(data: Uint8Array | Uint8ClampedArray, width: number, height: number, options: SplineOptions): Job;
