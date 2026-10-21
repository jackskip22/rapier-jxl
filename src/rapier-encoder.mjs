// SPDX-License-Identifier: MIT
import {createStillEncoder} from './rapier-still.mjs';
import {encodeAnimationSteps} from './animation.mjs';
import {encodeAnimationPool, serveAnimationPool} from './animation-pool.mjs';
import {finishEncoding, checkSignal} from './async-job.mjs';

const ANIMATION_POOL_PIXELS = 1000000;

export function createJPEGXLEncoder(options = {}) {
  const still = createStillEncoder(options), {spawn, workers} = still.pool;
  return {
    ...still,
    async animation(animation, options) {
      checkSignal(options.signal);
      const pixels = (animation?.frames?.length || 0) * animation?.width * animation?.height;
      const pooled = options.parallel !== false && workers > 0 && animation?.frames?.length > 1 && pixels >= ANIMATION_POOL_PIXELS;
      const job = pooled ? encodeAnimationPool(animation, options, {spawn, workers}) : encodeAnimationSteps(animation, options);
      return finishEncoding(job, options);
    },
    serve: (message, report) => message.pool === 'animation' ? serveAnimationPool(message) : still.serve(message, report),
  };
}
