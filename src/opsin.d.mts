// SPDX-License-Identifier: MIT
import type {Bytes, Limits} from './index.mjs';
import type {BitWriter} from './writer.mjs';
export type {Bytes} from './index.mjs';
export const LIMITS: Limits;

/** The full-precision defaults specified by JPEG XL. Explicit custom fields are stored as binary16. */
export const DEFAULT_OPSIN: Readonly<{
  inverseMatrix: readonly number[];
  opsinBiases: readonly number[];
  quantizationBiases: readonly number[];
}>;

export interface OpsinOptions {
  /** Nine row-major values, or three rows of three values. Maps the three expanded opsin responses to linear sRGB. */
  inverseMatrix?: ArrayLike<number> | readonly [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>];
  /** Three values: subtract each bias's cube root before cubing, then add the bias. */
  opsinBiases?: ArrayLike<number>;
  /** Four AC dequantization values. A coefficient of magnitude one uses its channel's first three biases;
   * other nonzero coefficients subtract the fourth value divided by the coefficient. DC stays unchanged. */
  quantizationBiases?: ArrayLike<number>;
  /** Restore the format defaults. Cannot also supply inverseMatrix, opsinBiases or quantizationBiases.
   * Existing upsampling kernels are retained unless replaced explicitly. */
  reset?: boolean;
  /** Optional symmetric kernels: 15 values for factor 2, 55 for 4, 210 for 8. Replaces the supplied kernel set. */
  upsamplingWeights?: {2?: ArrayLike<number>; 4?: ArrayLike<number>; 8?: ArrayLike<number>};
}

/** Write the complete CustomTransformData bundle for an XYB image header. Append this writer as
 * ImageHeaderOptions.transformData; keep its unaligned bit length. Missing fields use the format defaults.
 * Supplying any opsin field stores all sixteen numbers as finite binary16, rounding omitted defaults too. */
export function prepareOpsinTransform(options?: OpsinOptions): BitWriter;

/** Replace global inverse-transform fields in an encoder-authored XYB JPEG XL file. This changes the decoded
 * colors or AC reconstruction; it does not refit the encoder's forward transform or promise a quality gain.
 * Unspecified fields retain existing values. Empty options return an owned exact copy. Non-XYB is refused.
 * All coded frames, original ICC bits, opaque metadata and level are retained. The first serialized frame-index
 * offset is adjusted for the header length; partial codestream boxes are coalesced into one jxlc box.
 * ICC parsing accepts this encoder's profile entropy representation. Input and output are at most 16 MiB. */
export function withOpsin(bytes: Uint8Array, options?: OpsinOptions): Bytes;
