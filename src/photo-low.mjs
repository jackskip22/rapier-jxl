// SPDX-License-Identifier: MIT
import {complete, part} from './bits.mjs';
import {photoProducer} from './photo-job.mjs';
import {photoXYBSteps, preferXYB, FAST_RANGE} from './photo-xyb.mjs';
import {P3_TRANSFORM} from './color-transform.mjs';
import {photoXYBBands} from './photo-bands.mjs';
import {v6For, smallPicture, uploadPicture} from './photo-v6-settings.mjs';
import {coefficientAnsSteps, BUDGETS} from './coefficient-ans.mjs';
import {candidateSteps} from './coefficient-effort.mjs';
import {photoSplitCandidates, photoSplitBands, splitCandidates, splitHasAlpha, splitEnd,
  splitRoute, encodeSplitCandidates} from './photo-split.mjs';
import {largePhoto} from './photo-low-settings.mjs';
import {SMALL_BUDGET, fastBudgets, choose, sizeFailure, retainedSteps, fastSmallSteps} from './photo-low-ladder.mjs';

export function lowWholePhoto(data, width, height, {colorSpace = 'srgb', signal, smooth} = {}) {
  const color = {space: colorSpace, ...(colorSpace === 'display-p3' && {transform: P3_TRANSFORM})};
  let opaque = true;
  for (let at = 3; at < data.length; at += 4) if (data[at] !== 255) { opaque = false; break; }
  const lowOptions = {color, split: opaque && !color.transform, smooth};
  const low = opaque && !color.transform && smallPicture(width, height) || preferXYB(data, width, height)
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

const LF3_BUDGET = [{...SMALL_BUDGET[0], lf: 3}], FAST_E5_BUDGETS = [LF3_BUDGET[0], {...BUDGETS[1], passes: 1, mapLz: true, lf: 3}];
const useFilter = (quality, width, height, nativeOpaque = true) => quality < 95 && !(nativeOpaque && largePhoto(width, height)) && !smallPicture(width, height);
const lightPicture = (effort, width, height, quality) => effort === 2 && useFilter(quality, width, height);
const alone = (quality, effort, filter, smooth, small) => filter && effort >= 3 && !small && (quality >= 80 || smooth === false);
const filteredBudgets = effort => effort >= 5 ? FAST_E5_BUDGETS : effort >= 4 ? LF3_BUDGET : [];
const filteredQuality = (quality, smooth) => quality >= 85 || quality < 80 && smooth === false ? quality - 0.5 : quality;
const filteredPredictionFor = (quality, width, height) => Math.min(width, height) >= 256 ? quality : undefined;

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

export function* lowPhotoPictureSteps(data, width, height, {quality, effort, observe = null, color = {}, split = true, screen, smooth, lowFilteredQuality}) {
  lowFilteredQuality = filteredPredictionFor(lowFilteredQuality, width, height);
  const images = observe ? new WeakMap() : null;
  const bytes = yield* pictureSteps(data, width, height, quality, effort, images, color, split, screen, smooth, lowFilteredQuality);
  if (observe && bytes) observe(images.get(bytes));
  return bytes;
}

function* remembered(steps, image, images, incumbent = null) {
  const bytes = yield* steps;
  if (images && bytes && bytes !== incumbent) images.set(bytes, typeof image === 'function' ? image() : image);
  return bytes;
}

function* pictureSteps(data, width, height, quality, effort, images, color, split, screen, smooth, lowFilteredQuality) {
  const control = {hurried: false}, filter = useFilter(quality, width, height, split && !color.transform);
  if (split && !color.transform && splitRoute(width, height)) {
    const remote = !(typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) && !images && (yield {split: {pixels: width * height,
      run: (helpers, options) => encodeLowSplit(data, width, height, quality, effort, helpers, {...options, smooth, lowFilteredQuality})}});
    if (remote) return remote;
    const candidate = function* (q, budgets, gaborish = false, light = false) {
      let image;
      return yield* remembered(photoSplitCandidates(data, width, height, q, budgets,
        {gaborish: gaborish || light, light, screen, ...(images && {observe: value => { image = value; }})}), () => image, images);
    };
    if (lightPicture(effort, width, height, quality))
      return yield* retainedSteps(part(candidate(quality, fastBudgets(effort, false, width * height), false, true), 0, 1), null, control);
    if (alone(quality, effort, filter, smooth, Math.min(width, height) < 256)) {
      try { return yield* retainedSteps(part(candidate(lowFilteredQuality ?? filteredQuality(quality, smooth), filteredBudgets(effort), true), 0, 1), null, control); }
      catch (error) { if (!sizeFailure(error)) throw error; }
      return yield* retainedSteps(part(candidate(quality, fastBudgets(effort, filter, width * height)), 0, 1), null, control);
    }
    const stages = effort >= 3 && filter ? 2 : 1;
    const best = yield* retainedSteps(part(candidate(quality, fastBudgets(effort, filter, width * height)), 0, stages), null, control);
    if (stages === 1 || control.hurried) return best;
    return yield* retainedSteps(part(candidate(lowFilteredQuality ?? filteredQuality(quality), filteredBudgets(effort), true), 1, stages), best, control);
  }
  if (alone(quality, effort, filter, smooth, Math.min(width, height) < 256)) {
    try { const bytes = yield* filteredSteps(data, width, height, quality, effort, null, control, images, color, smooth, lowFilteredQuality); if (bytes) return bytes; }
    catch (error) { if (!sizeFailure(error)) throw error; }
  }
  let image;
  try { image = complete(photoXYBSteps(data, width, height, quality, {...v6For(width, height), fast: true, fastBand: !color.transform, ...color})); }
  catch (error) {
    if (error !== FAST_RANGE) throw error;
    image = complete(photoXYBSteps(data, width, height, quality, {...v6For(width, height), ...color}));
  }
  const stages = effort >= 3 && filter ? 2 : 1;
  const best = yield* retainedSteps(part(remembered(fastSmallSteps(image, effort, control, !filter), image, images), 0, stages), null, control);
  if (stages === 1 || control.hurried || alone(quality, effort, filter, smooth, Math.min(width, height) < 256)) return best;
  return yield* retainedSteps(part(filteredSteps(data, width, height, quality, effort, best, control, images, color, undefined, lowFilteredQuality), 1, stages), best, control);
}

function* filteredSteps(data, width, height, quality, effort, best, control, images, color, smooth, lowFilteredQuality) {
  const stages = effort >= 4 ? 3 : 2;
  const q = lowFilteredQuality ?? filteredQuality(quality, smooth);
  const image = yield* part(photoXYBBands(data, width, height, q, {...uploadPicture(data, width, height, q), ...color}), 0, stages);
  if (control.hurried) return best;
  best = choose(best, yield* part(remembered(coefficientAnsSteps(image, 3, best), image, images, best), 1, stages));
  if (effort >= 4 && !control.hurried) return yield* retainedSteps(part(remembered(coefficientAnsSteps(image, Math.min(effort, 5), best), image, images, best), 2, stages), best, control);
  return best;
}

export async function encodeLowSplit(data, width, height, quality, effort, helpers, options = {}) {
  options.signal?.throwIfAborted();
  const {smooth, lowFilteredQuality: predicted, ...rest} = options;
  const lowFilteredQuality = filteredPredictionFor(predicted, width, height);
  const filter = useFilter(quality, width, height);
  if (lightPicture(effort, width, height, quality)) {
    const bytes = await encodeSplitCandidates(data, width, height, quality, helpers, fastBudgets(effort, false, width * height),
      {...rest, gaborish: true, light: true, opaque: true});
    options.signal?.throwIfAborted();
    return bytes;
  }
  const gaborish = () => encodeSplitCandidates(data, width, height,
    lowFilteredQuality ?? filteredQuality(quality, smooth), helpers, filteredBudgets(effort), {...rest, gaborish: true, opaque: true});
  if (alone(quality, effort, filter, smooth, Math.min(width, height) < 256)) {
    try {
      const bytes = await gaborish();
      options.signal?.throwIfAborted();
      if (bytes !== null) return bytes;
    } catch (error) { options.signal?.throwIfAborted(); if (!sizeFailure(error)) throw error; }
  }
  let best = await encodeSplitCandidates(data, width, height, quality, helpers, fastBudgets(effort, filter, width * height),
    {...rest, gaborish: false, opaque: true});
  options.signal?.throwIfAborted();
  if (best === null || effort < 3 || !filter || alone(quality, effort, filter, smooth, Math.min(width, height) < 256)) return best;
  try {
    const bytes = await gaborish();
    options.signal?.throwIfAborted();
    if (bytes !== null) best = choose(best, bytes);
  } catch (error) { options.signal?.throwIfAborted(); if (!sizeFailure(error)) throw error; }
  return best;
}

export function makeLowUpload(data, width, height, quality, effort, smooth, lowFilteredQuality) {
  lowFilteredQuality = filteredPredictionFor(lowFilteredQuality, width, height);
  const filter = useFilter(quality, width, height);
  if (lightPicture(effort, width, height, quality)) {
    const split = photoSplitBands(data, width, height, quality, {gaborish: true, light: true});
    if (!splitHasAlpha(split)) return {split, incumbent: null, filtered: false, filter, light: true};
    splitEnd(split);
  }
  if (alone(quality, effort, filter, smooth, Math.min(width, height) < 256)) {
    try {
      const split = photoSplitBands(data, width, height, lowFilteredQuality ?? filteredQuality(quality, smooth), {gaborish: true});
      if (!splitHasAlpha(split)) return {split, incumbent: null, filtered: true};
      splitEnd(split);
    } catch (error) { if (!sizeFailure(error)) throw error; }
  }
  const split = photoSplitBands(data, width, height, quality);
  if (splitHasAlpha(split) || effort < 3 || !filter || alone(quality, effort, filter, smooth, Math.min(width, height) < 256)) return {split, incumbent: null, filtered: false, filter};
  const incumbent = complete(splitCandidates(split, SMALL_BUDGET));
  try { return {split: photoSplitBands(data, width, height, lowFilteredQuality ?? filteredQuality(quality), {gaborish: true}), incumbent, filtered: true}; }
  catch (error) { if (!sizeFailure(error)) throw error; return {split: null, incumbent, filtered: true}; }
}
export function* finishLowUpload(state, effort) {
  if (!state.split) return state.incumbent;
  const budgets = state.light ? fastBudgets(effort, false, state.split.width * state.split.height)
    : state.filtered ? filteredBudgets(effort) : fastBudgets(effort, state.filter, state.split.width * state.split.height);
  return yield* retainedSteps(splitCandidates(state.split, budgets), state.incumbent);
}
export function closeLowUpload(state) { if (state.split) splitEnd(state.split); }


export {useFilter as lowPhotoUsesFilter, fastBudgets as lowPhotoBudgets,
  filteredQuality as lowPhotoFilteredQuality, choose as chooseLowPhoto,
  sizeFailure as lowPhotoSizeFailure, SMALL_BUDGET as LOW_PHOTO_SMALL_BUDGET};
