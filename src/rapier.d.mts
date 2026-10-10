// SPDX-License-Identifier: MIT
import type {Pixels, Bytes, Limits} from './index.mjs';
import type {EffortOptions} from './effort.mjs';
import type {Transcoded} from './jpeg.mjs';
export {kernelMode} from './kernels.mjs';
export const LIMITS: Limits;
export const JPEG_LIMITS: Limits;
export interface Image {data: Pixels | ArrayBuffer; width: number; height: number;}
export interface ProgressOptions {
  /** Completed work from 0 to 1. */
  progress?: ((fraction: number) => void) | undefined;
}
export interface Options extends EffortOptions, ProgressOptions {
  /** Forces quality 100. Otherwise quality defaults to 90; effort defaults to 9. */
  lossless?: boolean | undefined;
  /** Use photographic coding for non-palette RGBA8 below quality 100. */
  photo?: boolean | undefined;
}
export interface WorkerOptions {
  /** Spawn the same complete build. Required when its bootstrap is a module worker. */
  spawn?: (() => Worker) | undefined;
}
export interface Failure {code: string; stage?: string; detail?: string; message: string;}
export interface Encoder {
  /** Runs off the browser document thread. Input arrays remain unchanged. */
  encode(image: Image, options?: Options): Promise<Bytes>;
  /** Preserves admitted JPEG coefficients and orientation, using effort 9. */
  transcode(input: {bytes: Uint8Array | Uint8ClampedArray | ArrayBuffer}, options?: ProgressOptions): Promise<Transcoded>;
  failure(error: unknown): Failure;
}
export type Request = {id: string | number; operation: 'encode'; width: number; height: number; data: Pixels | ArrayBuffer; options?: Omit<Options, 'progress'>; /** Ask for `Progress` replies while the encode runs. */ progress?: boolean}
  | {id: string | number; operation: 'transcode'; bytes: Uint8Array | Uint8ClampedArray | ArrayBuffer; progress?: boolean};
/** Completed work from 0 to 1, before its `Response`; sent only to a request that asked. */
export type Progress = {id: string | number; progress: number};
export type Response = {id: string | number; ok: true; bytes: Bytes; width?: number; height?: number; orientation?: number}
  | {id: string | number; ok: false; error: Failure};
/** Complete encoder: optional WASM, effort search, photographic coding, JPEG and automatic parallel groups. */
export function createEncoder(options?: WorkerOptions): Encoder;
/** Install the standard request/response protocol on the current browser worker. */
export function installWorker(options?: WorkerOptions): void;
