// SPDX-License-Identifier: MIT
import type {Pixels, Bytes, EncodeOptions, Job, Limits} from './index.mjs';
export type {Pixels, Bytes, ColorSpace, Limits, EncodeOptions, ErrorCode, EncoderError, Job} from './index.mjs';
/** This door's limits, by its memory: the 16 MiB codestream, 40 million pixels, 16,384 on a side. */
export const LIMITS: Limits;
export interface PhotoOptions extends EncodeOptions {
  /** Whole number 1 to 9; default 1. Higher efforts search for smaller photographic streams. */
  effort?: number | undefined;
}
/** Photographs: DCT8 coefficients with exact alpha; quality 90 by default, 100 is exact.
 * Effort 1 is the default; 3 tries a cluster budget, 4 also a learned order, preserving reconstructed pixels.
 * Effort 5 adds per-block quantisation within effort 1's unclipped RGB sample reconstruction-error
 * model, retaining the preceding stream unless the complete candidate is smaller. Optional searches beyond their
 * memory estimate keep the preceding stream; this door's input limits do not change with effort. */
export function encodePhoto(data: Pixels, width: number, height: number, options?: PhotoOptions): Bytes;
/** encodePhoto's work and bytes as steps; the call is admitted at once. */
export function encodePhotoSteps(data: Pixels, width: number, height: number, options?: PhotoOptions): Job;
