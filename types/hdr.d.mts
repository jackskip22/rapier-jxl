// SPDX-License-Identifier: MIT
import type {ColorEncoding, EncodedInput} from './types.mjs';
export type {EncodedInput};

/** The picture record `encode` takes, read from a file: RGBA, straight rows, linear light, exact samples.
 * `sampleFormat` is 'float16' (raw binary16 words in a Uint16Array) when every sample is exactly a half, else 'float32'.
 * A picture without alpha has alpha 1. Nothing is tone-mapped, converted or scaled. */
export interface HdrPicture {
  data: Uint16Array | Float32Array;
  width: number;
  height: number;
  bitDepth: 16 | 32;
  sampleFormat: 'float16' | 'float32';
  /** Present when the file's primaries and white point are sRGB, Display P3 or Rec. 2020 (D65): `encode(picture)` takes it. */
  colorSpace?: 'srgb' | 'display-p3' | 'rec2020' | undefined;
  /** Present instead when they are any others, exactly as the file states them: `encode(picture)` and `format({kind: 'profile', ...picture})` take it. */
  colorEncoding?: Pick<ColorEncoding, 'space' | 'whitePoint' | 'primaries'>;
  transferFunction: 'linear';
  /** OpenEXR color is associated with alpha (premultiplied), unless every alpha is 1, which reads as straight. Radiance has no alpha. */
  alphaPremultiplied: boolean;
  /** OpenEXR whiteLuminance, in nits. */
  intensityTarget?: number | undefined;
  /** Number of parts in a multi-part OpenEXR file. The first image part supplies the picture. */
  parts?: number | undefined;
}
export interface HdrOptions {
  /** OpenEXR only. 'data' (default) is the pixels the file stores. 'display' is its display window, transparent black
   * where the data window does not reach. */
  window?: 'data' | 'display' | undefined;
  /** Optional caller ceiling in pixels. A picture above it refuses JXL_DIMENSIONS. Without it, only the host's allocation limits apply. */
  maxPixels?: number;
}
/** Read an OpenEXR (.exr) or Radiance (.hdr) file. Errors carry the encoder's codes: JXL_INPUT (malformed, or a feature
 * named in the message that is not read), JXL_OPTIONS (invalid options), JXL_DIMENSIONS (invalid dimensions or the
 * caller's maxPixels), JXL_MEMORY (host allocation refusal), JXL_IO (file read failure), JXL_PLATFORM (missing host API).
 *
 * OpenEXR: scan-line and tiled files (level 0 of mip and rip maps), the first image part in multi-part files.
 * HALF or FLOAT R, G, B or Y with optional A, and luminance-chroma Y, RY, BY. Other channels are skipped.
 * NONE, RLE, ZIPS, ZIP, PIZ, PXR24, B44, B44A, DWAA and DWAB. Refused by name: HTJ2K, LJ2K and ZSTD compression,
 * deep files, UINT color or alpha, and subsampled color other than 2-by-2 RY/BY with full-size Y.
 * Radiance: RGBE, either Y-row order and either X-column order, new run-length or flat rows. EXPOSURE and COLORCORR
 * are not applied. Refused: XYZE, old run-length rows and X-major files.
 * ZIP data is inflated by the platform's DecompressionStream, so the realm needs it (browsers, workers, Node 18+, Deno, Bun,
 * Cloudflare Workers). A picture the host cannot hold refuses JXL_MEMORY.
 * @example const picture = await read(exr); // then encode(picture) from jpegxl */
export function read(input: EncodedInput | Blob, options?: HdrOptions): Promise<HdrPicture>;

/** Codes for refusals raised by rapier-jxl. Caller callback errors and abort reasons pass through unchanged. */
export type {CodecError, ErrorCode} from './types.mjs';
