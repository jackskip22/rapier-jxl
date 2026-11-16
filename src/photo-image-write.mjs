// SPDX-License-Identifier: MIT
import {complete} from './bits.mjs';
import {materialize} from './varblock-core.mjs';
import {encodeStrategyImageSteps} from './varblock-write.mjs';
import {coefficientAnsSteps} from './coefficient-ans.mjs';
import {packedPicture} from './photo-packed-picture.mjs';
import {offloading} from './offload.mjs';

const packed = (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) || (typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) ? null : packedPicture;

export function* writeImageSteps(image, effort = 7, placement) {
  if (!(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true)) image = packed && image?.lazyStrategy?.packed && !offloading() ? packed(image) : materialize(image);
  if (placement !== undefined) image = {...image, placement};
  return yield* (!(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && image.strategyData ? encodeStrategyImageSteps(image, true, effort) : coefficientAnsSteps(image, effort));
}
export function writeImage(image, effort = 7, placement) { return complete(writeImageSteps(image, effort, placement)); }
