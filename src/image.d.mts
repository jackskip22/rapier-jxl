// SPDX-License-Identifier: MIT
import type {Bytes, ColorSpace, EncodeOptions, Pixels} from './index.mjs';
import type {ScoreTarget} from './score.mjs';

export const CONTRACT_VERSION: 1;
export interface RGBAImage {data: Pixels; width: number; height: number; colorSpace?: ColorSpace;}
export type BrowserImage = Blob | ImageBitmap | ImageData | OffscreenCanvas | HTMLCanvasElement | HTMLImageElement;
export type ImageSource = RGBAImage | BrowserImage;
export interface Controls {
  /** CPU is always available; auto permits GPU work with CPU fallback. Default auto. */
  gpu?: 'auto' | 'cpu';
  /** Aborting an active worker request terminates that private worker. Queued work continues in a new one. */
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
  /** Reject larger decoded pictures before allocating an encoding workspace. */
  maxPixels?: number;
}
export interface ImageOptions extends EncodeOptions, Controls {
  /** Capture worker only: visible RGB absolute error, integer 0–8; default 0, alpha remains exact. */
  maxError?: number;
  /** Photo/full worker: integer 1–9. */
  effort?: number;
  /** Photo worker: an internal reconstructed-image perceptual target. */
  target?: ScoreTarget;
  /** Full worker only: false decodes JPEG pixels instead of carrying the original JPEG. */
  transcode?: boolean;
}
export interface EncoderOptions {
  /** A self-contained capture, photo or full worker URL, or a factory creating a private Worker. */
  worker: string | URL | (() => Worker);
  /** Waiting images, in addition to the active image. Default 2; 0 disables waiting. */
  maxQueue?: number;
  /** Default 24 million pixels. Photo permits up to 40 million. */
  maxPixels?: number;
  /** Worker version-handshake timeout, milliseconds; default 15000. */
  startupTimeout?: number;
}
export interface ImageEncoder {
  /** Inputs are borrowed until settlement and never detached. Do not mutate them while pending. */
  encode(source: ImageSource, options?: ImageOptions): Promise<Bytes>;
  /** Idempotently terminate the private worker and reject active, queued and later work. */
  close(): void;
}
export function createEncoder(options: EncoderOptions): ImageEncoder;
