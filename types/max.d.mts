import type {Effort as StillEffort, EncodeOptions as StillOptions, ImageInput} from './types.mjs';
import type {EncodedResult, ImageJob as StillJob} from './result.mjs';
import type {ResumableFunction} from './resumable.mjs';
export type * from './types.mjs';
export type {CaptureCompleteOptions, CaptureFidelity} from './index.mjs';
/** 1 (fastest) to 10 (the most search for the smallest file). */
export type Effort = StillEffort | 10;
/** encode's options, with effort 10 as the default. */
export type EncodeOptions = Omit<StillOptions, 'effort'> & {
  /** 1-10. Default 10. Effort 10 can take minutes. */
  effort?: Effort};
/** An image operation whose encode options can request effort 10. Other operations keep their own options. */
export type ImageJob = Exclude<StillJob, {readonly verb: 'encode'}> |
  {readonly verb: 'encode'; readonly options?: EncodeOptions};
/** jpegxl/max: the full still encoder with efforts 1-10, default 10. Accepts every jpegxl input, including canvases,
 * pixels, ImageData, ImageBitmap, VideoFrame, Blob and GPU textures. Effort 10 can take minutes. It keeps effort 9's
 * file or a smaller file at the same requested fidelity, exact or lossy. A JPEG kept as it is also searches beyond
 * effort 9's reconstruction. The effort 10 device route runs where a usable WebGPU device answers and writes the same bytes.
 * A page's calls run in this module's own worker. Calls in a worker, Node and edge hosts run in place. */
export const encode: ResumableFunction<(input: ImageInput, options?: EncodeOptions) => Promise<EncodedResult>>;
/** Fit and variants keep efforts 1-9, default 7. */
export {fit, variants, prepare, supported, configureDecoder, configure, close} from './index.mjs';
