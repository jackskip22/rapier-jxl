// SPDX-License-Identifier: MIT
import {part} from './bits.mjs';
import {rgbCoefficientBandsSteps} from './photo-coefficient-bands.mjs';
import {writeImageSteps} from './photo-image-write.mjs';
import {stage} from './step-journal.mjs';

export function* pageFrameSteps(rows, width, height, {effort = 4, placement = {}, ...options}) {
  const image = yield* part(rgbCoefficientBandsSteps(rows, width, height, options), 0, 2);
  return yield* part(options.strategy ? writeImageSteps(image, effort, placement)
    : stage('frame-writer', () => writeImageSteps(image, effort, placement), undefined, true), 1, 2);
}
