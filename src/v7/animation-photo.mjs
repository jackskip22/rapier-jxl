// SPDX-License-Identifier: MIT
import {admitAnimation, ANIMATION_OBSERVER, exactFiles} from '../animation-frames.mjs';
import {displayedAnimationFrames} from '../animation-timeline.mjs';
import {ordinaryStillReader} from './ordinary-still-policy.mjs';
import {described} from './describe.mjs';
import {check} from './primitives.mjs';
import {measuredAnimation} from './animation-search.mjs';
import {askedLook} from '../photo-quality-table.mjs';
import {measuredTarget, djxlResidual} from '../photo-browser-margin.mjs';
import {MEASURED_EFFORT} from '../effort-level.mjs';
import {pagePicture, pageWithoutPhotograph} from './page-route.mjs';
import {screenPhotoRegions} from '../screen-photo-regions.mjs';
import {unchangedShare} from '../animation-diff.mjs';

const SCENE_KEPT = 0.5;
function pageScene(frames, {width, height, colorSpace}, codec) {
  const settings = {...codec, quality: Math.min(codec.quality, 99), colorSpace};
  return frames.some(({data}, k) => (k === 0 || unchangedShare(frames[k - 1].data, data, width, [0, 0, width, height]) < SCENE_KEPT &&
    pageWithoutPhotograph(data, width, height)) && pagePicture(data, width, height, settings) && !screenPhotoRegions(data, width, height).length);
}

export async function animationPhoto(animation, settings, encodeAt, {signal, maxPixels, onProgress, preview} = {}) {
  const {qualityIntent, ...codec} = settings;
  const encode = (quality, progress = onProgress, probe = false, prepare) => encodeAt({...codec, quality,
    ...(probe && {probe}), ...(prepare && {[ANIMATION_OBSERVER]: prepare})}, progress);
  const fixed = async quality => {
    const bytes = await encode(quality); check(signal);
    return {bytes, quality, exact: quality === 100 || exactFiles.has(bytes), measurements: []};
  };
  check(signal);
  if (qualityIntent === undefined) return fixed(codec.quality);
  admitAnimation(animation, codec);
  if (pageScene(displayedAnimationFrames(animation), animation, codec)) return fixed(100);
  if (codec.effort >= MEASURED_EFFORT && animation.width >= 8 && animation.height >= 8) {
    const target = measuredTarget(askedLook(qualityIntent));
    const answer = await measuredAnimation(animation, {ssimulacra2: target + djxlResidual(target, animation.width * animation.height)}, encode,
      {start: codec.quality, signal, onProgress, maxPixels, preview});
    if (answer) return answer;
  }
  const reader = ordinaryStillReader({signal, maxPixels, filteredStill: false});
  let quality = 1;
  try {
    const description = described(animation), {width, height} = animation;
    for (const frame of displayedAnimationFrames(animation)) {
      check(signal);
      const picture = {...description, data: frame.data, width, height};
      const decision = reader.read(settings, picture) ?? await reader.project(settings, picture);
      quality = Math.max(quality, decision.quality);
    }
  } finally { reader.destroy(); }
  return fixed(quality);
}
