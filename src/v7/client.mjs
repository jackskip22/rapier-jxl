
import {hostPendingBytes, SNAPSHOTS, withCost, record, dimensions, measure, snapshot} from './ownership.mjs';
import {fail as error, declared, callers, isCaller, PIXELS, abortError, progressOf, abortable, snapshotOptions} from './primitives.mjs';
import {createTransport, REPLACED} from './transport.mjs';
import {elsewhere, program, relocatable} from './worker-start.mjs';
import {admitFrames} from './surface.mjs';
const DEFAULT_JOBS = 32;
const HELPER_BYTES = 46137344, PIXEL_BYTES = 56;
const IDLE = 60000;
const IDLE_DEVICE = 300000;

function admittedFrames(input, plans) {
  const fields = value => plans.get(value)?.fields ?? [];
  const value = (record, name) => fields(record).find(([key]) => key === name)?.[1].value;
  const source = value(input, 'frames');
  const framePlan = plans.get(source);
  if (framePlan?.kind !== 'record' || !framePlan.array) return;
  const frames = [];
  for (const [key, descriptor] of framePlan.fields) {
    const frame = descriptor.value;
    let data = value(frame, 'data');
    const plan = plans.get(data);
    if (plan?.kind === 'view' || plan?.kind === 'handed') {
      try { data = new plan.Type(plan.buffer, plan.byteOffset, plan.byteLength / (plan.Type.BYTES_PER_ELEMENT ?? 1)); }
      catch { throw error('JXL_INPUT', "ArrayBuffer: detached or too small"); }
    }
    Object.defineProperty(frames, key, {value: frame && typeof frame === 'object' ? {data, duration: value(frame, 'duration')} : frame,
      writable: true, enumerable: true, configurable: true});
  }
  admitFrames({width: value(input, 'width'), height: value(input, 'height'), frames});
}

function positive(value, fallback, name) {
  if (value === undefined) value = fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw error('JXL_OPTIONS', `${name}: positive safe integer`);
  return value;
}
function aborted(signal) {
  try { return signal?.reason === undefined ? callers(abortError()) : callers(signal.reason); }
  catch (reason) { return callers(reason); }
}
const NO_WORKER = "Workers are unavailable here; use a page or worker, or pass workerFactory.";
const WORKER_START = "Worker did not start; serve the package from the page origin, allow blob: in worker-src, or pass workerFactory.";
function started(make, cleanup) {
  try { return make(); } catch (cause) { cleanup?.(); throw Object.assign(error('JXL_WORKER', WORKER_START), {cause}); }
}
function browserWorker(spec) {
  if (!spec.url) return started(spec.worker);
  const url = started(spec.url);
  return elsewhere(url) ? embeddedWorker(program(url.href), spec.role) : relocatable(() => started(spec.worker), url, {role: spec.role});
}

export function embeddedWorker(program, name) {
  const source = URL.createObjectURL(new Blob([program], {type: 'text/javascript'}));
  let blocked = false;
  const violation = event => {
    if (event.disposition === 'enforce' && event.effectiveDirective === 'worker-src' && (event.blockedURI === 'blob' || event.blockedURI === source)) blocked = true;
  };
  const done = () => { globalThis.document?.removeEventListener('securitypolicyviolation', violation); URL.revokeObjectURL(source); };
  globalThis.document?.addEventListener('securitypolicyviolation', violation);
  const worker = started(() => new Worker(source, {type: 'module', ...name && {name}}), done);
  worker.addEventListener('message', done, {once: true});
  worker.addEventListener('error', event => {
    done();
    if (blocked) Object.defineProperties(event, {code: {value: 'JXL_WORKER'}, message: {value: "CSP worker-src: allow blob:"}});
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
    const memory = declared(reason);
    if (memory?.code === 'JXL_MEMORY') return memory;
    let message = '';
    try { message = String(reason.message ?? ''); } catch {}
    return Object.assign(error('JXL_INTERNAL', message || "client:job"), {cause: reason});
  } catch { return reason; }
}

export {deviceHelpers, helperReservation} from './helper-reservation.mjs';
import {helperReservation} from './helper-reservation.mjs';

export function createCodec(config = {}, spec, replies) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw error('JXL_OPTIONS', "config: object");
  config = snapshotOptions(config, 'config', [], true);
  for (const key of Object.keys(config)) if (!['workerFactory', 'workerStartupTimeout', 'maxPendingBytes', 'maxPixels', 'maxPendingJobs', 'helpers', 'webgpu'].includes(key))
    throw error('JXL_OPTIONS', `unknown option: ${key}`);
  if (config.workerFactory !== undefined && typeof config.workerFactory !== 'function') throw error('JXL_OPTIONS', "workerFactory: function");
  if (config.webgpu !== undefined && config.webgpu !== 'required' && config.webgpu !== false)
    throw error('JXL_OPTIONS', "webgpu: required|false|omit");
  const webgpu = config.webgpu;
  const maxPendingBytes = positive(config.maxPendingBytes, hostPendingBytes(), 'maxPendingBytes');
  const maxPixels = positive(config.maxPixels, PIXELS, 'maxPixels');
  const helpers = helperReservation(config.helpers);
  const owner = helpers ? {} : undefined;
  const besideBytes = helpers ? helpers.memoryBytes - helpers.count * HELPER_BYTES : 0;
  const maxPendingJobs = positive(config.maxPendingJobs, DEFAULT_JOBS, 'maxPendingJobs');
  const workerStartupTimeout = positive(config.workerStartupTimeout, 15000, 'workerStartupTimeout');
  if (workerStartupTimeout > 2147483647) throw error('JXL_OPTIONS', "workerStartupTimeout: <=2147483647 ms");
  const operations = spec.operations;
  if (!spec.runtime && !config.workerFactory && typeof Worker !== 'function') throw error('JXL_WORKER', NO_WORKER);
  const factory = config.workerFactory || (!spec.runtime || typeof document !== 'undefined' && typeof Worker === 'function' ? () => browserWorker(spec) : null);
  let closed = false, nextId = 0, retainedBytes = 0, here = null, wide = null, scheduled = false, stopping = null, transport = null, closing = null, runtimeLoaded = false;
  let idleTimer, preparing = 0, retiring = null, deviceWorker = false;
  const queue = [], running = new Map(), held = new Set(), preparations = new Set();
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
    const {effort = spec.defaultEffort ?? 7} = job.operation === 'encode' && job.options || {};
    if (effort === 10) return job.operation === 'encode';
    return job.operation === 'encode' && job.area >= 500000 && effort >= 7;
  };
  function schedule() {
    if (scheduled || closed || stopping || !queue.length || lane(queue[0]) < 0) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; pump(); });
  }
  function retainInput(job, bytes) {
    if (job.settled || job.released) throw aborted(job.controller.signal);
    const previous = job.expandedBytes ?? 0;
    if (!Number.isSafeInteger(bytes) || bytes < previous) throw error('JXL_WORKER', 'worker input bytes: invalid');
    const added = bytes - previous;
    if (added > maxPendingBytes - retainedBytes) throw error('JXL_MEMORY', `maxPendingBytes ${maxPendingBytes}: needs ${added} B`);
    retainedBytes += added; job.bytes += added; job.expandedBytes = bytes;
  }
  function release(job) {
    if (job.released || job.acquiring) return;
    job.released = true;
    retainedBytes -= job.bytes;
    job.input = job.options = null;
    if (job.onPreview) { replies.clear(job); job.onPreview = null; }
    job.onFrame = job.framing = null;
    running.delete(job.id);
    if (here === job) here = null;
    if (wide === job) wide = null;
    schedule();
    rest();
  }
  const idle = () => !closed && !stopping && !retiring && !preparing && !queue.length && !running.size && !held.size;
  function rest() {
    clearTimeout(idleTimer);
    if (factory ? transport : owner && runtimeLoaded) (idleTimer = setTimeout(retire, !factory || !deviceWorker ? IDLE : hidden() ? 0 : IDLE_DEVICE)).unref?.();
  }
  function retire() {
    if (!idle()) return;
    if (factory) { deviceWorker = false; transport.stop(); }
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
    job.controller.abort(reason);
    if (job.finished) return;
    if (running.get(job.id) === job) {
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
    try { (job.report ??= progressOf(job.onProgress, job.controller.signal, reason => cancel(job, reason)))?.(fraction); }
    catch (reason) { cancel(job, reason); }
  }
  function preview(job, record) {
    if (job.settled) return;
    const observer = job.onPreview;
    try { return job.observing = Promise.resolve(observer?.(record)).catch(reason => { cancel(job, reason); }); }
    catch (reason) { cancel(job, reason); }
  }
  function frame(job, value, index, ack) {
    if (job.settled || !job.onFrame) return;
    job.framing = Promise.resolve(job.framing).then(async () => { if (job.settled) return; await job.onFrame(value, index); ack?.(); }).catch(reason => { cancel(job, reason); });
  }
  async function complete(job, ok, value) {
    if (job.finished) return;
    job.finished = true;
    try {
      if (ok) { progress(job, 1); await job.report?.finish(); await abortable(job.observing, job.controller.signal); await abortable(job.framing, job.controller.signal); }
      settle(job, ok, value);
    } catch (reason) { settle(job, false, reason, true); }
    finally { release(job); }
  }
  const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
  const onVisibility = () => { if (hidden() && deviceWorker && idle()) { clearTimeout(idleTimer); retire(); } };
  let watching = false;
  const deviceHeld = on => {
    deviceWorker = on;
    if (on && !watching && factory && typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      watching = true; document.addEventListener('visibilitychange', onVisibility);
    }
  };
  const host = {frame, deviceHeld, factory, module: spec.module, file: (() => { try { return spec.url?.().pathname.split('/').pop(); } catch { return undefined; } })(), maxPixels, helpers, retainInput, webgpu, workerStartupTimeout, complete, progress, preview, replyPreview: replies?.reply, schedule, running,
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
    job.acquiring = taking.then(input => { job.taken = input; }, reason => { job.refused = reason ?? error('JXL_INPUT', "canvas: redraw or RGBA"); })
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
      Promise.resolve(retiring).then(() => spec.runtime()).then(({run}) => { runtimeLoaded = true; return run(job.operation, job.input, job.options, {signal: job.controller.signal, onProgress: fraction => progress(job, fraction), ...(job.onFrame && {onFrame: (value, index) => job.onFrame(value, index)}), ...(job.onPreview && {onPreview: record => preview(job, record)}), maxPixels, retainInput: bytes => retainInput(job, bytes), helpers, webgpu, owner, lane: job.lane, alone: job.alone}); })
        .then(value => complete(job, true, value), reason => complete(job, false, coded(reason, job)));
    }
  }
  function admit(options = {}, inputBytes = 0) {
    if (closed) throw error('JXL_CLOSED', "closed");
    if (!options || typeof options !== 'object') throw error('JXL_OPTIONS', "options: object");
    let fields;
    try { fields = record(options); }
    catch (reason) { throw !reason?.code || reason.code === 'JXL_INPUT' ? error('JXL_OPTIONS', "options: plain data fields") : reason; }
    if (Array.isArray(options)) throw error('JXL_OPTIONS', "options: object");
    const {signal, onProgress, onPreview, onFrame, ...parameters} = Object.fromEntries(fields.map(([key, descriptor]) => [key, descriptor.value]));
    if (signal !== undefined && (!signal || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function' || typeof signal.aborted !== 'boolean')) throw error('JXL_OPTIONS', "signal: AbortSignal");
    if (onProgress !== undefined && typeof onProgress !== 'function') throw error('JXL_OPTIONS', "onProgress: function");
    if (onPreview !== undefined && typeof onPreview !== 'function') throw error('JXL_OPTIONS', "onPreview: function");
    if (onFrame !== undefined && typeof onFrame !== 'function') throw error('JXL_OPTIONS', "onFrame: function");
    if (signal?.aborted) throw aborted(signal);
    if (queue.length + running.size + held.size >= maxPendingJobs) throw error('JXL_MEMORY', "maxPendingJobs: queue full");
    const optionPlans = new Map();
    let optionBytes;
    try { optionBytes = measure(parameters, Number.MAX_SAFE_INTEGER, optionPlans); }
    catch (reason) { throw reason?.code === 'JXL_INPUT' ? error('JXL_OPTIONS', "callbacks: onProgress|onPreview|onFrame") : reason; }
    if (inputBytes + optionBytes > maxPendingBytes - retainedBytes) throw error('JXL_MEMORY', `maxPendingBytes ${maxPendingBytes}: needs ${inputBytes + optionBytes} B`);
    return {signal, onProgress, onPreview, onFrame, parameters, optionBytes, optionPlans};
  }
  function submit(operation, input, options = {}, acquire = null, acquiredArea = 0) {
    try {
      const {signal, onProgress, onPreview, onFrame, parameters, optionBytes, optionPlans} = admit(options);
      if (onFrame !== undefined && operation !== 'decode') throw error('JXL_OPTIONS', "onFrame: decode only");
      if (onPreview !== undefined && (!replies || !['encode', 'capture', 'fit', 'variants'].includes(operation))) throw error('JXL_OPTIONS', "onPreview: unsupported operation");
      spec.admitInput?.(operation, input);
      const inputPlans = new Map(), bytes = measure(input, maxPixels, inputPlans) + optionBytes;
      if (bytes > maxPendingBytes - retainedBytes) throw error('JXL_MEMORY', `maxPendingBytes ${maxPendingBytes}: needs ${bytes} B`);
      if (operation === 'encode') admittedFrames(input, inputPlans);
      const taken = new Map(), ownedInput = snapshot(input, inputPlans, undefined, taken), ownedOptions = snapshot(parameters, optionPlans, undefined, taken);
      return new Promise((resolve, reject) => {
        const pixels = operation === 'encode' && ArrayBuffer.isView(ownedInput?.data) ? ownedInput.width * ownedInput.height : 0;
        const area = pixels || (operation === 'encode' ? acquiredArea || (SNAPSHOTS.has(input) ? SNAPSHOTS.get(input) / 4 : 0) : 0);
        const job = {id: ++nextId, operation, input: ownedInput, options: ownedOptions, bytes, pixels, area, signal, onProgress, onPreview, onFrame, resolve, reject, settled: false, released: false, progress: -1, controller: new AbortController()};
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
      if (!Number.isSafeInteger(byteLength) || byteLength < 1) throw error('JXL_INPUT', "image bytes: nonempty RGBA");
      inputBytes = byteLength + 8 + measure({width, height, colorSpace}, maxPixels);
    }
    admit(options, inputBytes);
  };
  encoder.remote = !!factory;
  Object.defineProperty(encoder, 'stats', {enumerable: true, get: () => Object.freeze({queuedJobs: queue.length + held.size, queuedBytes: retainedBytes - runningBytes(), activeJobs: running.size, activeBytes: runningBytes(), closed})});
  encoder.prepare = (operation = operations.includes('capture') && !operations.includes('encode') ? 'capture' : operations[0]) => {
    const shut = () => error('JXL_CLOSED', "closed");
    const refuse = reason => { throw closed ? shut() : declared(coded(reason)); };
    if (closed) return Promise.reject(shut());
    if (!operations.includes(operation)) return Promise.reject(error('JXL_OPTIONS', "prepare operation: " + operations.join(', ')));
    preparing++;
    const settled = () => { preparing--; rest(); };
    if (!factory) {
      const pending = Promise.resolve(retiring).then(() => { if (closed) throw shut(); return spec.runtime(); })
        .then(({prepare}) => { runtimeLoaded = true; if (closed) throw shut(); return prepare(operation, {webgpu, owner, helpers}); })
        .finally(settled).then(() => { if (closed) throw shut(); }, refuse);
      preparations.add(pending);
      const forget = () => preparations.delete(pending);
      pending.then(forget, forget);
      return pending;
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
    if (watching) { watching = false; document.removeEventListener('visibilitychange', onVisibility); }
    const reason = error('JXL_CLOSED', "closed");
    const taking = [...queue, ...running.values(), ...held].map(job => job.acquiring).filter(Boolean);
    for (const job of [...queue]) cancel(job, reason, false);
    for (const job of [...running.values()]) cancel(job, reason, false);
    transport?.stop();
    const prepared = Promise.allSettled([...preparations]).then(() => releaseHelpers(true));
    return closing = Promise.allSettled([stopping, transport?.ended, prepared, ...taking]).then(outcomes => {
      const failed = outcomes.find(outcome => outcome.status === 'rejected');
      if (failed) throw Object.assign(error('JXL_WORKER', "worker: cleanup failed"), {cause: failed.reason});
    });
  };
  return Object.freeze(encoder);
}

