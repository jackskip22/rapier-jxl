// SPDX-License-Identifier: MIT
import type {Bytes} from './index.mjs';

export interface ContainerOptions {
  /** Encoded bytes per jxlp box; defaults to 65536, from 1 through 16 MiB. */
  chunkSize?: number;
  /** Maximum total container bytes; defaults to 16 MiB. Streaming callers may set a larger safe integer. */
  maxBytes?: number;
  signal?: AbortSignal;
}
export interface ContainerStreamOptions extends ContainerOptions {
  /** Required codestream level. Level 10 writes jxll immediately after ftyp. Defaults to 5. */
  level?: 5 | 10;
}
/** Rebox a complete raw codestream or container as ordered jxlp. Image payload, metadata and JPEG reconstruction
 * bytes remain exact. Every returned chunk owns its storage. Does not create progressive image coding. */
export function containerChunks(bytes: Uint8Array, options?: ContainerOptions): Generator<Bytes, void, unknown>;
/** Collect containerChunks into one owned byte array. */
export function withContainer(bytes: Uint8Array, options?: ContainerOptions): Bytes;
/** Forward raw codestream chunks with backpressure, retaining one byte for a nonempty terminal fragment. Image encoding may
 * produce these chunks incrementally. Stopping iteration closes the source iterator. */
export function streamContainer(source: Iterable<Uint8Array> | AsyncIterable<Uint8Array>, options?: ContainerStreamOptions): AsyncGenerator<Bytes, void, unknown>;
