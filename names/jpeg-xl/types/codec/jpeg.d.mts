// SPDX-License-Identifier: MIT
import type {Bytes, Job, Limits} from './index.mjs';
export type {Bytes, Limits, ErrorCode, EncoderError, Job} from './index.mjs';
/** Limits: 64 million pixels and 16,384 pixels per side. Input and output use available memory. */
export const LIMITS: Limits;
export type Orientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export interface Transcoded {
  /** JPEG XL container with the coefficients and original JPEG reconstruction data. */ bytes: Bytes;
  /** Display dimensions, adjusted for Exif orientation. */ width: number; height: number;
  /** Exif orientation preserved in the JPEG XL header. */ orientation: Orientation;
}
/** JPEG coefficient transcoding options. Unsupported JPEG input throws JXL_JPEG. */
export interface TranscodeOptions {
  /** Integer from 1 to 9; default 1. Efforts 1–3 are one fast entropy pass. Effort 4 adds clustering and a learned coefficient order. */
  effort?: number | undefined;
  /** Embed the exact original RGB/GRAY profile. By default, recognized sRGB/Display P3 profiles retain the
   * compatible named-color codestream; every other admitted profile is carried exactly. Original JPEG
   * reconstruction retains every original APP2 byte in either mode. */
  icc?: 'preserve' | undefined;
  /** Entropy choice for the embedded ICC. Requires icc:'preserve'; default auto selects the shorter stream. */
  iccCompression?: 'auto' | 'prefix' | 'lz77' | undefined;
}
export function transcode(jpeg: Uint8Array, options?: TranscodeOptions): Transcoded;
/** Incremental transcode. The first step reads scans and sets display dimensions and orientation. */
export interface TranscodeJob extends Job { width?: number; height?: number; orientation?: Orientation; }
export function transcodeSteps(jpeg: Uint8Array, options?: TranscodeOptions): TranscodeJob;
/** Restore the original JPEG from reconstruction data, including files libjxl wrote; null when the file has none.
 * Throws JXL_RECONSTRUCTION when the data is invalid or its jbrd box is wrapped in brob, which the format forbids. */
export function reconstructJPEG(bytes: Uint8Array): Bytes | null;
