// Types for svg-jxl.js.
import type {Effort} from 'rapier-jxl/capture-complete';
import type {CaptureEncoder, SvgJxlRecord} from 'rapier-jxl/svg-jxl';

export type {SvgJxlPicture} from 'rapier-jxl/svg-jxl';
export type SvgJxlPluginOptions = {effort?: Effort; webgpu?: false | 'required'; codec?: CaptureEncoder};
/** toSvg()'s options and rapier-jxl/svg-jxl's. */
export type SvgJxlOptions = {quality?: number; exact?: boolean; scale?: number; width?: number; height?: number; effort?: Effort; signal?: AbortSignal;
  onProgress?: (fraction: number) => void};
export type SnapdomSvgJxlRecord = SvgJxlRecord & {blob: Blob};
export type SvgJxlContext = {export?: {requestedOptions?: SvgJxlOptions}};
export type SnapDOMExports = {svg?(options: object): Promise<HTMLImageElement>; blob?(options: object): Promise<Blob>};
export interface SvgJxlPlugin {
  name: string;
  defineExports(context: {exports?: SnapDOMExports}): {svgJxl(context: SvgJxlContext, options?: SvgJxlOptions): Promise<HTMLImageElement & {svgJxl: SnapdomSvgJxlRecord}>};
}
export function svgJxl(options?: SvgJxlPluginOptions): SvgJxlPlugin;

declare module '@zumer/snapdom' {
  interface CaptureResult {
    toSvgJxl(options?: SvgJxlOptions): Promise<HTMLImageElement & {svgJxl: SnapdomSvgJxlRecord}>;
  }
}
