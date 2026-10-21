// SPDX-License-Identifier: MIT
export type ImageSource = Blob | ImageBitmap | ImageData | OffscreenCanvas | HTMLCanvasElement | HTMLImageElement;
export interface ImageOptions {
  /** The complete worker: a `Worker` running rapier-worker.js, or that file's URL (one worker per call). Required. */
  worker: Worker | string | URL;
  /** 1 to 99 is lossy; omitted or 100 is lossless. Does not apply to a carried JPEG. */
  quality?: number | undefined;
  /** 1 to 9; defaults to 7. */
  effort?: number | undefined;
  /** Set false to decode a JPEG and encode its pixels instead of carrying its coefficients. */
  transcode?: boolean | undefined;
}
/** A picture to a `Blob` of type `image/jxl`. A JPEG file is carried losslessly and rebuilds to its exact bytes. */
export function toJXL(source: ImageSource, options: ImageOptions): Promise<Blob>;
