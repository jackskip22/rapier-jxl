// SPDX-License-Identifier: MIT
import {coefficientEffortSteps, coefficientOrderSteps, candidateSteps, prefetch, prefixPlans} from './coefficient-effort.mjs';
import {offloading} from './offload.mjs';
import {varDCTSteps, vdLfGroupCount, seedLfSections} from './vardct.mjs';
import {part, complete, scaled} from './bits.mjs';
import {buildAnsCoding, writeModularAnsHistograms} from './ans.mjs';
import {lfCoderFor, monotonicLfCoderFor} from './lf-coding.mjs';

const PHOTO_CLUSTERS = {maxClusters: 64, newClusterCost: 100, seeds: 128};
const BUDGETS = [{maxClusters: 64, newClusterCost: 80, seeds: 128, switchCost: 5}, {maxClusters: 48, newClusterCost: 130, seeds: 128}, {maxClusters: 64, newClusterCost: 90, seeds: 128, everyConfig: true}];
const EXTRA_BUDGETS = [{maxClusters: 64, newClusterCost: 70, seeds: 128, switchCost: 4, everyConfig: true}, {maxClusters: 64, newClusterCost: 58, seeds: 128, switchCost: 4, everyConfig: true}];

function rungs(effort) {
  if (effort < 4) return [{orders: true, lf: 3}];
  const lf = effort >= 7 ? 7 : 5, list = [...(effort >= 5 ? [{orders: true}] : []), {orders: true, lf}, {lf}];
  for (let i = 0; i < (effort >= 5 ? Math.min(3, effort - 4) : 0); i++) list.push({orders: 'best', lf, clusters: BUDGETS[i]});
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
  ...(rung.lf ? {lfCoder: lfCoderFor(rung.lf)} : {}), ...(orders ? {orders} : {}), clusters: rung.clusters ?? PHOTO_CLUSTERS});

const isSizeFailure = error => error instanceof RangeError && !error?.code || error?.code === 'JXL_SIZE';

const PREFIX_PIXELS = 128 * 128;

export function* coefficientAnsSteps(jpeg, effort, fallback, retain, pooled = false) {
  const shared = retain ? {} : {acCoding: buildAnsCoding};
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
        if (typeof value === 'number' ? response : !value?.gpu && (response === null || response?.hurried)) hurry = true;
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
  const adaptiveFast = !!(jpeg.xyb && !jpeg.strategyData && effort <= FAST_LAST);
  if (learn) orders = yield* run(quiet(coefficientOrderSteps(jpeg.components, 8, adaptiveFast)));
  let bestOrders = null;
  const written = new Set();
  const keyOf = (rung, use) => (use === orders && use ? 'o' : use ? '?' : 'n') + ':' + (rung.lf ?? 0) + ':' + (rung.clusters ? BUDGETS.indexOf(rung.clusters) : -1);
  let named = false;
  for (const rung of list) {
    if (hurry && best) break;
    if (rung.orders === 'best' && !named && !pooled && offloading()) {
      named = true;
      const plans = list.filter(r => r.orders === 'best' && !written.has(keyOf(r, bestOrders)))
        .map(r => ansPlan(r, bestOrders && (bestOrders === orders ? 'learned' : bestOrders), effort));
      if (plans.length) yield prefetch(jpeg, plans);
    }
    const use = rung.orders === 'best' ? bestOrders : rung.orders ? orders : null;
    const key = keyOf(rung, use);
    if (rung.orders === true && !orders && !adaptiveFast || written.has(key)) { at++; continue; }
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

export function* strategyLfSteps(image, effort = 7) {
  const plan = {clusters: BUDGETS[0], coding: buildAnsCoding, modularAns: writeModularAnsHistograms, lfCoder: lfCoderFor(Math.max(5, effort))};
  const n = vdLfGroupCount(image), groups = [];
  for (let g = 0; g < n; g++) { groups.push(complete(varDCTSteps(image, {...plan, lfGroup: g}))); yield (g + 1) / n; }
  seedLfSections(image, plan, groups);
}
export function* strategyAnsSteps(image, effort = 7, learned = null, pooled = false, primed = null, both = true) {
  const budgets = effort >= 9 ? [...BUDGETS, ...EXTRA_BUDGETS] : effort >= 8 ? [...BUDGETS, EXTRA_BUDGETS[0]] : BUDGETS.slice(0, Math.max(1, Math.min(3, effort - 6)));
  const lf = effort >= 8 ? monotonicLfCoderFor(effort) : lfCoderFor(Math.max(5, effort)), richContexts = effort >= 8;
  const plain = () => primed?.image === image ? {img: primed.img, shared: primed.shared} : {img: {...image, authoredOrderPasses: null}, shared: {}};
  const authoredOrders = Array.isArray(learned) && (learned.length === 0 || Array.isArray(learned[0])) ? learned.filter(Boolean) : learned ? [learned] : [];
  const orderList = authoredOrders.length ? both ? [null, ...authoredOrders] : authoredOrders : [null];
  const runs = [];
  if (effort <= 6) runs.push({...plain(), plan: {clusters: BUDGETS[0], coding: buildAnsCoding, modularAns: writeModularAnsHistograms, lfCoder: lf}});
  else for (const authored of orderList) {
    const {img, shared} = authored ? {img: {...image, authoredOrderPasses: authored}, shared: {}} : plain();
    if (image.width * image.height <= PREFIX_PIXELS) runs.push({img, shared, plan: {clusters: BUDGETS[0]}});
    if (richContexts) runs.push({img, shared, plan: {clusters: BUDGETS[0], coding: buildAnsCoding, modularAns: writeModularAnsHistograms, lfCoder: lf}});
    for (const clusters of budgets) runs.push({img, shared, plan: {clusters, coding: buildAnsCoding, modularAns: writeModularAnsHistograms, lfCoder: lf, ...(richContexts || effort >= 7 ? {richContexts: true} : {})}});
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
        if (typeof value === 'number' ? response : !value?.gpu && (response === null || response?.hurried)) hurry = true;
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

export function estimateBytes(image, primed = null) {
  const plan = {clusters: BUDGETS[0], coding: buildAnsCoding, modularAns: writeModularAnsHistograms, lfCoder: lfCoderFor(5), estimate: true};
  const img = {...image, authoredOrderPasses: null}, shared = {};
  if (primed) Object.assign(primed, {image, img, shared});
  const value = complete(varDCTSteps(img, plan, shared));
  return typeof value === 'number' ? value : value.length;
}
