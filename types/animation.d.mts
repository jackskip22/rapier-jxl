import type {PackageDecode, JpegRestore, JpegRecompress} from './types.mjs';
import type {EncodedResult, ImageResult} from './result.mjs';
import type {ImageInput, EncodeOptions, AnimationInput, AnimationOptions, VideoSurface} from './types.mjs';
import type {CodecConfig} from './types.mjs';
export type * from './types.mjs';
export {supported} from './index.mjs';
/** Compiles the kernels used by still and animation encoding. */
export function prepare(): Promise<void>;
/** An animation ({width, height, frames}), an animated GIF Blob (its frames, loops and timing), a video, or a still: the full still encoder carries both, in one file: a page's calls run in its own worker; calls in a worker, Node and edge hosts run in place. A GIF Blob given `readAs` goes to the still reader, not the animation reader.
 * A video (a Blob or File the browser plays, such as MP4, WebM or MOV, or a `<video>`) is read on the page: each distinct
 * frame the browser shows, lasting until the next one's time; identical neighbours become one frame, looping forever. Frames
 * the browser skips while playing are found again by seeking back over gaps longer than 1.5 times the shortest interval
 * read; a frame under half that interval inside a shorter gap is not found. Without requestVideoFrameCallback, or on a hidden page, a frame is sampled each 1/60 s. onProgress's first half is
 * the reading. The distinct frames are held as RGBA on the page while it is read, then move to the worker; past an eighth
 * of the device's memory (navigator.deviceMemory, else 4 GB) it refuses JXL_MEMORY. A video the browser cannot play, or
 * whose length it cannot learn, refuses JXL_INPUT with its reason. Elsewhere a video Blob refuses JXL_PLATFORM: pass its
 * decoded frames. A single-frame GIF Blob given `readAs` goes to the still reader; an animated GIF with `readAs` refuses
 * JXL_OPTIONS. Animation orientation or extra channels refuse JXL_INPUT; a required WebGPU device or job that cannot run
 * refuses JXL_WEBGPU. */
export function encode(input: AnimationInput | Blob | VideoSurface, options?: AnimationOptions): Promise<EncodedResult>;
export function encode(input: ImageInput, options?: EncodeOptions): Promise<EncodedResult>;

/** Where the host reads no JPEG (Node, Deno, Bun), the one setup step for a JPEG input: `configureDecoder(decode, restore,
 * recompress)` with jpegxl/decode's decode and jpegxl/jpeg's recompress (restore may be null). Without it a JPEG
 * refuses JXL_PLATFORM. One call serves every jpegxl module in the realm; null alone clears it, while null with helpers keeps them. */
export function configureDecoder(decode: PackageDecode | null, restore?: JpegRestore | null, recompress?: JpegRecompress | null): void;

/** This module's settings for the calls that follow. In a browser they are its queue's: the module runs in its own file's
 * worker, from a page or nested in a worker of the page's own; configure before the first call, or again once close() has
 * resolved. In place (Node, Deno, Bun, edge hosts, a page's own worker) it takes the same
 * keys: helpers (where the module has them), webgpu and maxPixels, and maxPendingJobs bounding the calls pending at once; no worker starts and nothing is copied
 * there, so the worker settings and maxPendingBytes have nothing to act on. Configuring while a call runs refuses JXL_OPTIONS. */
export function configure(settings?: CodecConfig): void;
/** Ends this module's worker and helpers; the next call starts them again. */
export function close(): Promise<void>;
