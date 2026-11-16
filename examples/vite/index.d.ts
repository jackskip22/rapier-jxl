import type {Plugin} from 'vite';
import type {Fidelity, Effort} from 'jpegxl';

export interface JxlOptions {
  /** As rapier-jxl's encode for PNG sources (and every source when `read` is set); the package default when unset. A JPEG without `read` is kept exactly. */
  fidelity?: Fidelity;
  /** 1 (fastest) to 9 (smallest); default 3, as fast as sharp's WebP. */
  effort?: Effort;
  /** Folders, from the project root, whose JPEG and PNG files each get a .jxl beside them (public folder included). */
  folder?: string | string[];
  /** Your own decoder for any source, returning 8-bit RGBA ({width, height, data}); with it JPEGs are encoded at `fidelity`. */
  read?: (bytes: Uint8Array, file: string) => Promise<{width: number; height: number; data: Uint8Array | Uint8ClampedArray}>;
  /** Keep encoded files in Vite's cache folder, keyed by the source, these options and the package version; default true. */
  cache?: boolean;
}
export function jxl(options?: JxlOptions): Plugin;
export default jxl;
