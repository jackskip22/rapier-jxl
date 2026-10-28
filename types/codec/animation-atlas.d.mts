// SPDX-License-Identifier: MIT
import type {Animation, AnimationOptions, AnimationJob} from './animation.mjs';
import type {Bytes} from './index.mjs';

export interface AtlasSearchOptions {
  /** Auto combines connected glyphs with aligned tiles; default auto. */
  strategy?: 'auto' | 'glyphs' | 'tiles';
  /** Tile edge in pixels; default 16. */
  tileSize?: 4 | 8 | 16 | 32 | 64;
  /** Maximum retained source rectangles, 1..4096; default 256. */
  maxEntries?: number;
  /** Maximum packed atlas pixels, 16..1048576; default 262144. */
  maxPixels?: number;
  /** Useful repeated placements required per rectangle, 2..65536; default 2. */
  minUses?: number;
}
export interface AnimationAtlasPlan {
  /** Owned RGBA8 reference image, at most 1,048,576 pixels. */
  atlas: {data: Uint8Array | Uint8ClampedArray; width: number; height: number};
  /** Up to 4096 source rectangles and 262144 positions. Every placement must exactly match its source frame. */
  patches: readonly {
    sourceX: number;
    sourceY: number;
    width: number;
    height: number;
    positions: readonly {frame: number; x: number; y: number}[];
  }[];
}
export interface AnimationAtlasOptions extends AnimationOptions {
  /** Authored or previously discovered plan. Omit to discover repeated glyphs and tiles. */
  atlas?: AnimationAtlasPlan;
  /** Auto retains an atlas only when the complete animation is smaller; force requires a usable atlas.
   * Off returns the ordinary animation bytes. Default auto. */
  atlasMode?: 'auto' | 'force' | 'off';
  atlasSearch?: AtlasSearchOptions;
}

/** Deterministically discover and pack byte-exact repeated glyphs/tiles. All channels, including hidden RGB,
 * participate in matching. Unchanged rectangles after the previous shown frame do not inflate use counts.
 * Returns null when no useful candidate fits the search bounds. The source buffers remain unchanged. */
export function buildAnimationAtlas(animation: Animation, options?: AtlasSearchOptions): AnimationAtlasPlan | null;
/** Shared reference slot 3 keeps exact sprites across displayed frames, crops and canvas slot 2.
 * Ordinary per-frame patch dictionaries retain slot 1. Timing, loops and source differencing use the ordinary
 * animation encoder. Auto returns its exact original bytes outside straight RGBA8 quality 100 or without a saving.
 * Keep all source and supplied atlas buffers unchanged while a stepped call is active. */
export function encodeAnimationAtlas(animation: Animation, options?: AnimationAtlasOptions): Bytes;
/** Same result as encodeAnimationAtlas. Exhaust to set bytes; cancellation leaves bytes null.
 * Hurry reuses the completed baseline at planning boundaries and reduces active searches; a started candidate
 * may finish. Force always completes the authored candidate. */
export function encodeAnimationAtlasSteps(animation: Animation, options?: AnimationAtlasOptions): AnimationJob;
