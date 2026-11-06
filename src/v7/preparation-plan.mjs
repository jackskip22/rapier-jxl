// SPDX-License-Identifier: MIT
import {createPhotoPlanSteps} from '../photo-plan.mjs';
import {admitSampleFormat} from '../admit-samples.mjs';
import {drain} from './common.mjs';
import {check, isCaller} from './primitives.mjs';
import {encodeFidelity} from './fidelity.mjs';
import {ordinaryStillReader} from './ordinary-still-policy.mjs';

export function retainedFit(picture, policy) {
  const features = policy.encode.features;
  if (!features || Object.keys(features).length !== 1 || !Object.hasOwn(features, 'transforms') ||
      features.transforms === undefined || features.transforms === 'auto' || policy.search.maxQuality >= 100 ||
      picture.icc !== undefined || picture.extraChannels !== undefined || !admitSampleFormat(picture.data, picture).native8) return null;
  const effort = policy.encode.effort ?? 7;
  let plan, attempted = false;
  const reader = ordinaryStillReader({signal: policy.encode.signal, maxPixels: policy.encode.maxPixels});
  const codingQuality = quality => reader.read(encodeFidelity({quality}), picture, {exactAllowed: false}).quality;
  return {
    async probe(quality, hooks) {
      const started = !attempted;
      if (started) {
        attempted = true;
        try {
          const {data, width, height, ...description} = picture;
          plan = await drain(createPhotoPlanSteps(data, width, height, {...description, ...features,
            quality: codingQuality(policy.search.maxQuality), effort}),
          {...hooks, onProgress: fraction => hooks.onProgress?.(fraction / 4)});
        } catch (error) {
          check(hooks.signal);
          if (isCaller(error) || error?.code !== 'JXL_MEMORY') throw error;
        }
      }
      if (!plan) return null;
      const onProgress = fraction => hooks.onProgress?.(started ? .25 + fraction * .75 : fraction);
      return {bytes: await drain(plan.encodeSteps(codingQuality(quality)), {...hooks, onProgress})};
    },
    dispose() { try { plan?.dispose(); } finally { plan = null; reader.destroy(); } },
  };
}
