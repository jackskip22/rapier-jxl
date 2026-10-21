// SPDX-License-Identifier: MIT
import type {Bytes, Job, Limits} from './index.mjs';
import type {AdvancedPhotoOptions} from './photo-advanced.mjs';
export const LIMITS: Limits;
export interface HybridRegion {x: number; y: number; width: number; height: number}
export interface HybridOptions {
  quality?: number;
  effort?: number;
  colorSpace?: 'srgb' | 'display-p3';
  /** Auto keeps only a smaller complete file; explicit rectangles always retain exact source samples.
   * Each rectangle expands to enclosing DCT8 blocks, clipped to the source canvas. */
  regions?: 'auto' | readonly HybridRegion[];
  orientation?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  progressive?: AdvancedPhotoOptions['progressive'];
}
/** Inspect few-color tiles; candidates are aligned to DCT8 blocks and limited to255. */
export function hybridRegions(data: Uint8Array | Uint8ClampedArray, width: number, height: number): HybridRegion[];
export function encodeHybrid(data: Uint8Array | Uint8ClampedArray, width: number, height: number, options?: HybridOptions): Bytes;
export function encodeHybridSteps(data: Uint8Array | Uint8ClampedArray, width: number, height: number, options?: HybridOptions): Job;
