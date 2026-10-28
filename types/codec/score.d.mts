// SPDX-License-Identifier: MIT
import type {Bytes, Limits, EncoderError} from './index.mjs';
export type {Bytes, Limits, ErrorCode, EncoderError} from './index.mjs';
/** Limits: 40 million pixels and 16,384 pixels per side. */
export const LIMITS: Limits;
/** Measured reconstruction targets: SSIMULACRA2 at least, Butteraugli maximum or 3-norm at most. Name one or more. */
export interface ScoreTarget {
  ssimulacra2?: number | undefined;
  butteraugli?: number | undefined;
  butteraugli3?: number | undefined;
}
export interface ScoreOptions {
  target: ScoreTarget;
  /** Integer from 1 to 9; default 7. The entropy search used to price each accepted candidate's complete file. */
  effort?: number | undefined;
  /** Some of 'gaborish', 'blocks', 'field', 'closed' and 'plain'; default all five. */
  candidates?: ReadonlyArray<'gaborish' | 'blocks' | 'field' | 'closed' | 'plain'> | undefined;
  /** Permit an exact final candidate when lossy coding misses the target; default true. */
  allowLossless?: boolean | undefined;
  /** Optional positive safe-integer limit on the complete encoded file. */
  maxBytes?: number | undefined;
  /** A GPUDevice: Butteraugli is measured on WebGPU. Without one every measurement runs on the CPU. */
  gpu?: unknown;
  /** Called with a fraction as the GPU search progresses. */
  onProgress?: ((fraction: number) => void) | undefined;
}
export interface ScoreResult {
  bytes: Bytes;
  /** The quality the chosen candidate needed. */
  quality: number;
  candidate: 'gaborish' | 'blocks' | 'field' | 'closed' | 'plain' | 'lossless';
  /** A returned file meets the target; otherwise encoding throws. */
  pass: true;
  butteraugli: number;
  butteraugli3: number;
  ssimulacra2?: number;
}
/** A target or byte-budget refusal includes the closest lossy scores observed during the search. */
export interface ScoreRefusal extends EncoderError {
  code: 'JXL_TARGET' | 'JXL_SIZE';
  target: ScoreTarget;
  best: ScoreTarget & {candidate: Exclude<ScoreResult['candidate'], 'lossless'>; quality: number};
}
/** The smallest file whose decoded picture meets every target, from 8-bit sRGB RGBA. Each candidate's quality is searched
 * by measuring the picture the file decodes to; the smallest meeting file wins. With `gpu`, results can differ by device. */
export function encodeToScore(data: Uint8Array | Uint8ClampedArray, width: number, height: number, options: ScoreOptions): Promise<ScoreResult>;
/** encodeToScore on the CPU as steps (a fraction each); the last step's value is the result. */
export function encodeToScoreSteps(data: Uint8Array | Uint8ClampedArray, width: number, height: number, options: ScoreOptions): Generator<number, ScoreResult, unknown>;
