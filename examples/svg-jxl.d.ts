// Types for svg-jxl.js.
import type {Effort, CaptureInput, CaptureCompleteOptions, ImageResult} from 'jpegxl/capture-complete';

/** A capture module (import * as codec from 'jpegxl/capture-complete'), or anything with its capture. */
export type CaptureEncoder = {capture(input: CaptureInput, options?: CaptureCompleteOptions): Promise<ImageResult>};
/** fidelity: as encode's, default {quality: 92}. cache: shared between calls, a picture is coded once. */
export type SvgJxlOptions = {
  /** 'exact' skips the lossy try: JPEGs restore exactly, the rest code lossless. {quality} from 1 to 100, as encode's
   * (100 is exact). Default {quality: 92}. */
  fidelity?: 'exact' | {quality: number};
  /** 1 (fastest) to 9 (smallest file), as rapier-jxl/capture-complete's. */
  effort?: Effort;
  /** As rapier-jxl's webgpu option. */
  webgpu?: false | 'required';
  /** Aborts the call. */
  signal?: AbortSignal | undefined;
  /** Called with 0 to 1 as pictures are coded. */
  onProgress?: ((fraction: number) => void) | undefined;
  /** The capture module to code with. Default rapier-jxl/capture-complete. */
  codec?: CaptureEncoder;
  /** Shared between calls: a picture is coded once. */
  cache?: Map<string, unknown>};
/** kind by its bytes. Route kept, with each try's bytes. kept: why it stays. alpha: coded from the PNG's own samples. */
export type SvgJxlPicture = {kind: string; bytes?: number; jxl?: number; route: 'jpeg' | 'lossless' | 'quality' | 'kept'; tries?: {quality?: number; jpeg?: number; lossless?: number}; kept?: string; alpha?: boolean; reader?: string; url?: string};
/** The SVG's size in bytes before (bytes) and after (jxl), its pictures with how each was coded, and its font count. */
export type SvgJxlRecord = {bytes: number; jxl: number; pictures: SvgJxlPicture[]; fonts: number};
/** The same kind back, and the record. Not a sanitizer: the SVG's scripts, styles and links pass through unchanged.
 * @example const {svg, record} = await svgJxl(svgText); */
export function svgJxl<T extends string | Blob>(input: T, options?: SvgJxlOptions): Promise<{
  svg: T extends string ? string : T extends File ? File : Blob;
  record: SvgJxlRecord;
}>;
