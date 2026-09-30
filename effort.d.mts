// SPDX-License-Identifier: MIT
import type {Pixels, EncodeOptions, Job} from './index.mjs';
export {LIMITS} from './index.mjs';
export type {Pixels, Limits, EncodeOptions, ErrorCode, EncoderError, Job} from './index.mjs';
/** The core's encode with a search above it for exact pictures: effort 1 (the default) writes the core's bytes; 2 tries
 * the weighted predictor on every channel, 3 also splits its contexts by the predictor's error. Never larger than the
 * effort below; slower. */
export function encode(data: Pixels, width: number, height: number, options?: EncodeOptions): Uint8Array;
/** encode's work and bytes as steps. Above effort 1 an exact picture's first half (fractions up to 0.5) writes effort
 * 1's stream and the second searches; `hurry` ends the search with the smallest stream written so far. */
export function encodeSteps(data: Pixels, width: number, height: number, options?: EncodeOptions): Job;
