// SPDX-License-Identifier: MIT
import type {Pixels, Bytes, Limits} from './index.mjs';
export type {Pixels, Bytes, ColorSpace, SampleFormat, TransferFunction, Limits, EncodeOptions, ErrorCode, EncoderError} from './index.mjs';
import type {EncodeOptions} from './index.mjs';
/** Per-frame canvas limits as the core's; the file is at most 256 MiB and has at most 1,048,576 frames. */
export const LIMITS: Limits & {readonly frames: number};
export interface Frame {
  /** The whole canvas, width * height * 4 straight RGBA samples, in any layout `encode` admits. Every frame uses the same array type. */
  data: Pixels;
  /** Milliseconds this frame shows. A frame of 0 that is not the last is composed into the next and never shown alone. */
  duration: number;
}
export interface Animation {
  width: number;
  height: number;
  /** Times to play; 0 (default) plays forever. */
  loops?: number | undefined;
  frames: Frame[];
}
export interface AnimationOptions extends EncodeOptions {
  /** Same as quality 100. */ lossless?: boolean | undefined;
  /** Integer from 1 to 9; default 1. Each frame gets that still effort. */ effort?: number | undefined;
  /** Lossy 8-bit frames: true codes every frame with DCT8 (XYB when the first frame suits it); false keeps modular
   * coding (exact palettes or Squeeze). Default: modular when the first frame has at most 2,048 colors. */
  photo?: boolean | undefined;
  /** DCT8 frames: "auto" (default) or "off", as encodePhoto. */ filter?: 'auto' | 'off' | undefined;
  /** Checked between steps. */ signal?: AbortSignal | undefined;
  /** encodeAnimation reports the fraction done, 0 to 1. */ progress?: ((fraction: number) => void) | undefined;
}
/** Animated JPEG XL. Each shown frame stores only the rectangle that changed since the frame before; an unchanged
 * frame lengthens the one before it. Durations are exact when the header can express them in ticks, else rounded
 * to milliseconds without drift. Quality 100 (default) keeps every frame exact. */
export function encodeAnimation(animation: Animation, options?: AnimationOptions): Bytes;
/** Incremental encodeAnimation: validates at once, yields progress in (0, 1]; exhaust it to set `bytes`. */
export interface AnimationJob extends Generator<number, Bytes | undefined, boolean | undefined> {
  bytes: Bytes | null;
  hurry: boolean;
  [Symbol.iterator](): this;
}
export function encodeAnimationSteps(animation: Animation, options?: AnimationOptions): AnimationJob;
