// SPDX-License-Identifier: MIT
import type {Pixels, Bytes, EncodeOptions, Job} from './index.mjs';
export {LIMITS} from './index.mjs';
export type {Pixels, Bytes, ColorSpace, SampleFormat, TransferFunction, Limits, EncodeOptions, ErrorCode, EncoderError, Job} from './index.mjs';
export interface EffortOptions extends EncodeOptions {
  /** Integer from 1 to 9; default 1. Higher levels search for smaller files. */
  effort?: number | undefined;
  /** Reduced 8-bit lossless search: efforts 2 and 3 learn image trees; 4 to 9 also learn group trees.
   * Omit to include all candidates. Hurrying this search returns effort 1's bytes. */
  treeLearning?: 'sampled' | undefined;
}
/** Lossless encoding: effort 1 writes the core's bytes; 2 adds weighted prediction; 3 adds contexts and screen
 * coding; 4 adds color-transform search and local palettes; 5 learns a predictor/context model per group with
 * prefix/ANS selection and broader screen matching; 6 learns it under the color transform that sampled residuals rank
 * first; 7 adds predictors and properties; 8 uses all 14 predictors; 9 also learns it under the second-ranked
 * transform.
 * Levels 1 to 4 accumulate; from 5 each level's learned model replaces the level below's. Complete streams compete
 * by size, with the earlier result winning ties.
 * Native integer effort 2 also tries untransformed RGB; floats have no additional lossless search. */
export function encode(data: Pixels, width: number, height: number, options?: EffortOptions): Bytes;
/** Incremental encode. Above effort 1, lossless progress up to 0.5 writes effort 1's stream; the rest searches.
 * `hurry` returns the smallest completed stream, or effort 1's bytes for `treeLearning: 'sampled'`. */
export function encodeSteps(data: Pixels, width: number, height: number, options?: EffortOptions): Job;
