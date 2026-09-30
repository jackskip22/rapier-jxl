// SPDX-License-Identifier: MIT
// Rapier JXL: the types of the checked entries, the limits and the error codes. The raw entries beneath the
// checked ones take input the checked entries have already admitted; their shapes are the modules' own.
export type Pixels = Uint8Array | Uint8ClampedArray;
export interface Limits { readonly bytes: number; readonly pixels: number; readonly edge: number; }
/** The 16 MiB codestream, 24 million pixels, 16,384 on a side; a larger ask is refused before any work. */
export const LIMITS: Limits;
export interface EncodeOptions { /** 1 to 100; 100 (the default) is exact. */ quality?: number; }
export interface Transcoded {
  /** A bare JPEG XL codestream, the .jxl file's bytes. */ bytes: Uint8Array;
  /** The picture's size as shown, swapped when the Exif orientation turns it. */ width: number; height: number;
  /** The Exif orientation, 1 to 8, kept in the JPEG XL header. */ orientation: number;
}
export type ErrorCode = 'JXL_INPUT' | 'JXL_DIMENSIONS' | 'JXL_SIZE' | 'JXL_MEMORY' | 'JXL_JPEG';
/** Every refusal is an Error carrying one of the five codes. */
export interface EncoderError extends Error { code: ErrorCode; }
/** Straight RGBA bytes, row by row, to a bare JPEG XL codestream; quality 100 (the default) is exact. */
export function encode(data: Pixels, width: number, height: number, options?: EncodeOptions): Uint8Array;
export function encodeLosslessRGBA(data: Pixels, width: number, height: number): Uint8Array;
export function encodeLossyRGBA(data: Pixels, width: number, height: number, quality?: number): Uint8Array;
/** A JPEG's bytes to JPEG XL, its coefficients carried; a JPEG this path does not take is refused as JXL_JPEG. */
export function transcode(jpeg: Uint8Array): Transcoded;
export function encodeLossless(data: Pixels, width: number, height: number, options?: {shape?: unknown}): Uint8Array;
export function encodeLossy(data: Pixels, width: number, height: number, options: {quality: number; shape?: unknown}): Uint8Array;
export function transcodeJPEG(jpeg: Uint8Array, parsed: unknown): Uint8Array;
export function parseJPEG(jpeg: Uint8Array): unknown;
export function inspectPixels(data: Pixels, width: number, height: number): unknown;
