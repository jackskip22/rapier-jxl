// SPDX-License-Identifier: MIT
import type {Bytes} from './index.mjs';
import type {PhotoOptions} from './photo.mjs';
import type {ScoreTarget} from './score.mjs';
import type {ImageSource, Controls} from './image.mjs';
export * from './photo.mjs';
export {encodeToScore, encodeToScoreSteps} from './score.mjs';
export interface PhotoImageOptions extends PhotoOptions, Controls {
  /** Target uses the encoder's reconstructed-image metric; validate delivery requirements with an external decoder. */
  target?: ScoreTarget;
}
/** Quality 90, effort 9 by default; optional target searches high-quality photographic candidates. */
export function encode(source: ImageSource, options?: PhotoImageOptions): Promise<Bytes>;
