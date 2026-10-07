// SPDX-License-Identifier: MIT
import type {Pixels, Bytes, EncodeOptions, Job} from './index.mjs';
export {LIMITS} from './index.mjs';
export type {Pixels, Bytes, ColorSpace, SampleFormat, TransferFunction, Limits, EncodeOptions, ErrorCode, EncoderError, Job} from './index.mjs';
export interface EffortOptions extends EncodeOptions {
  /** Whole number 1 to 9; default 1. A level without a new search uses the preceding search. */
  effort?: number | undefined;
  /** An alternative ordinary 8-bit lossless search: efforts 2/3 share sampled image trees; 4..9 also try richer group trees.
   * Omit for the ordinary search. Any sampled-search hurry returns effort 1 exactly. */
  treeLearning?: 'sampled' | undefined;
}
/** The core's encode with a search above it for exact pictures: effort 1 (the default) writes the core's bytes; 2 tries
 * the weighted predictor on every channel, 3 splits its contexts and tries screen palettes, runs and glyphs,
 * 4 models palette indices per group and tries other reversible colour transforms, 5 deepens screen matching
 * and predictor search, and 6 also learns gradient-property splits. A level
 * without another rung uses the preceding one.
 * Native integer effort 2 also prices untransformed RGB; floats have no additional lossless rung.
 * Never larger than the effort below; slower. */
export function encode(data: Pixels, width: number, height: number, options?: EffortOptions): Bytes;
/** encode's work and bytes as steps. Above effort 1 an exact picture's first half (fractions up to 0.5) writes effort
 * 1's stream and the second searches; `hurry` ends the ordinary search with the smallest stream written so far,
 * or a sampled search with effort 1 exactly. */
export function encodeSteps(data: Pixels, width: number, height: number, options?: EffortOptions): Job;
