// SPDX-License-Identifier: MIT
import type {Bytes, Job} from './index.mjs';
export type PatchBlend = 'none' | 'replace' | 'add' | 'multiply' | 'blend-above' | 'blend-below'
  | 'alpha-weighted-add-above' | 'alpha-weighted-add-below';
/** Normative patch blend modes, in their codestream order 0 through 7. */
export const PATCH_BLEND_MODES: readonly PatchBlend[];
export interface PatchPosition {
  /** Destination top-left pixel. The complete rectangle must fit inside the image. */
  x: number;
  y: number;
  /** Color blend, default replace. Geometry and blends are applied in the supplied order. */
  blend?: PatchBlend;
  /** Alpha blend, default the color blend. Color blend-above/below also sets composite alpha. */
  alphaBlend?: PatchBlend;
  /** Clamp foreground factors to [0,1] for multiply or alpha-aware modes, default false. */
  clamp?: boolean;
  /** Same for alpha; defaults to clamp when the alpha mode uses clamping. */
  alphaClamp?: boolean;
}
export interface AuthoredPatch {
  sourceX: number;
  sourceY: number;
  width: number;
  height: number;
  positions: readonly PatchPosition[];
}
export interface PatchOptions {
  atlas: {data: Uint8Array | Uint8ClampedArray; width: number; height: number};
  patches: readonly AuthoredPatch[];
  colorSpace?: 'srgb' | 'display-p3';
  /** Exact encoding search, integer 1..9, default 1. */
  effort?: number;
  /** Optional base RGB quantization, integer 0..127; maximum error before blending, default 0.
   * Atlas samples, alpha and fully transparent base RGB remain exact. Replacement patches stay exact. */
  baseError?: number;
  orientation?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  /** Default 5. Explicit 10 allows larger total patch area; Chrome 155 still applies the level-5 area bound. */
  level?: 5 | 10;
}
/** Encode a base and arbitrary source atlas with all eight patch blend modes. Straight RGBA8 only.
 * Both input buffers and geometry remain owned by the caller and must stay unchanged during a stepped job.
 * At most floor(image pixels/16) source rectangles and four times that many placements.
 * All pixels in replacement patches, including hidden RGB and alpha, are copied exactly.
 * Arithmetic can exceed [0,1] before final conversion. For alpha above one, Chrome 155's default
 * createImageBitmap premultiplication differs; ImageDecoder or {premultiplyAlpha: 'none'} retains the result. */
export function encodePatches(data: Uint8Array | Uint8ClampedArray, width: number, height: number, options: PatchOptions): Bytes;
/** Same result as encodePatches. Hurry retains complete authored output; cancellation leaves bytes null. */
export function encodePatchesSteps(data: Uint8Array | Uint8ClampedArray, width: number, height: number, options: PatchOptions): Job;
