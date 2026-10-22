// SPDX-License-Identifier: MIT
import type {Pixels, Bytes, Job, Limits} from './index.mjs';
import type {AdvancedPhotoOptions, TransformName} from './photo-advanced.mjs';
export type {Pixels, Bytes, Job, EncoderError, ErrorCode} from './index.mjs';
export interface PhotoPlanOptions extends AdvancedPhotoOptions {
  /** Maximum retained typed-array bytes; default 256 MiB, at most 2 GiB. The conservative preflight includes
   * coefficients, LF samples, scan arrays, possible alpha, typed extra-plane snapshots, prepared kernels
   * and authored-order buffers; transient encode buffers and object overhead
   * are outside the limit. Raising the limit is an explicit memory choice. */
  maxRetainedBytes?: number | undefined;
}
export const LIMITS: Limits & {readonly retainedBytes: number};
export interface TargetOptions {
  minQuality?: number | undefined;
  maxQuality?: number | undefined;
  /** A previously measured quality to probe immediately after maxQuality. Useful near a narrow file-size
   * minimum caused by table, alpha or LF-frame overhead. The value must be inside the selected range. */
  initialQuality?: number | undefined;
  /** At most 2 through 32 complete entropy candidates; default 12. */
  maxProbes?: number | undefined;
}
export interface TargetResult {
  readonly bytes: Bytes;
  /** Highest quality actually probed whose complete file fits targetBytes. */
  readonly quality: number;
  readonly targetBytes: number;
  readonly probes: readonly {readonly quality: number; readonly bytes: number | null}[];
}
export interface TargetJob extends Generator<number, TargetResult, boolean | undefined> {
  /** Stops search once a complete fitting candidate exists; never emits a partial or oversized result. */
  hurry: boolean;
  bytes: Bytes | null;
  result: TargetResult | null;
}
export interface PhotoPlan {
  /** Declared canvas dimensions before Exif orientation, including spatial upsampling. */
  readonly width: number;
  readonly height: number;
  readonly planningQuality: number;
  readonly retainedBytes: number;
  readonly blockCount: number;
  readonly strategies: readonly {readonly name: TransformName; readonly blocks: number}[];
  readonly disposed: boolean;
  /** Quality defaults to planningQuality. Valid range is 1 through less than 100. */
  encode(quality?: number): Bytes;
  encodeSteps(quality?: number): Job;
  /** Fits the final complete file, including alpha, progressive/LF frames, noise and container headers.
   * Searches a fixed transform layout. Quantization/entropy steps can be nonmonotonic; this does not claim
   * the globally highest possible quality. If no tested candidate fits, throws JXL_SIZE. */
  encodeTarget(targetBytes: number, options?: TargetOptions): TargetResult;
  encodeTargetSteps(targetBytes: number, options?: TargetOptions): TargetJob;
  /** Releases retained buffers; later encodes throw JXL_INPUT. */
  dispose(): void;
}
export interface PhotoPlanJob extends Generator<number, PhotoPlan, boolean | undefined> {
  hurry: boolean;
  plan: PhotoPlan | null;
}
/** Retains YCbCr transform coefficients once. Eight-bit sRGB-transfer inputs only; no ICC profile.
 * Default layout is the optional auto DCT8/DCT16 planner, selected at quality 90 unless supplied. Explicit
 * strategies support all format transforms, raw/compact quantization and per-pass coefficient orders. Caller pixels are not
 * retained or modified. Extra-channel samples are copied at admission, before the first incremental step,
 * and released on dispose. Upsampling takes ceil(width/factor) by ceil(height/factor) RGBA samples and retains
 * the declared canvas. LF pyramid intermediates are regenerated from each candidate's quantized DC. */
export function createPhotoPlan(data: Pixels, width: number, height: number, options?: PhotoPlanOptions): PhotoPlan;
/** Incremental planning; option and retained-memory admission are eager. */
export function createPhotoPlanSteps(data: Pixels, width: number, height: number, options?: PhotoPlanOptions): PhotoPlanJob;
