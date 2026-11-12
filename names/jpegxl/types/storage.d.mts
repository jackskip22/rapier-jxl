import type {Bytes} from './types.mjs';
export type {Bytes};

/** SharedArrayBuffer backing is refused with JXL_INPUT. */
export type ObjectBody = Uint8Array | ArrayBuffer | Blob | ReadableStream<Uint8Array>;
export interface ReadOptions {
  /** Positive byte limit, at most and by default 256 MiB. */
  maxBytes?: number;
  signal?: AbortSignal;
}
/** Copies bytes; bounds a stream as it is read, and cancels it on overflow, refusal or abort. */
export function readAll(body: ObjectBody, options?: ReadOptions): Promise<Bytes>;

