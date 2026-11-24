// SPDX-License-Identifier: MIT
import {hostShort} from './fault.mjs';
import {part} from './bits.mjs';
import {coefficientAnsSteps, BUDGETS} from './coefficient-ans.mjs';
import {candidateSteps} from './coefficient-effort.mjs';
import {SMALL_CLUSTERS, SMALL_PIXELS} from './photo-v6-settings.mjs';

export const SMALL_BUDGET = [BUDGETS[0]];
const MAP_BUDGET = [{...SMALL_CLUSTERS, mapLz: true}];
export const plannedEffort = (effort, pixels) => Math.min(effort, pixels >= SMALL_PIXELS ? 3 : 4);
export const fastBudgets = (effort, filter, pixels) => {
  effort = plannedEffort(effort, pixels);
  if (effort < 2) return [];
  if (effort === 2) return pixels < SMALL_PIXELS ? MAP_BUDGET : [];
  return !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && effort >= 5 ? filter ? [...SMALL_BUDGET, ...BUDGETS.slice(1)] : BUDGETS
    : filter ? SMALL_BUDGET : BUDGETS.slice(0, effort - 1);
};
export const choose = (incumbent, bytes) => !incumbent || bytes.length < incumbent.length ? bytes : incumbent;
export const sizeFailure = error => (error?.code === 'JXL_SIZE' || error?.code === 'JXL_MEMORY') && !hostShort(error);

export function* retainedSteps(steps, best, control = {hurried: false}) {
  let step, reply, failed = false;
  try {
    for (;;) {
      try { step = steps.next(reply); }
      catch (error) { if (best && sizeFailure(error)) return best; throw error; }
      if (step.done) return choose(best, step.value);
      reply = yield step.value;
      if (typeof step.value === 'number' && reply || reply?.hurried) control.hurried = true;
    }
  } catch (error) { failed = true; throw error; }
  finally { try { steps.return?.(); } catch (error) { if (!failed) throw error; } }
}

export function* fastSmallSteps(image, effort, control, entropyOnly) {
  const stages = entropyOnly ? (!(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && effort >= 5 ? 5 : effort) : Math.min(effort, 2) + (!(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && effort >= 5 ? 1 : 0);
  let best = yield* part(coefficientAnsSteps(image, 1), 0, stages), plan = null;
  if (effort < 2 || control.hurried) return best;
  const remember = entropyOnly && effort >= 3 ? (bytes, candidate) => { if (candidate.coding) plan = candidate; } : undefined;
  best = yield* retainedSteps(part(coefficientAnsSteps(image, 2, best, remember), 1, stages), best, control);
  const budgets = !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && effort >= 5 ? [0, 2] : [0, 1].slice(0, effort - 2);
  if (plan) for (const [i, budget] of budgets.entries()) {
    if (control.hurried) break;
    best = yield* retainedSteps(part(candidateSteps(image, {...plan, clusters: BUDGETS[budget]}, {}), 2 + i, stages), best, control);
  }
  if (!(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && effort >= 5 && !control.hurried) best = yield* retainedSteps(part(coefficientAnsSteps(image, 5, best), stages - 1, stages), best, control);
  return best;
}
