import type {Bytes, WorkerLike, DecodeOptions, DecodedImage} from './types.mjs';
/** Options for install(). All are optional. */
export interface PolyfillOptions {
  /** The document to patch. Default the global one. */
  document?: Document;
  /** Where to look for images: a document, element or shadow root. Default the document. */
  root?: Document | Element | ShadowRoot;
  /** A JPEG XL data or image URL the native test loads. Default a built-in one. */
  probeURL?: string;
  /** true decodes every image here, even where the browser shows JPEG XL itself. Default false. */
  force?: boolean;
  /** Images decoded at once, 1 to 4. Default 2. */
  workers?: 1 | 2 | 3 | 4;
  /** Bytes for decoded images, none by default: when set, each decode, one per worker at once, is bounded by it alone,
   * and the images shown together stay under it. A decode holds about 32 bytes a pixel. A larger picture fails with
   * JXL_DIMENSIONS, naming its size and this limit. */
  maxDecodedBytes?: number;
  /** Largest file fetched, in bytes. None by default. A larger one fails with JXL_LIMIT. */
  maxInputBytes?: number;
  /** How far off screen an image starts decoding, in pixels or percent. Default '1000px'. */
  rootMargin?: string;
  /** Makes the decode worker. For a bundler or a Content Security Policy that needs your own URL. */
  workerFactory?: (() => WorkerLike) | undefined;
  /** Your own decoder in place of the package's (a native or a server-side one): it receives owned bytes and may
   * return the decoded image directly or asynchronously. */
  decode?: ((bytes: Bytes, options: DecodeOptions) => DecodedImage | PromiseLike<DecodedImage>) | undefined;
  /** An image that could not be shown, with its ErrorCode: JXL_IO where the image request failed, JXL_PLATFORM where the
   * page's image policy refuses decoded images or the decoded picture could not be put on screen.
   * A value this callback throws or rejects is reported unchanged through the window's reportError. */
  onError?: ((error: unknown, element: Element) => void) | ((error: unknown, element: Element) => PromiseLike<void>) | undefined;
}
export interface PolyfillController {
  readonly status: 'active' | 'native' | 'probe-blocked' | 'unavailable' | 'closed';
  readonly stats?: {elements: number; resources: number; active: number; queued: number};
  refresh(): void;
  disconnect(): void;
}
/** null means policy or a timeout prevented detection, not lack of native support.
 * A document unable to create images, or a non-string probeURL, refuses JXL_OPTIONS.
 * @example if (!await supportsJXL()) await install(); */
export function supportsJXL(document?: Document, probeURL?: string): Promise<boolean | null>;
/** Whether the browser plays animated JPEG XL: `false` where it shows stills only (Safari), `null` where that is not known.
 * @example if (await supportsAnimatedJXL() === false) await install(); */
export function supportsAnimatedJXL(document?: Document): Promise<boolean | null>;
/** Shows JPEG XL images where the browser does not: those on the page and those added later. Importing installs
 * nothing. One installation a document: a later call returns it until disconnect(). refresh() rereads the page at once.
 * Options are read once, at the call. Invalid ones reject with JXL_OPTIONS and leave any earlier installation connected.
 * @example const polyfill = await install(); */
export function install(options?: PolyfillOptions): Promise<PolyfillController>;

/** Codes for refusals raised by rapier-jxl. Caller callback errors and abort reasons pass through unchanged. */
export type {CodecError, ErrorCode} from './types.mjs';
