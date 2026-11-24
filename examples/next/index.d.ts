import type {Fidelity, Effort} from 'jpegxl';

export interface NextJxlOptions {
  /** The Next.js project's folder. Default the current one. */
  root?: string;
  /** As rapier-jxl's encode. Default {quality: 64}, the look of Next's default WebP. */
  fidelity?: Fidelity;
  /** 1 (fastest) to 9 (smallest). Default 3. */
  effort?: Effort;
  /** Where progress lines go. Default console.log. */
  log?: (line: string) => void;
}
/** Writes public/_jxl/w<width>/<picture URL>.jxl for every JPEG and PNG of the build, at every next/image width. */
export function writeNextJxl(options?: NextJxlOptions): Promise<{pictures: number; files: number; left: string[]; widths: number[]; inputBytes: number; outputBytes: number; ms: number; exported: boolean}>;
export const JXL_DIR: string;
export function jxlPath(url: string, width: number): string;
