// SPDX-License-Identifier: MIT
import {complete} from './bits.mjs';
import {materialize} from './varblock-core.mjs';
import {encodeStrategyImageSteps} from './varblock-write.mjs';
import {coefficientAnsSteps} from './coefficient-ans.mjs';

export function* writeImageSteps(image, effort = 7, placement) {
  image = materialize(image);
  if (placement !== undefined) image = {...image, placement};
  return yield* (image.strategyData ? encodeStrategyImageSteps(image, true, effort) : coefficientAnsSteps(image, effort));
}
export function writeImage(image, effort = 7, placement) { return complete(writeImageSteps(image, effort, placement)); }
