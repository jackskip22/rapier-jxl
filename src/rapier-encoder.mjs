// SPDX-License-Identifier: MIT
// JPEG XL worker adapter. Complete the requested search before returning the smallest result.
import {configureKernels} from './kernels.mjs';
import {encodeSteps} from './effort.mjs';
import {encodePool, servePool} from './pool.mjs';
import {transcode} from './jpeg.mjs';
import {encodePhoto} from './photo.mjs';
import {inspectPixels} from './lossless.mjs';

const POOL_GROUPS = 40;

export function createJPEGXLEncoder({spawn} = {}) {
  if (spawn !== undefined && typeof spawn !== 'function') throw new TypeError('spawn must create a worker.');
  const available = spawn || typeof Worker === 'function' && typeof location === 'object' && location?.href;
  const workers = available ? Math.min(4, (globalThis.navigator?.hardwareConcurrency || 1) - 1) : 0;
  const spawnWorker = spawn || (() => new Worker(location.href));
  configureKernels('auto');
  return {
    async encode(data, width, height, options) {
      const {quality, photo} = options;
      if (photo && quality < 100 && (data instanceof Uint8Array || data instanceof Uint8ClampedArray) && !inspectPixels(data, width, height).palette)
        return encodePhoto(data, width, height, options);
      const pooled = workers > 1 && quality >= 100 && Math.ceil(width / 256) * Math.ceil(height / 256) >= POOL_GROUPS;
      const job = pooled ? encodePool(data, width, height, options, {spawn: spawnWorker, workers}) : encodeSteps(data, width, height, options);
      // Each step reports how far the work is, from 0 to 1; a caller that asks (options.progress) is told.
      for (let step; !(step = await job.next()).done;) if (typeof options.progress === 'function') options.progress(step.value);
      return job.bytes;
    },
    transcode: jpeg => transcode(jpeg, {effort: 9}),
    serve: servePool,
  };
}
