import type {Fidelity, Effort} from 'jpegxl';

export interface JxlFilesOptions {
  /** As rapier-jxl's encode for PNG sources (and every source when `read` is set); the package default when unset. A JPEG without `read` is kept exactly. */
  fidelity?: Fidelity;
  /** 1 (fastest) to 9 (smallest); default 3. */
  effort?: Effort;
  /** Your own decoder for any source, returning 8-bit RGBA; with it JPEGs are encoded at `fidelity`. It is handed the
   * wanted width, if any, and may return pixels already at it; wider pixels are resized by rapier-jxl. */
  read?: (bytes: Uint8Array, file: string, wanted: {width?: number}) => Promise<{width: number; height: number; data: Uint8Array | Uint8ClampedArray}>;
  /** A folder that keeps each encoded file, keyed by the source, these options and the package version. */
  cacheDir?: string;
}
export const IMAGE: RegExp;
export const JPEG: RegExp;
export function jxlName(name: string): string;
export function jxlFiles(options?: JxlFilesOptions): {
  /** One file's JPEG XL bytes; `width` shrinks it (a JPEG without `read` is kept whole); `bytes` are the file's when held already. */
  toJxl(file: string, options?: {width?: number; bytes?: Uint8Array}): Promise<{key: string; bytes: Uint8Array}>;
};
