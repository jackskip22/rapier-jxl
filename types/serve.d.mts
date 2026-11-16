import type {Bytes} from './types.mjs';
export type {Bytes};

/** How serve answers: cache header, entity tag, pixel bound and abort. */
export interface ServeOptions {
  /** Cache-Control header (default 'private, no-cache'; pass 'public, max-age=31536000, immutable' for public, content-addressed URLs). */
  cacheControl?: string;
  /** The stored file's entity tag; each representation gets its own (-jxl, -jpeg). Default: the file's SHA-256, computed
   * once per stored Uint8Array or Blob (pass a new array, or your own etag, after changing its bytes; a large file's own
   * key or version is a cheap etag). */
  etag?: string;
  /** The largest picture served, in pixels; none by default. A larger one refuses JXL_DIMENSIONS. */
  maxPixels?: number;
  /** To an image/jxl client, the smallest of the file's sizes (1:8, 1:4, 1:2, 1:1) at least this many pixels wide, cut
   * from the file without decoding (rapier-jxl/metadata slice). A file with no passes to cut is served whole. */
  width?: number;
  /** To an image/jxl client, the largest of the file's sizes in at most this many bytes; none refuses JXL_LIMIT. */
  maxBytes?: number;
  /** Take width from the client's Sec-CH-Viewport-Width (or Viewport-Width) times its DPR, and Vary on them. */
  responsive?: boolean;
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
 * A file from `recompress` served to every client: `image/jxl` where the request accepts it, else the exact original
 * JPEG, with `Vary: Accept`, an ETag per representation, `Cache-Control`, `Content-Length`, `304` and `HEAD`.
 * With a node:http response, a refusal first answers it 500, so no client waits; handle the promise. Invalid requests and options refuse JXL_OPTIONS; oversized pictures JXL_DIMENSIONS; missing JPEG reconstruction data JXL_RECONSTRUCTION. Caller bytes use plain Uint8Array; SharedArrayBuffer backing is refused with JXL_INPUT.
 */
export function serve(stored: Uint8Array | Blob, request: ServeRequest, options?: ServeOptions): Promise<Response>;
export function serve(stored: Uint8Array | Blob, request: ServeRequest, response: ServeNodeResponse, options?: ServeOptions): Promise<undefined>;

/** Whether an `Accept` header prefers `image/jxl` to `alternative` (RFC 9110 12.5.1), as `serve` decides; default `image/jpeg`.
 * With a string Accept header, a non-string alternative refuses JXL_OPTIONS. */
export function acceptsJxl(accept: string | null | undefined, alternative?: string): boolean;

/** Every refusal: a coded Error. */
export type {CodecError, ErrorCode} from './types.mjs';
