import type {WorkerLike, DecodeOptions, DecodedImage} from './types.mjs';
export interface PolyfillOptions {
  document?: Document;
  root?: Document | Element | ShadowRoot;
  probeURL?: string;
  force?: boolean;
  workers?: 1 | 2 | 3 | 4;
  /** Bytes for decoded images (default 128 MiB): each decode, one per worker at once, is bounded by it alone, and the
   * images shown together stay under it. Not one cap on all the polyfill's memory. */
  maxDecodedBytes?: number;
  maxInputBytes?: number;
  rootMargin?: string;
  workerFactory?: () => WorkerLike;
  /** Your own decoder in place of the package's (a native or a server-side one): it receives each image's bytes. */
  decode?: (bytes: Uint8Array, options: DecodeOptions) => Promise<DecodedImage>;
  /** An image that could not be shown. `error.code` is the decoder's ErrorCode, or one of the polyfill's own:
   * JXL_FETCH (the image request failed), JXL_IMAGE_CSP (the page's image policy refuses decoded images) or
   * JXL_DISPLAY (the decoded picture could not be put on screen). */
  onError?: (error: unknown, element: Element) => void;
}
export interface PolyfillController {
  readonly status: 'active' | 'native' | 'probe-blocked' | 'unavailable' | 'closed';
  readonly stats?: {elements: number; resources: number; active: number; queued: number};
  refresh(): void;
  disconnect(): void;
}
/** null means policy or a timeout prevented detection, not lack of native support. */
export function supportsJXL(document?: Document, probeURL?: string): Promise<boolean | null>;
/** Explicit installation supersedes automatic installation. Repeated explicit calls reuse it until disconnected.
 * Options are read once, at the call; invalid ones reject with JXL_OPTIONS and leave any earlier installation connected. */
export function install(options?: PolyfillOptions): Promise<PolyfillController>;
/** Initial installation. If already settled, its controller can later be closed by explicit installation. */
export const ready: Promise<PolyfillController | null>;
