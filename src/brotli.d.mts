// SPDX-License-Identifier: MIT
import type {Bytes} from './index.mjs';
export interface BrotliOptions {
  /** Optional nonnegative safe-integer output budget, checked before decoder output allocation. Defaults to available memory. */
  maxOutputLength?: number;
}
/** Deterministic RFC 7932 LZ77/prefix compression without a static dictionary or native dependencies.
 * Input uses available memory; incompressible input uses stored blocks. Returns an owned buffer. */
export function compressBrotli(bytes: Uint8Array, options?: BrotliOptions): Bytes;
/** Bounded reader for stored blocks and the authored single-tree prefix/LZ77 subset. Other coding forms,
 * context maps, direct/postfix distances and dictionary references require a full external decoder.
 * This entry deliberately does not claim to decode all third-party Brotli streams. */
export function decompressBrotli(bytes: Uint8Array, options?: BrotliOptions): Bytes;
