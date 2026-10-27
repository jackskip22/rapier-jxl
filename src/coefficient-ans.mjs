// SPDX-License-Identifier: MIT
import {coefficientEffortSteps} from './coefficient-effort.mjs';
import {varDCTSteps} from './vardct.mjs';
import {part, complete, scaled} from './bits.mjs';
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

function closeCandidate(steps, preserveOutcome) {
  try { steps?.return(); }
  catch (error) { if (!preserveOutcome) throw error; }
}

export function* coefficientAnsSteps(jpeg, effort, fallback, retain, pooled = false) {
  const shared = {};
  if (effort < 2) return yield* part(coefficientEffortSteps(jpeg, effort, fallback, retain, shared, pooled), 0, 1);
  let learned;
  const keep = effort < 5 ? retain : (bytes, plan) => { if (plan.orders) learned = plan.orders; retain?.(bytes, plan); };
  const prefix = coefficientEffortSteps(jpeg, effort, fallback, keep, shared, pooled);
  let best, prefixComplete = false, prefixHurry = false;
  try {
    let step, reply;
    while (!(step = prefix.next(reply)).done) {
      const value = step.value;
      reply = yield scaled(value, done => done / 2);
      if (typeof value !== 'number' && (reply === null || reply?.hurried)) prefixHurry = true;
    }
    best = step.value; prefixComplete = true;
  }
  finally { closeCandidate(prefix, !prefixComplete); }
  let hurry = yield 0.5;
  if (hurry || prefixHurry) return best;
  const rungs = ladder(effort, learned);
  for (let at = 0; at < rungs.length; at++) {
    const rung = rungs[at], from = 0.5 + 0.5 * at / rungs.length, share = 0.5 / rungs.length;
    let candidate, settled = false, suspended = false;
    try {
      const plan = {orders: rung.orders, clusters: rung.clusters, coding: buildAnsCoding, modularAns: writeModularAnsHistograms, lfCoder: lfCoderFor(effort)};
      if (!plan.clusters) delete plan.clusters;
      candidate = varDCTSteps(jpeg, pooled ? {...plan, pooled: true, abortable: !!best} : plan, shared);
      let step, reply;
      while (!(step = candidate.next(reply)).done) {
        suspended = true;
        const value = step.value, response = yield scaled(value, done => from + done * share);
        suspended = false;
        reply = typeof value === 'number' ? undefined : response;
        if (typeof value !== 'number' && response?.hurried) hurry = true;
        if (typeof value === 'number' && (hurry = response) && value < 1) { settled = true; return best; }
      }
      if (pooled && step.value === null) {
        if (!best) throw new Error('Incomplete AC group stream.');
        settled = true; return best;
      }
      if (step.value.length < best.length) best = step.value;
      retain?.(step.value, plan);
      settled = true;
      if (hurry) return best;
    } catch (error) {
      if (suspended || !(error instanceof RangeError && !error?.code) && error?.code !== 'JXL_SIZE') throw error;
      return best;
    } finally {
      try { closeCandidate(candidate, !settled); }
      catch (error) {
        if (!(error instanceof RangeError && !error?.code) && error?.code !== 'JXL_SIZE') throw error;
        return best;
      }
    }
  }
  return best;
}

export function* strategyAnsSteps(image, effort = 7, learned = null, pooled = false) {
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
    const {img, shared, plan} = runs[at], candidate = varDCTSteps(img, pooled ? {...plan, pooled: true, abortable: !!best} : plan, shared);
    let settled = false, hurry = false;
    try {
      let step, reply;
      while (!(step = candidate.next(reply)).done) {
        const value = step.value, response = yield scaled(value, done => (at + done) / runs.length);
        reply = typeof value === 'number' ? undefined : response;
        if (typeof value !== 'number' && response?.hurried) hurry = true;
      }
      if (pooled && step.value === null) {
        if (!best) throw new Error('Incomplete AC group stream.');
        settled = true; return best;
      }
      if (!best || step.value.length < best.length) best = step.value;
      settled = true;
      if (hurry) return best;
    } finally {
      closeCandidate(candidate, !settled);
    }
  }
  return best;
}

export function estimateBytes(image) {
  const plan = {clusters: BUDGETS[0], coding: buildAnsCoding, modularAns: writeModularAnsHistograms, lfCoder: lfCoderFor(5), estimate: true};
  const value = complete(varDCTSteps({...image, authoredOrderPasses: null}, plan, {}));
  return typeof value === 'number' ? value : value.length;
}
