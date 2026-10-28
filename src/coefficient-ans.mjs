// SPDX-License-Identifier: MIT
import {coefficientEffortSteps, coefficientOrderSteps, candidateSteps, prefetch, prefixPlans} from './coefficient-effort.mjs';
import {offloading} from './offload.mjs';
import {varDCTSteps} from './vardct.mjs';
import {part, complete, scaled} from './bits.mjs';
import {buildAnsCoding, writeModularAnsHistograms} from './ans.mjs';
import {lfCoderFor} from './lf-coding.mjs';

const BUDGETS = [{maxClusters: 32, newClusterCost: 160}, {maxClusters: 24, newClusterCost: 100}, {maxClusters: 16, newClusterCost: 100}];

function rungs(effort) {
  const list = [{orders: true}];
  if (effort >= 4) list.push({orders: true, lf: 5}, {});
  if (effort >= 5) list.push({orders: 'best', lf: 5});
  for (let i = 0; i < (effort >= 6 ? Math.min(3, effort - 5) : 0); i++) list.push({orders: 'best', lf: 5, clusters: BUDGETS[i]});
  if (effort >= 8) list.push({orders: 'best', lf: 9});
  if (effort >= 9) list.push({orders: 'best', lf: 8}, {orders: 'best', lf: 7});
  return list;
}

function closeCandidate(steps, preserveOutcome) {
  try { steps?.return(); }
  catch (error) { if (!preserveOutcome) throw error; }
}

function* quiet(steps) { let step; while (!(step = steps.next()).done) yield step.value; return step.value; }

const FAST_LAST = 3;

const ansPlan = (rung, orders, effort) => ({coding: buildAnsCoding, modularAns: writeModularAnsHistograms, ...(effort <= FAST_LAST ? {fast: true} : {}),
  ...(rung.lf ? {lfCoder: lfCoderFor(rung.lf)} : {}), ...(orders ? {orders} : {}), ...(rung.clusters ? {clusters: rung.clusters} : {})});

const isSizeFailure = error => error instanceof RangeError && !error?.code || error?.code === 'JXL_SIZE';

const PREFIX_PIXELS = 512 * 512;

export function* coefficientAnsSteps(jpeg, effort, fallback, retain, pooled = false) {
  const shared = {};
  if (effort < 2) return yield* part(coefficientEffortSteps(jpeg, effort, fallback, retain, shared, pooled), 0, 1);
  const list = rungs(effort), learn = list.some(rung => rung.orders) ? 1 : 0, small = jpeg.width * jpeg.height <= PREFIX_PIXELS;
  const floorFirst = effort >= 4, parts = learn + list.length + (floorFirst || small ? 1 : 0);
  let best = fallback, hurry = false, at = 0, orders;
  function* run(steps) {
    const from = at / parts;
    let step, reply, settled = false;
    try {
      while (!(step = steps.next(reply)).done) {
        const value = step.value, response = yield scaled(value, done => Math.min(1, from + done / parts));
        reply = response;
        if (typeof value === 'number' ? response : response === null || response?.hurried) hurry = true;
        if (typeof value === 'number' && response && best && value < 1) return null;
      }
      settled = true;
      return step.value;
    } finally { at++; closeCandidate(steps, !settled); }
  }
  const keep = (bytes, plan) => {
    if (pooled && bytes === null) { if (!best) throw new Error('Incomplete AC group stream.'); return; }
    if (bytes && (!best || bytes.length < best.length)) best = bytes;
    if (bytes) retain?.(bytes, plan);
  };
  const floor = () => coefficientEffortSteps(jpeg, 1, undefined, undefined, {}, pooled);
  if (!pooled && offloading()) yield prefetch(jpeg, [...(floorFirst || small ? prefixPlans(1) : []),
    ...list.filter(rung => rung.orders !== 'best').map(rung => ansPlan(rung, rung.orders ? 'learned' : null, effort))]);
  if (floorFirst) {
    try { keep(yield* run(floor()), {}); }
    catch (error) { if (!isSizeFailure(error)) throw error; }
  }
  if (learn) orders = yield* run(quiet(coefficientOrderSteps(jpeg.components)));
  let bestOrders = null;
  const written = new Set();
  let named = false;
  for (const rung of list) {
    if (hurry && best) break;
    if (rung.orders === 'best' && !named && !pooled && offloading()) {
      named = true;
      yield prefetch(jpeg, list.filter(r => r.orders === 'best').map(r => ansPlan(r, bestOrders && (bestOrders === orders ? 'learned' : bestOrders), effort)));
    }
    const use = rung.orders === 'best' ? bestOrders : rung.orders ? orders : null;
    const key = (use === orders && use ? 'o' : use ? '?' : 'n') + ':' + (rung.lf ?? 0) + ':' + (rung.clusters ? BUDGETS.indexOf(rung.clusters) : -1);
    if (rung.orders === true && !orders || written.has(key)) { at++; continue; }
    written.add(key);
    const plan = ansPlan(rung, use, effort);
    try {
      const before = best;
      keep(yield* run(candidateSteps(jpeg, pooled ? {...plan, pooled: true, abortable: !!best} : plan, shared)), plan);
      if (best !== before) bestOrders = use;
    } catch (error) { if (!isSizeFailure(error)) throw error; }
  }
  if (!floorFirst && small && !(hurry && best) || !best) {
    try { keep(yield* run(floor()), {}); }
    catch (error) { if (!isSizeFailure(error) || !best) throw error; }
  }
  if (at < parts) yield 1;
  return best;
}

coefficientAnsSteps.splits = true;

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
