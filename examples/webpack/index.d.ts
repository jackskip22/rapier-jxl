import type {Fidelity, Effort} from 'jpegxl';

export interface JxlOptions {
  /** As rapier-jxl's encode for PNG sources (and every source when `read` is set). The package default when unset. A JPEG without `read` is kept exactly. */
  fidelity?: Fidelity;
  /** 1 (fastest) to 9 (smallest). Default 3. */
  effort?: Effort;
  /** Your own decoder for any source, returning 8-bit RGBA ({width, height, data}). With it JPEGs are encoded at `fidelity`. */
  read?: (bytes: Uint8Array, file: string) => Promise<{width: number; height: number; data: Uint8Array | Uint8ClampedArray}>;
  /** Keep encoded files in node_modules/.cache/rapier-jxl, keyed by the source, these options and the package version. Default true. */
  cache?: boolean;
  /** true writes a .jxl beside every JPEG and PNG the build emits (a RegExp: those whose names match). Default false. */
  beside?: boolean | RegExp;
}
/** The plug-in, for webpack 5's or Rspack's `plugins`. */
export function jxl(options?: JxlOptions): {apply(compiler: unknown): void};
/** A generator for image-minimizer-webpack-plugin's `generator` list (`implementation`). */
export function jxlGenerator(options?: Omit<JxlOptions, 'beside'>): (original: {filename: string; data: Uint8Array; warnings: Error[]; errors: Error[]; info: object}) => Promise<object | null>;
