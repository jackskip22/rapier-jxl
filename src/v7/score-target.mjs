// SPDX-License-Identifier: MIT
import {encodeToScoreSteps} from '../score.mjs';
import {photoOutputMeasurements} from '../photo-output-policy.mjs';
import {drain, targetSource} from './common.mjs';
import {acceleration} from './acceleration.mjs';

export async function scoreTarget(data, width, height, source, settings, target, hooks, webgpu) {
  targetSource(data, source, settings);
  await acceleration(webgpu, 0, 0, settings.effort, 'a measured fidelity');
  const answer = await drain(encodeToScoreSteps(data, width, height, {target, effort: settings.effort, signal: hooks.signal, preview: hooks.preview}), hooks);
  return {bytes: answer.bytes, facts: answer.quality === 100 ? {kept: 'pixels', measurements: []}
    : {kept: 'lossy', measurements: photoOutputMeasurements(target, answer, 'encoder-reconstruction')}};
}
