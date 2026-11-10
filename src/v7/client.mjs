
import {DEFAULT_INPUT_BYTES, DEFAULT_PIXELS, SNAPSHOTS, withCost, record, dimensions, measure, snapshot} from './ownership.mjs';
import {fail as error, declared, callers, isCaller, LARGEST, JPEG_PIXELS} from './primitives.mjs';
import {createTransport, REPLACED} from './transport.mjs';
import {elsewhere, program, relocatable} from './worker-start.mjs';
const DEFAULT_JOBS = 32;
const HELPER_BYTES = 46137344, PIXEL_BYTES = 56;
const IDLE = 60000;

function positive(value, fallback, name) {
  if (value === undefined) value = fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw error('JXL_OPTIONS', `${name} must be a positive safe integer.`);
  return value;
}
function aborted(signal) {
  try { return signal?.reason === undefined ? error('JXL_ABORTED', 'JPEG XL operation was canceled.') : callers(signal.reason); }
  catch (reason) { return callers(reason); }
}
const WORKER_START = 'The worker did not start. Serve the package from the page origin, allow blob: in worker-src, import the module to run in place, or pass workerFactory.';
function started(make, cleanup) {
  try { return make(); } catch (cause) { cleanup?.(); throw Object.assign(error('JXL_WORKER', WORKER_START), {cause}); }
}
function browserWorker(spec) {
  if (!spec.url) return started(spec.worker);
  const url = spec.url();
  return elsewhere(url) ? embeddedWorker(program(url.href)) : relocatable(() => started(spec.worker), url);
}

export function embeddedWorker(program) {
  const source = URL.createObjectURL(new Blob([program], {type: 'text/javascript'}));
  let blocked = false;
  const violation = event => {
    if (event.disposition === 'enforce' && event.effectiveDirective === 'worker-src' && (event.blockedURI === 'blob' || event.blockedURI === source)) blocked = true;
  };
  const done = () => { globalThis.document?.removeEventListener('securitypolicyviolation', violation); URL.revokeObjectURL(source); };
  globalThis.document?.addEventListener('securitypolicyviolation', violation);
  const worker = started(() => new Worker(source, {type: 'module'}), done);
  worker.addEventListener('message', done, {once: true});
  worker.addEventListener('error', event => {
    done();
    if (blocked) Object.defineProperties(event, {code: {value: 'JXL_WORKER_CSP'}, message: {value: "The CSP blocks the blob: worker. Add blob: to worker-src, or import the module to run in place."}});
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

export function deviceHelpers(nav = globalThis.navigator) {
  const reported = nav?.deviceMemory > 0, os = reported ? null : globalThis.process?.getBuiltinModule?.('node:os'), each = 3 * 2 ** 25;
  const count = Math.min(16, (nav?.hardwareConcurrency || os?.availableParallelism() || 1) - 1,
    (reported ? nav.deviceMemory * 2 ** (nav.userAgentData?.mobile === false ? 27 : 26) : os ? os.freemem() / 4 : 2 * each) / each | 0);
  return count > 0 ? Object.freeze({count, memoryBytes: count * each}) : undefined;
}

export function helperReservation(value) {
  if (value === undefined) return undefined;
  if (value === true) return deviceHelpers();
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw error('JXL_OPTIONS', 'helpers is true or {count, memoryBytes}.');
  for (const key of Object.keys(value)) if (key !== 'count' && key !== 'memoryBytes') throw error('JXL_OPTIONS', `Unknown helpers field: ${key}.`);
  const {count, memoryBytes} = value;
  if (!Number.isInteger(count) || count < 0 || count > 16) throw error('JXL_OPTIONS', 'helpers.count is a whole number from 0 to 16.');
  if (count && (!Number.isSafeInteger(memoryBytes) || memoryBytes < 1)) throw error('JXL_OPTIONS', 'helpers.memoryBytes is a positive safe integer.');
  return count ? Object.freeze({count, memoryBytes}) : undefined;
}

export function createCodec(config = {}, spec, replies) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw error('JXL_OPTIONS', 'Codec configuration must be an object.');
  for (const key of Object.keys(config)) if (!['workerFactory', 'workerStartupTimeout', 'maxPendingBytes', 'maxPixels', 'maxPendingJobs', 'helpers', 'webgpu'].includes(key))
    throw error('JXL_OPTIONS', `Unknown encoder configuration: ${key}.`);
  if (config.workerFactory !== undefined && typeof config.workerFactory !== 'function') throw error('JXL_OPTIONS', 'workerFactory must be a function.');
  if (config.webgpu !== undefined && config.webgpu !== 'required' && config.webgpu !== false)
    throw error('JXL_OPTIONS', "webgpu is 'required' or false, or left out.");
  const webgpu = config.webgpu;
  const maxPendingBytes = positive(config.maxPendingBytes, DEFAULT_INPUT_BYTES, 'maxPendingBytes');
  const maxPixels = positive(config.maxPixels, DEFAULT_PIXELS, 'maxPixels');
  if (maxPixels > LARGEST) throw error('JXL_OPTIONS', 'maxPixels is at most ' + LARGEST + ' (16,384 x 16,384).');
  const helpers = helperReservation(config.helpers);
  const owner = helpers ? {} : undefined;
  const besideBytes = helpers ? helpers.memoryBytes - helpers.count * HELPER_BYTES : 0;
  const maxPendingJobs = positive(config.maxPendingJobs, DEFAULT_JOBS, 'maxPendingJobs');
  const workerStartupTimeout = positive(config.workerStartupTimeout, 15000, 'workerStartupTimeout');
  if (workerStartupTimeout > 2147483647) throw error('JXL_OPTIONS', 'workerStartupTimeout must fit a platform timer.');
  const operations = spec.operations;
  const factory = config.workerFactory || (!spec.inPlace && typeof document !== 'undefined' && typeof Worker === 'function' ? () => browserWorker(spec) : null);
  let closed = false, nextId = 0, retainedBytes = 0, here = null, wide = null, scheduled = false, stopping = null, transport = null, closing = null, runtimeLoaded = false;
  let idleTimer, preparing = 0, retiring = null;
  const queue = [], running = new Map(), held = new Set();
  const runningBytes = () => [...running.values()].reduce((sum, job) => sum + job.bytes, 0);
  function lane(job) {
    if (wide) return -1;
    if ((job.operation === 'fit' || job.operation === 'variants') && running.size) return -1;
    if (!here) return 0;
    if (!helpers || !job.pixels || running.size > helpers.count) return -1;
    let pixels = job.pixels;
    for (const other of running.values()) if (other !== here) pixels += other.pixels;
    return pixels * PIXEL_BYTES <= besideBytes ? 1 : -1;
  }

  const widens = job => {
    if (!helpers || job.operation === 'fit' || job.operation === 'variants') return true;
    const {effort = spec.defaultEffort ?? 7, fidelity} = job.operation === 'encode' && job.options || {};
    const exact = fidelity === 'exact' || (fidelity !== null && typeof fidelity === 'object' && fidelity.quality === 100);
    return job.operation === 'encode' && job.area >= 500000 && effort >= 7 && !exact;
  };
  function schedule() {
    if (scheduled || closed || stopping || !queue.length || lane(queue[0]) < 0) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; pump(); });
  }
  function release(job) {
    if (job.released || job.acquiring) return;
    job.released = true;
    retainedBytes -= job.bytes;
    job.input = job.options = null;
    if (job.onPreview) { replies.clear(job); job.onPreview = null; }
    running.delete(job.id);
    if (here === job) here = null;
    if (wide === job) wide = null;
    schedule();
    rest();
  }
  const idle = () => !closed && !stopping && !retiring && !preparing && !queue.length && !running.size && !held.size;
  function rest() {
    clearTimeout(idleTimer);
    if (factory ? transport : owner && runtimeLoaded) (idleTimer = setTimeout(retire, IDLE)).unref?.();
  }
  function retire() {
    if (!idle()) return;
    if (factory) transport.stop();
    else retiring = Promise.resolve(releaseHelpers()).finally(() => { retiring = null; schedule(); });
  }
  function settle(job, ok, value, caller = false) {
    if (job.settled) return;
    let outcome = value;
    if (!ok && !caller) { try { outcome = declared(coded(value, job)); } catch {} }
    job.settled = true;
    if (job.onPreview) replies.clear(job);
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
      if (job.acquiring) held.add(job);
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
  function encoded(job, record) {
    if (job.settled) return;
    try { job.onEncoded?.(record); } catch (reason) { cancel(job, reason); }
  }
  function preview(job, record) {
    if (job.settled) return;
    const observer = job.onPreview;
    try { return Promise.resolve(observer?.(record)).catch(() => {}); } catch {}
  }
  function complete(job, ok, value) {
    job.finished = true;
    try {
      if (ok) progress(job, 1);
      settle(job, ok, value);
    } finally { release(job); }
  }
  const jpegPixels = Math.min(config.maxPixels ?? JPEG_PIXELS, JPEG_PIXELS);
  const host = {factory, module: spec.module, bytes: spec.bytes === true, maxPixels, jpegPixels, helpers, webgpu, workerStartupTimeout, complete, progress, encoded, preview, replyPreview: replies?.reply, schedule, running,
    get stopping() { return stopping; }, set stopping(value) { stopping = value; }};
  function pump() {
    while (!closed && !stopping && queue.length) {
      const job = queue[0], where = lane(job);
      if (where < 0) return;
      const preparation = job.operation === 'fit' || job.operation === 'variants';
      const alone = !running.size && (preparation || queue.length === 1) && widens(job);
      queue.shift();
      running.set(job.id, job);
      Object.assign(job, {lane: where, alone});
      if (where === 0) here = job;
      if (alone && helpers) wide = job;
      progress(job, 0);
      if (job.settled) { release(job); continue; }
      if (!job.acquiring) begin(job);
    }
  }
  function begin(job) {
    if (job.refused) { complete(job, false, job.refused); return; }
    if (job.taken) { job.input = job.taken; job.taken = null; }
    job.started = true;
    start(job);
  }
  function acquiring(job, acquire) {
    let resolve, reject;
    const taking = new Promise((yes, no) => { resolve = yes; reject = no; });
    job.acquiring = taking.then(input => { job.taken = input; }, reason => { job.refused = reason ?? error('JXL_INPUT', 'The canvas could not be read.'); })
      .then(() => {
        job.acquiring = null; held.delete(job);
        if (job.settled) { try { job.taken?.close?.(); } catch {} job.taken = null; release(job); }
        else if (running.get(job.id) === job && !job.started) begin(job);
      });
    try { resolve(typeof acquire === 'function' ? acquire() : acquire); } catch (reason) { reject(reason); }
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
      Promise.resolve(retiring).then(() => spec.runtime()).then(({run}) => { runtimeLoaded = true; return run(job.operation, job.input, job.options, {signal: job.controller.signal, onProgress: fraction => progress(job, fraction), onEncoded: record => encoded(job, record), ...(job.onPreview && {onPreview: record => preview(job, record)}), maxPixels, jpegPixels, helpers, webgpu, owner, lane: job.lane, alone: job.alone}); })
        .then(value => complete(job, true, value), reason => complete(job, false, coded(reason, job)));
    }
  }
  function admit(options = {}, inputBytes = 0) {
    if (closed) throw error('JXL_CLOSED', 'The JPEG XL encoder is closed.');
    if (!options || typeof options !== 'object') throw error('JXL_OPTIONS', 'JPEG XL options must be an object.');
    let fields;
    try { fields = record(options); }
    catch (reason) { throw !reason?.code || reason.code === 'JXL_INPUT' ? error('JXL_OPTIONS', 'JPEG XL options must be a plain record of data fields: ' + reason?.message) : reason; }
    if (Array.isArray(options)) throw error('JXL_OPTIONS', 'JPEG XL options must be an object.');
    const {signal, onProgress, onEncoded, onPreview, ...parameters} = Object.fromEntries(fields.map(([key, descriptor]) => [key, descriptor.value]));
    if (signal !== undefined && (!signal || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function' || typeof signal.aborted !== 'boolean')) throw error('JXL_OPTIONS', 'signal must be an AbortSignal.');
    if (onProgress !== undefined && typeof onProgress !== 'function') throw error('JXL_OPTIONS', 'onProgress must be a function.');
    if (onEncoded !== undefined && typeof onEncoded !== 'function') throw error('JXL_OPTIONS', 'onEncoded must be a function.');
    if (onPreview !== undefined && typeof onPreview !== 'function') throw error('JXL_OPTIONS', 'onPreview must be a function.');
    if (signal?.aborted) throw aborted(signal);
    if (queue.length + running.size + held.size >= maxPendingJobs) throw error('JXL_MEMORY', 'The encoder queue is full (maxPendingJobs).');
    const optionPlans = new Map();
    let optionBytes;
    try { optionBytes = measure(parameters, Number.MAX_SAFE_INTEGER, optionPlans); }
    catch (reason) { throw reason?.code === 'JXL_INPUT' ? error('JXL_OPTIONS', 'JPEG XL options must be a plain record of data fields: ' + reason.message) : reason; }
    if (inputBytes + optionBytes > maxPendingBytes - retainedBytes) throw error('JXL_MEMORY', `Pending input is over maxPendingBytes (${maxPendingBytes} B): send less or raise it.`);
    return {signal, onProgress, onEncoded, onPreview, parameters, optionBytes, optionPlans};
  }
  function submit(operation, input, options = {}, acquire = null, acquiredArea = 0) {
    try {
      const {signal, onProgress, onEncoded, onPreview, parameters, optionBytes, optionPlans} = admit(options);
      if (onEncoded !== undefined && operation !== 'capture') throw error('JXL_OPTIONS', 'onEncoded is a capture option.');
      if (onPreview !== undefined && (!replies || !['encode', 'capture', 'fit', 'variants'].includes(operation))) throw error('JXL_OPTIONS', 'onPreview is an encode, capture, fit, or variants option.');
      const inputPlans = new Map(), bytes = measure(input, maxPixels, inputPlans) + optionBytes;
      if (bytes > maxPendingBytes - retainedBytes) throw error('JXL_MEMORY', `Pending input is over maxPendingBytes (${maxPendingBytes} B): send less or raise it.`);
      const ownedInput = snapshot(input, inputPlans), ownedOptions = snapshot(parameters, optionPlans);
      return new Promise((resolve, reject) => {
        const pixels = operation === 'encode' && ArrayBuffer.isView(ownedInput?.data) ? ownedInput.width * ownedInput.height : 0;
        const area = pixels || (operation === 'encode' ? acquiredArea || (SNAPSHOTS.has(input) ? SNAPSHOTS.get(input) / 4 : 0) : 0);
        const job = {id: ++nextId, operation, input: ownedInput, options: ownedOptions, bytes, pixels, area, signal, onProgress, onEncoded, onPreview, resolve, reject, settled: false, released: false, progress: -1, controller: new AbortController()};
        job.abort = () => cancel(job, aborted(signal));
        retainedBytes += bytes;
        queue.push(job);
        if (acquire) acquiring(job, acquire);
        try {
          if (!job.settled) signal?.addEventListener('abort', job.abort, {once: true});
          if (signal?.aborted) job.abort();
        } catch (reason) { cancel(job, reason); }
        schedule();
      });
    } catch (reason) { return Promise.reject(declared(reason)); }
  }
  const encoder = Object.fromEntries(operations.map(operation => [operation, (input, options) => submit(operation, input, options)]));
  encoder.acquired = (operation, acquire, cost, options, area = cost / 4) => submit(operation, withCost({}, cost), options, acquire, area);
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
  encoder.remote = !!factory;
  Object.defineProperty(encoder, 'stats', {enumerable: true, get: () => Object.freeze({queuedJobs: queue.length + held.size, queuedBytes: retainedBytes - runningBytes(), activeJobs: running.size, activeBytes: runningBytes(), closed})});
  encoder.prepare = operation => {
    const shut = () => error('JXL_CLOSED', 'The JPEG XL encoder is closed.');
    const refuse = reason => { throw closed ? shut() : declared(coded(reason)); };
    if (closed) return Promise.reject(shut());
    if (!operations.includes(operation)) return Promise.reject(error('JXL_OPTIONS', 'prepare names its operation: ' + operations.join(', ') + '.'));
    preparing++;
    const settled = () => { preparing--; rest(); };
    if (!factory) {
      runtimeLoaded = true;
      return Promise.resolve(retiring).then(() => spec.runtime()).then(({prepare}) => prepare(operation, {webgpu, owner, helpers}))
        .finally(settled).then(() => { if (closed) throw shut(); }, refuse);
    }
    return (async () => {
      await null;
      for (;;) {
        while (stopping) await stopping;
        if (closed) throw shut();
        transport ||= createTransport(host);
        try { return await transport.prepare(operation); }
        catch (reason) { if (!reason?.[REPLACED] || closed) throw reason; }
      }
    })().finally(settled).catch(refuse);
  };
  encoder.close = () => {
    if (closing) return closing;
    closed = true;
    clearTimeout(idleTimer);
    const reason = error('JXL_CLOSED', 'The JPEG XL encoder is closed.');
    const taking = [...queue, ...running.values(), ...held].map(job => job.acquiring).filter(Boolean);
    for (const job of [...queue]) cancel(job, reason, false);
    for (const job of [...running.values()]) cancel(job, reason, false);
    transport?.stop();
    return closing = Promise.allSettled([stopping, transport?.ended, releaseHelpers(true), ...taking]).then(outcomes => {
      const failed = outcomes.find(outcome => outcome.status === 'rejected');
      if (failed) throw Object.assign(error('JXL_WORKER', 'The JPEG XL worker or a helper could not be ended.'), {cause: failed.reason});
    });
  };
  return Object.freeze(encoder);
}

