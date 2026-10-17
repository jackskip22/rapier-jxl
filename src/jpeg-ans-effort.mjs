// SPDX-License-Identifier: MIT
import {jpegEffortSteps} from './jpeg-effort.mjs';
import {coefficientEffortSteps, coefficientOrderSteps} from './coefficient-effort.mjs';
import {varDCTSteps} from './vardct.mjs';
import {buildAnsCoding} from './ans.mjs';
import {part} from './bits.mjs';

export const PREFIX_LADDER_PIXELS = 512 * 512;

export function* jpegAnsFirstSteps(jpeg, effort, fallback, retain) {
  if (effort < 2) return yield* coefficientEffortSteps(jpeg, effort, fallback, retain);
  let ladder = jpeg.width * jpeg.height <= PREFIX_LADDER_PIXELS, best = fallback;
  try {
    const candidate = varDCTSteps(jpeg, {coding: buildAnsCoding});
    let step;
    while (!(step = candidate.next()).done) {
      if ((yield ladder ? step.value / 2 : step.value) && best && step.value < 1) { candidate.return(); return best; }
    }
    if (!best || step.value.length < best.length) best = step.value;
    retain?.(step.value, {coding: buildAnsCoding});
  } catch (error) {
    if (!(error instanceof RangeError && !error.code) && error.code !== 'JXL_SIZE') throw error;
    if (!best) ladder = true;
  }
  if (!ladder || (yield 0.5) && best) return best;
  return yield* part(coefficientEffortSteps(jpeg, effort, best, retain), 1, 2);
}

export function* jpegAnsEffortSteps(jpeg, effort, retain) {
  if (effort < 8) return yield* jpegEffortSteps(jpeg, effort, retain, jpegAnsFirstSteps);
  let step, hurry, best;
  const floor = jpegEffortSteps(jpeg, effort, retain, jpegAnsFirstSteps);
  while (!(step = floor.next(hurry)).done) hurry = yield step.value / 2;
  best = step.value;
  if (hurry) return best;
  const alternate = {maxClusters: 32, newClusterCost: 160}, parts = effort === 8 ? 4 : 7;
  let part = 0;
  function* learn(bucket) {
    const steps = coefficientOrderSteps(jpeg.components, bucket);
    while (!(step = steps.next()).done) {
      hurry = yield 0.5 + (part + step.value) / (2 * parts);
      if (hurry) { steps.return(); return null; }
    }
    part++;
    return step.value;
  }
  function* write(orders, clusters) {
    const plan = {orders, clusters, coding: buildAnsCoding};
    const steps = varDCTSteps(jpeg, plan);
    while (!(step = steps.next()).done) {
      hurry = yield 0.5 + (part + step.value) / (2 * parts);
      if (hurry && step.value < 1) { steps.return(); return; }
    }
    if (step.value.length < best.length) best = step.value;
    retain?.(step.value, plan);
    part++;
  }
  try {
    yield* write(undefined, alternate);
    if (hurry) return best;
    const orders = yield* learn(8);
    if (hurry) return best;
    for (const clusters of [undefined, alternate]) {
      yield* write(orders, clusters);
      if (hurry) return best;
    }
    if (effort === 8) return best;
    const exact = yield* learn(1);
    if (hurry) return best;
    for (const clusters of [undefined, alternate]) {
      yield* write(exact, clusters);
      if (hurry) return best;
    }
    return best;
  } catch (error) {
    if (!(error instanceof RangeError && !error.code) && error.code !== 'JXL_SIZE') throw error;
    return best;
  }
}
