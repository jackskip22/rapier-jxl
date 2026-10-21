// SPDX-License-Identifier: MIT
import type {Pixels, Bytes, Job} from './index.mjs';
import type {AdvancedPhotoOptions, Noise} from './photo-advanced.mjs';
export {LIMITS, photonNoise} from './photo-advanced.mjs';
export type {Pixels, Bytes, Job} from './index.mjs';
export type NoiseMode = Noise | 'auto' | 'off' | number;
export interface NoisePhotoOptions extends Omit<AdvancedPhotoOptions, 'noise'> {
  /** Auto estimates source grain in flat opaque regions, removes a bounded luminance residual and writes a
   * conservative synthesis LUT. This optional entry defaults to auto only at qualities 25–52 for eight-bit
   * sRGB; other qualities/sample formats and clean images retain the ordinary route. Quality 100 stays exact.
   * Off disables synthesis; a numeric ISO uses the full-frame photon model without removing source grain.
   * The ordinary photo entry and package presets keep their existing defaults. */
  noise?: NoiseMode | undefined;
}
/** Optional grain-aware photographic entry. Quality defaults to 90; automatic replacement is inactive there. */
export function encodePhoto(data: Pixels, width: number, height: number, options?: NoisePhotoOptions): Bytes;
/** Incremental entry with eager option admission and complete results when hurried. */
export function encodePhotoSteps(data: Pixels, width: number, height: number, options?: NoisePhotoOptions): Job;
