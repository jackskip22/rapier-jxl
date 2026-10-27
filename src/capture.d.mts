// SPDX-License-Identifier: MIT
import type {Bytes, ColorSpace, Limits} from './index.mjs';
import type {BrowserImage, Controls} from './image.mjs';
export const LIMITS: Limits;
export interface CapturePixels {data: Uint8Array | Uint8ClampedArray; width: number; height: number; colorSpace?: ColorSpace;}
export type CaptureSource = CapturePixels | BrowserImage;
export interface CaptureOptions extends Controls {
  /** Exact by default. Integer 1–8 bounds visible RGB error; alpha and hidden RGB stay exact. */
  maxError?: number;
  /** Declare raw pixels' existing color space; never relabel an ImageData with a different space. */
  colorSpace?: ColorSpace;
}
/** Works directly in an existing worker or Node/Deno with RGBA8; browser sources are rasterized by the host. */
export function encode(source: CaptureSource, options?: CaptureOptions): Promise<Bytes>;
