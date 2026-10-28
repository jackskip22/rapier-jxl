import {WORKER_PROTOCOL} from './protocol.mjs';

function blob(value) { return typeof Blob === 'function' && value instanceof Blob; }
function transfers(value, buffers = new Set(), seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value) || blob(value)) return buffers;
  seen.add(value);
  if (value instanceof ArrayBuffer) buffers.add(value);
  else if (ArrayBuffer.isView(value)) buffers.add(value.buffer);
  else for (const item of Object.values(value)) transfers(item, buffers, seen);
  return buffers;
}

function error(code, message) { return Object.assign(new Error(message), {code}); }
function listen(target, type, callback) {
  if (typeof target.addEventListener === 'function') {
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
  const {factory, maxPixels, helpers, workerStartupTimeout, complete, progress, schedule, running} = host;
  let thread = null, generation = 0;
  function stopThread(reason = error('JXL_WORKER', 'The JPEG XL worker stopped.')) {
    const old = thread;
    if (!old) return;
    thread = null;
    generation++;
    clearTimeout(old.timer);
    for (const remove of old.listeners) remove();
    let result;
    try { result = old.worker.terminate(); } catch { return; }
    if (result && typeof result.then === 'function') {
      const wait = Promise.resolve(result).catch(() => {}).finally(() => { if (host.stopping === wait) host.stopping = null; schedule(); });
      host.stopping = wait;
    }
    for (const job of [...running.values()]) complete(job, false, reason);
  }
  function crash(current, event) {
    if (thread !== current || current.generation !== generation) return;
    const reason = error(event?.code || 'JXL_WORKER', event?.message || event?.error?.message || 'The JPEG XL worker stopped.');
    stopThread(reason);
    schedule();
  }
  function send(current, job) {
    if (!current.ready || job.sent || job.settled || thread !== current || running.get(job.id) !== job) return;
    try {
      current.worker.postMessage({id: job.id, operation: job.operation, input: job.input, options: job.options, maxPixels, helpers, lane: job.lane, alone: job.alone}, [...transfers([job.input, job.options])]);
      job.sent = true;
      job.input = job.options = null;
    } catch (reason) { complete(job, false, reason); stopThread(); }
  }
  function cancel(job) {
    if (!job.sent) { complete(job, false, undefined); return; }
    try { thread?.worker.postMessage({cancel: job.id}); } catch { stopThread(); }
  }
  function openThread() {
    if (thread) return thread;
    const worker = factory();
    if (!worker || typeof worker.postMessage !== 'function' || typeof worker.terminate !== 'function') throw error('JXL_OPTIONS', 'workerFactory must return a new Worker.');
    const current = {worker, generation: ++generation, listeners: [], ready: false, timer: null};
    thread = current;
    try {
      current.listeners.push(listen(worker, 'message', ({data}) => {
        if (thread !== current || generation !== current.generation) return;
        if (data?.ready !== undefined) {
          if (data.ready !== WORKER_PROTOCOL) { crash(current, {code: 'JXL_PROTOCOL', message: 'The worker belongs to a different JPEG XL protocol.'}); return; }
          current.ready = true; clearTimeout(current.timer);
          for (const job of running.values()) send(current, job);
          return;
        }
        if (!current.ready) { crash(current, {code: 'JXL_PROTOCOL', message: 'The worker replied before identifying its protocol.'}); return; }
        const job = running.get(data?.id);
        if (!job) return;
        if ('progress' in data) { progress(job, data.progress); return; }
        if (data.ok === true) complete(job, true, data.value);
        else if (data.ok === false) complete(job, false, Object.assign(new Error(data.error?.message || 'JPEG XL operation failed.'), {name: data.error?.name || 'Error', code: data.error?.code || 'JXL_WORKER'}));
        else crash(current, {message: 'The JPEG XL worker returned an invalid reply.'});
      }));
      current.listeners.push(listen(worker, 'error', event => crash(current, event)));
      current.listeners.push(listen(worker, 'messageerror', event => crash(current, event)));
      if (typeof worker.on === 'function') current.listeners.push(listen(worker, 'exit', () => crash(current)));
      current.timer = setTimeout(() => crash(current, {code: 'JXL_WORKER_TIMEOUT', message: 'The JPEG XL worker did not become ready in time.'}), workerStartupTimeout);
      current.timer.unref?.();
    } catch (reason) { stopThread(); throw reason; }
    return current;
  }
  return {open: openThread, send, cancel, stop: stopThread, get generation() { return generation; }};
}
