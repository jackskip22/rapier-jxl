// SPDX-License-Identifier: MIT
import {complete} from './bits.mjs';
import {materialize} from './varblock-core.mjs';
import {encodeStrategyImageSteps} from './varblock-write.mjs';
import {coefficientAnsSteps, PLAN_LF} from './coefficient-ans.mjs';
import {packedPictureSteps} from './photo-packed-picture.mjs';
import {bandRecipe} from './photo-layout-picture.mjs';
import {offloading} from './offload.mjs';

const packed = (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) || (typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) ? null : packedPictureSteps;

export function* writeImageSteps(image, effort = 7, placement, designs, planLf) {
  if (!(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true)) image = packed && image?.lazyStrategy && !image.lazyStrategy.held?.() && !offloading() ? yield* packed(image, bandRecipe) : materialize(image);
  if (placement !== undefined) image = {...image, placement};
  if (designs) image = {...image, lowDesigns: designs};
  if (planLf) image = {...image, [PLAN_LF]: planLf};
  return yield* (!(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && image.strategyData ? encodeStrategyImageSteps(image, true, effort) : coefficientAnsSteps(image, effort));
}
export function writeImage(image, effort = 7, placement) { return complete(writeImageSteps(image, effort, placement)); }
