// SPDX-License-Identifier: MIT
import type {Bytes, Limits} from './index.mjs';
export const LIMITS: Limits;
export interface CaptureOptions {
  /** Checked before the encode and after it. The encode itself runs to a finished file. */
  signal?: AbortSignal | undefined;
  /** false encodes on this thread. A Worker encodes there. The default is a module worker on a document, and this thread elsewhere. */
  worker?: Worker | false | undefined;
}
/** Lossless JPEG XL for a screen capture. Flat UI uses the fast context-model pass; anything else uses the core exact encode.
 * The result is never larger than that exact encode, and the caller's pixels are left unchanged. */
export function encodeCapture(data: Uint8Array | Uint8ClampedArray, width: number, height: number, options?: CaptureOptions): Promise<Bytes>;
