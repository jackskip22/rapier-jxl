// Types for jxl.js, beside it.
import type {CaptureOptions} from 'jpegxl/capture';
import type {UploadCaptureOptions} from 'jpegxl/upload';
import type {Effort, CaptureInput, CaptureCompleteOptions, ImageResult} from 'jpegxl/capture-complete';
import type {CaptureInput as LeanInput} from 'jpegxl/capture';
import type {UploadCaptureInput} from 'jpegxl/upload';

export type LeanCaptureModule = 'rapier-jxl/capture' | 'rapier-jxl/upload';
export type CompleteCaptureModule = 'rapier-jxl/capture-complete';
export type CaptureModule = LeanCaptureModule | CompleteCaptureModule;
export type CaptureEffort = CaptureOptions['effort'];
export type UploadEffort = UploadCaptureOptions['effort'];
export type {Effort};
/** A capture module imported directly (import * as codec from 'jpegxl/capture'), or anything with its capture and prepare. */
export type CaptureEncoder =
  {capture(input: CaptureInput, options?: CaptureCompleteOptions): Promise<ImageResult>; prepare(): Promise<void>} |
  {capture(input: LeanInput, options?: CaptureOptions): Promise<ImageResult>; prepare(): Promise<void>} |
  {capture(input: UploadCaptureInput, options?: UploadCaptureOptions): Promise<ImageResult>; prepare(operation?: 'encode' | 'capture'): Promise<void>};
/** 'rapier-jxl/capture' and 'rapier-jxl/upload' come only as the codec you import, so a build holds the modules you
 * chose. Helpers are the module's own: configure({helpers}) from it. */
export type JxlOptions =
  {module: 'rapier-jxl/capture'; codec: CaptureEncoder; effort?: CaptureEffort; webgpu?: never} |
  {module: 'rapier-jxl/upload'; codec: CaptureEncoder; effort?: UploadEffort; webgpu?: never} |
  {module?: CompleteCaptureModule; codec?: undefined; effort?: Effort; webgpu?: CompleteWebGPU} |
  {codec: CaptureEncoder; module?: CompleteCaptureModule; effort?: Effort; webgpu?: CompleteWebGPU};
/** The complete capture's device choice: false never asks for one, 'required' refuses without one; left out, it is used where it helps.
 * The lean modules run on WebAssembly and take none. */
export type CompleteWebGPU = CaptureCompleteOptions['webgpu'];
/** The export's record: exact, every pixel as drawn; textMarks 'skipped' where unboxed text was not looked for. */
export type JxlRecord = {readonly exact: boolean; readonly textMarks?: 'skipped'};
/** SnapDOM's export options (quality, scale, size, dpr, filename), effort and capture callbacks for this export;
 * backgroundColor left out keeps transparent samples transparent, as SnapDOM's PNG does.
 * onProgress reports encoding only, after SnapDOM draws; onEncoded gets the export's record once the file is written.
 * Callback promises settle before the export resolves unless aborted; a thrown or rejected value rejects the export unchanged. */
export type JxlExportOptions = Pick<CaptureOptions, 'onProgress'> & {onEncoded?: ((record: JxlRecord) => void) | ((record: JxlRecord) => PromiseLike<void>) | undefined} &
  {quality?: number; scale?: number; width?: number; height?: number; dpr?: number;
  backgroundColor?: string | null; filename?: string; format?: string; effort?: Effort; signal?: AbortSignal | undefined};
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
