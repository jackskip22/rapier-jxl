// SPDX-License-Identifier: MIT
import {encodeToScoreSteps} from '../score.mjs';
import {photoOutputMeasurements} from '../photo-output-policy.mjs';
import {drain, targetSource} from './common.mjs';
import {acceleration} from './acceleration.mjs';
import {lowWholePhoto} from '../photo-low.mjs';
import {smoothPhoto} from './low-photo.mjs';
import {wholeRebuildMeasure} from '../photo-whole-rebuild.mjs';
import {memoryPlan} from '../memory-plan.mjs';
import {explicitShownMargin} from '../photo-whole-policy.mjs';
import {measuredFileSearch} from './measured-search.mjs';
import {effortJob} from '../effort-job.mjs';
import {EXACT_LADDER} from '../exact-ladder.mjs';
import {PHOTO_LIMITS} from '../limits.mjs';
import {fail} from './primitives.mjs';
import {photoTarget} from '../photo-quality-search.mjs';

async function lowScoreTarget(data, width, height, effort, target, hooks) {
  if (width < 8 || height < 8) throw fail('JXL_INPUT', 'A score target needs at least 8 x 8 pixels.');
  let metric = null;
  const exact = onProgress => {
    metric?.destroy(); metric = null;
    return drain(effortJob(data, width, height, {quality: 100, effort}, false,
      PHOTO_LIMITS, undefined, undefined, EXACT_LADDER), {...hooks, onProgress});
  };
  if (target.ssimulacra2 === 100) return {bytes: await exact(hooks.onProgress), facts: {kept: 'pixels', measurements: []}};
  const producer = lowWholePhoto(data, width, height, {signal: hooks.signal, smooth: smoothPhoto(data, width, height)});
  const plan = memoryPlan(width * height, {width, height, inputBytes: data.buffer.byteLength});
  metric = wholeRebuildMeasure(data, width, height, producer.color, hooks.signal, plan);
  const probe = async (quality, onProgress) => {
    let picture;
    const bytes = await drain(producer.steps({quality, effort, observe: image => { picture = image; }}), {...hooks, onProgress});
    if (!picture) throw fail('JXL_INTERNAL', 'The low photo writer did not expose its selected image.');
    let scores = metric.measure(picture, {ssimulacra2: true, butteraugli: false});
    if (typeof scores?.next === 'function') scores = await drain(scores, {signal: hooks.signal});
    const margin = explicitShownMargin(scores.ssimulacra2, width, height);
    return {quality, bytes, scores: {ssimulacra2: scores.ssimulacra2 - margin}};
  };
  try {
    const found = await measuredFileSearch(target, probe, null, {...hooks, exact, width, height,
      domain: 'encoder-reconstruction'});
    return {bytes: found.bytes, facts: {kept: found.exact ? 'pixels' : 'lossy', measurements: found.measurements}};
  } finally { metric?.destroy(); }
}

export async function scoreTarget(data, width, height, source, settings, target, hooks, webgpu) {
  targetSource(data, source, settings);
  await acceleration(webgpu, 0, 0, settings.effort, 'a measured fidelity');
  target = photoTarget(target);
  if (settings.effort <= 5 && Object.keys(target).length === 1 && target.ssimulacra2 !== undefined)
    return lowScoreTarget(data, width, height, settings.effort, target, hooks);
  const answer = await drain(encodeToScoreSteps(data, width, height, {target, effort: settings.effort, signal: hooks.signal, preview: hooks.preview,
    shownBound: target.ssimulacra2 !== undefined}), hooks);
  return {bytes: answer.bytes, facts: answer.quality === 100 ? {kept: 'pixels', measurements: []}
    : {kept: 'lossy', measurements: photoOutputMeasurements(target, answer, 'encoder-reconstruction')}};
}
