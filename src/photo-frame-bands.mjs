// SPDX-License-Identifier: MIT
import {part} from './bits.mjs';
import {rgbCoefficientBandsSteps} from './photo-coefficient-bands.mjs';
import {writeImageSteps} from './photo-image-write.mjs';

export function* pageFrameSteps(rows, width, height, {effort = 4, placement = {}, ...options}) {
  const image = yield* part(rgbCoefficientBandsSteps(rows, width, height, options), 0, 2);
  return yield* part(writeImageSteps(image, effort, placement), 1, 2);
}
