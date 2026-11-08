// Types for svg-jxl.js.
import type {CaptureCompleteCodec} from 'rapier-jxl/codec';
import type {Effort} from 'rapier-jxl/capture-complete';

export type CaptureEncoder = Pick<CaptureCompleteCodec, 'capture'>;
/** quality: 0-1 (rapier-jxl's quality divided by 100), 0.92 by default; exact: no lossy try; cache: shared between calls, a picture is coded once. */
export type SvgJxlOptions = {quality?: number; exact?: boolean; effort?: Effort; webgpu?: false | 'required'; signal?: AbortSignal;
  onProgress?: (fraction: number) => void; codec?: CaptureEncoder; cache?: Map<string, unknown>};
/** kind by its bytes; route kept, with each try's bytes; kept: why it stays; alpha: coded from the PNG's own samples. */
export type SvgJxlPicture = {kind: string; bytes?: number; jxl?: number; route: 'jpeg' | 'lossless' | 'quality' | 'kept'; tries?: {quality?: number; jpeg?: number; lossless?: number}; kept?: string; alpha?: boolean; reader?: string; url?: string};
export type SvgJxlRecord = {bytes: number; jxl: number; pictures: SvgJxlPicture[]; fonts: number};
/** The same kind back, and the record. Not a sanitizer: the SVG's scripts, styles and links pass through unchanged. */
export function svgJxl<T extends string | Blob>(input: T, options?: SvgJxlOptions): Promise<{
  svg: T extends string ? string : T extends File ? File : Blob;
  record: SvgJxlRecord;
}>;
