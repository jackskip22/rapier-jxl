// SPDX-License-Identifier: MIT
import {jpegEffortSteps} from './jpeg-effort.mjs';
import {coefficientEffortSteps, coefficientOrderSteps, candidateSteps, prefetch} from './coefficient-effort.mjs';
import {buildAnsCoding, writeModularAnsHistograms} from './ans.mjs';
import {JPEG_ANS} from './jpeg-ans-configs.mjs';
import {lfCoderFor, fixedLfCoder, quickOrFixedLfCoder, fastOrFixedLfCoder, jpegBroadOrFixedLfCoder} from './lf-coding.mjs';
import {part, scaled} from './bits.mjs';
import {offloading} from './offload.mjs';
import {jpegJob} from './jpeg-job.mjs';

export const PREFIX_LADDER_PIXELS = 512 * 512;
const SMALL_PIXELS = 1 << 21;
const twins = (jpeg, clusters) => jpeg.width * jpeg.height <= SMALL_PIXELS && clusters.jpeg
  ? [clusters, {maxClusters: clusters.maxClusters, seeds: clusters.seeds, newClusterCost: clusters.newClusterCost, ...clusters.everyConfig && {everyConfig: true}}] : [clusters];
const WIDE = {maxClusters: 128, seeds: 255, newClusterCost: 160, jpeg: JPEG_ANS};
const SHAPED_WIDE = {...WIDE, headerAware: true, shapedMerge: true};
const WIDEST = {maxClusters: 255, seeds: 255, newClusterCost: 80, headerAware: true, shapedMerge: true, jpeg: JPEG_ANS};
const NARROW = {maxClusters: 48};
const EVERY_WIDE = {...SHAPED_WIDE, everyConfig: true}, EVERY_WIDEST = {...WIDEST, everyConfig: true};
const lfFor = effort => (typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) || effort <= 3 ? fixedLfCoder : effort >= 9 ? jpegBroadOrFixedLfCoder : effort === 8 ? fastOrFixedLfCoder : effort >= 5 ? lfCoderFor(effort) : quickOrFixedLfCoder;

export function* jpegAnsFirstSteps(jpeg, effort, fallback, retain, shared = {}, every = effort >= 9) {
  const wide = effort === 2 ? NARROW : !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && every ? EVERY_WIDE : !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && effort >= 5 ? SHAPED_WIDE : WIDE;
  if (effort < 2) return yield* coefficientEffortSteps(jpeg, effort, fallback, retain, shared);
  let ladder = jpeg.width * jpeg.height <= PREFIX_LADDER_PIXELS, best = fallback;
  const learn = !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && effort >= 5 && !ladder;
  const first = effort <= 4 && !ladder ? 'learned' : undefined;
  if (!(typeof __RAPIER_JXL_JPEG__ !== 'undefined' && __RAPIER_JXL_JPEG__ === true || typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && offloading()) yield prefetch(jpeg, [{orders: first, coding: buildAnsCoding, clusters: wide, modularAns: writeModularAnsHistograms, lfCoder: lfFor(effort)},
    ...(learn ? [{orders: 'learned', coding: buildAnsCoding, clusters: wide, modularAns: writeModularAnsHistograms, lfCoder: lfFor(effort)}] : [])]);
  try {
    let orders, step, hurry, reply;
    if (first) {
      const learning = coefficientOrderSteps(jpeg.components);
      while (!(step = learning.next()).done) yield step.value / 20;
      orders = step.value;
    }
    const firsts = twins(jpeg, wide);
    for (const [k, clusters] of firsts.entries()) {
      const at = done => (orders ? 0.05 + 0.95 * done : ladder || learn ? done / 2 : done) * (k + 1) / firsts.length;
      const plan = {orders, coding: buildAnsCoding, clusters, modularAns: writeModularAnsHistograms, lfCoder: lfFor(effort)};
      const candidate = candidateSteps(jpeg, plan, shared);
      while (!(step = candidate.next(reply)).done) {
        reply = undefined;
        if (typeof step.value !== 'number') { reply = yield scaled(step.value, at); continue; }
        hurry = yield at(step.value);
        if (hurry && best && step.value < 1) { candidate.return(); return best; }
      }
      if (!best || step.value.length < best.length) best = step.value;
      retain?.(step.value, plan);
      if (hurry) return best;
    }
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
    const orders = step.value, list = twins(jpeg, wide);
    for (const [k, clusters] of list.entries()) {
      const plan = {orders, coding: buildAnsCoding, clusters, modularAns: writeModularAnsHistograms, lfCoder: lfFor(effort)}, at = done => 0.75 + (k + done) / (4 * list.length);
      const candidate = candidateSteps(jpeg, plan, shared);
      let reply;
      while (!(step = candidate.next(reply)).done) {
        reply = undefined;
        if (typeof step.value !== 'number') { reply = yield scaled(step.value, at); continue; }
        if ((yield at(step.value)) && step.value < 1) { candidate.return(); return best; }
      }
      if (step.value.length < best.length) best = step.value;
      retain?.(step.value, plan);
    }
  } catch (error) {
    if (!(error instanceof RangeError && !error.code) && error.code !== 'JXL_SIZE') throw error;
  }
  return best;
}

export function* jpegAnsEffortSteps(jpeg, effort, retain) {
  const shared = {};
  if (effort < 8 || (typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true)) return yield* jpegEffortSteps(jpeg, effort, retain, jpegAnsFirstSteps, shared);
  let step, hurry, best;
  const ladder = jpeg.width * jpeg.height <= SMALL_PIXELS;
  const first = effort >= 9 ? (image, e, fallback, keep, cache) => jpegAnsFirstSteps(image, e, fallback, keep, cache, true) : jpegAnsFirstSteps;
  const floor = ladder ? jpegEffortSteps(jpeg, effort, retain, first, shared) : first(jpeg, effort, undefined, retain, shared);
  let reply;
  try { while (!(step = floor.next(reply)).done) {
    if (typeof step.value !== 'number') { reply = yield scaled(step.value, done => done / 2); continue; }
    reply = hurry = yield step.value / 2;
  } } finally { if (!step?.done) floor.return?.(); }
  best = step.value;
  if (!best && !ladder && !hurry) {
    const backup = jpegEffortSteps(jpeg, effort, retain, coefficientEffortSteps, shared);
    try { while (!(step = backup.next()).done) { if (typeof step.value === 'number' && (hurry = yield step.value / 2)) break; } }
    finally { if (!step?.done) backup.return?.(); }
    if (step?.done) best = step.value;
  }
  if (hurry) return best;
  const alternate = {maxClusters: 32, newClusterCost: 160, everyConfig: effort === 9}, parts = (!ladder && best ? 2 : 0) + (effort === 8 ? 4 : 7) + (jpeg.width * jpeg.height <= SMALL_PIXELS ? effort === 8 ? 2 : 4 : 0);
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
  function* write(orders, each) {
    for (const clusters of twins(jpeg, each)) { yield* writeOne(orders, clusters); if (hurry) return; }
  }
  function* writeOne(orders, clusters) {
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
    if (!ladder && best) {
      const orders16 = yield* learn(16);
      if (hurry) return best;
      yield* write(orders16, effort === 9 ? EVERY_WIDEST : WIDEST);
      if (hurry) return best;
    }
    const orders = yield* learn(8);
    if (hurry) return best;
    for (const clusters of effort === 9 ? [EVERY_WIDE, EVERY_WIDEST] : [SHAPED_WIDE, WIDEST]) {
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

jpegAnsEffortSteps.contextsFrom = 2;
export function ansTranscodeSteps(jpeg, options) { return jpegJob(jpeg, options, jpegAnsEffortSteps); }
