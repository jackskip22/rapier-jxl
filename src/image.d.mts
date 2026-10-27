// SPDX-License-Identifier: MIT
export type ImageSource = Blob | ImageBitmap | ImageData | OffscreenCanvas | HTMLCanvasElement | HTMLImageElement;
export interface ImageOptions {
  /** A `Worker` running rapier-still-worker.js or rapier-worker.js, or either file's URL (a new worker for that call).
   * Calls sharing one `Worker` run one after another. Required. */
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
