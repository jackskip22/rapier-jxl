// SPDX-License-Identifier: MIT
import {encodePhotoSteps} from '../photo-advanced.mjs';
import {pictureMeasure, preparePictureMeasure} from '../photo-picture-measure.mjs';
import {rebuildPicture, rebuildable} from '../photo-rebuild.mjs';
import {webpTarget} from '../photo-quality-table.mjs';
import {measuredTarget} from '../photo-browser-margin.mjs';
import {measuredFileSearch, withAnnounced} from './measured-search.mjs';
import {drain} from './common.mjs';
import {check} from './primitives.mjs';
import {MEASURED_EFFORT} from '../effort-level.mjs';

const MEASURED = new Set(['transforms', 'quantization']);

export async function measuredFeatures(picture, features, settings, qualityIntent, hooks) {
  const {data, width, height} = picture, {qualityIntent: _intent, ...coding} = settings;
  if (settings.effort < MEASURED_EFFORT || qualityIntent === undefined || width < 8 || height < 8 || picture.orientation !== undefined ||
      picture.extraChannels !== undefined || !features || !Object.keys(features).length || Object.keys(features).some(key => !MEASURED.has(key)))
    return null;
  check(hooks.signal);
  await preparePictureMeasure(); check(hooks.signal);
  const metric = pictureMeasure(picture, {signal: hooks.signal, maxPixels: hooks.maxPixels});
  if (!metric) return null;
  const probe = async (quality, onProgress) => {
    let last = null;
    const bytes = await withAnnounced(() => drain(encodePhotoSteps(data, width, height, {...coding, ...features, quality}), {...hooks, onProgress}),
      (file, image) => { last = [file, image]; });
    const shown = last?.[0] === bytes && rebuildable(last[1]) ? {width, height, rgba: rebuildPicture(last[1]).rgba} : null;
    return {quality, bytes, shown};
  };
  try {
    return await measuredFileSearch({ssimulacra2: measuredTarget(webpTarget(qualityIntent))}, probe, metric.measure,
      {start: coding.quality, signal: hooks.signal, onProgress: hooks.onProgress, closest: true, preview: hooks.preview, width, height});
  } finally { metric.destroy(); }
}
