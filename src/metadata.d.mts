// SPDX-License-Identifier: MIT
import type {Bytes} from './index.mjs';

export interface MetadataOptions {
  /** Raw TIFF bytes, beginning with II or MM; no Exif\0\0 or JPEG APP1 header. */
  exif?: Uint8Array | null | undefined;
  /** XMP packet as a UTF-8 string or its original UTF-8 bytes. */
  xmp?: string | Uint8Array | null | undefined;
}
/** Return owned JPEG XL bytes with the requested Exif/XMP fields replaced (null removes). Omitted fields and other boxes remain
 * unchanged. Pixels, color encoding and orientation are not rewritten; keep Exif orientation coherent with the
 * encoded image. Metadata edits reject files containing JPEG reconstruction data. Maximum output: 16 MiB. */
export function withMetadata(bytes: Uint8Array, options?: MetadataOptions): Bytes;
