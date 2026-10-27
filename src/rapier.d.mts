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
export interface PictureOptions extends EncodingProgressOptions {
  /** 1 to 99 is lossy; omitted or 100 is lossless. Ignored for a carried JPEG. */
  quality?: number | undefined;
  /** 1 to 9; defaults to 7. */
  effort?: number | undefined;
  /** Set false to decode a JPEG and encode its pixels. */
  transcode?: boolean | undefined;
  /** GPU selection when the picture is encoded from pixels: false keeps the CPU; true discovers a device.
   * A GPUDevice may be supplied in the encoder's own realm. */
  gpu?: boolean | object | undefined;
  /** Memory reservation when the picture is encoded from pixels. Ignored for a carried JPEG. */
  memory?: EncoderMemory | undefined;
}
export interface Image {data: Pixels | ArrayBuffer; width: number; height: number;}
export interface ProgressOptions {
  /** Completed work from 0 to 1. */
  progress?: ((fraction: number) => void) | undefined;
  /** Stop at the next incremental boundary. Rejects with signal.reason and publishes no partial file. */
  signal?: AbortSignal | undefined;
}
export interface EncodingProgressOptions extends ProgressOptions {
  /** Abort this signal to request the best complete file at the next safe boundary. Its reason is unused. */
  hurrySignal?: AbortSignal | undefined;
}
/** Conditional byte reservation for still-pixel encoding. Byte counts are nonnegative safe integers.
 * Required owner scopes are disjoint; an explicit zero is a caller assertion. Missing scopes grant
 * no optional DCT/cache/helpers. This descriptor is not a measured process/GPU memory guarantee. */
export interface EncoderMemory {
  /** Total conditional reservation; defaults to 1,073,741,824 bytes. */
  budgetBytes?: number | undefined;
  /** Page/decode extras, object headers, VM/code, driver/native storage and GC slack. Required for admission. */
  externalBytes?: number | undefined;
  /** Simultaneously retained candidate/decision graphs, excluding prepared planes and DCT caches. Required. */
  searchBytes?: number | undefined;
  /** Additional writers, models, clone/assembly and fallback work above search/output storage. Required. */
  entropyBytes?: number | undefined;
  /** All simultaneously retained complete incumbent/output files. Required. */
  outputBytes?: number | undefined;
  /** Device, readback and GPU-owner host storage retained during CPU work. Required; this value alone
   * does not authorize GPU execution under a claimed complete memory scope. */
  gpuBytes?: number | undefined;
  /** The adapter always substitutes the actual input backing buffer's byteLength. */
  inputBytes?: number | undefined;
  /** Separately owned metric input snapshot; defaults to four bytes per pixel. */
  metricInputBytes?: number | undefined;
  /** Additional retained references not already counted by the planner; defaults to zero. */
  referenceBytes?: number | undefined;
  /** Requested total live helper count shared across pools; defaults to zero. */
  workers?: number | undefined;
  /** Explicit core allowance, including the coordinator. A grant cannot exceed cores - 1. */
  cores?: number | undefined;
  /** Per-helper VM/code/runtime storage retained across every stage. */
  workerRuntimeBytes?: number | undefined;
  /** Per-helper host message, clone/transit, scratch and result bound, in addition to runtime storage.
   * Must cover workerInputBytes + 2 * workerOutputBytes + the 1,388,544-byte AC scratch floor;
   * exact-region geometry may require more. */
  workerJobBytes?: number | undefined;
  /** Maximum unique ArrayBuffer backing bytes for one helper input, including its model. */
  workerInputBytes?: number | undefined;
  /** Maximum complete backing-buffer capacity of a helper result. */
  workerOutputBytes?: number | undefined;
  /** Optional retained metric-cache allowance; defaults to zero. */
  cacheBytes?: number | undefined;
  /** Set false to disable retention of both DCT caches. */
  dct?: boolean | undefined;
  /** Set true to require banded exact measurement. */
  banded?: boolean | undefined;
  /** Owned rows per band; the planner still includes halos and grid padding. */
  bandRows?: 8 | 16 | 32 | 64 | 128 | undefined;
  /** The still adapter uses native scalar SSIMULACRA2; this path cannot request a full map. */
  map?: false | undefined;
}
export interface Options extends EffortOptions, EncodingProgressOptions {
  /** Defaults for quality, effort and photo coding; explicit options override them. */
  preset?: 'web' | 'photo' | 'archive' | 'screen' | 'lossless' | undefined;
  /** Set false to disable helpers for this encode. Positive helper use requires an admitted memory reservation. */
  parallel?: boolean | undefined;
  /** False keeps the CPU; true discovers a device. A GPUDevice may be supplied in the encoder's own realm. */
  gpu?: boolean | object | undefined;
  /** Still-pixel reservation. The constructor value, or the first encode value when omitted there,
   * is copied and pinned for the encoder instance. Later values must have the same fields and values;
   * image geometry and the actual input backing size are repriced for each encode. */
  memory?: EncoderMemory | undefined;
  /** Forces quality 100. Otherwise quality defaults to 90; effort defaults to 7. */
  lossless?: boolean | undefined;
  /** Use photographic coding for non-palette RGBA8 below quality 100. */
  photo?: boolean | undefined;
  /** Photo edge-preserving filter. Auto applies to XYB through quality 90; off preserves unfiltered detail. */
  filter?: 'auto' | 'off' | undefined;
}
export interface TranscodeOptions extends JPEGTranscodeOptions, EncodingProgressOptions {
  /** 1 to 9; defaults to 7. */
  effort?: number | undefined;
}
export interface WorkerOptions {
  /** Explicit factory for helpers serving the same complete installed protocol. Omit to use the canonical
   * helper asset in the encoder's realm. The factory does not grant a worker reservation. */
  spawn?: (() => Worker) | undefined;
  /** Still-pixel reservation copied at construction. Missing scopes admit no optional retention or helpers. */
  memory?: EncoderMemory | undefined;
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
export type Request = {id: string | number; operation: 'encode'; width: number; height: number; data: Pixels | ArrayBuffer; options?: Omit<Options, 'progress' | 'signal' | 'hurrySignal' | 'gpu'> & {gpu?: boolean | undefined}; /** Ask for `Progress` replies while the encode runs. */ progress?: boolean}
  /** Transfer each frame's buffer. */
  | {id: string | number; operation: 'animation'; width: number; height: number; loops?: number; frames: Frame[]; options?: Omit<Options, 'progress' | 'signal' | 'hurrySignal' | 'gpu'> & {gpu?: boolean | undefined}; progress?: boolean}
  | {id: string | number; operation: 'transcode'; bytes: Uint8Array | Uint8ClampedArray | ArrayBuffer; options?: Omit<TranscodeOptions, 'progress' | 'signal' | 'hurrySignal'>; progress?: boolean}
  | {id: string | number; operation: 'image'; source: ImageSource; options?: Omit<PictureOptions, 'progress' | 'signal' | 'hurrySignal' | 'gpu'> & {gpu?: boolean | undefined}; progress?: boolean}
  | {id: string | number; operation: 'reconstruct'; bytes: Uint8Array | Uint8ClampedArray | ArrayBuffer}
  | {id: string | number; operation: 'format'; input: FormatRequest; progress?: boolean}
  /** Finish the active encode, animation, transcode or image request at a safe complete result.
   * No separate response; a stale id has no effect. */
  | {id: string | number; operation: 'hurry'}
  /** Cancel the active request with this exact id; its response is JXL_ABORTED. A stale id has no effect.
   * An optional structured-cloneable reason is carried by the aborted response. */
  | {id: string | number; operation: 'cancel'; reason?: unknown};
/** Completed work from 0 to 1, before its `Response`; sent only to a request that asked. */
export type Progress = {id: string | number; progress: number};
export type Response = {id: string | number; ok: true; bytes: Bytes; width?: number; height?: number; orientation?: number}
  | {id: string | number; ok: true; bytes: null}
  | {id: string | number; ok: true; result: Exclude<FormatResult, Uint8Array>}
  | {id: string | number; ok: false; error: Failure; /** Present on an aborted response, after structured cloning. */ reason?: unknown};
/** Complete encoder: optional WASM, effort search, photographic coding, JPEG and admitted helpers. */
export function createEncoder(options?: WorkerOptions): Encoder;
/** Install the standard request/response protocol on the current browser worker. */
export function installWorker(options?: WorkerOptions): void;
