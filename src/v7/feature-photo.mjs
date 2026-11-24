// SPDX-License-Identifier: MIT
import {encodePhotoSteps} from '../photo-advanced.mjs';
import {withProgressive} from '../coefficient-ans.mjs';
import {pictureMeasure, preparePictureMeasure} from '../photo-picture-measure.mjs';
import {rebuildShown, rebuildable, rebuildableUpsampled} from '../photo-rebuild.mjs';
import {upsampleOn} from '../upsample-plane.mjs';
import {askedLook} from '../photo-quality-table.mjs';
import {measuredTarget, djxlResidual} from '../photo-browser-margin.mjs';
import {measuredFileSearch, withAnnounced} from './measured-search.mjs';
import {photoOutputMeasurements} from '../photo-output-policy.mjs';
import {drain} from './common.mjs';
import {check} from './primitives.mjs';
import {MEASURED_EFFORT} from '../effort-level.mjs';

const MEASURED = new Set(['transforms', 'quantization', 'upsampling', 'upsamplingWeights', 'progressive', 'noise']);

export async function measuredFeatures(picture, features, settings, qualityIntent, hooks, coded = picture.data) {
  const {width, height} = picture, {qualityIntent: _intent, ...coding} = settings;
  if (settings.effort < MEASURED_EFFORT || qualityIntent === undefined || width < 8 || height < 8 || picture.orientation !== undefined ||
      picture.extraChannels !== undefined || !features || !Object.keys(features).length || Object.keys(features).some(key => !MEASURED.has(key)))
    return null;
  check(hooks.signal);
  await preparePictureMeasure(); check(hooks.signal);
  const samples = picture.data.subarray(0, picture.data.length);
  const metric = pictureMeasure({...picture, data: samples}, {signal: hooks.signal, maxPixels: hooks.maxPixels});
  if (!metric) return null;
  const {noise} = features;
  const probe = async (quality, onProgress, effort = coding.effort) => {
    const seen = new Map();
    const rawSteps = encodePhotoSteps(coded, width, height, {...coding, ...features, quality, effort});
    const steps = coding.progressive && !features.progressive ? withProgressive(true, rawSteps, effort) : rawSteps;
    const bytes = await withAnnounced(() => drain(steps, {...hooks, onProgress}),
      (file, image) => { seen.set(file, image); });
    const announced = seen.get(bytes), image = announced?.noiseLut ? {...announced, noiseLut: null} : announced;
    const made = image && (rebuildable(image) || rebuildableUpsampled(image)) ? rebuildShown(image, {upsample: upsampleOn}) : null;
    const shown = made ? {width, height, rgba: made.rgba, native: made.native()} : null;
    return {quality, bytes, shown};
  };
  try {
    const look = measuredTarget(askedLook(qualityIntent));
    const target = {ssimulacra2: look + djxlResidual(look, width * height)};
    let answer = await measuredFileSearch(target, probe, metric.measure,
      {start: coding.quality, signal: hooks.signal, onProgress: hooks.onProgress, closest: true, preview: hooks.preview, width, height});
    if (noise) return answer.exact || !answer.bytes ? answer : {...answer, measurements: answer.measurements.map(m => ({...m, view: 'without-noise'}))};
    if (!(features.upsampling > 1)) return answer;
    check(hooks.signal);
    const floor = target.ssimulacra2, top = answer.measurements[0]?.score;
    if (!answer.exact && answer.bytes && !(top >= floor)) {
      const reachable = await measuredFileSearch({ssimulacra2: top - 0.1}, probe, metric.measure,
        {start: coding.quality, signal: hooks.signal, onProgress: hooks.onProgress, closest: true, preview: hooks.preview, width, height});
      if (reachable.bytes && reachable.bytes.length < answer.bytes.length)
        answer = {...reachable, measurements: photoOutputMeasurements(target, {ssimulacra2: reachable.measurements[0].score}, 'decoded-output')};
      check(hooks.signal);
    }
    const lower = await probe(coding.quality, undefined, 5);
    if (!lower.shown) return answer;
    const score = metric.measure(lower.shown, {ssimulacra2: true, exact: true}).ssimulacra2;
    const closest = answer.measurements[0]?.score, reached = closest >= floor;
    return lower.bytes.length <= answer.bytes.length && (score >= floor || !reached && score >= closest)
      ? {bytes: lower.bytes, quality: coding.quality, exact: false, measurements: photoOutputMeasurements(target, {ssimulacra2: score}, 'decoded-output')}
      : answer;
  } finally { metric.destroy(); }
}
