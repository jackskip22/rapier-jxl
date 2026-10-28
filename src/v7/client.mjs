
import {DEFAULT_INPUT_BYTES, DEFAULT_PIXELS, record, dimensions, measure, snapshot} from './ownership.mjs';
const DEFAULT_JOBS = 32;
const HELPER_BYTES = 46137344, PIXEL_BYTES = 56;
const operations = ['encode', 'capture', 'recompress', 'restore', 'decode', 'animate', 'format'];

function error(code, message) { return Object.assign(new Error(message), {code}); }
function positive(value, fallback, name) {
  if (value === undefined) value = fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw error('JXL_OPTIONS', `${name} must be a positive safe integer.`);
  return value;
}
function aborted(signal) {
  try { return signal?.reason === undefined ? error('JXL_ABORTED', 'JPEG XL operation was canceled.') : signal.reason; }
  catch (reason) { return reason; }
}
function browserWorker() {
  return new Worker(new URL('./worker.mjs', import.meta.url), {type: 'module'});
}

function helperReservation(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw error('JXL_OPTIONS', 'helpers is {count, memoryBytes}.');
  for (const key of Object.keys(value)) if (key !== 'count' && key !== 'memoryBytes') throw error('JXL_OPTIONS', `Unknown helpers field: ${key}.`);
  const {count, memoryBytes} = value;
  if (!Number.isInteger(count) || count < 0 || count > 16) throw error('JXL_OPTIONS', 'helpers.count is a whole number from 0 to 16.');
  if (count && (!Number.isSafeInteger(memoryBytes) || memoryBytes < 1)) throw error('JXL_OPTIONS', 'helpers.memoryBytes is a positive safe integer.');
  return count ? Object.freeze({count, memoryBytes}) : undefined;
}

export function createEncoder(config = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw error('JXL_OPTIONS', 'Encoder configuration must be an object.');
  for (const key of Object.keys(config)) if (!['worker', 'workerFactory', 'workerStartupTimeout', 'maxInputBytes', 'maxPixels', 'maxQueuedJobs', 'helpers'].includes(key))
    throw error('JXL_OPTIONS', `Unknown encoder configuration: ${key}.`);
  if (config.worker !== undefined && config.worker !== false) throw error('JXL_OPTIONS', 'worker may be false; supply workerFactory for a custom worker.');
  if (config.workerFactory !== undefined && typeof config.workerFactory !== 'function') throw error('JXL_OPTIONS', 'workerFactory must be a function.');
  if (config.worker === false && config.workerFactory) throw error('JXL_OPTIONS', 'worker:false and workerFactory are mutually exclusive.');
  const maxInputBytes = positive(config.maxInputBytes, DEFAULT_INPUT_BYTES, 'maxInputBytes');
  const maxPixels = positive(config.maxPixels, DEFAULT_PIXELS, 'maxPixels');
  const helpers = helperReservation(config.helpers);
  const owner = helpers ? {} : undefined;
  const besideBytes = helpers ? helpers.memoryBytes - helpers.count * HELPER_BYTES : 0;
  const maxQueuedJobs = positive(config.maxQueuedJobs, DEFAULT_JOBS, 'maxQueuedJobs');
  const workerStartupTimeout = positive(config.workerStartupTimeout, 15000, 'workerStartupTimeout');
  if (workerStartupTimeout > 2147483647) throw error('JXL_OPTIONS', 'workerStartupTimeout must fit a platform timer.');
  const factory = config.workerFactory || (config.worker !== false && typeof document !== 'undefined' && typeof Worker === 'function' ? browserWorker : null);
  let closed = false, nextId = 0, retainedBytes = 0, here = null, wide = null, scheduled = false, stopping = null, transport = null, loading = null, runtimeLoaded = false;
  const queue = [], running = new Map();
  const runningBytes = () => [...running.values()].reduce((sum, job) => sum + job.bytes, 0);
  function lane(job) {
    if (wide) return -1;
    if (!here) return 0;
    if (!helpers || !job.pixels || running.size > helpers.count) return -1;
    let pixels = job.pixels;
    for (const other of running.values()) if (other !== here) pixels += other.pixels;
    return pixels * PIXEL_BYTES <= besideBytes ? 1 : -1;
  }

  const widens = job => {
    if (!helpers) return true;
    const {effort = 7, quality = 90, lossless} = job.operation === 'encode' && job.options || {};
    return job.operation === 'encode' && job.pixels >= 500000 && effort >= 7 && quality < 100 && lossless !== true;
  };
  function schedule() {
    if (scheduled || closed || stopping || !queue.length || lane(queue[0]) < 0) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; pump(); });
  }
  function release(job) {
    if (job.released) return;
    job.released = true;
    retainedBytes -= job.bytes;
    job.input = job.options = null;
    running.delete(job.id);
    if (here === job) here = null;
    if (wide === job) wide = null;
    schedule();
  }
  function settle(job, ok, value) {
    if (job.settled) return;
    job.settled = true;
    try { job.signal?.removeEventListener('abort', job.abort); } catch {}
    ok ? job.resolve(value) : job.reject(value);
  }
  function cancel(job, reason) {
    if (job.settled) return;
    settle(job, false, reason);
    if (running.get(job.id) === job) {
      job.controller.abort(reason);
      if (!job.started) release(job);
      else if (running.size > 1) { if (factory) transport ? transport.cancel(job) : release(job); }
      else if (factory) { transport?.stop(); release(job); }
      else releaseHelpers();
    } else {
      const at = queue.indexOf(job);
      if (at !== -1) queue.splice(at, 1);
      release(job);
    }
  }
  function releaseHelpers() {
    if (owner && !factory && runtimeLoaded) import('./runtime.mjs').then(({release}) => release?.(owner)).catch(() => {});
  }
  function progress(job, fraction) {
    if (job.settled || !Number.isFinite(fraction) || fraction < 0 || fraction > 1 || fraction <= job.progress) return;
    job.progress = fraction;
    try { job.onProgress?.(fraction); } catch (reason) { cancel(job, reason); }
  }
  function complete(job, ok, value) {
    if (ok) progress(job, 1);
    settle(job, ok, value);
    release(job);
  }
  const host = {factory, maxPixels, helpers, workerStartupTimeout, complete, progress, schedule, running,
    get stopping() { return stopping; }, set stopping(value) { stopping = value; }};
  function pump() {
    while (!closed && !stopping && queue.length) {
      const job = queue[0], where = lane(job);
      if (where < 0) return;
      const alone = !running.size && queue.length === 1 && widens(job);
      queue.shift();
      running.set(job.id, job);
      Object.assign(job, {lane: where, alone});
      if (where === 0) here = job;
      if (alone && helpers) wide = job;
      progress(job, 0);
      if (job.settled) { release(job); continue; }
      job.started = true;
      start(job);
    }
  }
  function start(job) {
    if (factory) {
      loading ||= import('./transport.mjs').then(({createTransport}) => { transport = createTransport(host); },
        reason => { loading = null; throw reason; });
      loading.then(() => {
        if (running.get(job.id) !== job) return;
        if (job.settled) { release(job); return; }
        try { transport.send(transport.open(), job); } catch (reason) { transport.stop(); complete(job, false, reason); }
      }, reason => { if (running.get(job.id) === job) complete(job, false, reason); });
    } else {
      import('./runtime.mjs').then(({run}) => { runtimeLoaded = true; return run(job.operation, job.input, job.options, {signal: job.controller.signal, onProgress: fraction => progress(job, fraction), maxPixels, helpers, owner, lane: job.lane, alone: job.alone}); })
        .then(value => complete(job, true, value), reason => complete(job, false, reason));
    }
  }
  function admit(options = {}, inputBytes = 0) {
    if (closed) throw error('JXL_CLOSED', 'The JPEG XL encoder is closed.');
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw error('JXL_OPTIONS', 'JPEG XL options must be an object.');
    const {signal, onProgress, ...parameters} = Object.fromEntries(record(options).map(([key, descriptor]) => [key, descriptor.value]));
    if (signal !== undefined && (!signal || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function' || typeof signal.aborted !== 'boolean')) throw error('JXL_OPTIONS', 'signal must be an AbortSignal.');
    if (onProgress !== undefined && typeof onProgress !== 'function') throw error('JXL_OPTIONS', 'onProgress must be a function.');
    if (signal?.aborted) throw aborted(signal);
    if (queue.length + running.size >= maxQueuedJobs) throw error('JXL_MEMORY', 'The encoder queue is full.');
    const optionPlans = new Map(), optionBytes = measure(parameters, Number.MAX_SAFE_INTEGER, optionPlans);
    if (inputBytes + optionBytes > maxInputBytes - retainedBytes) throw error('JXL_MEMORY', 'Outstanding input exceeds maxInputBytes.');
    return {signal, onProgress, parameters, optionBytes, optionPlans};
  }
  function submit(operation, input, options = {}) {
    try {
      const {signal, onProgress, parameters, optionBytes, optionPlans} = admit(options);
      const inputPlans = new Map(), bytes = measure(input, maxPixels, inputPlans) + optionBytes;
      if (bytes > maxInputBytes - retainedBytes) throw error('JXL_MEMORY', 'Outstanding input exceeds maxInputBytes.');
      const ownedInput = snapshot(input, inputPlans), ownedOptions = snapshot(parameters, optionPlans);
      return new Promise((resolve, reject) => {
        const pixels = operation === 'encode' && ArrayBuffer.isView(ownedInput?.data) ? ownedInput.width * ownedInput.height : 0;
        const job = {id: ++nextId, operation, input: ownedInput, options: ownedOptions, bytes, pixels, signal, onProgress, resolve, reject, settled: false, released: false, progress: -1, controller: new AbortController()};
        job.abort = () => cancel(job, aborted(signal));
        retainedBytes += bytes;
        queue.push(job);
        try {
          signal?.addEventListener('abort', job.abort, {once: true});
          if (signal?.aborted) job.abort();
        } catch (reason) { cancel(job, reason); }
        schedule();
      });
    } catch (reason) { return Promise.reject(reason); }
  }
  const encoder = Object.fromEntries(operations.map(operation => [operation, (input, options) => submit(operation, input, options)]));
  encoder.admitSurface = (shape, options) => {
    let inputBytes = 0;
    if (shape) {
      const {width, height, byteLength = width * height * 4, colorSpace = 'display-p3'} = shape;
      dimensions({width, height}, maxPixels);
      if (!Number.isSafeInteger(byteLength) || byteLength < 1) throw error('JXL_INPUT', 'Invalid surface byte length.');
      inputBytes = byteLength + 8 + measure({width, height, colorSpace}, maxPixels);
    }
    admit(options, inputBytes);
  };
  Object.defineProperty(encoder, 'stats', {enumerable: true, get: () => Object.freeze({queuedJobs: queue.length, queuedBytes: retainedBytes - runningBytes(), activeJobs: running.size, activeBytes: runningBytes(), closed, workerGeneration: transport?.generation ?? 0})});
  encoder.close = () => {
    if (closed) return;
    closed = true;
    const reason = error('JXL_CLOSED', 'The JPEG XL encoder is closed.');
    for (const job of [...queue]) cancel(job, reason);
    for (const job of [...running.values()]) cancel(job, reason);
    transport?.stop();
    releaseHelpers();
  };
  return Object.freeze(encoder);
}

