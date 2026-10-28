// SPDX-License-Identifier: MIT
import {jpegEffortSteps} from './jpeg-effort.mjs';
import {coefficientEffortSteps, coefficientOrderSteps, candidateSteps, prefetch} from './coefficient-effort.mjs';
import {buildAnsCoding, writeModularAnsHistograms} from './ans.mjs';
import {lfCoder, lfCoderFor, RUNGS} from './lf-coding.mjs';
import {part, scaled} from './bits.mjs';
import {offloading} from './offload.mjs';
import {jpegJob} from './jpeg-job.mjs';

export const PREFIX_LADDER_PIXELS = 512 * 512;
const WIDE = {maxClusters: 128, seeds: 255, newClusterCost: 160}, WIDEST = {maxClusters: 255, seeds: 255, newClusterCost: 80};
const EVERY_WIDE = {...WIDE, everyConfig: true}, EVERY_WIDEST = {...WIDEST, everyConfig: true};
const JPEG_BROAD = {...RUNGS.broad, clustered: true};
const lfFor = effort => effort >= 9 ? lfCoder(JPEG_BROAD) : lfCoderFor(effort);

export function* jpegAnsFirstSteps(jpeg, effort, fallback, retain, shared = {}, every = effort >= 9) {
  const wide = every ? EVERY_WIDE : WIDE;
  if (effort < 2) return yield* coefficientEffortSteps(jpeg, effort, fallback, retain, shared);
  let ladder = jpeg.width * jpeg.height <= PREFIX_LADDER_PIXELS, best = fallback;
  const learn = effort >= 4 && !ladder;
  if (offloading()) yield prefetch(jpeg, [{coding: buildAnsCoding, clusters: wide, modularAns: writeModularAnsHistograms, lfCoder: lfFor(effort)},
    ...(learn ? [{orders: 'learned', coding: buildAnsCoding, clusters: wide, modularAns: writeModularAnsHistograms, lfCoder: lfFor(effort)}] : [])]);
  try {
    const plan = {coding: buildAnsCoding, clusters: wide, modularAns: writeModularAnsHistograms, lfCoder: lfFor(effort)};
    const candidate = candidateSteps(jpeg, plan, shared);
    let step, hurry, reply;
    while (!(step = candidate.next(reply)).done) {
      reply = undefined;
      if (typeof step.value !== 'number') { reply = yield scaled(step.value, done => ladder || learn ? done / 2 : done); continue; }
      hurry = yield ladder || learn ? step.value / 2 : step.value;
      if (hurry && best && step.value < 1) { candidate.return(); return best; }
    }
    if (!best || step.value.length < best.length) best = step.value;
    retain?.(step.value, plan);
    if (hurry) return best;
  } catch (error) {
    if (!(error instanceof RangeError && !error.code) && error.code !== 'JXL_SIZE') throw error;
    if (!best) ladder = true;
  }
  if (ladder) {
    if ((yield 0.5) && best) return best;
    return yield* part(coefficientEffortSteps(jpeg, effort, best, retain, shared), 1, 2);
  }
  if (!learn || (yield 0.5)) return best;
  try {
    const learning = coefficientOrderSteps(jpeg.components);
    let step;
    while (!(step = learning.next()).done) if (yield 0.5 + step.value / 4) { learning.return(); return best; }
    const plan = {orders: step.value, coding: buildAnsCoding, clusters: wide, modularAns: writeModularAnsHistograms, lfCoder: lfFor(effort)};
    const candidate = candidateSteps(jpeg, plan, shared);
    let reply;
    while (!(step = candidate.next(reply)).done) {
      reply = undefined;
      if (typeof step.value !== 'number') { reply = yield scaled(step.value, done => 0.75 + done / 4); continue; }
      if ((yield 0.75 + step.value / 4) && step.value < 1) { candidate.return(); return best; }
    }
    if (step.value.length < best.length) best = step.value;
    retain?.(step.value, plan);
  } catch (error) {
    if (!(error instanceof RangeError && !error.code) && error.code !== 'JXL_SIZE') throw error;
  }
  return best;
}

export function* jpegAnsEffortSteps(jpeg, effort, retain) {
  const shared = {};
  if (effort < 8) return yield* jpegEffortSteps(jpeg, effort, retain, jpegAnsFirstSteps, shared);
  let step, hurry, best;
  const first = effort >= 9 ? (image, e, fallback, keep, cache) => jpegAnsFirstSteps(image, e, fallback, keep, cache, true) : jpegAnsFirstSteps;
  const floor = jpegEffortSteps(jpeg, effort, retain, first, shared);
  let reply;
  while (!(step = floor.next(reply)).done) {
    if (typeof step.value !== 'number') { reply = yield scaled(step.value, done => done / 2); continue; }
    reply = hurry = yield step.value / 2;
  }
  best = step.value;
  if (hurry) return best;
  const alternate = {maxClusters: 32, newClusterCost: 160, everyConfig: effort === 9}, parts = effort === 8 ? 4 : 7;
  let part = 0;
  function* learn(bucket) {
    const steps = coefficientOrderSteps(jpeg.components, bucket);
    while (!(step = steps.next()).done) {
      hurry = yield 0.5 + (part + step.value) / (2 * parts);
      if (hurry) { steps.return(); return null; }
    }
    part++;
    return step.value;
  }
  function* write(orders, clusters) {
    const plan = {orders, clusters, coding: buildAnsCoding, modularAns: writeModularAnsHistograms, lfCoder: lfFor(effort)};
    const steps = candidateSteps(jpeg, plan, shared);
    let reply;
    while (!(step = steps.next(reply)).done) {
      reply = undefined;
      if (typeof step.value !== 'number') { reply = yield scaled(step.value, done => 0.5 + (part + done) / (2 * parts)); continue; }
      hurry = yield 0.5 + (part + step.value) / (2 * parts);
      if (hurry && step.value < 1) { steps.return(); return; }
    }
    if (step.value.length < best.length) best = step.value;
    retain?.(step.value, plan);
    part++;
  }
  try {
    yield* write(undefined, alternate);
    if (hurry) return best;
    const orders = yield* learn(8);
    if (hurry) return best;
    for (const clusters of effort === 9 ? [EVERY_WIDE, EVERY_WIDEST] : [WIDE, WIDEST]) {
      yield* write(orders, clusters);
      if (hurry) return best;
    }
    if (effort === 8) return best;
    const exact = yield* learn(1);
    if (hurry) return best;
    for (const clusters of [EVERY_WIDE, EVERY_WIDEST]) {
      yield* write(exact, clusters);
      if (hurry) return best;
    }
    return best;
  } catch (error) {
    if (!(error instanceof RangeError && !error.code) && error.code !== 'JXL_SIZE') throw error;
    return best;
  }
}

export function ansTranscodeSteps(jpeg, options) { return jpegJob(jpeg, options, jpegAnsEffortSteps); }
