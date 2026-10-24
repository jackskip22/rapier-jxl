// SPDX-License-Identifier: MIT
import {jpegEffortSteps} from './jpeg-effort.mjs';
import {coefficientEffortSteps, coefficientOrderSteps} from './coefficient-effort.mjs';
import {varDCTSteps} from './vardct.mjs';
import {buildAnsCoding, writeModularAnsHistograms} from './ans.mjs';
import {lfCoderFor} from './lf-coding.mjs';
import {part} from './bits.mjs';

export const PREFIX_LADDER_PIXELS = 512 * 512;

export function* jpegAnsFirstSteps(jpeg, effort, fallback, retain, shared = {}) {
  if (effort < 2) return yield* coefficientEffortSteps(jpeg, effort, fallback, retain, shared);
  let ladder = jpeg.width * jpeg.height <= PREFIX_LADDER_PIXELS, best = fallback;
  const learn = effort >= 4 && !ladder;
  try {
    const plan = {coding: buildAnsCoding, modularAns: writeModularAnsHistograms, lfCoder: lfCoderFor(effort)};
    const candidate = varDCTSteps(jpeg, plan, shared);
    let step, hurry;
    while (!(step = candidate.next()).done) {
      hurry = yield ladder || learn ? step.value / 2 : step.value;
      if (hurry && best && step.value < 1) { candidate.return(); return best; }
    }
    if (!best || step.value.length < best.length) best = step.value;
    retain?.(step.value, plan);
    if (hurry) return best;
  } catch (error) {
    if (!(error instanceof RangeError && !error.code) && error.code !== 'JXL_SIZE') throw error;
    if (!best) ladder = true;
  }
  if (ladder) {
    if ((yield 0.5) && best) return best;
    return yield* part(coefficientEffortSteps(jpeg, effort, best, retain, shared), 1, 2);
  }
  if (!learn || (yield 0.5)) return best;
  try {
    const learning = coefficientOrderSteps(jpeg.components);
    let step;
    while (!(step = learning.next()).done) if (yield 0.5 + step.value / 4) { learning.return(); return best; }
    const plan = {orders: step.value, coding: buildAnsCoding, modularAns: writeModularAnsHistograms, lfCoder: lfCoderFor(effort)};
    const candidate = varDCTSteps(jpeg, plan, shared);
    while (!(step = candidate.next()).done) if ((yield 0.75 + step.value / 4) && step.value < 1) { candidate.return(); return best; }
    if (step.value.length < best.length) best = step.value;
    retain?.(step.value, plan);
  } catch (error) {
    if (!(error instanceof RangeError && !error.code) && error.code !== 'JXL_SIZE') throw error;
  }
  return best;
}

export function* jpegAnsEffortSteps(jpeg, effort, retain) {
  const shared = {};
  if (effort < 8) return yield* jpegEffortSteps(jpeg, effort, retain, jpegAnsFirstSteps, shared);
  let step, hurry, best;
  const floor = jpegEffortSteps(jpeg, effort, retain, jpegAnsFirstSteps, shared);
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
    const plan = {orders, clusters, coding: buildAnsCoding, modularAns: writeModularAnsHistograms, lfCoder: lfCoderFor(effort)};
    const steps = varDCTSteps(jpeg, plan, shared);
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
