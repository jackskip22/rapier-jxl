// SPDX-License-Identifier: MIT
import type {Pixels, Bytes, EncodeOptions, Job, Limits} from './index.mjs';
export type {Pixels, Bytes, ColorSpace, SampleFormat, TransferFunction, Limits, EncodeOptions, ErrorCode, EncoderError, Job} from './index.mjs';
/** Limits: 16 MiB output, 40 million pixels, 16,384 pixels per side. */
export const LIMITS: Limits;
export interface PhotoOptions extends EncodeOptions {
  /** Integer from 1 to 9; default 1. Higher efforts search for smaller photographic streams. */
  effort?: number | undefined;
}
/** Encode 8-bit photographs with DCT8 and exact alpha. Quality defaults to 90; 100 preserves all samples.
 * Native precision and HDR use modular coding with source-domain quantization.
 * Effort 3 adds clustering; 4 adds a learned coefficient order. Both preserve reconstructed pixels.
 * Effort 5 adds per-block quantization within effort 1's unclipped RGB reconstruction-error model.
 * Candidates replace the preceding stream only when smaller. Searches exceeding their memory estimate retain
 * the preceding stream. Input limits do not depend on effort. */
export function encodePhoto(data: Pixels, width: number, height: number, options?: PhotoOptions): Bytes;
/** Incremental encodePhoto with immediate input validation. */
export function encodePhotoSteps(data: Pixels, width: number, height: number, options?: PhotoOptions): Job;
