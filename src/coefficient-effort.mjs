// SPDX-License-Identifier: MIT
import {varDCTSteps} from './vardct.mjs';
import {ZIGZAG} from './jfif.mjs';
import {complete, part, scaled} from './bits.mjs';

export function coefficientOrders(components) { return complete(coefficientOrderSteps(components)); }

export function* coefficientOrderSteps(components, bucket = 8) {
  const scan = ZIGZAG.map(n => ((n & 7) << 3) | (n >> 3));
  const histograms = components.map(() => new Uint32Array(64)), total = components.reduce((n, c) => n + c.coeffs.length, 0);
  let done = 0;
  for (let c = 0; c < components.length; c++) {
    const {coeffs} = components[c], counts = histograms[c];
    for (let from = 0; from < coeffs.length; from += 65536) {
      const end = Math.min(from + 65536, coeffs.length);
      for (let at = from; at < end; at += 64) for (let k = 1; k < 64; k++) if (coeffs[at + scan[k]]) counts[k]++;
      done += end - from;
      if (yield done / total) return null;
    }
  }
  return histograms.map(counts => [0, ...Array.from({length: 63}, (_, k) => k + 1).sort((a, b) => Math.floor(counts[b] / bucket) - Math.floor(counts[a] / bucket) || a - b)]);
}

export function* coefficientEffortSteps(jpeg, effort, fallback, retain, shared = {}, pooled = false) {
  if (effort < 3 && !fallback && !retain) {
    const bytes = yield* part(varDCTSteps(jpeg, pooled ? {pooled: true, abortable: false} : {}, shared), 0, 1);
    if (pooled && bytes === null) throw new Error('Incomplete AC group stream.');
    return bytes;
  }
  let best = fallback, active, settled = false, suspended = false, hurry = false, interrupted = false;
  function* write(plan, fraction) {
    active = varDCTSteps(jpeg, pooled ? {...plan, pooled: true, abortable: !!best} : plan, shared);
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
    const first = yield* write({}, done => done / 2);
    if (!keep(first, {}) || hurry || effort < 3) { settled = true; return best; }
    const parts = effort < 4 ? 1 : 3;
    const clustered = yield* write({clusters: {maxClusters: 32, newClusterCost: 160}}, done => 0.5 + done / (2 * parts));
    if (!keep(clustered, {clusters: {maxClusters: 32, newClusterCost: 160}}) || hurry || effort < 4) { settled = true; return best; }
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
