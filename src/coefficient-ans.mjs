// SPDX-License-Identifier: MIT
import {coefficientEffortSteps} from './coefficient-effort.mjs';
import {varDCTSteps} from './vardct.mjs';
import {part} from './bits.mjs';
import {buildAnsCoding, writeModularAnsHistograms} from './ans.mjs';

export function* coefficientAnsSteps(jpeg, effort, fallback, retain) {
  const shared = {};
  if (effort < 2) return yield* coefficientEffortSteps(jpeg, effort, fallback, retain, shared);
  let orders;
  const keep = effort < 5 ? retain : (bytes, plan) => { if (plan.orders) orders = plan.orders; retain?.(bytes, plan); };
  let best = yield* part(coefficientEffortSteps(jpeg, effort, fallback, keep, shared), 0, 2);
  if (yield 0.5) return best;
  try {
    const plan = {orders, coding: buildAnsCoding, modularAns: writeModularAnsHistograms};
    const candidate = varDCTSteps(jpeg, plan, shared);
    let step;
    while (!(step = candidate.next()).done) {
      if ((yield 0.5 + step.value / 2) && step.value < 1) { candidate.return(); return best; }
    }
    if (step.value.length < best.length) best = step.value;
    retain?.(step.value, plan);
  } catch (error) {
    if (!(error instanceof RangeError && !error.code) && error.code !== 'JXL_SIZE') throw error;
  }
  return best;
}
