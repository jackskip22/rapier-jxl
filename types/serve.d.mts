import type {Bytes, EncodedInput} from './types.mjs';
export type {Bytes, EncodedInput};

/** How serve answers: cache header, entity tag, pixel bound and abort. */
export interface ServeOptions {
  /** Cache-Control header (default 'private, no-cache', pass 'public, max-age=31536000, immutable' for public, content-addressed URLs). */
  cacheControl?: string;
  /** The stored file's entity tag. Each representation gets its own (-jxl, -jpeg). Default: the first 128 bits of the file's SHA-256, computed
   * once per stored Uint8Array or Blob (pass a new array, or your own etag, after changing its bytes, a large file's own
   * key or version is a cheap etag). */
  etag?: string;
  /** The largest picture served, in pixels. None by default. A larger one refuses JXL_DIMENSIONS. */
  maxPixels?: number;
  /** To an image/jxl client, the smallest of the file's sizes (1:8, 1:4, 1:2, 1:1) at least this many pixels wide, cut
   * from the file without decoding (jpegxl/metadata slice). A file with no passes to cut is served whole. */
  width?: number;
  /** To an image/jxl client, the largest of the file's sizes in at most this many bytes. None refuses JXL_LIMIT. */
  maxBytes?: number;
  /** Take width from the client's Sec-CH-Viewport-Width (or Viewport-Width) times its DPR, and Vary on them. */
  responsive?: boolean;
  /** Another representation, ranked by Accept alongside JPEG XL and any restorable JPEG. A function is called only
   * when this representation is selected, before any 304. The response has Vary: Accept and a tag from its type and
   * bytes, independent of `etag`. */
  fallback?: {type: string; bytes: EncodedInput | Blob | (() => EncodedInput | Blob | Promise<EncodedInput | Blob>)};
  signal?: AbortSignal | undefined;
}

/** A request: a Web Request, or anything with `method` and `headers` (a Headers object or a header record). */
export interface ServeRequest {
  readonly method?: string | undefined;
  readonly headers: {get(name: string): string | null} | Readonly<Record<string, string | readonly string[] | undefined>>;
}

/** node:http's response: status, headers and body are written to it. */
export interface ServeNodeResponse {
  writeHead(statusCode: number, headers?: Record<string, string>): unknown;
  end(chunk?: Uint8Array): unknown;
}

/**
 * Serve stored JPEG XL according to Accept, with its exact original JPEG when restorable or a supplied `fallback`.
 * Responses include `Vary: Accept`, an ETag per representation, `Cache-Control`, `Content-Length`, `304` and `HEAD`.
 * With a node:http response, a refusal first answers it 500, so no client waits. Handle the promise. Invalid requests and options refuse JXL_OPTIONS, oversized pictures JXL_DIMENSIONS, and missing JPEG reconstruction data JXL_RECONSTRUCTION. Caller bytes use an ArrayBuffer or any view of one. SharedArrayBuffer backing is refused with JXL_INPUT.
 * @example const response = await serve(stored, request); */
export function serve(stored: EncodedInput | Blob, request: ServeRequest, options?: ServeOptions): Promise<Response>;
export function serve(stored: EncodedInput | Blob, request: ServeRequest, response: ServeNodeResponse, options?: ServeOptions): Promise<undefined>;

/** Whether an `Accept` header prefers `image/jxl` to `alternative` (RFC 9110 12.5.1), as `serve` decides. Default `image/jpeg`.
 * With a string Accept header, a non-string alternative refuses JXL_OPTIONS.
 * @example const wantsJxl = acceptsJxl(request.headers.get('accept')); */
export function acceptsJxl(accept: string | null | undefined, alternative?: string): boolean;

/** Codes for refusals raised by rapier-jxl. Caller callback errors and abort reasons pass through unchanged. */
export type {CodecError, ErrorCode} from './types.mjs';
