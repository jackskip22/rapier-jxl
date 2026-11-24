import {shownEntry} from './entry-name.mjs';
import {suppliedWasm} from '../wasm-modules.mjs';
import {WORKER_PROTOCOL} from './protocol.mjs';
import {fail as error, callers, isBlob} from './primitives.mjs';
import {isImageResult} from './result-shape.mjs';
import {failure} from './worker-runtime.mjs';
export const REPLACED = Symbol('replaced');
const workerUnloaded = file => `The JPEG XL worker did not load. Copy ${file ?? "the module's own file"} from the package's dist folder beside the bundle, or pass workerFactory.`;
const IMAGE_OPERATIONS = new Set(['encode', 'capture', 'recompress', 'restore', 'fit', 'format']);

function blob(value) { return isBlob(value); }
const isBitmap = value => typeof ImageBitmap === 'function' && value instanceof ImageBitmap || typeof VideoFrame === 'function' && value instanceof VideoFrame;
function transfers(value, buffers = new Set(), seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value) || blob(value) || isBitmap(value)) return buffers;
  seen.add(value);
  if (value instanceof ArrayBuffer || typeof MessagePort === 'function' && value instanceof MessagePort) buffers.add(value);
  else if (ArrayBuffer.isView(value)) buffers.add(value.buffer);
  else for (const item of Object.values(value)) transfers(item, buffers, seen);
  return buffers;
}

function listen(target, type, callback) {
  if (typeof target.addEventListener === 'function' && typeof target.removeEventListener === 'function') {
    target.addEventListener(type, callback);
    return () => target.removeEventListener(type, callback);
  }
  if (typeof target.on === 'function' && typeof target.off === 'function') {
    const handler = type === 'message' ? value => callback({data: value}) : callback;
    target.on(type, handler);
    return () => target.off(type, handler);
  }
  throw error('JXL_OPTIONS', "workerFactory: Worker instance");
}

export function createTransport(host) {
  const {factory, module, maxPixels, helpers, retainInput, webgpu, workerStartupTimeout, complete, progress, preview, replyPreview, schedule, running} = host;
  let thread = null, generation = 0, ended, failed;
  function stopThread(reason = Object.assign(error('JXL_WORKER', "worker: restart"), {[REPLACED]: true})) {
    const old = thread;
    if (!old) return;
    thread = null;
    generation++;
    clearTimeout(old.timer);
    for (const waiter of old.prepareWaiters.values()) waiter.reject(reason);
    for (const remove of old.listeners) {
      try { remove(); } catch (reason) { failed ??= {reason}; }
    }
    for (const waiter of old.waiters) waiter.reject(reason);
    let result;
    try { result = old.worker.terminate(); } catch (reason) { result = Promise.reject(reason); }
    const end = new Promise(resolve => resolve(result)).then(() => {}, reason => { failed ??= {reason}; throw reason; });
    end.catch(() => {});
    ended = Promise.allSettled([ended, end]).then(() => { if (failed) throw failed.reason; });
    ended.catch(() => {});
    if (result && (typeof result === 'object' || typeof result === 'function')) {
      const wait = end.catch(() => {}).finally(() => { if (host.stopping === wait) host.stopping = null; schedule(); });
      host.stopping = wait;
    }
    for (const job of [...running.values()]) complete(job, false, reason);
  }
  function crash(current, event) {
    if (thread !== current) return;
    const unloaded = !current.ready && event?.type === 'error' && !event.message && !event.error;
    const reason = error(typeof event?.code === 'string' && event.code.startsWith('JXL_') ? event.code : 'JXL_WORKER', event?.message || event?.error?.message || (unloaded ? workerUnloaded(host.file) : "worker: restart"));
    stopThread(reason);
    schedule();
  }
  function send(current, job) {
    if (!current.ready || !job.started || job.sent || job.settled || thread !== current || running.get(job.id) !== job) return;
    const bitmap = isBitmap(job.input);
    try {
      current.worker.postMessage({id: job.id, operation: job.operation, input: job.input, options: job.options, ...(bitmap && {bitmap: true}), ...(job.onPreview && {preview: true}), ...(job.onFrame && {frames: true}), maxPixels, helpers, webgpu, lane: job.lane, alone: job.alone}, [...transfers([job.input, job.options])]);
      job.sent = true;
      job.input = job.options = null;
    } catch (reason) { try { complete(job, false, reason); } finally { stopThread(); } }
  }
  function cancel(job) {
    if (!job.sent) { complete(job, false, undefined); return; }
    try { thread?.worker.postMessage({cancel: job.id}); } catch { stopThread(); }
  }
  function openThread() {
    if (thread) return thread;
    let worker;
    try {
      worker = factory();
      if (worker && typeof worker.then === 'function') Promise.resolve(worker).catch(() => {});
    }
    catch (cause) { throw callers(cause); }
    if (!worker || typeof worker.postMessage !== 'function' || typeof worker.terminate !== 'function') throw error('JXL_OPTIONS', "workerFactory: fresh Worker per call");
    generation++;
    const current = {worker, listeners: [], ready: false, timer: null, waiters: [], preparations: new Map(), prepareWaiters: new Map(), prepareAttempt: 0};
    thread = current;
    try {
      current.listeners.push(listen(worker, 'message', ({data}) => {
        if (thread !== current) return;
        if (data?.ready !== undefined) {
          if (current.ready && data.ready === WORKER_PROTOCOL) return;
          if (data.ready !== WORKER_PROTOCOL) { crash(current, {code: 'JXL_WORKER', message: "worker protocol: mismatch"}); return; }
          if (data.module !== module) { crash(current, {code: 'JXL_WORKER', message: `worker module ${data.module ? shownEntry(data.module) : "unnamed"}: use ${shownEntry(module)}`}); return; }
          current.ready = true; clearTimeout(current.timer);
          for (const waiter of current.waiters.splice(0)) waiter.resolve(current);
          for (const job of running.values()) send(current, job);
          return;
        }
        if (data?.configurationError) { crash(current, data.configurationError); return; }
        if (!current.ready) { crash(current, {code: 'JXL_WORKER', message: "worker: reply before ready"}); return; }
        if (data?.prepared === true) {
          const waiter = current.prepareWaiters.get(data.attempt);
          if (!waiter) return;
          current.prepareWaiters.delete(data.attempt);
          if (data.ok === true) waiter.resolve();
          else waiter.reject(error(data.error?.code || 'JXL_WASM', data.error?.message || 'WebAssembly SIMD: enable'));
          return;
        }
        const job = running.get(data?.id);
        if (!job) return;
        if ('inputBytes' in data) {
          if (job.settled) return;
          let ok = false, refusal;
          try {
            if (!Number.isSafeInteger(data.inputSequence) || data.inputSequence !== (job.inputSequence ?? 0) + 1)
              throw error('JXL_WORKER', 'worker input reservation: sequence mismatch');
            retainInput(job, data.inputBytes); job.inputSequence = data.inputSequence; ok = true;
          } catch (error) {
            refusal = failure(error);
            if (refusal.code === 'JXL_WORKER') { crash(current, refusal); return; }
          }
          try { current.worker.postMessage({id: job.id, inputAck: data.inputSequence, ok, ...(!ok && {error: refusal})}); }
          catch (error) { crash(current, error); }
          return;
        }
        if ('progress' in data) { progress(job, data.progress); return; }
        if ('frame' in data) {
          if (job.onFrame && !job.settled) host.frame(job, data.frame, data.frameIndex, () => {
            if (thread === current && running.get(job.id) === job && !job.settled) current.worker.postMessage({id: job.id, frameAck: data.frameSequence});
          });
          return;
        }
        if ('preview' in data) {
          if (job.onPreview && !job.settled) replyPreview(job, data.preview, data.previewSequence, value => preview(job, value), () => {
            if (thread === current && running.get(job.id) === job && !job.settled) current.worker.postMessage({id: job.id, previewAck: data.previewSequence});
          });
          return;
        }
        if (data.ok === true || data.ok === false) host.deviceHeld?.(data.device === true);
        if (data.ok === true) {
          if (IMAGE_OPERATIONS.has(job.operation) && !isImageResult(data.value) ||
              job.operation === 'variants' && (!Array.isArray(data.value) || !data.value.length || !data.value.every(isImageResult)))
            complete(job, false, error('JXL_WORKER', "worker result: invalid"));
          else complete(job, true, data.value);
        } else if (data.ok === false) complete(job, false, Object.assign(new Error(data.error?.message || 'worker: retry operation'), {name: data.error?.name || 'Error', code: data.error?.code || 'JXL_WORKER'}));
        else crash(current, {message: 'worker reply: invalid'});
      }));
      current.listeners.push(listen(worker, 'error', event => crash(current, event)));
      current.listeners.push(listen(worker, 'messageerror', event => crash(current, event)));
      if (typeof worker.on === 'function' && typeof worker.off === 'function') current.listeners.push(listen(worker, 'exit', () => crash(current)));
      current.timer = setTimeout(() => crash(current, {code: 'JXL_WORKER', message: `worker startup ${workerStartupTimeout}ms: check URL/CSP/workerStartupTimeout`}), workerStartupTimeout);
      current.timer.unref?.();
      const modules = suppliedWasm();
      if (modules) worker.postMessage({wasmModules: modules});
    } catch (reason) { stopThread(reason?.code === 'JXL_OPTIONS' ? reason : undefined); throw reason; }
    return current;
  }
  function ready() {
    const current = openThread();
    return current.ready ? Promise.resolve(current) : new Promise((resolve, reject) => current.waiters.push({resolve, reject}));
  }
  function prepare(operation) {
    const current = openThread();
    const pending = current.preparations.get(operation);
    if (pending) return pending;
    const attempt = ++current.prepareAttempt;
    const waiter = {};
    const preparation = new Promise((resolve, reject) => {
      waiter.resolve = resolve; waiter.reject = reject;
      current.prepareWaiters.set(attempt, waiter);
      try { current.worker.postMessage({prepare: operation, attempt, webgpu, helpers}); } catch (reason) { crash(current, reason); }
    });
    current.preparations.set(operation, preparation);
    preparation.catch(() => { if (current.preparations.get(operation) === preparation) current.preparations.delete(operation); });
    return preparation;
  }
  return {open: openThread, ready, prepare, send, cancel, stop: stopThread, get generation() { return generation; }, get ended() { return ended; }};
}
