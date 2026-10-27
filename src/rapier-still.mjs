// SPDX-License-Identifier: MIT
import {configureKernels} from './kernels.mjs';
import {encodeSteps} from './effort.mjs';
import {encodePool, servePool} from './pool.mjs';
import {transcodeSteps, reconstructJPEG} from './jpeg-ans.mjs';
import {encodePhotoSteps, encodePhotoGpuSteps} from './photo.mjs';
import {gpuJob, GPU_PIXELS} from './gpu-drive.mjs';
import {inspectPixels} from './lossless.mjs';
import {finishEncoding, checkSignal} from './async-job.mjs';
import {encodePhotoPool, servePhotoPool} from './photo-pool.mjs';
import {serveAcGroup} from './ac-group.mjs';
import {runJob} from './exact-region.mjs';
import {spawnJxlHelper} from './worker-assets.mjs';
import {workerLease} from './worker-reservation.mjs';
import {memoryPlan} from './memory-plan.mjs';
import {codecError} from './worker-input.mjs';
import {preferXYB} from './photo-xyb.mjs';
import {photoV6MeasuredJob} from './photo-v6-search.mjs';
import {GpuMeasure} from './gpu-reconstruct.mjs';
import {attachVarblocks} from './gpu-varblocks.mjs';

let gpuDevice;
async function gpu() {
  if (gpuDevice !== undefined) return gpuDevice;
  gpuDevice = null;
  try {
    for (let i = 0; i < 4 && globalThis.navigator?.gpu && !gpuDevice; i++) {
      const adapter = await navigator.gpu.requestAdapter({powerPreference: 'high-performance'});
      if (adapter) gpuDevice = await adapter.requestDevice({requiredLimits: {maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize, maxBufferSize: adapter.limits.maxBufferSize}});
      else await new Promise(resolve => setTimeout(resolve, 250));
    }
    gpuDevice?.lost.then(() => { gpuDevice = undefined; });
  } catch { gpuDevice = null; }
  return gpuDevice;
}


function gpuForSignal(signal) {
  checkSignal(signal);
  if (!signal) return gpu();
  return new Promise((resolve, reject) => {
    let pending = true;
    const abort = () => { pending = false; signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, {once: true});
    gpu().then(device => {
      signal.removeEventListener('abort', abort);
      if (pending) { pending = false; resolve(device); }
    }, error => {
      signal.removeEventListener('abort', abort);
      if (pending) { pending = false; reject(error); }
    });
  });
}

const POOL_GROUPS = 40;
const PAINTING_POOL_GROUPS = 32;
const PHOTO_POOL_PIXELS = 3000000;

export function createStillEncoder({spawn, memory} = {}) {
  if (spawn !== undefined && typeof spawn !== 'function') throw new TypeError('spawn must create a worker.');
  let reserved = memory === undefined ? undefined : memorySnapshot(memory), pinned = memory !== undefined, busy = false;
  let poisoned = false, cleanupFailure;
  const available = !!spawn || typeof Worker === 'function';
  const workers = 0;
  const spawnWorker = spawn || spawnJxlHelper;
  configureKernels('auto');
  return {
    async encode(data, width, height, options) {
      checkSignal(options.signal);
      if (poisoned) throw cleanupFailure;
      if (busy) throw codecError('JXL_BUSY', 'The image worker is busy.');
      const requested = options.memory === undefined ? reserved ?? {} : memorySnapshot(options.memory);
      if (pinned && !sameMemory(reserved, requested)) throw codecError('JXL_OPTIONS', 'The encoder memory reservation changed.');
      const memoryOptions = Object.freeze({...requested, width, height, inputBytes: data.buffer.byteLength, exact: false});
      const memory = memoryPlan(width * height, memoryOptions);
      if (memory.known && !memory.fits) throw codecError('JXL_MEMORY', 'The image exceeds its memory reservation.');
      if (!pinned) { reserved = Object.freeze(requested); pinned = true; }
      options = {...options, memory: memoryOptions};
      const lease = workerLease(available && options.parallel !== false && memory.known && memory.fits ? memory.workerReservation : undefined, spawnWorker);
      busy = true;
      let failed = false;
      try {
        const {quality, photo} = options;
        if (options.losslessProfile === undefined && photo && quality < 100 && (data instanceof Uint8Array || data instanceof Uint8ClampedArray) && !inspectPixels(data, width, height).palette) {
          const effort = options.effort ?? 1;
          if (effort >= 8 && options.gpu !== false && options.icc === undefined && (options.colorSpace ?? 'srgb') === 'srgb' && width >= 8 && height >= 8 && preferXYB(data, width, height)) {
            if (memory.known) throw codecError('JXL_MEMORY_GPU_UNPROVEN', 'GPU allocation has no complete memory reservation.');
            const device = options.gpu && typeof options.gpu === 'object' ? options.gpu : await gpuForSignal(options.signal);
            checkSignal(options.signal);
            if (device) {
              let measurer, measuredJob, failed = false, failure;
              try {
                const metricBytes = width * height * 4;
                if (memoryOptions.metricInputBytes !== undefined && memoryOptions.metricInputBytes < metricBytes)
                  throw codecError('JXL_MEMORY', 'Memory reservation omits the metric input snapshot.');
                const referenceRgba = new Uint8Array(metricBytes);
                referenceRgba.set(data);
                measurer = await GpuMeasure.create(device, referenceRgba, width, height, {signal: options.signal});
                checkSignal(options.signal);
                measurer = await attachVarblocks(measurer, device, {signal: options.signal});
                checkSignal(options.signal);
                measuredJob = photoV6MeasuredJob(data, width, height, quality, effort, measurer,
                  {workerLease: lease, reservation: lease.reservation, memory: memoryOptions, signal: options.signal, referenceRgba});
                return await finishEncoding(measuredJob, options);
              } catch (error) {
                failed = true; failure = error; checkSignal(options.signal);
                if (error?.name === 'AbortError' || error?.code === 'JXL_MEMORY' || error?.code === 'JXL_MEMORY_GPU_UNPROVEN' || error?.code === 'JXL_WORKER_LEASE') throw error;
                if (measuredJob && measuredJob.stats?.backend !== 'gpu-failed') throw error;
              }
              finally {
                try { measurer?.destroy(); }
                catch (error) { poisoned = true; cleanupFailure = error; checkSignal(options.signal); throw failed ? failure : error; }
              }
            }
          }
          if (effort >= 8 && lease.reservation.count > 0 && options.icc === undefined &&
              (options.colorSpace ?? 'srgb') === 'srgb' && width >= 8 && height >= 8 && preferXYB(data, width, height)) {
            return await finishEncoding(photoV6MeasuredJob(data, width, height, quality, effort, null,
              {decisions: 'cpu', workerLease: lease, reservation: lease.reservation, memory: memoryOptions, signal: options.signal}), options);
          }
          if (effort <= 7 && options.gpu !== false && (options.gpu || width * height >= GPU_PIXELS)) {
            if (memory.known) throw codecError('JXL_MEMORY_GPU_UNPROVEN', 'GPU allocation has no complete memory reservation.');
            const device = options.gpu && typeof options.gpu === 'object' ? options.gpu : await gpuForSignal(options.signal);
            checkSignal(options.signal);
            if (device) return await finishEncoding(gpuJob(encodePhotoGpuSteps(data, width, height, options), device), options);
          }
          const pooled = options.parallel !== false && workers > 0 && width * height >= PHOTO_POOL_PIXELS;
          const job = pooled ? encodePhotoPool(data, width, height, options, {spawn: spawnWorker, workers}) : encodePhotoSteps(data, width, height, options);
          return await finishEncoding(job, options);
        }
        const groups = Math.ceil(width / 256) * Math.ceil(height / 256);
        const groupWorkers = options.parallel !== false && workers > 0 && quality >= 100 && groups >= (options.losslessProfile === 'painting' ? PAINTING_POOL_GROUPS : POOL_GROUPS);
        const pooled = groupWorkers || options.parallel !== false && workers > 0 && quality >= 100 && options.effort === 9;
        const job = pooled ? encodePool(data, width, height, options, {spawn: spawnWorker, workers, groupWorkers}) : encodeSteps(data, width, height, options);
        return await finishEncoding(job, options);
      } catch (error) { failed = true; throw error; }
      finally {
        try { await lease.close(); }
        catch (error) {
          poisoned = true; cleanupFailure = error;
          if (!failed) { checkSignal(options.signal); throw error; }
        } finally { busy = false; }
        if (!failed) checkSignal(options.signal);
      }
    },
    async transcode(jpeg, options = {}) {
      checkSignal(options.signal);
      const job = transcodeSteps(jpeg, {effort: options.effort ?? 7, icc: options.icc, iccCompression: options.iccCompression});
      const bytes = await finishEncoding(job, options);
      return {bytes, width: job.width, height: job.height, orientation: job.orientation};
    },
    reconstruct: reconstructJPEG,
    serve: (message, report) => message.pool === 'exact' ? serveExact(message)
      : message.pool === 'ac-model' || message.pool === 'ac-group' ? serveAcGroup(message)
      : message.pool === 'photo' ? servePhotoPool(message) : servePool(message, report),
    pool: {spawn: spawnWorker, workers},
  };
}

function serveExact(message) {
  try { return [{pool: 'exact', id: message.id, result: runJob(message)}, []]; }
  catch (error) {
    return [{pool: 'exact', id: message.id, error: {name: String(error?.name ?? 'Error'),
      message: String(error?.message ?? error), ...(error?.code === undefined ? {} : {code: error.code})}}, []];
  }
}

function memorySnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('memory must describe a reservation.');
  const entries = Object.entries(value).filter(([, item]) => item !== undefined);
  if (entries.some(([, item]) => typeof item !== 'number' && typeof item !== 'boolean'))
    throw new TypeError('Memory reservation fields must be numbers or booleans.');
  return Object.freeze(Object.fromEntries(entries));
}
function sameMemory(a, b) {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && Object.is(a[key], b[key]));
}
