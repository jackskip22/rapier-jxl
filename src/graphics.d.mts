// SPDX-License-Identifier: MIT
import type {Bytes, Job, Limits} from './index.mjs';
import type {DeltaPaletteOptions} from './delta-palette.mjs';
export type {Bytes, Job, EncoderError, ErrorCode} from './index.mjs';

export const LIMITS: Limits;
export interface GraphicsOptions extends Pick<DeltaPaletteOptions,
  'colorSpace' | 'deltaPredictor' | 'maxPaletteColors' | 'groupSize' | 'screenEffort'> {
  /** Exact is the default. Screen allows two RGB code values of error and palette merging;
   * dither allows eight and also prices a bounded local dither-reduction candidate. */
  preset?: 'exact' | 'screen' | 'dither' | undefined;
  /** Hard maximum absolute error per RGB channel, integer 0–32; overrides the preset.
   * Zero is byte-exact source preservation through the ordinary exact delta-palette selector. */
  maxColorError?: number | undefined;
  /** Maximum learned color clusters, integer 1–4096; default 256. This is a search budget, not an output
   * color-count promise: protected/unmerged source colors and an exact winning file can exceed it. */
  paletteColors?: number | undefined;
  /** Default true. Pins outer-border pixels and pixels whose 3×3 source neighborhood has an RGB channel
   * range of at least 32, or touches nonopaque alpha. This is a precise edge rule, not semantic text detection. */
  preserveEdges?: boolean | undefined;
  /** Prices an additional 3×3 binomial-mean candidate, clamped against the original RGB error bounds,
   * followed by palette reduction. Default true only for preset dither. */
  undither?: boolean | undefined;
  /** Row-major byte mask of exactly width*height entries. Every nonzero entry preserves all four source
   * samples exactly. Keep this array unchanged while incremental encoding is in progress. */
  protectedMask?: Uint8Array | Uint8ClampedArray | undefined;
}

/** Selects the smallest complete exact or bounded-error Modular/palette file. Exact wins ties. Alpha and all
 * RGB samples at alpha<255 remain exact, including hidden RGB. Source arrays are never modified. Eight-bit
 * straight RGBA with sRGB transfer and sRGB/Display P3 primaries; no arbitrary ICC or native-depth route. */
export function encodeGraphics(data: Uint8Array | Uint8ClampedArray, width: number, height: number, options?: GraphicsOptions): Bytes;
/** Incremental encoding. Keep input and mask unchanged until completion. Hurry retains a complete candidate;
 * breaking iteration cancels without returning partial bytes. */
export function encodeGraphicsSteps(data: Uint8Array | Uint8ClampedArray, width: number, height: number, options?: GraphicsOptions): Job;
