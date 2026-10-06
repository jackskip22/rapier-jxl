// SPDX-License-Identifier: MIT
// The optional doors add ANS at effort 2; earlier completed streams remain the
// answer on a tie, hurry, allocation failure or candidate above the size limit.
import {coefficientEffortSteps} from './coefficient-effort.mjs';
import {varDCTSteps} from './vardct.mjs';
import {part} from './bits.mjs';
import {buildAnsCoding} from './ans.mjs';

export function* coefficientAnsSteps(jpeg, effort, fallback) {
  if (effort < 2) return yield* coefficientEffortSteps(jpeg, effort, fallback);
  let best = yield* part(coefficientEffortSteps(jpeg, effort, fallback), 0, 2);
  if (yield 0.5) return best;
  try {
    const candidate = varDCTSteps(jpeg, {coding: buildAnsCoding});
    let step;
    while (!(step = candidate.next()).done) {
      // The final group has already been written at fraction 1. Let its bounded
      // assembly finish before comparing; a hurry must not discard that work.
      if ((yield 0.5 + step.value / 2) && step.value < 1) { candidate.return(); return best; }
    }
    if (step.value.length < best.length) best = step.value;
  } catch (error) {
    if (!(error instanceof RangeError && !error.code) && error.code !== 'JXL_SIZE') throw error;
  }
  return best;
}
