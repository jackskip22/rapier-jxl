// SPDX-License-Identifier: MIT
import type {Bytes, Limits} from './index.mjs';
export type {Bytes, Limits, ErrorCode, EncoderError} from './index.mjs';
/** Limits: 40 million pixels and 16,384 pixels per side. */
export const LIMITS: Limits;
/** Internal reconstruction targets: SSIMULACRA2 at least, Butteraugli maximum or 3-norm at most. Name one or more. */
export interface ScoreTarget {
  ssimulacra2?: number | undefined;
  butteraugli?: number | undefined;
  butteraugli3?: number | undefined;
}
export interface ScoreOptions {
  target: ScoreTarget;
  /** Integer from 1 to 9; default 7. The entropy search of the chosen file. */
  effort?: number | undefined;
  /** Some of 'gaborish', 'blocks', 'field', 'closed' and 'plain'; default all five. */
  candidates?: ReadonlyArray<'gaborish' | 'blocks' | 'field' | 'closed' | 'plain'> | undefined;
  /** A GPUDevice: Butteraugli is measured on WebGPU. Without one every measurement runs on the CPU. */
  gpu?: unknown;
  /** Called with a fraction as the GPU search progresses. */
  onProgress?: ((fraction: number) => void) | undefined;
}
export interface ScoreResult {
  bytes: Bytes;
  /** The quality the chosen candidate needed. */
  quality: number;
  candidate: 'gaborish' | 'blocks' | 'field' | 'closed' | 'plain';
  butteraugli: number;
  butteraugli3: number;
  ssimulacra2?: number;
}
/** The smallest completed file among searched candidates whose internal reconstruction meets every target.
 * Input is straight 8-bit sRGB RGBA. Transparency is modeled over dark and bright sRGB backgrounds.
 * Each passing candidate is actually encoded before selecting its size.
 * Throws JXL_TARGET_UNMET when no candidate meets the targets. Scores on independently decoded pixels can differ
 * because reconstruction and output sample quantization differ. With `gpu`, results can differ by device. */
export function encodeToScore(data: Uint8Array | Uint8ClampedArray, width: number, height: number, options: ScoreOptions): Promise<ScoreResult>;
/** encodeToScore on the CPU as steps (a fraction each); the last step's value is the result. */
export function encodeToScoreSteps(data: Uint8Array | Uint8ClampedArray, width: number, height: number, options: ScoreOptions): Generator<number, ScoreResult, unknown>;
