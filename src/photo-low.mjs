// SPDX-License-Identifier: MIT
import {complete, part} from './bits.mjs';
import {photoProducer} from './photo-job.mjs';
import {photoXYBSteps, preferXYB, FAST_RANGE} from './photo-xyb.mjs';
import {P3_TRANSFORM} from './color-transform.mjs';
import {photoXYBBands} from './photo-bands.mjs';
import {V6, uploadPicture} from './photo-v6-settings.mjs';
import {coefficientAnsSteps, BUDGETS} from './coefficient-ans.mjs';
import {candidateSteps} from './coefficient-effort.mjs';
import {photoSplitCandidates, photoSplitBands, splitCandidates, splitHasAlpha, splitEnd,
  splitRoute, encodeSplitCandidates} from './photo-split.mjs';
import {largePhoto} from './photo-low-settings.mjs';

export function lowWholePhoto(data, width, height, {colorSpace = 'srgb', signal} = {}) {
  const color = {space: colorSpace, ...(colorSpace === 'display-p3' && {transform: P3_TRANSFORM})};
  let opaque = true;
  for (let at = 3; at < data.length; at += 4) if (data[at] !== 255) { opaque = false; break; }
  const lowOptions = {color, split: opaque && !color.transform};
  const low = preferXYB(data, width, height)
    ? options => lowPhotoPictureSteps(data, width, height, {...lowOptions, ...options})
    : options => lowOtherPhotoSteps(data, width, height, {colorSpace, ...options});
  return {color, *steps(options) {
    if (options.quality >= 100) return null;
    const steps = low(options);
    let step, reply, failed = false;
    try {
      for (;;) {
        if (signal?.aborted) throw signal.reason;
        step = steps.next(reply);
        if (step.done) return step.value;
        reply = yield step.value;
      }
    } catch (error) { failed = true; throw error; }
    finally { try { steps.return?.(); } catch (error) { if (!failed) throw error; } }
  }};
}

export function lowWholePhotoSteps(data, width, height, options) {
  return lowWholePhoto(data, width, height, options).steps(options);
}

const SMALL_BUDGET = [BUDGETS[0]];
const useFilter = (quality, width, height, nativeOpaque = true) => quality < 80 && !(nativeOpaque && largePhoto(width, height));
const fastBudgets = (effort, filter) => effort < 2 ? [] : effort >= 5 ? BUDGETS : filter || effort < 3
  ? SMALL_BUDGET : BUDGETS.slice(0, effort - 1);
const filteredBudgets = effort => effort >= 5 ? BUDGETS : effort >= 4 ? SMALL_BUDGET : [];
const filteredQuality = quality => Math.min(99.99, quality + 2);
const choose = (incumbent, bytes) => !incumbent || bytes.length < incumbent.length ? bytes : incumbent;
const sizeFailure = error => error?.code === 'JXL_SIZE' || error?.code === 'JXL_MEMORY' ||
  (error instanceof RangeError || error?.name === 'RangeError') && !error.code;

export function* lowOtherPhotoSteps(data, width, height, {quality, filter, colorSpace = 'srgb', effort = 4, observe = null}) {
  const control = {hurried: false};
  const image = yield* retainedSteps(part(photoProducer(data, width, height, quality, colorSpace, filter), 0, 3), null, control);
  const selected = bytes => { if (bytes) observe?.(image); return bytes; };
  if (effort <= 3 || control.hurried) return selected(yield* part(coefficientAnsSteps(image, control.hurried ? 1 : effort), 1, 2));
  let plan = null;
  const remember = (bytes, candidate) => { if (candidate.coding) plan = candidate; };
  const best = yield* retainedSteps(part(coefficientAnsSteps(image, 3, undefined, remember), 1, 3), null, control);
  if (!plan || control.hurried) return selected(best);
  return selected(yield* retainedSteps(part(candidateSteps(image, {...plan, clusters: BUDGETS[0]}, {}), 2, 3), best, control));
}

export function* lowPhotoPictureSteps(data, width, height, {quality, effort, observe = null, color = {}, split = true}) {
  const images = observe ? new WeakMap() : null;
  const bytes = yield* pictureSteps(data, width, height, quality, effort, images, color, split);
  if (observe && bytes) observe(images.get(bytes));
  return bytes;
}

function* remembered(steps, image, images, incumbent = null) {
  const bytes = yield* steps;
  if (images && bytes && bytes !== incumbent) images.set(bytes, typeof image === 'function' ? image() : image);
  return bytes;
}

function* pictureSteps(data, width, height, quality, effort, images, color, split) {
  const control = {hurried: false}, filter = useFilter(quality, width, height, split && !color.transform);
  if (split && !color.transform && splitRoute(width, height)) {
    const remote = !(typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) && !images && (yield {split: {pixels: width * height,
      run: (helpers, options) => encodeLowSplit(data, width, height, quality, effort, helpers, options)}});
    if (remote) return remote;
    const candidate = function* (q, budgets, gaborish = false) {
      let image;
      return yield* remembered(photoSplitCandidates(data, width, height, q, budgets,
        {gaborish, ...(images && {observe: value => { image = value; }})}), () => image, images);
    };
    const stages = effort >= 3 && filter ? 2 : 1;
    const best = yield* retainedSteps(part(candidate(quality, fastBudgets(effort, filter)), 0, stages), null, control);
    if (effort < 3 || !filter || control.hurried) return best;
    return yield* retainedSteps(part(candidate(filteredQuality(quality), filteredBudgets(effort), true), 1, stages), best, control);
  }
  let image;
  try { image = complete(photoXYBSteps(data, width, height, quality, {...V6, fast: true, fastBand: !color.transform, ...color})); }
  catch (error) {
    if (error !== FAST_RANGE) throw error;
    image = complete(photoXYBSteps(data, width, height, quality, {...V6, ...color}));
  }
  const stages = effort >= 3 && filter ? 2 : 1;
  const best = yield* retainedSteps(part(remembered(fastSmallSteps(image, effort, control, !filter), image, images), 0, stages), null, control);
  if (effort < 3 || !filter || control.hurried) return best;
  return yield* retainedSteps(part(filteredSteps(data, width, height, quality, effort, best, control, images, color), 1, stages), best, control);
}

function* retainedSteps(steps, best, control = {hurried: false}) {
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

function* fastSmallSteps(image, effort, control, entropyOnly) {
  const stages = (entropyOnly ? effort : Math.min(effort, 2)) + (effort >= 5 ? 1 : 0);
  let best = yield* part(coefficientAnsSteps(image, 1), 0, stages), plan = null;
  if (effort < 2 || control.hurried) return best;
  const remember = entropyOnly && effort >= 3 ? (bytes, candidate) => { if (candidate.coding) plan = candidate; } : undefined;
  best = yield* retainedSteps(part(coefficientAnsSteps(image, 2, best, remember), 1, stages), best, control);
  if (plan) for (let at = 2; at < effort && !control.hurried; at++)
    best = yield* retainedSteps(part(candidateSteps(image, {...plan, clusters: BUDGETS[at - 2]}, {}), at, stages), best, control);
  if (effort >= 5 && !control.hurried) best = yield* retainedSteps(part(coefficientAnsSteps(image, 5, best), stages - 1, stages), best, control);
  return best;
}

function* filteredSteps(data, width, height, quality, effort, best, control, images, color) {
  const stages = effort >= 4 ? 3 : 2;
  const image = yield* part(photoXYBBands(data, width, height, filteredQuality(quality), {...uploadPicture(data, width, height), ...color}), 0, stages);
  if (control.hurried) return best;
  best = choose(best, yield* part(remembered(coefficientAnsSteps(image, 3, best), image, images, best), 1, stages));
  if (effort >= 4 && !control.hurried) return yield* retainedSteps(part(remembered(coefficientAnsSteps(image, Math.min(effort, 5), best), image, images, best), 2, stages), best, control);
  return best;
}

export async function encodeLowSplit(data, width, height, quality, effort, helpers, options = {}) {
  options.signal?.throwIfAborted();
  const filter = useFilter(quality, width, height);
  let best = await encodeSplitCandidates(data, width, height, quality, helpers, fastBudgets(effort, filter),
    {...options, gaborish: false, opaque: true});
  options.signal?.throwIfAborted();
  if (best === null || effort < 3 || !filter) return best;
  try {
    const bytes = await encodeSplitCandidates(data, width, height, filteredQuality(quality), helpers, filteredBudgets(effort),
      {...options, gaborish: true, opaque: true});
    options.signal?.throwIfAborted();
    if (bytes !== null) best = choose(best, bytes);
  } catch (error) { options.signal?.throwIfAborted(); if (!sizeFailure(error)) throw error; }
  return best;
}

export function makeLowUpload(data, width, height, quality, effort) {
  const filter = useFilter(quality, width, height);
  const split = photoSplitBands(data, width, height, quality);
  if (splitHasAlpha(split) || effort < 3 || !filter) return {split, incumbent: null, filtered: false, filter};
  const incumbent = complete(splitCandidates(split, SMALL_BUDGET));
  try { return {split: photoSplitBands(data, width, height, filteredQuality(quality), {gaborish: true}), incumbent, filtered: true}; }
  catch (error) { if (!sizeFailure(error)) throw error; return {split: null, incumbent, filtered: true}; }
}
export function* finishLowUpload(state, effort) {
  if (!state.split) return state.incumbent;
  return yield* retainedSteps(splitCandidates(state.split, state.filtered ? filteredBudgets(effort) : fastBudgets(effort, state.filter)), state.incumbent);
}
export function closeLowUpload(state) { if (state.split) splitEnd(state.split); }


export {useFilter as lowPhotoUsesFilter, fastBudgets as lowPhotoBudgets,
  filteredQuality as lowPhotoFilteredQuality, choose as chooseLowPhoto,
  sizeFailure as lowPhotoSizeFailure, SMALL_BUDGET as LOW_PHOTO_SMALL_BUDGET};
