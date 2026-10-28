import type {CaptureOptions, EncodeOptions, ImageInput, Bytes} from './types.mjs';
export type {CaptureOptions} from './types.mjs';
export interface JxlPluginOptions {
  /** Default for every export: 0 (exact pixels), or 1-8 levels per RGB sample. */
  maxError?: CaptureOptions['maxError'];
  /** The encoder: rapier-jxl/capture's `encode` (default), or `encoder.capture` from your own `createEncoder()`.
   * Construction and explicit preparation pass a fresh raw RGBA screen (currently 1100 by 96), without options. */
  encode?: (input: ImageInput, options?: CaptureOptions) => Promise<Bytes>;
  /** For explicit quality below 1: `encoder.encode` from the same custom queue. Required when replacing `encode`.
   * Receives the encoder's quality scale (1-100), internally chosen effort and acceleration, plus signal and onProgress.
   * A custom hook also receives a one-pixel warm-up before a photographic export, without signal or onProgress. */
  encodeLossy?: (input: ImageInput, options?: EncodeOptions) => Promise<Bytes>;
  /** Start the capture encoder with a synthetic screen when the plug-in is made (default); false defers startup to an admitted export. */
  prepare?: boolean;
}
/** `result.toJxl(options)`: these, plus any SnapDOM canvas option (scale, width, height, backgroundColor, ...). */
export type JxlExportOptions = Pick<CaptureOptions, 'maxError' | 'signal' | 'onProgress'> & {
  /** Explicit finite 0-1 quality: 0 maps to codec quality 1 (its lowest); an original 1 stays exact even if a
   * beforeExport hook changes it. Caller values must be valid; below 1, hook-adjusted values must be valid too.
   * Omit for exact pixels (or maxError); SnapDOM's inherited quality is ignored. Cannot be combined with a nonzero
   * maxError, including the plug-in's default. Equal numeric WebP and JXL qualities do not imply equal measured quality. */
  quality?: number;
} & Record<string, unknown>;
export type JxlExports = {jxl(context: unknown, options?: JxlExportOptions): Promise<Blob>};
export interface JxlPlugin {
  name: 'jxl';
  /** Starts capture preparation with a synthetic screen. Overlapping calls share the current preparation; later calls start again.
   * Rejects if startup fails. Construction starts the screen in the background; admitted exports use one pixel
   * unless preparation is already pending. Background preparation is not awaited before canvas acquisition,
   * but an unfinished preparation can delay the real encode in the FIFO queue when its canvas is ready first. */
  prepare(): Promise<void>;
  defineExports(context: {exports: Record<string, (options?: any) => Promise<any>>}): JxlExports;
}
/** A SnapDOM 3.5 plug-in: `snapdom(element, {plugins: [jxl()]})`, then `await result.toJxl()` gives an exact image/jxl Blob.
 * `result.toJxl({quality: 0.9})` explicitly selects photographic encoding. */
export function jxl(options?: JxlPluginOptions): JxlPlugin;
