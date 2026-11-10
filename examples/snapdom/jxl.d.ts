// Types for jxl.js, beside it.
import type {CaptureCodec, CaptureCompleteCodec, CodecConfig} from 'rapier-jxl/codec';
import type {CaptureOptions} from 'rapier-jxl/capture';
import type {CaptureOptions as UploadCaptureOptions} from 'rapier-jxl/upload';
import type {Effort} from 'rapier-jxl/capture-complete';

export type LeanCaptureModule = 'rapier-jxl/capture' | 'rapier-jxl/upload';
export type CompleteCaptureModule = 'rapier-jxl/capture-complete';
export type CaptureModule = LeanCaptureModule | CompleteCaptureModule;
export type CaptureEffort = CaptureOptions['effort'];
export type UploadEffort = UploadCaptureOptions['effort'];
export type {Effort};
/** A codec your app made (createCodec), or a capture module imported directly. */
export type CaptureEncoder = Pick<CaptureCodec, 'capture' | 'prepare'> | Pick<CaptureCompleteCodec, 'capture' | 'prepare'>;
export type CaptureHelpers = CodecConfig['helpers'];
/** helpers configure a codec the plug-in makes; with your own codec they are accepted and ignored. */
export type JxlOptions = {webgpu?: false | 'required'} & (
  {module: 'rapier-jxl/capture'; codec?: undefined; effort?: CaptureEffort; helpers?: never} |
  {module: 'rapier-jxl/upload'; codec?: undefined; effort?: UploadEffort; helpers?: CaptureHelpers} |
  {module?: CompleteCaptureModule; codec?: undefined; effort?: Effort; helpers?: CaptureHelpers} |
  {codec: CaptureEncoder; module?: CaptureModule; effort?: Effort; helpers?: CaptureHelpers});
/** SnapDOM's WebP options, with the same defaults, effort and capture callbacks for this export.
 * onProgress reports encoding only, after SnapDOM draws; onEncoded and callback exceptions follow capture(). */
export type JxlExportOptions = Pick<CaptureOptions, 'onProgress' | 'onEncoded'> &
  {quality?: number; scale?: number; width?: number; height?: number; dpr?: number;
  backgroundColor?: string | null; filename?: string; format?: string; effort?: Effort; signal?: AbortSignal};
/** The parts of SnapDOM's capture context the plug-in reads. */
export type JxlContext = {element?: Element; nodeMap?: unknown; outerTransforms?: boolean; width?: number; height?: number;
  meta?: {clip?: {x?: number; y?: number; width?: number; height?: number} | null; contentX?: number; contentY?: number; vbW?: number; vbH?: number;
    targetW?: number; targetH?: number};
  export?: {requestedOptions?: JxlExportOptions}};
/** The parts of SnapDOM's built-in exports the plug-in builds on (optional, as SnapDOM's own types have them). */
export type SnapDOMExports = {canvas?(options: JxlExportOptions): Promise<HTMLCanvasElement>; blob?(options: JxlExportOptions): Promise<Blob>};
/** The plug-in: result.toJxl() gives an <img>; toBlob({format: 'jxl'}) the file; download({format: 'jxl'}) saves it. */
export interface JxlPlugin {
  name: string;
  pure: true;
  afterClone?(context: JxlContext): void;
  defineExports(context: {exports?: SnapDOMExports}): {
    jxl(context: JxlContext, options?: JxlExportOptions): Promise<HTMLImageElement>;
    blob(context: JxlContext, options?: JxlExportOptions): Promise<Blob>;
    download(context: JxlContext, options?: JxlExportOptions): Promise<void>;
  };
}
export function jxl(options?: JxlOptions): JxlPlugin;

// Loading this plug-in's declaration adds its exports to SnapDOM's result.
declare module '@zumer/snapdom' {
  interface CaptureResult {
    toJxl(options?: JxlExportOptions): Promise<HTMLImageElement>;
    toBlob(options: JxlExportOptions & {format: 'jxl'}): Promise<Blob>;
    download(options: JxlExportOptions & {format: 'jxl'}): Promise<void>;
  }
}
