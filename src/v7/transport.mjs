import {suppliedWasm} from '../wasm-modules.mjs';
import {WORKER_PROTOCOL} from './protocol.mjs';
import {fail as error, callers} from './primitives.mjs';
export const REPLACED = Symbol('replaced');

function blob(value) { return typeof Blob === 'function' && value instanceof Blob; }
function transfers(value, buffers = new Set(), seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value) || blob(value)) return buffers;
  seen.add(value);
  if (value instanceof ArrayBuffer) buffers.add(value);
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
  throw error('JXL_OPTIONS', 'workerFactory must return a Worker with message and error events.');
}

export function createTransport(host) {
  const {factory, module, maxPixels, helpers, webgpu, workerStartupTimeout, complete, progress, schedule, running} = host;
  let thread = null, generation = 0, ended, failed;
  function stopThread(reason = Object.assign(error('JXL_WORKER', 'The JPEG XL worker stopped.'), {[REPLACED]: true})) {
    const old = thread;
    if (!old) return;
    thread = null;
    generation++;
    clearTimeout(old.timer);
    for (const waiter of old.prepareWaiters.values()) waiter.reject(reason);
    for (const remove of old.listeners) remove();
    for (const waiter of old.waiters) waiter.reject(reason);
    let result;
    try { result = old.worker.terminate(); } catch (reason) { result = Promise.reject(reason); }
    const end = Promise.resolve(result).then(() => {}, reason => { failed ??= {reason}; throw reason; });
    end.catch(() => {});
    ended = Promise.allSettled([ended, end]).then(() => { if (failed) throw failed.reason; });
    ended.catch(() => {});
    if (result && typeof result.then === 'function') {
      const wait = end.catch(() => {}).finally(() => { if (host.stopping === wait) host.stopping = null; schedule(); });
      host.stopping = wait;
    }
    for (const job of [...running.values()]) complete(job, false, reason);
  }
  function crash(current, event) {
    if (thread !== current) return;
    const reason = error(typeof event?.code === 'string' && event.code.startsWith('JXL_') ? event.code : 'JXL_WORKER', event?.message || event?.error?.message || 'The JPEG XL worker stopped.');
    stopThread(reason);
    schedule();
  }
  function send(current, job) {
    if (!current.ready || job.sent || job.settled || thread !== current || running.get(job.id) !== job) return;
    try {
      current.worker.postMessage({id: job.id, operation: job.operation, input: job.input, options: job.options, maxPixels, helpers, webgpu, lane: job.lane, alone: job.alone}, [...transfers([job.input, job.options])]);
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
    try { worker = factory(); }
    catch (cause) { throw callers(cause); }
    if (!worker || typeof worker.postMessage !== 'function' || typeof worker.terminate !== 'function') throw error('JXL_OPTIONS', 'workerFactory must return a new Worker.');
    generation++;
    const current = {worker, listeners: [], ready: false, timer: null, waiters: [], preparations: new Map(), prepareWaiters: new Map(), prepareAttempt: 0};
    thread = current;
    try {
      current.listeners.push(listen(worker, 'message', ({data}) => {
        if (thread !== current) return;
        if (data?.ready !== undefined) {
          if (current.ready && data.ready === WORKER_PROTOCOL) return;
          if (data.ready !== WORKER_PROTOCOL) { crash(current, {code: 'JXL_WORKER', message: 'The worker belongs to a different JPEG XL protocol.'}); return; }
          if (data.module !== module) { crash(current, {code: 'JXL_WORKER', message: `This worker runs ${data.module ?? 'the rapier-jxl queue entry'}; this codec runs ${module ?? 'the rapier-jxl queue entry'}. Give it that module's worker file.`}); return; }
          current.ready = true; clearTimeout(current.timer);
          for (const waiter of current.waiters.splice(0)) waiter.resolve(current);
          for (const job of running.values()) send(current, job);
          return;
        }
        if (data?.configurationError) { crash(current, data.configurationError); return; }
        if (!current.ready) { crash(current, {code: 'JXL_WORKER', message: 'The worker replied before identifying its protocol.'}); return; }
        if (data?.prepared === true) {
          const waiter = current.prepareWaiters.get(data.attempt);
          if (!waiter) return;
          current.prepareWaiters.delete(data.attempt);
          if (data.ok === true) waiter.resolve();
          else waiter.reject(error(data.error?.code || 'JXL_WASM', data.error?.message || 'Could not prepare the JPEG XL WebAssembly core.'));
          return;
        }
        const job = running.get(data?.id);
        if (!job) return;
        if ('progress' in data) { progress(job, data.progress); return; }
        if (data.ok === true) complete(job, true, data.value);
        else if (data.ok === false) complete(job, false, Object.assign(new Error(data.error?.message || 'JPEG XL operation failed.'), {name: data.error?.name || 'Error', code: data.error?.code || 'JXL_WORKER'}));
        else crash(current, {message: 'The JPEG XL worker returned an invalid reply.'});
      }));
      current.listeners.push(listen(worker, 'error', event => crash(current, event)));
      current.listeners.push(listen(worker, 'messageerror', event => crash(current, event)));
      if (typeof worker.on === 'function' && typeof worker.off === 'function') current.listeners.push(listen(worker, 'exit', () => crash(current)));
      current.timer = setTimeout(() => crash(current, {code: 'JXL_WORKER_TIMEOUT', message: 'The JPEG XL worker did not become ready in time.'}), workerStartupTimeout);
      current.timer.unref?.();
      const modules = suppliedWasm(true);
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
