import type {PackageDecode, JpegRestore, JpegRecompress} from './types.mjs';
import type {EncodedResult, ImageResult} from './result.mjs';
import type {ImageInput, EncodeOptions as StillOptions, AnimationInput, AnimationOptions, VideoSurface} from './types.mjs';
import type {CodecConfig} from './types.mjs';
export type * from './types.mjs';
export type EncodeOptions = StillOptions;
export {supported} from './index.mjs';
/** Compiles the kernels used by still and animation encoding.
 * @example await prepare(); */
export function prepare(): Promise<void>;
/** An animation ({width, height, frames}), an animated GIF Blob (its frames, loops and timing), a video, or a still: the full still encoder carries both, in one file: a page's calls run in its own worker. Calls in a worker, Node and edge hosts run in place.
 * A video (a Blob or File the browser plays, such as MP4, WebM or MOV, or a `<video>`) is read on the page: each distinct
 * frame the browser shows, lasting until the next one's time. Identical neighbors become one frame, looping forever. Frames
 * the browser skips while playing are found again by seeking back over gaps longer than 1.5 times the shortest interval
 * read. A frame under half that interval inside a shorter gap is not found. Without native frame timestamps, or on a
 * hidden page, frames are sampled by seeking. Frames stream to the encoder and are released after each encoding
 * window. Frame size, effort, and mode set each window. A device that cannot hold one refuses JXL_MEMORY. A video the browser cannot play, or
 * whose length it cannot learn, refuses JXL_INPUT with its reason. Elsewhere a video Blob refuses JXL_PLATFORM: pass its
 * decoded frames. A single-frame GIF Blob given `readAs` goes to the still reader. An animated GIF with `readAs` refuses
 * JXL_OPTIONS. Animation orientation or extra channels refuse JXL_INPUT. A required WebGPU device or job that cannot run
 * refuses JXL_WEBGPU.
 * `frames` may be an async (or sync) iterable of `{data, duration}`: each frame is read as the coder takes it and released
 * after its window, and the file equals the array form's for the same frames. A one-shot iterator that a lossy clip must read
 * twice refuses JXL_INPUT: give an iterable that iterates again, or quality 100. An animated GIF over 64 MiB of frames, and an
 * animated PNG or WebP where the platform has ImageDecoder, are read the same way.
 * @example const {bytes} = await encode(gif); // an animated GIF, a video or {width, height, loops, frames} */
export function encode(input: AnimationInput | Blob | VideoSurface, options?: AnimationOptions): Promise<EncodedResult>;
export function encode(input: ImageInput, options?: EncodeOptions): Promise<EncodedResult>;

/** Where the host reads no JPEG (Node, Deno, Bun), the one setup step for a JPEG input: `configureDecoder(decode, restore,
 * recompress)` with jpegxl/decode's decode and jpegxl/jpeg's recompress (restore may be null). Without it a JPEG
 * refuses JXL_PLATFORM. One call serves every jpegxl module in the realm. null alone clears it, while null with helpers keeps them.
 * @example configureDecoder((await import('jpegxl/decode')).decode, null, (await import('jpegxl/jpeg')).recompress); */
export function configureDecoder(decode: PackageDecode | null, restore?: JpegRestore | null, recompress?: JpegRecompress | null): void;

/** Settings for following calls. Configure before the first call or after close() resolves.
 * A browser import on a page uses this module's worker. Inside your own worker it runs in place without
 * a nested queue worker. Cold calls copy plain pixels and options and read 2D canvases before the module loads.
 * maxPendingJobs includes these calls. maxPendingBytes bounds their total retained snapshot bytes until they settle.
 * Loaded in-place calls, including Node, Deno, Bun, and edge calls, make no queue copy. workerFactory,
 * workerStartupTimeout, and maxPendingBytes have no effect there. maxPendingJobs still applies.
 * Configuring during a configured call refuses JXL_OPTIONS. An unconfigured call keeps running unchanged.
 * @example configure({maxPendingJobs: 4}); */
export function configure(settings?: CodecConfig): void;
/** Ends this module's worker and helpers. The next call starts them again.
 * Cancels cold calls still waiting to start. Calls already running in place are neither canceled nor awaited.
 * @example await close(); */
export function close(): Promise<void>;
