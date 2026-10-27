// SPDX-License-Identifier: MIT
import type {Bytes, Limits} from './index.mjs';
export const LIMITS: Limits;
export interface CaptureOptions {
  /** Checked before the encode and after it. The encode itself runs to a finished file. */
  signal?: AbortSignal | undefined;
  /** false encodes on this thread. A Worker encodes there. The default is a module worker on a document, and this thread elsewhere. */
  worker?: Worker | false | undefined;
  /** Allow high-contrast RGB to move by at most maxColorError so antialiased text collapses. Default false: every sample stays exact.
   * Flat colour and gradients stay exact. The result is kept only when it is smaller than the lossless file. */
  nearLossless?: boolean | undefined;
  /** 1–32, default 6. Used only when nearLossless is true. */}
  maxColorError?: number | undefined;
}
/** JPEG XL for a screen capture. Lossless unless nearLossless is set. Pages of up to 16,384 colours use a palette and the SIMD context model.
 * The caller's pixels are left unchanged. */
export function encodeCapture(data: Uint8Array | Uint8ClampedArray, width: number, height: number, options?: CaptureOptions): Promise<Bytes>;
