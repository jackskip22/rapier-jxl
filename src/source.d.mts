// SPDX-License-Identifier: MIT
import type {ColorSpace, SampleFormat, TransferFunction} from './index.mjs';

/** Original RGBA words and encoding options. Floating-point words retain signed zero, subnormals and IEEE payloads.
 * PNG alpha is straight; OpenEXR alpha is associated. */
export interface SourceImage {
  data: Uint16Array | Float32Array;
  width: number;
  height: number;
  bitDepth: 16 | 32;
  sampleFormat: SampleFormat;
  colorSpace: ColorSpace;
  transferFunction: TransferFunction;
  alphaPremultiplied: boolean;
  intensityTarget?: number | undefined;
}

/** Decode 16-bit PNG (including Adam7) or single-part flat scanline OpenEXR HALF/FLOAT with NONE/RLE/ZIPS/ZIP.
 * PNG supports grayscale/RGB with optional alpha, cICP and sRGB color declarations. Untagged PNG assumes sRGB;
 * unsupported ICC or gamma profiles are rejected. OpenEXR accepts uniform RGB or Y plus optional A, square pixels
 * and coincident data/display windows. It assumes linear sRGB primaries when chromaticities are absent.
 * Recognized primaries are sRGB, Display P3 and Rec. 2020 (D65); samples and colors are not converted.
 * Compressed input uses DecompressionStream. Errors use the encoder's public codes. */
export function readSource(bytes: Uint8Array | ArrayBuffer): Promise<SourceImage>;
