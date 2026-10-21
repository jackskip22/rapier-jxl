// SPDX-License-Identifier: MIT
import {configureKernels} from './kernels.mjs';
import {encodeSteps} from './effort.mjs';
import {encodePool, servePool} from './pool.mjs';
import {transcodeSteps, reconstructJPEG} from './jpeg-ans.mjs';
import {encodePhotoSteps} from './photo.mjs';
import {inspectPixels} from './lossless.mjs';
import {finishEncoding, checkSignal} from './async-job.mjs';
import {encodePhotoPool, servePhotoPool} from './photo-pool.mjs';

const POOL_GROUPS = 40;
const PAINTING_POOL_GROUPS = 32;
const PHOTO_POOL_PIXELS = 3000000;

export function createStillEncoder({spawn} = {}) {
  if (spawn !== undefined && typeof spawn !== 'function') throw new TypeError('spawn must create a worker.');
  const available = spawn || typeof Worker === 'function' && typeof location === 'object' && location?.href;
  const workers = available ? Math.max(0, Math.min(3, (globalThis.navigator?.hardwareConcurrency || 1) - 1)) : 0;
  const spawnWorker = spawn || (() => new Worker(location.href));
  configureKernels('auto');
  return {
    async encode(data, width, height, options) {
      checkSignal(options.signal);
      const {quality, photo} = options;
      if (options.losslessProfile === undefined && photo && quality < 100 && (data instanceof Uint8Array || data instanceof Uint8ClampedArray) && !inspectPixels(data, width, height).palette) {
        const pooled = options.parallel !== false && workers > 0 && width * height >= PHOTO_POOL_PIXELS;
        const job = pooled ? encodePhotoPool(data, width, height, options, {spawn: spawnWorker, workers}) : encodePhotoSteps(data, width, height, options);
        return finishEncoding(job, options);
      }
      const groups = Math.ceil(width / 256) * Math.ceil(height / 256);
      const groupWorkers = options.parallel !== false && workers > 0 && quality >= 100 && groups >= (options.losslessProfile === 'painting' ? PAINTING_POOL_GROUPS : POOL_GROUPS);
      const pooled = groupWorkers || options.parallel !== false && workers > 0 && quality >= 100 && options.effort === 9;
      const job = pooled ? encodePool(data, width, height, options, {spawn: spawnWorker, workers, groupWorkers}) : encodeSteps(data, width, height, options);
      return finishEncoding(job, options);
    },
    async transcode(jpeg, options = {}) {
      checkSignal(options.signal);
      const job = transcodeSteps(jpeg, {effort: options.effort ?? 7, icc: options.icc, iccCompression: options.iccCompression});
      const bytes = await finishEncoding(job, options);
      return {bytes, width: job.width, height: job.height, orientation: job.orientation};
    },
    reconstruct: reconstructJPEG,
    serve: (message, report) => message.pool === 'photo' ? servePhotoPool(message) : servePool(message, report),
    pool: {spawn: spawnWorker, workers},
  };
}
