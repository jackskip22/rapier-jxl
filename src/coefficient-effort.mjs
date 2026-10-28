// SPDX-License-Identifier: MIT
import {varDCTSteps} from './vardct.mjs';
import {ZIGZAG} from './jpeg-tables.mjs';
import {complete, part, scaled} from './bits.mjs';
import {offloading} from './offload.mjs';
import {kernelHooks} from './kernel-hooks.mjs';

export function coefficientOrders(components) { return complete(coefficientOrderSteps(components)); }

export function* coefficientOrderSteps(components, bucket = 8) {
  const scan = ZIGZAG.map(n => ((n & 7) << 3) | (n >> 3));
  const histograms = components.map(() => new Uint32Array(64)), total = components.reduce((n, c) => n + c.coeffs.length, 0);
  let done = 0;
  const natural = new Uint32Array(64);
  for (let c = 0; c < components.length; c++) {
    const {coeffs} = components[c], counts = histograms[c];
    natural.fill(0);
    for (let from = 0; from < coeffs.length; from += 65536) {
      const end = Math.min(from + 65536, coeffs.length);
      if (!kernelHooks.nonzero?.(coeffs, from, end, natural)) for (let at = from; at < end; at += 64) for (let i = 0; i < 64; i++) if (coeffs[at + i]) natural[i]++;
      done += end - from;
      if (yield done / total) return null;
    }
    for (let k = 1; k < 64; k++) counts[k] = natural[scan[k]];
  }
  return ordersFromCounts(histograms, bucket);
}

export function ordersFromCounts(histograms, bucket = 8) {
  return histograms.map(counts => [0, ...Array.from({length: 63}, (_, k) => k + 1).sort((a, b) => Math.floor(counts[b] / bucket) - Math.floor(counts[a] / bucket) || a - b)]);
}

export function* candidateSteps(image, plan, shared) {
  if (!plan.pooled && offloading()) {
    const bytes = yield {offload: 'run', task: {kind: 'vardct', image, plan}, at: done => done};
    if (bytes) return bytes;
  }
  return yield* varDCTSteps(image, plan, shared);
}
export const prefetch = (image, plans) => ({offload: 'prefetch', tasks: plans.map(plan => ({kind: 'vardct', image, plan})), at: done => done});
const CLUSTERED = Object.freeze({maxClusters: 32, newClusterCost: 160});
const FAST = Object.freeze({fast: true, clusters: Object.freeze({fixed: true})});
export const prefixPlans = (effort, fallback, retain) => effort <= 3 && !fallback && !retain ? [FAST]
  : [...(effort >= 4 && !fallback ? [FAST] : []), {}, ...(effort >= 3 ? [{clusters: CLUSTERED}] : []), ...(effort >= 4 ? [{orders: 'learned'}] : [])];

export function* coefficientEffortSteps(jpeg, effort, fallback, retain, shared = {}, pooled = false) {
  if (effort <= 3 && !fallback && !retain) {
    const fast = jpeg.xyb ? {fast: true} : {};
    const bytes = yield* part(varDCTSteps(jpeg, pooled ? {...fast, pooled: true, abortable: false} : fast, shared), 0, 1);
    if (pooled && bytes === null) throw new Error('Incomplete AC group stream.');
    return bytes;
  }
  let best = fallback, active, settled = false, suspended = false, hurry = false, interrupted = false;
  if (!pooled && offloading()) yield prefetch(jpeg, prefixPlans(effort, fallback, retain));
  function* write(plan, fraction, cache = shared) {
    active = candidateSteps(jpeg, pooled ? {...plan, pooled: true, abortable: !!best} : plan, cache);
    let step, reply;
    hurry = false; interrupted = false;
    while (!(step = active.next(reply)).done) {
      suspended = true;
      const value = step.value, response = yield scaled(value, fraction);
      suspended = false;
      reply = typeof value === 'number' ? undefined : response;
      if (typeof value === 'number') {
        hurry = response;
        if (hurry && best && value < 1) { interrupted = true; return; }
      } else if (response?.hurried) hurry = true;
    }
    return step.value;
  }
  const keep = (bytes, plan) => {
    if (interrupted || pooled && bytes === null) {
      if (!best) throw new Error('Incomplete AC group stream.');
      return false;
    }
    if (!best || bytes.length < best.length) best = bytes;
    retain?.(bytes, plan);
    return true;
  };
  try {
    const ladder = effort >= 4 && !fallback && jpeg.xyb;
    if (ladder) {
      const fastPlan = {fast: true}, fastBytes = yield* write(fastPlan, done => done / 10, {});
      if (!keep(fastBytes, fastPlan) || hurry) { settled = true; return best; }
    }
    const first = yield* write({}, ladder ? done => 0.1 + 0.4 * done : done => done / 2);
    if (!keep(first, {}) || hurry || effort < 3) { settled = true; return best; }
    const parts = effort < 4 ? 1 : 3;
    const clustered = yield* write({clusters: CLUSTERED}, done => 0.5 + done / (2 * parts));
    if (!keep(clustered, {clusters: CLUSTERED}) || hurry || effort < 4) { settled = true; return best; }
    active = coefficientOrderSteps(jpeg.components);
    let step;
    while (!(step = active.next()).done) {
      suspended = true;
      const response = yield 0.5 + (1 + step.value) / 6;
      suspended = false;
      if (response) { settled = true; return best; }
    }
    const plan = {orders: step.value}, candidate = yield* write(plan, done => 0.5 + (2 + done) / 6);
    keep(candidate, plan);
    settled = true;
    return best;
  } catch (error) {
    if (suspended || !best || !(error instanceof RangeError && !error?.code) && error?.code !== 'JXL_SIZE') throw error;
    return best;
  } finally {
    try { active?.return(); }
    catch (error) {
      if (settled && (!best || !(error instanceof RangeError && !error?.code) && error?.code !== 'JXL_SIZE')) throw error;
    }
  }
}
