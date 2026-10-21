// SPDX-License-Identifier: MIT
import type {Bytes} from './index.mjs';
import type {ColorEncoding, ICCCompression} from './icc.mjs';

export interface ContainerBounds {
  /** Complete input and output byte limit, default 16 MiB. May be raised explicitly to a safe integer. */
  maxBytes?: number;
}
export interface ContainerWriteOptions extends ContainerBounds {
  /** Use 64-bit extended headers for new boxes. The signature always retains its fixed 12-byte form. */
  extended?: boolean;
  /** Default preserves an input container's level, or 5 for a naked codestream. Level 10 cannot be demoted. */
  level?: 5 | 10;
}
export interface ContainerFragment {
  sequence: number;
  last: boolean;
  /** Physical byte offset and payload length, excluding the sequence counter. */
  byteOffset: number;
  byteLength: number;
  headerLength: 8 | 16;
}
export interface ContainerInspection {
  /** Owned copy in logical decoding order. */
  codestream: Bytes;
  level: 5 | 10;
  minorVersion: 0 | 1;
  /** Physical delivery order. Empty for a naked stream or jxlc. */
  fragments: ContainerFragment[];
  /** Owned opaque payloads, including compressed boxes and JPEG reconstruction data. */
  auxiliary: {boxType: string; data: Bytes; extended: boolean}[];
}
/** Write an ordinary or extended box header without allocating the payload. byte length is a safe integer. */
export function containerBoxHeader(boxType: string, bodyByteLength: number, options?: {extended?: boolean}): Bytes;
/** Check box bounds, brands, levels and complete logical fragment order. Does not decode image syntax. */
export function inspectContainer(bytes: Uint8Array, options?: ContainerBounds): ContainerInspection;

export interface ReframeOptions extends ContainerWriteOptions {
  /** Split the logical codestream into jxlp fragments of at most this many bytes. Default writes one jxlc. */
  chunkSize?: number;
  /** Complete permutation of fragment sequence numbers. Out-of-order delivery requires version 1. */
  fragmentOrder?: readonly number[];
  /** Default 0 for ordered output or 1 for out-of-order output. */
  minorVersion?: 0 | 1;
  /** Every preview/hidden/displayed frame header's logical byte offset, strictly increasing. Usually omitted:
   * the encoder's frame parser reads its own output. Supply this complete list for external codestreams with
   * unsupported header syntax. The caller is responsible for the correctness and completeness of that list.
   * Each frame-start fragment must stay after all earlier and before all later fragments. */
  frameStarts?: readonly number[];
  /** Default false also keeps the fragment immediately before each frame start in order. Chrome 155 rejects
   * some animated version 1 files whose preceding fragment comes from its reorder buffer. True admits those
   * format-valid layouts; libjxl 0.12.0 decodes them. Oxide 0.12.6 rejects all out-of-order delivery. */
  allowBufferedFrameEnds?: boolean;
  /** Prepared ICC payload bit length, when the automatic frame parser reads an ICC-bearing image. */
  iccBitLength?: number;
}
/** Preserve codestream and opaque auxiliary bytes while choosing box widths and fragment delivery order.
 * With default options this normalizes version 1 to ordered version 0, for readers such as oxide 0.12.6.
 * Does not change animation timing or frame contents. */
export function reframeContainer(bytes: Uint8Array, options?: ReframeOptions): Bytes;

export type IndexInteger = number | bigint;
export interface FrameIndexEntry {
  /** Absolute byte offset from the start of the logical naked codestream, not the enclosing file. */
  byteOffset: IndexInteger;
  /** Duration in index ticks until the next indexed frame, or the end of the stream. */
  duration: IndexInteger;
  /** Number of displayed frames until the next indexed frame, or through the end. At least one. */
  framesToNext: IndexInteger;
}
export interface FrameIndex {
  /** One tick lasts tickNumerator / tickDenominator seconds. Both are unsigned 32-bit; denominator is nonzero. */
  tickNumerator: number;
  tickDenominator: number;
  /** First displayed frame is indexed; all entries must be independently decodable keyframes. The author
   * supplies offsets and durations. Hidden compositing frames do not count toward framesToNext. */
  frames: readonly FrameIndexEntry[];
}
/** Serialize jxli contents with exact unsigned 63-bit integers. Unsafe Numbers must be supplied as bigint. */
export function frameIndexPayload(index: FrameIndex, options?: ContainerBounds): Bytes;
/** Replace/add the one jxli box, or remove it with null. Offset bounds are checked; keyframe independence
 * and correspondence with actual frame headers are the author's responsibility. */
export function withFrameIndex(bytes: Uint8Array, index: FrameIndex | null, options?: ContainerWriteOptions): Bytes;
/** Return owned index records, using bigint only when a decoded value exceeds Number.MAX_SAFE_INTEGER. */
export function readFrameIndex(bytes: Uint8Array, options?: ContainerBounds): FrameIndex | null;

export interface GainMapBundle {
  version?: 0;
  /** Original ISO 21496-1 metadata, at most 65535 bytes. Carried without interpreting or regenerating it. */
  gainMapMetadata: Uint8Array;
  /** Already encoded JPEG XL gain-map image. A container is unwrapped to its naked logical codestream. */
  gainMap: Uint8Array;
  alternativeColorEncoding?: ColorEncoding;
  /** Exact serialized ColorEncoding bundle, as returned by readGainMap. Exclusive with structured encoding. */
  alternativeColorEncodingBytes?: Uint8Array;
  /** Original alternate-rendering ICC profile; compressed with JPEG XL's ICC coding. */
  alternativeICC?: Uint8Array;
  iccCompression?: ICCCompression;
  /** Already compressed alternate ICC, as returned by readGainMap. Exclusive with original ICC. */
  alternativeICCCompressed?: Uint8Array;
}
export interface ReadGainMapBundle {
  version: 0;
  gainMapMetadata: Bytes;
  gainMap: Bytes;
  alternativeColorEncodingBytes: Bytes;
  alternativeICCCompressed: Bytes;
}
/** Serialize the version 0 jhgm bundle from ISO/IEC 18181-2 edition 3 (2026). This writes supplied gain maps;
 * it does not derive gain-map samples, interpret ISO 21496-1 metadata or apply HDR rendering. */
export function gainMapPayload(bundle: GainMapBundle, options?: ContainerWriteOptions): Bytes;
/** Replace/add jhgm, or remove with null. Preserves the base codestream, metadata and JPEG reconstruction. */
export function withGainMap(bytes: Uint8Array, bundle: GainMapBundle | null, options?: ContainerWriteOptions): Bytes;
/** Read a plain jhgm into owned payloads. Brotli-wrapped gain maps require external decompression first. */
export function readGainMap(bytes: Uint8Array, options?: ContainerBounds): ReadGainMapBundle | null;
