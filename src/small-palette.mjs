// SPDX-License-Identifier: MIT
import {smallPicture} from './photo-v6-settings.mjs';
import {flatSamples, CAPTURE_FLAT} from './screen-samples.mjs';

export const SMALL_SCREEN = 1, SMALL_PHOTO = 2;
export function smallPalette(data, width, height, colorSpace) {
  if (!smallPicture(width, height)) return 0;
  return typeof colorSpace !== 'object' && flatSamples(data, width, height) >= CAPTURE_FLAT ? SMALL_SCREEN : SMALL_PHOTO;
}
