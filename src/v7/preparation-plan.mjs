// SPDX-License-Identifier: MIT
import {createPhotoPlanSteps} from '../photo-plan.mjs';
import {admitSampleFormat} from '../admit-samples.mjs';
import {drain} from './common.mjs';
import {check, isCaller} from './primitives.mjs';

export function retainedFit(picture, policy) {
  const features = policy.encode.features;
  if (!features || Object.keys(features).length !== 1 || !Object.hasOwn(features, 'transforms') ||
      features.transforms === undefined || features.transforms === 'auto' || policy.search.maxQuality >= 100 ||
      picture.icc !== undefined || picture.extraChannels !== undefined || !admitSampleFormat(picture.data, picture).native8) return null;
  let plan, attempted = false;
  return {
    async probe(quality, hooks) {
      const started = !attempted;
      if (started) {
        attempted = true;
        try {
          const {data, width, height, ...description} = picture;
          plan = await drain(createPhotoPlanSteps(data, width, height, {...description, ...features,
            quality: policy.search.maxQuality, effort: policy.encode.effort ?? 7}),
          {...hooks, onProgress: fraction => hooks.onProgress?.(fraction / 4)});
        } catch (error) {
          check(hooks.signal);
          if (isCaller(error) || error?.code !== 'JXL_MEMORY') throw error;
        }
      }
      if (!plan) return null;
      return drain(plan.encodeSteps(quality), {...hooks,
        onProgress: fraction => hooks.onProgress?.(started ? .25 + fraction * .75 : fraction)});
    },
    dispose() { plan?.dispose(); plan = null; },
  };
}
