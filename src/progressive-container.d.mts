// SPDX-License-Identifier: MIT
import type {Bytes} from './index.mjs';
import type {CompressedMetadataOptions} from './metadata.mjs';

export interface ProgressiveContainerOptions {
  /** Maximum encoded payload per fragment. Defaults to 65536; extra cuts align with image milestones. */
  chunkSize?: number;
  /** Maximum complete container size. Defaults to 16 MiB. */
  maxBytes?: number;
  extended?: boolean;
  /** Existing Level10 is preserved; a Level5 input may be promoted. */
  level?: 5 | 10;
  /** Move Exif, XMP and JUMBF, including brob, after the image by default. Other boxes retain their bytes. */
  metadataPlacement?: 'before' | 'after';
  /** Required to frame an ICC-bearing codestream; use the prepared profile's exact encoded bit length. */
  iccBitLength?: number;
  signal?: AbortSignal;
}
export interface ProgressiveFragment {
  index: number;
  codestreamByteStart: number;
  codestreamByteEnd: number;
  containerByteStart: number;
  containerByteEnd: number;
  last: boolean;
}
export interface ProgressiveMilestone {
  /** LF frames are dependencies, not displayed pictures. An API may not expose incomplete LF/pass renders. */
  kind: 'preview' | 'lf-frame' | 'low-frequency' | 'pass' | 'reference-frame' | 'frame' | 'complete';
  /** -1 denotes the dedicated preview frame. */
  frameIndex: number;
  codestreamByteEnd: number;
  containerByteEnd: number;
  width: number;
  height: number;
  dcLevel?: number;
  pass?: number;
  /** Coded progressive hint, not a promise of API output dimensions. */
  downsample?: 1 | 2 | 4 | 8;
}
export interface ProgressiveContainerPlan {
  width: number;
  height: number;
  level: 5 | 10;
  codestreamBytes: number;
  containerBytes: number;
  prefixBytes: number;
  suffixBytes: number;
  fragments: ProgressiveFragment[];
  milestones: ProgressiveMilestone[];
}
export interface ProgressiveStreamOptions extends ProgressiveContainerOptions {
  /** Optional portable Brotli hook is passed through. Metadata editing retains its 16 MiB admission limit
   * and refuses JPEG reconstruction files. Compression completes before the first yielded byte. */
  metadata?: CompressedMetadataOptions;
}
/** Inspect this encoder's supported frame syntax. The codestream is copied, never recompressed. */
export function progressiveContainerPlan(bytes: Uint8Array, options?: ProgressiveContainerOptions): ProgressiveContainerPlan;
/** Eagerly capture/admit input, then emit complete ordered jxlp boxes with backpressure and owned storage. */
export function progressiveContainerChunks(bytes: Uint8Array, options?: ProgressiveContainerOptions): Generator<Bytes, void, unknown>;
export function withProgressiveContainer(bytes: Uint8Array, options?: ProgressiveContainerOptions): Bytes;
export function streamProgressiveContainer(bytes: Uint8Array, options?: ProgressiveStreamOptions): AsyncGenerator<Bytes, void, unknown>;
