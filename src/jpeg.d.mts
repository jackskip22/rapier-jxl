// SPDX-License-Identifier: MIT
import type {Bytes, Job, Limits} from './index.mjs';
export type {Bytes, Limits, ErrorCode, EncoderError, Job} from './index.mjs';
/** This door's limits, by its memory: the 16 MiB codestream and JPEG, 64 million pixels, 16,384 on a side. */
export const LIMITS: Limits;
export type Orientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export interface Transcoded {
  /** A bare JPEG XL codestream, the .jxl file's bytes. */ bytes: Bytes;
  /** The picture's size as shown, swapped when the Exif orientation turns it. */ width: number; height: number;
  /** The Exif orientation, 1 to 8, kept in the JPEG XL header. */ orientation: Orientation;
}
/** A JPEG's bytes to JPEG XL, its coefficients carried; a JPEG this path does not take is refused as JXL_JPEG. */
export interface TranscodeOptions {
  /** Whole number 1 to 9; default 1. From 3, try a 32-cluster budget; from 4, also a learned coefficient order. */
  effort?: number | undefined;
}
export function transcode(jpeg: Uint8Array, options?: TranscodeOptions): Transcoded;
/** transcode's work as steps; the first step reads the scans and sets the picture's size as shown and orientation. */
export interface TranscodeJob extends Job { width?: number; height?: number; orientation?: Orientation; }
export function transcodeSteps(jpeg: Uint8Array, options?: TranscodeOptions): TranscodeJob;
