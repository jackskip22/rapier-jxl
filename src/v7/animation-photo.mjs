// SPDX-License-Identifier: MIT
import {admitAnimation} from '../animation-frames.mjs';
import {displayedAnimationFrames} from '../animation-timeline.mjs';
import {photoIntentReader} from '../photo-intent.mjs';
import {ordinaryStillDecision} from './ordinary-still-policy.mjs';
import {described} from './describe.mjs';
import {check} from './primitives.mjs';
import {measuredAnimation} from './animation-search.mjs';
import {webpTarget} from '../photo-quality-table.mjs';
import {measuredTarget} from '../photo-browser-margin.mjs';
import {MEASURED_EFFORT} from '../effort-level.mjs';

export async function animationPhoto(animation, settings, encodeAt, {signal, maxPixels, onProgress, preview} = {}) {
  const {qualityIntent, ...codec} = settings;
  const encode = (quality, progress = onProgress, probe = false) => encodeAt({...codec, quality, ...(probe && {probe})}, progress);
  const fixed = async quality => {
    const bytes = await encode(quality); check(signal);
    return {bytes, quality, exact: quality === 100, measurements: []};
  };
  check(signal);
  if (qualityIntent === undefined) return fixed(codec.quality);
  admitAnimation(animation, codec);
  if (codec.effort >= MEASURED_EFFORT && animation.width >= 8 && animation.height >= 8) {
    const answer = await measuredAnimation(animation, {ssimulacra2: measuredTarget(webpTarget(qualityIntent))}, encode,
      {start: codec.quality, signal, onProgress, maxPixels, preview});
    if (answer) return answer;
  }
  const reader = photoIntentReader(ordinaryStillDecision, {signal, maxPixels});
  let quality = 1;
  try {
    const description = described(animation), {width, height} = animation;
    for (const frame of displayedAnimationFrames(animation)) {
      check(signal);
      const picture = {...description, data: frame.data, width, height};
      const decision = reader.read(settings, picture) ?? await reader.project(picture);
      quality = Math.max(quality, decision.quality);
    }
  } finally { reader.destroy(); }
  return fixed(quality);
}
