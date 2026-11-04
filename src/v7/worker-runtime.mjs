import {configureModules} from '../wasm-modules.mjs';
import {WORKER_PROTOCOL} from './protocol.mjs';

function transferable(value, buffers = new Set(), seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return buffers;
  seen.add(value);
  if (value instanceof ArrayBuffer) buffers.add(value);
  else if (ArrayBuffer.isView(value)) buffers.add(value.buffer);
  else for (const item of Object.values(value)) transferable(item, buffers, seen);
  return buffers;
}

const INSTALLED = Symbol.for('rapier-jxl.worker-runtime');

function failure(reason, named = false) {
  let name = 'Error', code = 'JXL_INTERNAL', message = 'The JPEG XL operation failed.';
  try { const value = reason?.name; if (typeof value === 'string' && value) name = value; } catch {}
  try { const value = reason?.code; if (typeof value === 'string' && value.startsWith('JXL_')) code = value; } catch {}
  try {
    const value = reason?.message ?? reason;
    if (value === null || typeof value !== 'object' && typeof value !== 'function')
      message = value === '' && reason && typeof reason === 'object' ? name : String(value);
  } catch {}
  return named ? {name, code, message} : {code, message};
}

export function workerPort() {
  try { const port = globalThis.process?.getBuiltinModule?.('node:worker_threads')?.parentPort; if (port) return port; } catch {}
  const own = globalThis;
  return typeof own.postMessage === 'function' && typeof own.addEventListener === 'function' && typeof own.document === 'undefined' ? own : null;
}

export function install(port, pending = [], runtime) {
  const {run, prepare} = runtime;
  if (!port || typeof port.postMessage !== 'function' || typeof port.on !== 'function' && typeof port.addEventListener !== 'function') return;
  if (port[INSTALLED]) return;
  try { Object.defineProperty(port, INSTALLED, {value: true}); } catch {}
  let here = false, configurationError;
  const owner = {}, running = new Map();
  const reply = (id, reason) => port.postMessage({id, ok: false, error: failure(reason, true)});
  const receive = message => {
    if (!message) return;
    if (message.wasmModules) {
      try { configureModules(message.wasmModules); }
      catch (error) { configurationError = {code: error?.code || 'JXL_WASM', message: error?.message || 'Invalid precompiled WebAssembly modules.'}; port.postMessage({configurationError}); }
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
    if (message.cancel !== undefined) { running.get(message.cancel)?.abort(Object.assign(new Error('JPEG XL operation was canceled.'), {code: 'JXL_ABORTED'})); return; }
    if (!Number.isSafeInteger(message.id) || message.id < 1) return;
    const {id, operation, input, options, maxPixels, jpegPixels, helpers, webgpu, lane, alone} = message;
    const beside = lane === 1 && helpers && running.size - here < helpers.count;
    if (running.has(id) || (here && !beside)) { reply(id, Object.assign(new Error('The worker already has an active operation.'), {code: 'JXL_BUSY'})); return; }
    const controller = new AbortController();
    running.set(id, controller);
    if (!beside) here = true;
    const done = () => { running.delete(id); if (!beside) here = false; };
    Promise.resolve().then(() => run(operation, input, options, {maxPixels, jpegPixels, helpers, webgpu, owner, lane: beside ? 1 : 0, alone, signal: controller.signal, onProgress: progress => port.postMessage({id, progress}), ...(operation === 'capture' && {onEncoded: encoded => port.postMessage({id, encoded})})})).then(value => {
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
