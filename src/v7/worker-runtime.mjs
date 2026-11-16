import {configureModules} from '../wasm-modules.mjs';
import {WORKER_PROTOCOL} from './protocol.mjs';
import {abortError, outOfMemory} from '../fault.mjs';

function transferable(value, buffers = new Set(), seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return buffers;
  seen.add(value);
  if (value instanceof ArrayBuffer) buffers.add(value);
  else if (ArrayBuffer.isView(value)) buffers.add(value.buffer);
  else for (const item of Object.values(value)) transferable(item, buffers, seen);
  return buffers;
}

const INSTALLED = Symbol.for('rapier-jxl.worker-runtime');

export function failure(reason, named = false) {
  let name = 'Error', code = 'JXL_INTERNAL', message = "Image job failed; report the input and options.";
  try { const value = reason?.name; if (typeof value === 'string' && value) name = value; } catch {}
  try { const value = reason?.code; if (typeof value === 'string' && value.startsWith('JXL_')) code = value; } catch {}
  try {
    const value = reason?.message ?? reason;
    if (value === null || typeof value !== 'object' && typeof value !== 'function')
      message = value === '' && reason && typeof reason === 'object' ? name : String(value);
  } catch {}
  if (code === 'JXL_INTERNAL' && outOfMemory(reason)) {
    code = 'JXL_MEMORY';
    message = `Not enough memory for this picture${message ? ` (${message})` : ''}; free memory or use a smaller picture.`;
  }
  return named ? {name, code, message} : {code, message};
}

export function workerPort() {
  try { const port = globalThis.process?.getBuiltinModule?.('node:worker_threads')?.parentPort; if (port) return port; } catch {}
  const own = globalThis;
  return typeof own.postMessage === 'function' && typeof own.addEventListener === 'function' && typeof own.document === 'undefined' ? own : null;
}

export function install(port, pending = [], runtime, previewHub) {
  const {run, prepare} = runtime;
  if (!port || typeof port.postMessage !== 'function' || typeof port.on !== 'function' && typeof port.addEventListener !== 'function') return;
  if (port[INSTALLED]) return;
  try { Object.defineProperty(port, INSTALLED, {value: true}); } catch {}
  let here = false, configurationError;
  const previews = previewHub?.(port);
  const owner = {}, running = new Map();
  const reply = (id, reason) => port.postMessage({id, ok: false, error: failure(reason, true)});
  const receive = message => {
    if (!message) return;
    if (previews?.ack(message)) return;
    if (message.wasmModules) {
      try { configureModules(message.wasmModules); }
      catch (error) { configurationError = {code: error?.code || 'JXL_WASM', message: error?.message || 'The precompiled WebAssembly modules are invalid; prepare them again in this host.'}; port.postMessage({configurationError}); }
      return;
    }
    if (configurationError) {
      if (message.prepare) port.postMessage({prepared: true, attempt: message.attempt, ok: false, error: configurationError});
      else if (message.id) reply(message.id, configurationError);
      return;
    }
    if (typeof message.prepare === 'string') {
      prepare(message.prepare, {webgpu: message.webgpu, owner, helpers: message.helpers})
        .then(() => port.postMessage({prepared: true, attempt: message.attempt, ok: true}), reason => port.postMessage({prepared: true, attempt: message.attempt, ok: false, error: failure(reason)}));
      return;
    }
    if (message.cancel !== undefined) { running.get(message.cancel)?.controller.abort(abortError()); return; }
    if (message.inputAck !== undefined) {
      const job = running.get(message.id), waiting = job?.waiting;
      if (waiting?.sequence === message.inputAck) {
        job.waiting = null;
        message.ok === true ? waiting.resolve() : waiting.reject(Object.assign(new Error(message.error?.message || 'Input reservation refused.'), {code: message.error?.code || 'JXL_WORKER'}));
      }
      return;
    }
    if (!Number.isSafeInteger(message.id) || message.id < 1) return;
    const {id, operation, input, options, maxPixels, helpers, webgpu, lane, alone} = message;
    const arrived = typeof ImageBitmap === 'function' && input instanceof ImageBitmap || typeof VideoFrame === 'function' && input instanceof VideoFrame;
    if (message.bitmap === true && !arrived) { reply(id, Object.assign(new Error("Bitmap did not reach the worker; pass a live bitmap and retry."), {code: 'JXL_INPUT'})); return; }
    const beside = lane === 1 && helpers && running.size - here < helpers.count;
    if (running.has(id) || (here && !beside)) { reply(id, Object.assign(new Error("Worker already has an active operation; wait for it to finish."), {code: 'JXL_BUSY'})); return; }
    const controller = new AbortController();
    const preview = message.preview === true ? previews?.start(id, controller.signal) : undefined;
    const job = {controller, sequence: 0, waiting: null};
    running.set(id, job);
    const stopInput = () => { const waiting = job.waiting; job.waiting = null; waiting?.reject(controller.signal.reason ?? abortError()); };
    controller.signal.addEventListener('abort', stopInput, {once: true});
    const retainInput = bytes => new Promise((resolve, reject) => {
      if (controller.signal.aborted) { reject(controller.signal.reason); return; }
      const sequence = ++job.sequence;
      job.waiting = {sequence, resolve, reject};
      try { port.postMessage({id, inputBytes: bytes, inputSequence: sequence}); }
      catch (error) { job.waiting = null; reject(error); }
    });
    if (!beside) here = true;
    const done = () => { preview?.close(); stopInput(); controller.signal.removeEventListener('abort', stopInput); running.delete(id); if (!beside) here = false; };
    Promise.resolve().then(() => run(operation, input, options, {maxPixels, retainInput, helpers, webgpu, owner, lane: beside ? 1 : 0, alone, signal: controller.signal, onProgress: progress => port.postMessage({id, progress}), ...(preview && {onPreview: preview.send})})).then(value => {
      done();
      try { port.postMessage({id, ok: true, value}, [...transferable(value)]); } catch (reason) { reply(id, reason); }
    }, reason => { done(); reply(id, reason); });
  };
  if (typeof port.on === 'function') port.on('message', receive);
  else {
    port.addEventListener('message', event => receive(event.data));
    port.start?.();
  }
  port.postMessage({ready: WORKER_PROTOCOL, ...(runtime.module && {module: runtime.module})});
  for (const message of pending) receive(message);
}
