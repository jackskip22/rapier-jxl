// SPDX-License-Identifier: MIT
import {photoAnimationMeasure, composeTimeline} from '../photo-animation-measure.mjs';
import {preparePictureMeasure} from '../photo-picture-measure.mjs';
import {watchShown} from '../photo-shown.mjs';
import {rebuildPicture, rebuildable} from '../photo-rebuild.mjs';
import {check, fail} from './primitives.mjs';
import {measuredFileSearch} from './measured-search.mjs';

export async function measuredAnimation(animation, target, encodeAt, {start = 90, probes = 8, signal, onProgress, maxPixels, preview} = {}) {
  check(signal);
  await preparePictureMeasure(); check(signal);
  const metric = photoAnimationMeasure(animation, {signal, maxPixels});
  if (!metric) return null;
  const probe = async (quality, progress) => {
    const pictures = new Map(), timelines = new Map();
    const stop = watchShown((bytes, picture) => {
      if (picture.timeline) timelines.set(bytes, picture.timeline);
      else if (rebuildable(picture)) pictures.set(bytes, rebuildPicture(picture).rgba);
    });
    let bytes;
    try { bytes = await encodeAt(quality, progress, true); } finally { stop(); }
    check(signal);
    if (!(bytes instanceof Uint8Array)) throw fail('JXL_INTERNAL', 'An animation producer must return complete bytes.');
    const timeline = timelines.get(bytes);
    return {quality, bytes, shown: timeline ? composeTimeline(timeline, pictures) : null};
  };
  try {
    return await measuredFileSearch(target, probe, metric.measure, {start, probes, signal, onProgress,
      exact: progress => encodeAt(100, progress), preview, width: animation.width, height: animation.height});
  } finally { metric.destroy(); }
}
