// SPDX-License-Identifier: MIT
import {guard} from './admit.mjs';
import {complete, part} from './bits.mjs';
import {checkSignal} from './async-job.mjs';
import {admitAnimation, animationSteps} from './animation-frames.mjs';
import {photoXYBSteps} from './photo-xyb.mjs';
import {rebuildPicture} from './photo-rebuild.mjs';
import {coefficientAnsSteps, estimateBytes} from './coefficient-ans.mjs';
import {V6, GABORISH, blockSearchOptions} from './photo-v6.mjs';
import {SMALL_V6, smallPicture} from './photo-v6-settings.mjs';
import {E7_SCALE} from './photo-v6-blocks.mjs';
import {perceptualMaskField} from './aq.mjs';
import {xybStrategies, encodeStrategyImageSteps} from './varblocks.mjs';
import {screenLike} from './screen-samples.mjs';
import {captureFillClear} from './capture-kernels.mjs';
import {shown as markShown} from './photo-shown.mjs';

const ADDITIVE_PLANS = new WeakMap();
const xybFrameRebuild = image => rebuildPicture(image, {rgba: false, xyb: true}).xyb;
const xybTargetPlanes = (rgba, w, h, quality) => complete(photoXYBSteps(rgba, w, h, quality, {...V6, planesOnly: true})).planes;

function* monotoneDctAnsSteps(image, effort) {
  if (effort <= 1) return yield* part(coefficientAnsSteps(image, 1), 0, 1);
  if (effort <= 3) {
    const fast = yield* part(coefficientAnsSteps(image, effort), 0, 1);
    if (fast.length <= 16384) {
      const floor1 = yield* part(coefficientAnsSteps(image, 1), 0, 1);
      if (floor1.length < fast.length) return floor1;
    }
    return fast;
  }
  let floor = yield* part(coefficientAnsSteps(image, 3), 0, 1);
  if (floor.length <= 16384) {
    const floor1 = yield* part(coefficientAnsSteps(image, 1), 0, 1);
    if (floor1.length < floor.length) floor = floor1;
  }
  return yield* part(coefficientAnsSteps(image, effort, floor), 0, 1);
}

const unfiltered = image => { image.epf = 0; image.gab = null; image.adaptiveLFSmoothing = false; return image; };

function* blocksOrDct(a, pixels, w, h, sharpDct, base, weight, ansEffort, residual) {
  const searchOpts = {...blockSearchOptions(pixels, w, h, V6.deadzone), ids: [4, 5, 6, 7], lowScale: E7_SCALE, maskWeight: weight, priceOnly: true, keepChosen: true};
  const varImage = xybStrategies(base, w, h, searchOpts).image;
  if (residual) unfiltered(varImage);
  const primed = {};
  const blocksWin = estimateBytes(varImage, primed) < estimateBytes(sharpDct) * 0.97;
  if (a.effort < 8) {
    const bytes = blocksWin
      ? yield* part(encodeStrategyImageSteps(varImage, ansEffort >= 7, ansEffort, false, primed, a.effort >= 7), 0, 1)
      : yield* part(coefficientAnsSteps(sharpDct, ansEffort), 0, 1);
    return markShown(bytes, blocksWin ? varImage : sharpDct);
  }
  if (blocksWin) {
    const varBytes = yield* part(encodeStrategyImageSteps(varImage, ansEffort >= 7, ansEffort, false, null, true), 0, 1);
    const dctFloor = yield* monotoneDctAnsSteps(sharpDct, 5);
    return varBytes.length < dctFloor.length ? markShown(varBytes, varImage) : markShown(dctFloor, sharpDct);
  }
  return markShown(yield* monotoneDctAnsSteps(sharpDct, ansEffort), sharpDct);
}

function* xybAnimationFrameSteps(a, crop, w, h, floor, measuredSearch) {
  const additive = ADDITIVE_PLANS.get(crop);
  const pixels = floor.alpha ? captureFillClear(crop, w, h) : crop;
  const small = a.small ?? smallPicture(w, h);
  const probeFast = a.probe && a.effort >= 6;
  const ansEffort = probeFast ? 2 : Math.min(a.effort, 7);
  let plain = null;
  if (additive) {
    const residual = {filter: 'off', gaborish: null, pre: additive.deltaPlanes};
    let sharpDct = unfiltered(complete(photoXYBSteps(pixels, w, h, a.quality, {...(small ? SMALL_V6 : V6), ...residual, calibrationRow: true})));
    if (additive.checkPlain) plain = complete(photoXYBSteps(pixels, w, h, a.quality, {...(small ? SMALL_V6 : V6), filter: a.filter, fast: true}));
    additive.usedAdditive = !plain || estimateBytes(plain) > estimateBytes(sharpDct) + additive.dictBytes;
    if (additive.usedAdditive) {
      plain = null;
      if (a.filter === 'off' || small || a.effort <= 5 || probeFast || w < 128 || h < 128)
        return markShown(yield* monotoneDctAnsSteps(sharpDct, ansEffort), sharpDct);
      const base = unfiltered(complete(photoXYBSteps(pixels, w, h, a.quality, {...V6, ...residual, lowScale: E7_SCALE, keepPlanes: true})));
      return yield* blocksOrDct(a, pixels, w, h, sharpDct, base, additive.maskWeight, ansEffort, true);
    }
    additive.deltaPlanes = residual.pre = sharpDct = null;
  }
  if (a.filter === 'off' || small || a.effort <= 5 || floor.alpha || probeFast || w < 128 || h < 128 || screenLike(pixels, w, h)) {
    const img = plain ?? (yield* part(photoXYBSteps(pixels, w, h, a.quality, {...(small ? SMALL_V6 : V6), filter: a.filter, fast: true}), 0, 2));
    img.alpha = floor.alpha ? crop : null;
    if (!floor.alpha && a.effort >= 8) return markShown(yield* part(monotoneDctAnsSteps(img, ansEffort), 1, 2), img);
    return markShown(yield* part(coefficientAnsSteps(img, ansEffort), 1, 2), img);
  }
  const sharpDct = plain ?? complete(photoXYBSteps(pixels, w, h, a.quality, {...V6, filter: a.filter, fast: true}));
  const base = complete(photoXYBSteps(pixels, w, h, a.quality, {...V6, ...GABORISH, lowScale: E7_SCALE, keepPlanes: true}));
  return yield* blocksOrDct(a, pixels, w, h, sharpDct, base, perceptualMaskField(base.planes, Math.ceil(w / 8), Math.ceil(h / 8)).weight, ansEffort, false);
}

export function encodeAnimationJob(animation, options = {}, captures = false) {
  const admitted = admitAnimation(animation, {
    ...options,
    xybSteps: xybAnimationFrameSteps,
    xybRebuild: xybFrameRebuild,
    xybTargetPlanes,
    additivePlans: ADDITIVE_PLANS,
  });
  const it = (function* () {
    const steps = animationSteps(admitted);
    let step, last, reply;
    try { while (!(step = guard(() => steps.next(reply ?? it.hurry))).done) {
      checkSignal(admitted.signal);
      if (typeof step.value === 'number') { reply = undefined; yield last = step.value; } else reply = captures ? yield step.value : undefined;
    } } finally { if (!step?.done) steps.return?.(); }
    if (last < 1) yield 1;
    return it.bytes = step.value;
  })();
  it.bytes = null; it.hurry = false;
  return it;
}
