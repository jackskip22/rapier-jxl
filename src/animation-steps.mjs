// SPDX-License-Identifier: MIT
import {guard} from './admit.mjs';
import {complete, part} from './bits.mjs';
import {checkSignal} from './async-job.mjs';
import {admitAnimation, animationSteps} from './animation-frames.mjs';
import {photoXYBSteps} from './photo-xyb.mjs';
import {coefficientAnsSteps, estimateBytes} from './coefficient-ans.mjs';
import {V6, GABORISH, blockSearchOptions} from './photo-v6.mjs';
import {SMALL_V6, smallPicture} from './photo-v6-settings.mjs';
import {E7_SCALE} from './photo-v6-blocks.mjs';
import {perceptualMaskField} from './aq.mjs';
import {xybStrategies, encodeStrategyImageSteps} from './varblocks.mjs';
import {screenLike} from './screen-samples.mjs';
import {captureFillClear} from './capture-kernels.mjs';
import {shown as markShown} from './photo-shown.mjs';

function* xybAnimationFrameSteps(a, crop, w, h, floor, measuredSearch) {
  const pixels = floor.alpha ? captureFillClear(crop, w, h) : crop;
  const small = a.small ?? smallPicture(w, h);
  const probeFast = a.probe && a.effort >= 6;
  const ansEffort = probeFast ? 2 : Math.min(a.effort, 7);
  if (a.filter === 'off' || small || a.effort <= 5 || floor.alpha || probeFast || w < 128 || h < 128 || screenLike(pixels, w, h)) {
    const img = yield* part(photoXYBSteps(pixels, w, h, a.quality, {...(small ? SMALL_V6 : V6), filter: a.filter, fast: true}), 0, 2);
    img.alpha = floor.alpha ? crop : null;
    return markShown(yield* part(coefficientAnsSteps(img, ansEffort), 1, 2), img);
  }
  const sharpDct = complete(photoXYBSteps(pixels, w, h, a.quality, {...V6, filter: a.filter, fast: true}));
  const base = complete(photoXYBSteps(pixels, w, h, a.quality, {...V6, ...GABORISH, lowScale: E7_SCALE, keepPlanes: true}));
  const stride = Math.ceil(w / 8), rows = Math.ceil(h / 8);
  const weight = perceptualMaskField(base.planes, stride, rows).weight;
  const searchOpts = {...blockSearchOptions(pixels, w, h, V6.deadzone), ids: [4, 5, 6, 7], lowScale: E7_SCALE, maskWeight: weight, priceOnly: true, keepChosen: true};
  const varImage = xybStrategies(base, w, h, searchOpts).image;
  const primed = {};
  const blocksWin = estimateBytes(varImage, primed) < estimateBytes(sharpDct) * 0.97;
  const chosenImage = blocksWin ? varImage : sharpDct;
  let bytes = blocksWin
    ? yield* part(encodeStrategyImageSteps(varImage, ansEffort >= 7, ansEffort, false, a.effort >= 8 ? null : primed, a.effort >= 7), 0, 1)
    : yield* part(coefficientAnsSteps(sharpDct, ansEffort), 0, 1);
  bytes = markShown(bytes, chosenImage);
  return bytes;
}

export function encodeAnimationJob(animation, options = {}, captures = false) {
  const admitted = admitAnimation(animation, {...options, xybSteps: xybAnimationFrameSteps});
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
