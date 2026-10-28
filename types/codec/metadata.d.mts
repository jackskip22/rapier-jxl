// SPDX-License-Identifier: MIT
import type {Bytes} from './index.mjs';

export interface MetadataOptions {
  /** Raw TIFF bytes, beginning with II or MM; no Exif\0\0 or JPEG APP1 header. */
  exif?: Uint8Array | null | undefined;
  /** XMP packet as a UTF-8 string or its original UTF-8 bytes. */
  xmp?: string | Uint8Array | null | undefined;
  /** Contents of one JUMBF superbox, or multiple superboxes. null or [] removes all JUMBF boxes. */
  jumb?: Uint8Array | readonly Uint8Array[] | null | undefined;
}
export type BrotliCodec = (bytes: Uint8Array, options: {maxOutputLength?: number}) => Uint8Array | Promise<Uint8Array>;
export interface CompressedMetadataOptions extends MetadataOptions {
  /** auto uses brob only when its full payload is smaller; brotli always compresses. Defaults to auto. */
  compression?: 'auto' | 'brotli';
  /** Optional codec. Node uses node:zlib; browsers use native Brotli streams or the portable LZ77/prefix writer. */
  compress?: BrotliCodec;
}
export interface MetadataReadOptions {
  /** Optional positive safe-integer budget for combined decoded metadata, 64 MiB (67108864) by default. Beyond it the
   * read is refused with JXL_SIZE. */
  maxDecodedBytes?: number;
  /** Optional full decoder. It must honor a supplied maxOutputLength before allocating output. Without native support,
   * the built-in reader accepts the portable writer's subset; arbitrary external Brotli may need this hook. */
  decompress?: BrotliCodec;
}
export interface Metadata {
  /** Raw TIFF bytes, one array per Exif box, in file order. */
  exif: Bytes[];
  /** Original UTF-8 packet bytes, one array per XMP box, in file order. */
  xmp: Bytes[];
  /** Original JUMBF superbox contents, in file order. */
  jumb: Bytes[];
  /** Known metadata awaiting decompression. boxType is its unsigned four-byte box code; data is the Brotli stream. */
  compressed: {boxType: number; data: Bytes}[];
}
/** Replace requested fields (null removes); omitted fields and all other boxes stay exact. Pixels, color encoding
 * and orientation are not rewritten. Metadata edits refuse JPEG reconstruction files. Output uses available memory. */
export function withMetadata(bytes: Uint8Array, options?: MetadataOptions): Bytes;
/** withMetadata with optional brob compression. Inputs are captured before the first asynchronous codec call. */
export function withCompressedMetadata(bytes: Uint8Array, options?: CompressedMetadataOptions): Promise<Bytes>;
/** Extract plain metadata with owned buffers, retaining known compressed metadata in compressed. */
export function readMetadata(bytes: Uint8Array): Metadata;
/** Extract plain and compressed metadata with owned buffers; compressed is empty on success. */
export function readMetadataAsync(bytes: Uint8Array, options?: MetadataReadOptions): Promise<Metadata>;
