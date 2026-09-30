// SPDX-License-Identifier: MIT
// Rapier JXL's core: the type of encode, the shape of the limits (each door has its own, by its memory) and the error
// codes every door shares.
export type Pixels = Uint8Array | Uint8ClampedArray;
export interface Limits { readonly bytes: number; readonly pixels: number; readonly edge: number; }
/** The core's limits: the 16 MiB codestream, 24 million pixels, 16,384 on a side; a larger ask is refused before any
 * work. The photo door takes 40 million pixels and the JPEG carrier 64 million, each by its memory. */
export const LIMITS: Limits;
export interface EncodeOptions {
  /** 1 to 100; 100 is exact. */ quality?: number;
  /** The samples' colour space, declared in the header; 'srgb' by default. */ colorSpace?: 'srgb' | 'display-p3';
  /** 1 to 9, a whole number, read by /effort, which runs its highest rung at or below it; the core has rung 1 alone. */ effort?: number;
}
export type ErrorCode = 'JXL_INPUT' | 'JXL_DIMENSIONS' | 'JXL_SIZE' | 'JXL_MEMORY' | 'JXL_JPEG';
/** Every refusal is an Error carrying one of the five codes. */
export interface EncoderError extends Error { code: ErrorCode; }
/** Straight RGBA bytes, row by row, to a bare JPEG XL codestream; quality 100 (the default) is exact. */
export function encode(data: Pixels, width: number, height: number, options?: EncodeOptions): Uint8Array;
/** A door's work as steps: iterate for the fraction done, in (0, 1], the last exactly 1; `bytes` holds the stream after
 * the last step. Leaving the loop cancels. `hurry` asks a search to finish with the best candidate it has priced. */
export interface Job extends Generator<number, Uint8Array, undefined> { bytes: Uint8Array | null; hurry: boolean; }
/** encode's work and bytes, a group of one pass per step; the call is admitted at once. */
export function encodeSteps(data: Pixels, width: number, height: number, options?: EncodeOptions): Job;
