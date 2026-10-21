// SPDX-License-Identifier: MIT
import type {Pixels, Bytes, Limits} from './index.mjs';
import type {EffortOptions} from './effort.mjs';
import type {Transcoded, TranscodeOptions as JPEGTranscodeOptions} from './jpeg.mjs';
import type {Frame} from './animation.mjs';
import type {FormatRequest, FormatResult} from './format-worker.mjs';
export type {FormatRequest, FormatResult} from './format-worker.mjs';
export {kernelMode} from './kernels.mjs';
export const LIMITS: Limits;
export const JPEG_LIMITS: Limits;
export type ImageSource = Blob | ImageBitmap | ImageData | OffscreenCanvas;
export interface PictureOptions extends ProgressOptions {
  /** 1 to 99 is lossy; omitted or 100 is lossless. Ignored for a carried JPEG. */
  quality?: number | undefined;
  /** 1 to 9; defaults to 7. */
  effort?: number | undefined;
  /** Set false to decode a JPEG and encode its pixels. */
  transcode?: boolean | undefined;
}
export interface Image {data: Pixels | ArrayBuffer; width: number; height: number;}
export interface ProgressOptions {
  /** Completed work from 0 to 1. */
  progress?: ((fraction: number) => void) | undefined;
  /** Stop at the next incremental boundary. Rejects with signal.reason and publishes no partial file. */
  signal?: AbortSignal | undefined;
}
export interface Options extends EffortOptions, ProgressOptions {
  /** Defaults for quality, effort and photo coding; explicit options override them. */
  preset?: 'web' | 'photo' | 'archive' | 'screen' | 'lossless' | undefined;
  /** Set false to disable helper workers for this encode. Defaults to automatic parallel work. */
  parallel?: boolean | undefined;
  /** Forces quality 100. Otherwise quality defaults to 90; effort defaults to 7. */
  lossless?: boolean | undefined;
  /** Use photographic coding for non-palette RGBA8 below quality 100. */
  photo?: boolean | undefined;
  /** Photo edge-preserving filter. Auto applies to XYB through quality 90; off preserves unfiltered detail. */
  filter?: 'auto' | 'off' | undefined;
}
export interface TranscodeOptions extends JPEGTranscodeOptions, ProgressOptions {
  /** 1 to 9; defaults to 7. */
  effort?: number | undefined;
}
export interface WorkerOptions {
  /** Spawn the same complete build. Required when its bootstrap is a module worker. */
  spawn?: (() => Worker) | undefined;
}
export interface Failure {code: string; stage?: string; detail?: string; message: string;}
export interface Encoder {
  /** Runs off the browser document thread. Input arrays remain unchanged. */
  encode(image: Image, options?: Options): Promise<Bytes>;
  /** Animated JPEG XL from whole-canvas frames (durations in milliseconds; loops 0 plays forever). The same presets and
   * options as encode; without `photo` or a preset, lossy 8-bit frames choose DCT8 or modular coding from the first frame. */
  animation(input: {width: number; height: number; loops?: number | undefined; frames: Frame[]}, options?: Options): Promise<Bytes>;
  /** Preserves admitted JPEG coefficients and orientation. Effort is 1 to 9, 7 by default. */
  transcode(input: {bytes: Uint8Array | Uint8ClampedArray | ArrayBuffer}, options?: TranscodeOptions): Promise<Transcoded>;
  /** A picture the worker holds: a JPEG file is carried, anything else is decoded and encoded. */
  image(input: {source: ImageSource}, options?: PictureOptions): Promise<Transcoded | {bytes: Bytes}>;
  /** Restore a carried JPEG; null when the file has no JPEG reconstruction data. */
  reconstruct(input: {bytes: Uint8Array | Uint8ClampedArray | ArrayBuffer}): Promise<Bytes | null>;
  /** Optional format encoders and metadata operations in the same offline worker. */
  format(input: FormatRequest, options?: ProgressOptions): Promise<FormatResult>;
  failure(error: unknown): Failure;
}
export type Request = {id: string | number; operation: 'encode'; width: number; height: number; data: Pixels | ArrayBuffer; options?: Omit<Options, 'progress' | 'signal'>; /** Ask for `Progress` replies while the encode runs. */ progress?: boolean}
  /** Transfer each frame's buffer. */
  | {id: string | number; operation: 'animation'; width: number; height: number; loops?: number; frames: Frame[]; options?: Omit<Options, 'progress' | 'signal'>; progress?: boolean}
  | {id: string | number; operation: 'transcode'; bytes: Uint8Array | Uint8ClampedArray | ArrayBuffer; options?: Omit<TranscodeOptions, 'progress' | 'signal'>; progress?: boolean}
  | {id: string | number; operation: 'image'; source: ImageSource; options?: Omit<PictureOptions, 'progress' | 'signal'>; progress?: boolean}
  | {id: string | number; operation: 'reconstruct'; bytes: Uint8Array | Uint8ClampedArray | ArrayBuffer}
  | {id: string | number; operation: 'format'; input: FormatRequest; progress?: boolean}
  /** Cancel the active request with this exact id; its response is JXL_ABORTED. A stale id has no effect. */
  | {id: string | number; operation: 'cancel'};
/** Completed work from 0 to 1, before its `Response`; sent only to a request that asked. */
export type Progress = {id: string | number; progress: number};
export type Response = {id: string | number; ok: true; bytes: Bytes; width?: number; height?: number; orientation?: number}
  | {id: string | number; ok: true; bytes: null}
  | {id: string | number; ok: true; result: Exclude<FormatResult, Uint8Array>}
  | {id: string | number; ok: false; error: Failure};
/** Complete encoder: optional WASM, effort search, photographic coding, JPEG and automatic parallel groups. */
export function createEncoder(options?: WorkerOptions): Encoder;
/** Install the standard request/response protocol on the current browser worker. */
export function installWorker(options?: WorkerOptions): void;
