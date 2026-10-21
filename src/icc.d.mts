// SPDX-License-Identifier: MIT
import type {Pixels, Bytes, EncodeOptions, Job, Limits} from './index.mjs';
import type {BitWriter} from './writer.mjs';
export type {Pixels, Bytes, Job} from './index.mjs';
export const LIMITS: Limits;

export type ICCCompression = 'auto' | 'prefix' | 'lz77';
export type Chromaticity = readonly [x: number, y: number];
export type RenderingIntent = 'perceptual' | 'relative' | 'saturation' | 'absolute';
export type ExtendedTransferFunction = 'srgb' | 'linear' | 'pq' | 'hlg' | 'bt709' | 'dci';

/** Color meaning of the stored samples. No color conversion is performed. */
export interface ColorEncoding {
  /** Default rgb. Gray requires bit-identical R, G and B sample words in every RGBA pixel. */
  space?: 'rgb' | 'gray' | undefined;
  /** Default d65. Custom x,y coordinates are stored in millionths. */
  whitePoint?: 'd65' | 'e' | 'dci' | Chromaticity | undefined;
  /** RGB only. Default follows colorSpace, or srgb; custom order is red, green, blue. */
  primaries?: 'srgb' | 'display-p3' | 'rec2020' | readonly [Chromaticity, Chromaticity, Chromaticity] | undefined;
  /** Default follows the sample format: srgb for integers, linear for floats. Mutually exclusive with gamma. */
  transferFunction?: ExtendedTransferFunction | undefined;
  /** Encoding exponent in [1/8192, 1], e.g. 1/2.2. Stored in ten-millionths. Mutually exclusive with transferFunction. */
  gamma?: number | undefined;
  renderingIntent?: RenderingIntent | undefined;
}

/** JPEG XL display-adaptation metadata; writing it does not tone-map the source. Luminances are binary16. */
export interface ToneMapping {
  /** Peak luminance in nits; defaults to 10000 for PQ, 1000 for HLG, otherwise 255. Must be positive and below 65520. */
  intensityTarget?: number | undefined;
  /** Minimum luminance, between zero and intensityTarget. Default zero. */
  minNits?: number | undefined;
  /** Interpret linearBelow relative to the display peak. Default false. */
  relativeToMaxDisplay?: boolean | undefined;
  /** Linear region in nits, or a fraction from zero to one when relativeToMaxDisplay is true. Default zero. */
  linearBelow?: number | undefined;
}

export interface ProfileOptions extends EncodeOptions {
  /** Complete RGB or GRAY ICC profile. All original bytes, including unknown tags and padding, are retained.
   * Mutually exclusive with colorEncoding, colorSpace and transferFunction. Profiles are limited to 16 MiB;
   * level 5 permits at most 4 MiB. The complete encoded image retains the package's 16 MiB output limit. */
  icc?: Uint8Array | undefined;
  /** Default auto compares actual prefix and LZ77 bit lengths. Requires icc. */
  iccCompression?: ICCCompression | undefined;
  /** Explicit standard or custom color fields instead of an embedded ICC profile. */
  colorEncoding?: ColorEncoding | undefined;
  toneMapping?: ToneMapping | undefined;
  /** 1 (default) or 2; 2 also evaluates coding without a reversible color transform. */
  effort?: 1 | 2 | undefined;
  /** Defaults to the least level required by the samples and profile. An incompatible explicit level 5 is refused. */
  level?: 5 | 10 | undefined;
}

/** Lossless by default. Below quality 100, source-domain RGB quantization may reduce size; alpha remains exact.
 * The source precision and color profile are preserved without conversion. RGB stays RGB even for gray pixels. */
export function encodeProfile(data: Pixels, width: number, height: number, options?: ProfileOptions): Bytes;
/** Validate input and prepare color metadata immediately, then yield encoding progress. */
export function encodeProfileSteps(data: Pixels, width: number, height: number, options?: ProfileOptions): Job;

/** Header composition helper. Append colorData as ColorEncoding and iccData after transform data, before the
 * image header's byte alignment. Do not replace either writer with its padded finish() result. */
export interface PreparedICC {
  colorData: BitWriter;
  iccData: BitWriter;
  colorChannels: 1 | 3;
  level: 5 | 10;
}
/** colorSpace constrains the profile's source space. CMYK is admitted only with colorSpace:'cmyk', requires
 * level 10 and a black extra channel supplied by the composing planar encoder; it is never an RGBA route. */
export function prepareICC(profile: Uint8Array, options?: {
  level?: 5 | 10;
  compression?: ICCCompression;
  colorSpace?: 'rgb' | 'gray' | 'cmyk';
}): PreparedICC;
