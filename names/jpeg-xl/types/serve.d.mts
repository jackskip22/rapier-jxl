import type {Bytes} from './types.mjs';
export type {Bytes};

export interface ServeOptions {
  /** Cache-Control header (default 'private, no-cache'; pass 'public, max-age=31536000, immutable' for public, content-addressed URLs). */
  cacheControl?: string;
  /** The stored file's entity tag; each representation gets its own (-jxl, -jpeg). Default: the file's SHA-256, computed
   * once per stored Uint8Array or Blob (pass a new array, or your own etag, after changing its bytes; a large file's own
   * key or version is a cheap etag). */
  etag?: string;
  /** The largest picture served, in pixels: at most 64,000,000 (the default); a larger one refuses JXL_DIMENSIONS. */
  maxPixels?: number;
  signal?: AbortSignal;
}

/** A request: a Web Request, or anything with `method` and `headers` (a Headers object or a header record). */
export interface ServeRequest {
  readonly method?: string;
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
 * Caller bytes use plain Uint8Array; SharedArrayBuffer backing is refused at runtime with JXL_INPUT.
 */
export function serve(stored: Uint8Array | Blob, request: ServeRequest, options?: ServeOptions): Promise<Response>;
export function serve(stored: Uint8Array | Blob, request: ServeRequest, response: ServeNodeResponse, options?: ServeOptions): Promise<undefined>;
