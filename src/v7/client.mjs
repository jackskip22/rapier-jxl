
import {DEFAULT_INPUT_BYTES, DEFAULT_PIXELS, record, dimensions, measure, snapshot} from './ownership.mjs';
import {fail as error, declared, callers, isCaller} from './primitives.mjs';
import {createTransport, REPLACED} from './transport.mjs';
const DEFAULT_JOBS = 32;
const HELPER_BYTES = 46137344, PIXEL_BYTES = 56;

function positive(value, fallback, name) {
  if (value === undefined) value = fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw error('JXL_OPTIONS', `${name} must be a positive safe integer.`);
  return value;
}
function aborted(signal) {
  try { return signal?.reason === undefined ? error('JXL_ABORTED', 'JPEG XL operation was canceled.') : callers(signal.reason); }
  catch (reason) { return callers(reason); }
}
const WORKER_START = 'Could not start the JPEG XL module worker. Serve the package from the page origin, allow blob: in worker-src when it comes from another origin, or import the module to run it in place. workerFactory can supply your own worker.';
function started(make, cleanup) {
  try { return make(); } catch (cause) { cleanup?.(); throw Object.assign(error('JXL_WORKER', WORKER_START), {cause}); }
}
function browserWorker(spec) {
  const url = spec.url(), origin = url.origin;
  if (typeof location === 'undefined' || !origin || origin === 'null' || origin === location.origin)
    return started(spec.worker);
  const source = URL.createObjectURL(new Blob(['import ' + JSON.stringify(url.href) + ';'], {type: 'text/javascript'}));
  let blocked = false;
  const violation = event => {
    if (event.disposition === 'enforce' && event.effectiveDirective === 'worker-src' && (event.blockedURI === 'blob' || event.blockedURI === source)) blocked = true;
  };
  const done = () => { document.removeEventListener('securitypolicyviolation', violation); URL.revokeObjectURL(source); };
  document.addEventListener('securitypolicyviolation', violation);
  const worker = started(() => new Worker(source, {type: 'module'}), done);
  worker.addEventListener('message', done, {once: true});
  worker.addEventListener('error', event => {
    done();
    if (blocked) Object.defineProperties(event, {code: {value: 'JXL_WORKER_CSP'}, message: {value: "This page's Content Security Policy blocks blob: workers, which rapier-jxl/codec needs when loaded from another origin. Add blob: to worker-src, or import the module to run it in place."}});
  }, {once: true});
  const terminate = worker.terminate;
  worker.terminate = function () { done(); return terminate.call(this); };
  return worker;
}

function coded(reason, job = null) {
  try {
    if (reason === null || typeof reason !== 'object' && typeof reason !== 'function') return reason;
    if (isCaller(reason) || job && reason === job.controller.signal.reason) return reason;
    const code = reason.code;
    if (typeof code === 'string' && code.startsWith('JXL_')) return reason;
    let message = '';
    try { message = String(reason.message ?? ''); } catch {}
    return Object.assign(error('JXL_INTERNAL', message || 'The JPEG XL job failed.'), {cause: reason});
  } catch { return reason; }
}

export function helperReservation(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw error('JXL_OPTIONS', 'helpers is {count, memoryBytes}.');
  for (const key of Object.keys(value)) if (key !== 'count' && key !== 'memoryBytes') throw error('JXL_OPTIONS', `Unknown helpers field: ${key}.`);
  const {count, memoryBytes} = value;
  if (!Number.isInteger(count) || count < 0 || count > 16) throw error('JXL_OPTIONS', 'helpers.count is a whole number from 0 to 16.');
  if (count && (!Number.isSafeInteger(memoryBytes) || memoryBytes < 1)) throw error('JXL_OPTIONS', 'helpers.memoryBytes is a positive safe integer.');
  return count ? Object.freeze({count, memoryBytes}) : undefined;
}

export function createCodec(config = {}, spec) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw error('JXL_OPTIONS', 'Codec configuration must be an object.');
  for (const key of Object.keys(config)) if (!['workerFactory', 'workerStartupTimeout', 'maxPendingBytes', 'maxPixels', 'maxPendingJobs', 'helpers', 'webgpu'].includes(key))
    throw error('JXL_OPTIONS', `Unknown encoder configuration: ${key}.`);
  if (config.workerFactory !== undefined && typeof config.workerFactory !== 'function') throw error('JXL_OPTIONS', 'workerFactory must be a function.');
  if (config.webgpu !== undefined && config.webgpu !== 'required' && config.webgpu !== false)
    throw error('JXL_OPTIONS', "webgpu is 'required' or false; leave it out to use WebGPU where this realm has it.");
  const webgpu = config.webgpu;
  const maxPendingBytes = positive(config.maxPendingBytes, DEFAULT_INPUT_BYTES, 'maxPendingBytes');
  const maxPixels = positive(config.maxPixels, DEFAULT_PIXELS, 'maxPixels');
  if (maxPixels > DEFAULT_PIXELS) throw error('JXL_OPTIONS', 'maxPixels is at most ' + DEFAULT_PIXELS + ', the encoders\' own limit.');
  const helpers = helperReservation(config.helpers);
  const owner = helpers ? {} : undefined;
  const besideBytes = helpers ? helpers.memoryBytes - helpers.count * HELPER_BYTES : 0;
  const maxPendingJobs = positive(config.maxPendingJobs, DEFAULT_JOBS, 'maxPendingJobs');
  const workerStartupTimeout = positive(config.workerStartupTimeout, 15000, 'workerStartupTimeout');
  if (workerStartupTimeout > 2147483647) throw error('JXL_OPTIONS', 'workerStartupTimeout must fit a platform timer.');
  const operations = spec.operations;
  const factory = config.workerFactory || (!spec.inPlace && typeof document !== 'undefined' && typeof Worker === 'function' ? () => browserWorker(spec) : null);
  let closed = false, nextId = 0, retainedBytes = 0, here = null, wide = null, scheduled = false, stopping = null, transport = null, closing = null, runtimeLoaded = false;
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
    const {effort = spec.defaultEffort ?? 7, fidelity} = job.operation === 'encode' && job.options || {};
    const exact = fidelity === 'exact' || (fidelity !== null && typeof fidelity === 'object' && fidelity.quality === 100);
    return job.operation === 'encode' && job.pixels >= 500000 && effort >= 7 && !exact;
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
  function settle(job, ok, value, caller = false) {
    if (job.settled) return;
    let outcome = value;
    if (!ok && !caller) { try { outcome = declared(coded(value, job)); } catch {} }
    job.settled = true;
    try { job.signal?.removeEventListener('abort', job.abort); } catch {}
    ok ? job.resolve(outcome) : job.reject(outcome);
  }
  function cancel(job, reason, caller = true) {
    if (job.settled) return;
    settle(job, false, reason, caller);
    if (job.finished) return;
    if (running.get(job.id) === job) {
      job.controller.abort(reason);
      if (!job.started) release(job);
      else if (running.size > 1 || factory && !job.sent) { if (factory) transport ? transport.cancel(job) : release(job); }
      else if (factory) { transport?.stop(); release(job); }
      else releaseHelpers();
    } else {
      const at = queue.indexOf(job);
      if (at !== -1) queue.splice(at, 1);
      release(job);
    }
  }
  function releaseHelpers(report = false) {
    if (!owner || factory || !runtimeLoaded) return;
    const released = spec.runtime().then(({release}) => release?.(owner, report));
    return report ? released : released.catch(() => {});
  }
  function progress(job, fraction) {
    if (job.settled || !Number.isFinite(fraction) || fraction < 0 || fraction > 1 || fraction <= job.progress) return;
    job.progress = fraction;
    try { job.onProgress?.(fraction); } catch (reason) { cancel(job, reason); }
  }
  function complete(job, ok, value) {
    job.finished = true;
    try {
      if (ok) progress(job, 1);
      settle(job, ok, value);
    } finally { release(job); }
  }
  const host = {factory, module: spec.module, maxPixels, helpers, webgpu, workerStartupTimeout, complete, progress, schedule, running,
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
      transport ||= createTransport(host);
      try {
        const current = transport.open();
        if (!current.ready && job.operation !== 'encode') transport.prepare(job.operation).catch(() => {});
        transport.send(current, job);
      } catch (reason) { transport.stop(); complete(job, false, reason); }
    } else {
      spec.runtime().then(({run}) => { runtimeLoaded = true; return run(job.operation, job.input, job.options, {signal: job.controller.signal, onProgress: fraction => progress(job, fraction), maxPixels, helpers, webgpu, owner, lane: job.lane, alone: job.alone}); })
        .then(value => complete(job, true, value), reason => complete(job, false, coded(reason, job)));
    }
  }
  function admit(options = {}, inputBytes = 0) {
    if (closed) throw error('JXL_CLOSED', 'The JPEG XL encoder is closed.');
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw error('JXL_OPTIONS', 'JPEG XL options must be an object.');
    let fields;
    try { fields = record(options); }
    catch (reason) { throw reason?.code === 'JXL_INPUT' ? error('JXL_OPTIONS', 'JPEG XL options must be a plain record of data fields: ' + reason.message) : reason; }
    const {signal, onProgress, ...parameters} = Object.fromEntries(fields.map(([key, descriptor]) => [key, descriptor.value]));
    if (signal !== undefined && (!signal || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function' || typeof signal.aborted !== 'boolean')) throw error('JXL_OPTIONS', 'signal must be an AbortSignal.');
    if (onProgress !== undefined && typeof onProgress !== 'function') throw error('JXL_OPTIONS', 'onProgress must be a function.');
    if (signal?.aborted) throw aborted(signal);
    if (queue.length + running.size >= maxPendingJobs) throw error('JXL_MEMORY', 'The encoder queue is full (maxPendingJobs).');
    const optionPlans = new Map();
    let optionBytes;
    try { optionBytes = measure(parameters, Number.MAX_SAFE_INTEGER, optionPlans); }
    catch (reason) { throw reason?.code === 'JXL_INPUT' ? error('JXL_OPTIONS', 'JPEG XL options must be a plain record of data fields: ' + reason.message) : reason; }
    if (inputBytes + optionBytes > maxPendingBytes - retainedBytes) throw error('JXL_MEMORY', 'Pending input exceeds maxPendingBytes.');
    return {signal, onProgress, parameters, optionBytes, optionPlans};
  }
  function submit(operation, input, options = {}) {
    try {
      const {signal, onProgress, parameters, optionBytes, optionPlans} = admit(options);
      const inputPlans = new Map(), bytes = measure(input, maxPixels, inputPlans) + optionBytes;
      if (bytes > maxPendingBytes - retainedBytes) throw error('JXL_MEMORY', 'Pending input exceeds maxPendingBytes.');
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
    } catch (reason) { return Promise.reject(declared(reason)); }
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
  Object.defineProperty(encoder, 'stats', {enumerable: true, get: () => Object.freeze({queuedJobs: queue.length, queuedBytes: retainedBytes - runningBytes(), activeJobs: running.size, activeBytes: runningBytes(), closed})});
  encoder.prepare = operation => {
    const shut = () => error('JXL_CLOSED', 'The JPEG XL encoder is closed.');
    const refuse = reason => { throw closed ? shut() : declared(coded(reason)); };
    if (closed) return Promise.reject(shut());
    if (!operations.includes(operation)) return Promise.reject(error('JXL_OPTIONS', 'prepare names its operation: ' + operations.join(', ') + '.'));
    if (!factory) { runtimeLoaded = true; return spec.runtime().then(({prepare}) => prepare(operation, {webgpu, owner, helpers})).then(() => { if (closed) throw shut(); }, refuse); }
    return (async () => {
      await null;
      for (;;) {
        while (stopping) await stopping;
        if (closed) throw shut();
        transport ||= createTransport(host);
        try { return await transport.prepare(operation); }
        catch (reason) { if (!reason?.[REPLACED] || closed) throw reason; }
      }
    })().catch(refuse);
  };
  encoder.close = () => {
    if (closing) return closing;
    closed = true;
    const reason = error('JXL_CLOSED', 'The JPEG XL encoder is closed.');
    for (const job of [...queue]) cancel(job, reason, false);
    for (const job of [...running.values()]) cancel(job, reason, false);
    transport?.stop();
    return closing = Promise.allSettled([stopping, transport?.ended, releaseHelpers(true)]).then(outcomes => {
      const failed = outcomes.find(outcome => outcome.status === 'rejected');
      if (failed) throw Object.assign(error('JXL_WORKER', 'The JPEG XL worker or a helper could not be ended.'), {cause: failed.reason});
    });
  };
  return Object.freeze(encoder);
}

