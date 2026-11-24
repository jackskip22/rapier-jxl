// SPDX-License-Identifier: MIT
import {landsAtEffort} from './photo-quality-table.mjs';
import {complete, part} from './bits.mjs';
import {photoProducer} from './photo-job.mjs';
import {photoXYBSteps, preferXYB, FAST_RANGE} from './photo-xyb.mjs';
import {P3_TRANSFORM} from './color-transform.mjs';
import {photoXYBBands, photoXYBBand, PHOTO_BAND_MARGIN} from './photo-bands.mjs';
import {v6For, smallPicture, uploadPicture, uploadBandPicture, GABORISH} from './photo-v6-settings.mjs';
import {coefficientAnsSteps, BUDGETS} from './coefficient-ans.mjs';
import {candidateSteps} from './coefficient-effort.mjs';
import {photoSplitCandidates, photoSplitBands, splitCandidates, splitHasAlpha, splitEnd,
  splitRoute, encodeSplitCandidates, plainSampleSmaller} from './photo-split.mjs';
import {largePhoto} from './photo-low-settings.mjs';
import {SMALL_BUDGET, fastBudgets, plannedEffort, choose, sizeFailure, retainedSteps, fastSmallSteps} from './photo-low-ladder.mjs';

export function lowWholePhoto(data, width, height, {colorSpace = 'srgb', signal, smooth, v6 = false} = {}) {
  const color = {space: colorSpace, ...(colorSpace === 'display-p3' ? {transform: P3_TRANSFORM} : typeof colorSpace === 'object' && colorSpace.transform && {transform: colorSpace.transform})};
  let opaque = true;
  for (let at = 3; at < data.length; at += 4) if (data[at] !== 255) { opaque = false; break; }
  const lowOptions = {color, split: opaque && !color.transform, smooth, v6};
  const low = !color.transform && smallPicture(width, height) || preferXYB(data, width, height)
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
const useFilter = (quality, width, height, nativeOpaque = true, largeFiltered = false, landing = false) =>
  (landing && largeFiltered ? quality < 99.5 : quality < 95 && !(nativeOpaque && !largeFiltered && largePhoto(width, height))) && !smallPicture(width, height);
const alone = (quality, effort, filter, smooth, both, calibrated = false) => filter && !both && (calibrated || effort < 3 || quality >= 80 || smooth === false);
const filteredBudgets = (effort, pixels) => (effort = plannedEffort(effort, pixels)) >= 5 ? FAST_E5_BUDGETS : effort >= 4 ? LF3_BUDGET : [];
const splitBudgets = (effort, filter, quality, width, height) => {
  const budgets = fastBudgets(effort, filter, width * height);
  return !filter && quality < 95 && largePhoto(width, height) ? budgets.slice(0, 1) : budgets;
};

export const filteredQuality = (quality, smooth) => quality >= 85 || quality < 80 && smooth === false ? quality - 0.5 : quality;
const filteredPredictionFor = (quality, width, height) => Math.min(width, height) >= 256 ? quality : undefined;
function pictureChoice(data, width, height, quality, effort, filter, smooth, lowFilteredQuality, lowBoth, sample = true) {
  if (!filter) return 0;
  const small = Math.min(width, height) < 256;
  let both = small;
  if (lowBoth && effort >= 3 && !small) {
    both = true;
    if (sample && !(typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) && height >= 384) {
      try { both = plainSampleSmaller(data, width, height, quality, lowFilteredQuality ?? filteredQuality(quality, smooth)); }
      catch (error) { if (!sizeFailure(error)) throw error; }
    }
  }
  if (alone(quality, effort, filter, smooth, both, landsAtEffort(effort) && lowFilteredQuality !== undefined)) return 1;
  return effort >= 3 ? 2 : 0;
}

const gaborishQualities = (quality, smooth, lowFilteredQuality, other) => {
  const q = lowFilteredQuality ?? filteredQuality(quality, smooth);
  return other === undefined || other === q ? [q] : [q, other];
};

export function lowPhotoWindow(data, width, height, {quality, effort, smooth, lowFilteredQuality, colorSpace = 'srgb', uploadFlat: flat, grain}) {
  const p3 = colorSpace === 'display-p3', color = p3 ? {space: 'display-p3', transform: P3_TRANSFORM} : null;
  const picFor = q => flat !== undefined && grain !== undefined ? uploadBandPicture(flat, grain, q) : uploadPicture(data, width, height, q);
  if (p3) {
    const picture = picFor(quality);
    const opts = {...v6For(width, height), ...GABORISH, tune: picture.tune, calibrationRow: picture.calibrationRow, ...color};
    return {quality, filtered: false, image({pixels, width: w, height: h}) {
      return complete(photoXYBBands(pixels, w, h, quality, opts));
    }};
  }
  lowFilteredQuality = filteredPredictionFor(lowFilteredQuality, width, height);
  const filter = useFilter(quality, width, height, true, lowFilteredQuality !== undefined, landsAtEffort(effort));
  if (filter && !alone(quality, effort, filter, smooth, Math.min(width, height) < 256, landsAtEffort(effort) && lowFilteredQuality !== undefined)) return null;
  const q = filter ? lowFilteredQuality ?? filteredQuality(quality, smooth) : quality;
  const picture = filter ? picFor(q) : {...v6For(width, height), fast: true, fastBand: true};
  return {quality: q, filtered: filter, image({pixels, width: w, height: h}) {
    return complete(filter ? photoXYBBands(pixels, w, h, q, picture) : photoXYBSteps(pixels, w, h, q, picture));
  },
  band(from, to, scratch = false) {
    const options = scratch ? {...picture, bandScratch: true} : picture;
    if (!filter) return complete(photoXYBSteps(data.subarray(from * width * 4, to * width * 4), width, to - from, q, options));
    const top = Math.max(0, from - PHOTO_BAND_MARGIN), end = Math.min(height, to + PHOTO_BAND_MARGIN);
    return photoXYBBand(data.subarray(top * width * 4, end * width * 4), width, to - from, q, options, from - top);
  }};
}

export function* lowOtherPhotoSteps(data, width, height, {quality, filter, colorSpace = 'srgb', effort = 4, observe = null}) {
  const control = {hurried: false};
  const image = yield* retainedSteps(part(photoProducer(data, width, height, quality, colorSpace, filter), 0, 3), null, control);
  const bytes = yield* lowCoefficientSteps(image, effort, control);
  if (bytes) observe?.(image);
  return bytes;
}
export function* lowCoefficientSteps(image, effort, control = {hurried: false}) {
  if ((typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) || effort <= 3 || control.hurried) return yield* part(coefficientAnsSteps(image, control.hurried ? 1 : effort), 1, 2);
  let plan = null;
  const remember = (bytes, candidate) => { if (candidate.coding) plan = candidate; };
  const best = yield* retainedSteps(part(coefficientAnsSteps(image, 3, undefined, remember), 1, 3), null, control);
  if (!plan || control.hurried) return best;
  return yield* retainedSteps(part(candidateSteps(image, {...plan, clusters: BUDGETS[0]}, {}), 2, 3), best, control);
}

export function* lowPhotoPictureSteps(data, width, height, {quality, effort, observe = null, color = {}, split = true, screen, smooth, lowFilteredQuality, lowFilteredOther, lowBoth = false, v6 = false, chooseLfGroup}) {
  lowFilteredQuality = filteredPredictionFor(lowFilteredQuality, width, height);
  const images = observe ? new WeakMap() : null;
  const bytes = yield* pictureSteps(data, width, height, quality, effort, images, color, split, screen, smooth, lowFilteredQuality, v6,
    filteredPredictionFor(lowFilteredOther, width, height), lowBoth, chooseLfGroup);
  if (observe && bytes) observe(images.get(bytes));
  return bytes;
}

function* remembered(steps, image, images, incumbent = null) {
  const bytes = yield* steps;
  if (images && bytes && bytes !== incumbent) images.set(bytes, typeof image === 'function' ? image() : image);
  return bytes;
}

function* pictureSteps(data, width, height, quality, effort, images, color, split, screen, smooth, lowFilteredQuality, v6 = false, other = undefined, lowBoth = false, chooseLfGroup) {
  if (!(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && !(typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) && v6 && color.transform && !color.transform.gray && effort >= 4 && quality < 100 && !smallPicture(width, height)) {
    const picture = uploadPicture(data, width, height, quality);
    const image = yield* part(photoXYBBands(data, width, height, quality, {...v6For(width, height), ...GABORISH, tune: picture.tune, calibrationRow: picture.calibrationRow, ...color}), 0, 2);
    return yield* part(remembered(coefficientAnsSteps(image, effort), image, images), 1, 2);
  }
  const control = {hurried: false}, filter = useFilter(quality, width, height, split && !color.transform, lowFilteredQuality !== undefined, landsAtEffort(effort));
  if (!(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && !(typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) && v6 && color.transform && !color.transform.gray && effort >= 4 && quality < 100 && splitRoute(width, height)) {
    let image;
    try {
      return yield* remembered(photoSplitCandidates(data, width, height, quality, fastBudgets(effort, false, width * height),
        {color, screen: false, ...(images && {observe: value => { image = value; }})}), () => image, images);
    } catch (error) { if (error !== FAST_RANGE) throw error; }
  }
  if (split && !color.transform && splitRoute(width, height)) {
    const onePicture = chooseLfGroup && (!filter || (alone(quality, effort, filter, smooth, lowBoth || Math.min(width, height) < 256, landsAtEffort(effort) && lowFilteredQuality !== undefined) &&
      gaborishQualities(quality, smooth, lowFilteredQuality, other).length === 1));
    const lfGroup = onePicture ? chooseLfGroup() : undefined;
    const remote = !(typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) && !images && (yield {split: {pixels: width * height,
      run: (helpers, options) => encodeLowSplit(data, width, height, quality, effort, helpers, {...options, smooth, lowFilteredQuality, lowFilteredOther: other, lowBoth, lfGroup})}});
    if (remote) return remote;
    const mode = pictureChoice(data, width, height, quality, effort, filter, smooth, lowFilteredQuality, lowBoth);
    const candidate = function* (q, budgets, gaborish = false) {
      let image;
      return yield* remembered(photoSplitCandidates(data, width, height, q, budgets,
        {gaborish, screen, lfGroup, ...(images && {observe: value => { image = value; }})}), () => image, images);
    };
    if (mode === 1) {
      const qualities = gaborishQualities(quality, smooth, lowFilteredQuality, other);
      try {
        let best = null;
        for (const [i, q] of qualities.entries()) if (!best || !control.hurried)
          best = yield* retainedSteps(part(candidate(q, filteredBudgets(effort, width * height), true), i, qualities.length), best, control);
        return best;
      } catch (error) { if (!sizeFailure(error)) throw error; }
      return yield* retainedSteps(part(candidate(quality, splitBudgets(effort, filter, quality, width, height)), 0, 1), null, control);
    }
    const stages = mode === 2 ? 2 : 1;
    const best = yield* retainedSteps(part(candidate(quality, splitBudgets(effort, filter, quality, width, height)), 0, stages), null, control);
    if (stages === 1 || control.hurried) return best;
    return yield* retainedSteps(part(candidate(lowFilteredQuality ?? filteredQuality(quality), filteredBudgets(effort, width * height), true), 1, stages), best, control);
  }
  const mode = pictureChoice(data, width, height, quality, effort, filter, smooth, lowFilteredQuality, lowBoth, false);
  if (mode === 1) {
    const [first, second] = gaborishQualities(quality, smooth, lowFilteredQuality, other), n = second === undefined ? 1 : 2;
    try {
      let bytes = yield* part(filteredSteps(data, width, height, quality, effort, null, control, images, color, smooth, first), 0, n);
      if (bytes && n === 2 && !control.hurried)
        bytes = yield* retainedSteps(part(filteredSteps(data, width, height, quality, effort, bytes, control, images, color, smooth, second), 1, 2), bytes, control);
      if (bytes) return bytes;
    }
    catch (error) { if (!sizeFailure(error)) throw error; }
  }
  let image;
  try { image = complete(photoXYBSteps(data, width, height, quality, {...v6For(width, height), fast: true, fastBand: !color.transform, ...color})); }
  catch (error) {
    if (error !== FAST_RANGE) throw error;
    image = complete(photoXYBSteps(data, width, height, quality, {...v6For(width, height), ...color}));
  }
  const stages = mode === 2 ? 2 : 1;
  const best = yield* retainedSteps(part(remembered(fastSmallSteps(image, effort, control, !filter), image, images), 0, stages), null, control);
  if (stages === 1 || control.hurried || mode === 1) return best;
  return yield* retainedSteps(part(filteredSteps(data, width, height, quality, effort, best, control, images, color, undefined, lowFilteredQuality), 1, stages), best, control);
}

function* filteredSteps(data, width, height, quality, effort, best, control, images, color, smooth, lowFilteredQuality) {
  const stages = !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && effort >= 4 ? 3 : 2;
  const q = lowFilteredQuality ?? filteredQuality(quality, smooth);
  const image = yield* part(photoXYBBands(data, width, height, q, {...uploadPicture(data, width, height, q), ...color}), 0, stages);
  if (control.hurried) return best;
  best = choose(best, yield* part(remembered(coefficientAnsSteps(image, 3, best), image, images, best), 1, stages));
  if (!(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && effort >= 4 && !control.hurried) return yield* retainedSteps(part(remembered(coefficientAnsSteps(image, Math.min(effort, 5), best), image, images, best), 2, stages), best, control);
  return best;
}

export async function encodeLowSplit(data, width, height, quality, effort, helpers, options = {}) {
  options.signal?.throwIfAborted();
  const {smooth, lowFilteredQuality: predicted, lowFilteredOther, lowBoth, ...rest} = options;
  const lowFilteredQuality = filteredPredictionFor(predicted, width, height);
  const filter = useFilter(quality, width, height, true, lowFilteredQuality !== undefined, landsAtEffort(effort));
  const mode = pictureChoice(data, width, height, quality, effort, filter, smooth, lowFilteredQuality, lowBoth);
  const gaborish = (q = lowFilteredQuality ?? filteredQuality(quality, smooth)) => encodeSplitCandidates(data, width, height,
    q, helpers, filteredBudgets(effort, width * height), {...rest, gaborish: true, opaque: true});
  if (mode === 1) {
    const [first, second] = gaborishQualities(quality, smooth, lowFilteredQuality, filteredPredictionFor(lowFilteredOther, width, height));
    let best = null;
    try {
      best = await gaborish(first);
      options.signal?.throwIfAborted();
      if (best !== null && second !== undefined) {
        const bytes = await gaborish(second);
        options.signal?.throwIfAborted();
        if (bytes !== null) best = choose(best, bytes);
      }
    } catch (error) { options.signal?.throwIfAborted(); if (!sizeFailure(error)) throw error; }
    if (best !== null) return best;
  }
  let best = await encodeSplitCandidates(data, width, height, quality, helpers, splitBudgets(effort, filter, quality, width, height),
    {...rest, gaborish: false, opaque: true});
  options.signal?.throwIfAborted();
  if (best === null || mode < 2) return best;
  try {
    const bytes = await gaborish();
    options.signal?.throwIfAborted();
    if (bytes !== null) best = choose(best, bytes);
  } catch (error) { options.signal?.throwIfAborted(); if (!sizeFailure(error)) throw error; }
  return best;
}

export function makeLowUpload(data, width, height, quality, effort, smooth, lowFilteredQuality, lowFilteredOther, lowBoth = false) {
  lowFilteredQuality = filteredPredictionFor(lowFilteredQuality, width, height);
  const filter = useFilter(quality, width, height, true, lowFilteredQuality !== undefined, landsAtEffort(effort));
  const mode = pictureChoice(data, width, height, quality, effort, filter, smooth, lowFilteredQuality, lowBoth);
  if (mode === 1) {
    const [first, second] = gaborishQualities(quality, smooth, lowFilteredQuality, filteredPredictionFor(lowFilteredOther, width, height));
    let incumbent = null;
    try {
      const split = photoSplitBands(data, width, height, first, {gaborish: true});
      if (splitHasAlpha(split)) splitEnd(split);
      else if (second === undefined) return {split, incumbent: null, filtered: true};
      else {
        incumbent = complete(splitCandidates(split, filteredBudgets(effort, width * height)));
        return {split: photoSplitBands(data, width, height, second, {gaborish: true}), incumbent, filtered: true};
      }
    } catch (error) { if (!sizeFailure(error)) throw error; if (incumbent) return {split: null, incumbent, filtered: true}; }
  }
  const split = photoSplitBands(data, width, height, quality);
  if (splitHasAlpha(split) || mode < 2) return {split, incumbent: null, filtered: false, filter, quality, width, height};
  const incumbent = complete(splitCandidates(split, SMALL_BUDGET));
  try { return {split: photoSplitBands(data, width, height, lowFilteredQuality ?? filteredQuality(quality), {gaborish: true}), incumbent, filtered: true}; }
  catch (error) { if (!sizeFailure(error)) throw error; return {split: null, incumbent, filtered: true}; }
}
export function* finishLowUpload(state, effort) {
  if (!state.split) return state.incumbent;
  const budgets = state.filtered ? filteredBudgets(effort, state.split.width * state.split.height) : splitBudgets(effort, state.filter, state.quality, state.width, state.height);
  return yield* retainedSteps(splitCandidates(state.split, budgets), state.incumbent);
}
export function closeLowUpload(state) { if (state.split) splitEnd(state.split); }


export {useFilter as lowPhotoUsesFilter, fastBudgets as lowPhotoBudgets,
  filteredQuality as lowPhotoFilteredQuality, choose as chooseLowPhoto,
  sizeFailure as lowPhotoSizeFailure, SMALL_BUDGET as LOW_PHOTO_SMALL_BUDGET};
