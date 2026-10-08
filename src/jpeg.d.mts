// SPDX-License-Identifier: MIT
import type {Bytes, Job, Limits} from './index.mjs';
export type {Bytes, Limits, ErrorCode, EncoderError, Job} from './index.mjs';
/** Limits: 16 MiB each for input JPEG and output codestream, 64 million pixels, 16,384 pixels per side. */
export const LIMITS: Limits;
export type Orientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export interface Transcoded {
  /** JPEG XL file bytes as a bare codestream. */ bytes: Bytes;
  /** Display dimensions, adjusted for Exif orientation. */ width: number; height: number;
  /** Exif orientation preserved in the JPEG XL header. */ orientation: Orientation;
}
/** JPEG coefficient transcoding options. Unsupported JPEG input throws JXL_JPEG. */
export interface TranscodeOptions {
  /** Integer from 1 to 9; default 1. Effort 3 adds a 32-cluster budget; 4 adds a learned coefficient order. */
  effort?: number | undefined;
}
export function transcode(jpeg: Uint8Array, options?: TranscodeOptions): Transcoded;
/** Incremental transcode. The first step reads scans and sets display dimensions and orientation. */
export interface TranscodeJob extends Job { width?: number; height?: number; orientation?: Orientation; }
export function transcodeSteps(jpeg: Uint8Array, options?: TranscodeOptions): TranscodeJob;
