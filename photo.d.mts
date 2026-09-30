// SPDX-License-Identifier: MIT
import type {Pixels, EncodeOptions, Job, Limits} from './index.mjs';
export type {Pixels, Limits, EncodeOptions, ErrorCode, EncoderError, Job} from './index.mjs';
/** This door's limits, by its memory: the 16 MiB codestream, 40 million pixels, 16,384 on a side. */
export const LIMITS: Limits;
/** Photographs: DCT8 coefficients with exact alpha; quality 90 by default, 100 is exact. */
export function encodePhoto(data: Pixels, width: number, height: number, options?: EncodeOptions): Uint8Array;
/** encodePhoto's work and bytes as steps; the call is admitted at once. */
export function encodePhotoSteps(data: Pixels, width: number, height: number, options?: EncodeOptions): Job;
