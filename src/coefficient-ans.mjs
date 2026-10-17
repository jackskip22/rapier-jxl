// SPDX-License-Identifier: MIT
import {coefficientEffortSteps} from './coefficient-effort.mjs';
import {varDCTSteps} from './vardct.mjs';
import {part} from './bits.mjs';
import {buildAnsCoding} from './ans.mjs';

export function* coefficientAnsSteps(jpeg, effort, fallback, retain) {
  if (effort < 2) return yield* coefficientEffortSteps(jpeg, effort, fallback, retain);
  let best = yield* part(coefficientEffortSteps(jpeg, effort, fallback, retain), 0, 2);
  if (yield 0.5) return best;
  try {
    const candidate = varDCTSteps(jpeg, {coding: buildAnsCoding});
    let step;
    while (!(step = candidate.next()).done) {
      if ((yield 0.5 + step.value / 2) && step.value < 1) { candidate.return(); return best; }
    }
    if (step.value.length < best.length) best = step.value;
    retain?.(step.value, {coding: buildAnsCoding});
  } catch (error) {
    if (!(error instanceof RangeError && !error.code) && error.code !== 'JXL_SIZE') throw error;
  }
  return best;
}
