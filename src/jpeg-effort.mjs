// SPDX-License-Identifier: MIT
// JPEG-only entropy refinements retain complete earlier streams on equal size or interruption.
import {coefficientEffortSteps, coefficientOrderSteps} from './coefficient-effort.mjs';
import {varDCTSteps} from './vardct.mjs';
import {buildExactTokenCoding} from './coefficient-coding.mjs';

export function* jpegEffortSteps(jpeg, effort, retain, baseline = coefficientEffortSteps) {
  if (effort < 8) return yield* baseline(jpeg, effort, undefined, retain);
  let best, step, hurry;
  const floor = baseline(jpeg, 7, undefined, retain);
  while (!(step = floor.next(hurry)).done) hurry = yield step.value / 2;
  best = step.value;
  if (hurry) return best;
  const alternate = {maxClusters: 32, newClusterCost: 160}, parts = effort === 8 ? 2 : 11;
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
  function* write(plan) {
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
    const orders = yield* learn(8);
    if (hurry) return best;
    yield* write({orders, clusters: alternate});
    if (hurry || effort === 8) return best;
    for (const order of [undefined, orders]) for (const clusters of [undefined, alternate]) {
      yield* write({orders: order, clusters, coding: buildExactTokenCoding});
      if (hurry) return best;
    }
    const exact = yield* learn(1);
    if (hurry) return best;
    for (const coding of [undefined, buildExactTokenCoding]) for (const clusters of [undefined, alternate]) {
      yield* write({orders: exact, clusters, coding});
      if (hurry) return best;
    }
    return best;
  } catch (error) {
    if (!(error instanceof RangeError && !error.code) && error.code !== 'JXL_SIZE') throw error;
    return best;
  }
}
