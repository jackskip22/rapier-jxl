// SPDX-License-Identifier: MIT
import {coefficientEffortSteps} from './coefficient-effort.mjs';
import {varDCTSteps} from './vardct.mjs';
import {part, complete} from './bits.mjs';
import {buildAnsCoding, writeModularAnsHistograms} from './ans.mjs';
import {lfCoderFor} from './lf-coding.mjs';

const BUDGETS = [{maxClusters: 32, newClusterCost: 160}, {maxClusters: 24, newClusterCost: 100}, {maxClusters: 16, newClusterCost: 100}];

function ladder(effort, learned) {
  const rungs = [{orders: learned}];
  if (effort >= 6 && learned) rungs.push({});
  for (let i = 0; i < Math.min(3, effort - 6); i++) {
    rungs.push({orders: learned, clusters: BUDGETS[i]});
    if (learned) rungs.push({clusters: BUDGETS[i]});
  }
  return rungs;
}

export function* coefficientAnsSteps(jpeg, effort, fallback, retain) {
  const shared = {};
  if (effort < 2) return yield* coefficientEffortSteps(jpeg, effort, fallback, retain, shared);
  let learned;
  const keep = effort < 5 ? retain : (bytes, plan) => { if (plan.orders) learned = plan.orders; retain?.(bytes, plan); };
  let best = yield* part(coefficientEffortSteps(jpeg, effort, fallback, keep, shared), 0, 2);
  let hurry = yield 0.5;
  if (hurry) return best;
  const rungs = ladder(effort, learned);
  for (let at = 0; at < rungs.length; at++) {
    const rung = rungs[at], from = 0.5 + 0.5 * at / rungs.length, share = 0.5 / rungs.length;
    try {
      const plan = {orders: rung.orders, clusters: rung.clusters, coding: buildAnsCoding, modularAns: writeModularAnsHistograms, lfCoder: lfCoderFor(effort)};
      if (!plan.clusters) delete plan.clusters;
      const candidate = varDCTSteps(jpeg, plan, shared);
      let step;
      while (!(step = candidate.next()).done) {
        if ((hurry = yield from + step.value * share) && step.value < 1) { candidate.return(); return best; }
      }
      if (step.value.length < best.length) best = step.value;
      retain?.(step.value, plan);
      if (hurry) return best;
    } catch (error) {
      if (!(error instanceof RangeError && !error.code) && error.code !== 'JXL_SIZE') throw error;
      return best;
    }
  }
  return best;
}

export function* strategyAnsSteps(image, effort = 7, learned = null) {
  const budgets = BUDGETS.slice(0, Math.max(1, Math.min(3, effort - 6))), lf = lfCoderFor(Math.max(5, effort));
  const runs = [];
  if (effort <= 6) runs.push({img: {...image, authoredOrderPasses: null}, shared: {}, plan: {clusters: BUDGETS[0], coding: buildAnsCoding, modularAns: writeModularAnsHistograms, lfCoder: lf}});
  else for (const authored of learned ? [null, learned] : [null]) {
    const img = {...image, authoredOrderPasses: authored}, shared = {};
    runs.push({img, shared, plan: {clusters: BUDGETS[0]}});
    for (const clusters of budgets) runs.push({img, shared, plan: {clusters, coding: buildAnsCoding, modularAns: writeModularAnsHistograms, lfCoder: lf}});
  }
  let best = null;
  for (let at = 0; at < runs.length; at++) {
    const {img, shared, plan} = runs[at], candidate = varDCTSteps(img, plan, shared);
    let step;
    while (!(step = candidate.next()).done) yield (at + step.value) / runs.length;
    if (!best || step.value.length < best.length) best = step.value;
  }
  return best;
}

export function estimateBytes(image) {
  const plan = {clusters: BUDGETS[0], coding: buildAnsCoding, modularAns: writeModularAnsHistograms, lfCoder: lfCoderFor(5), estimate: true};
  const value = complete(varDCTSteps({...image, authoredOrderPasses: null}, plan, {}));
  return typeof value === 'number' ? value : value.length;
}
