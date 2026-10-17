// SPDX-License-Identifier: MIT
import {configureKernels} from './kernels.mjs';
import {encodeSteps} from './effort.mjs';
import {encodePool, servePool} from './pool.mjs';
import {transcodeSteps, reconstructJPEG} from './jpeg-ans.mjs';
import {encodePhotoSteps} from './photo.mjs';
import {inspectPixels} from './lossless.mjs';

const POOL_GROUPS = 40;
const PAINTING_POOL_GROUPS = 32;

export function createJPEGXLEncoder({spawn} = {}) {
  if (spawn !== undefined && typeof spawn !== 'function') throw new TypeError('spawn must create a worker.');
  const available = spawn || typeof Worker === 'function' && typeof location === 'object' && location?.href;
  const workers = available ? Math.max(0, Math.min(3, (globalThis.navigator?.hardwareConcurrency || 1) - 1)) : 0;
  const spawnWorker = spawn || (() => new Worker(location.href));
  configureKernels('auto');
  const complete = async (job, progress) => {
    for await (const step of job) if (typeof progress === 'function') progress(step);
    return job.bytes;
  };
  return {
    async encode(data, width, height, options) {
      const {quality, photo} = options;
      if (options.losslessProfile === undefined && photo && quality < 100 && (data instanceof Uint8Array || data instanceof Uint8ClampedArray) && !inspectPixels(data, width, height).palette)
        return complete(encodePhotoSteps(data, width, height, options), options.progress);
      const groups = Math.ceil(width / 256) * Math.ceil(height / 256);
      const groupWorkers = options.parallel !== false && workers > 0 && quality >= 100 && groups >= (options.losslessProfile === 'painting' ? PAINTING_POOL_GROUPS : POOL_GROUPS);
      const pooled = groupWorkers || options.parallel !== false && workers > 0 && quality >= 100 && options.effort === 9;
      const job = pooled ? encodePool(data, width, height, options, {spawn: spawnWorker, workers, groupWorkers}) : encodeSteps(data, width, height, options);
      return complete(job, options.progress);
    },
    async transcode(jpeg, options = {}) {
      const job = transcodeSteps(jpeg, {effort: options.effort ?? 7});
      const bytes = await complete(job, options.progress);
      return {bytes, width: job.width, height: job.height, orientation: job.orientation};
    },
    reconstruct: reconstructJPEG,
    serve: servePool,
  };
}
