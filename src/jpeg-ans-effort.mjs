// SPDX-License-Identifier: MIT
// Optional ANS interactions start only after the same-effort complete stream.
import {jpegEffortSteps} from './jpeg-effort.mjs';
import {coefficientAnsSteps} from './coefficient-ans.mjs';
import {coefficientOrderSteps} from './coefficient-effort.mjs';
import {varDCTSteps} from './vardct.mjs';
import {buildAnsCoding} from './ans.mjs';

export function* jpegAnsEffortSteps(jpeg, effort, retain) {
  if (effort < 8) return yield* jpegEffortSteps(jpeg, effort, retain, coefficientAnsSteps);
  let step, hurry, best;
  const floor = jpegEffortSteps(jpeg, effort, retain, coefficientAnsSteps);
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
