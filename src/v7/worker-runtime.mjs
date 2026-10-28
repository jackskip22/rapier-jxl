import {run} from './runtime.mjs';
import {WORKER_PROTOCOL} from './protocol.mjs';

function transferable(value, buffers = new Set(), seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return buffers;
  seen.add(value);
  if (value instanceof ArrayBuffer) buffers.add(value);
  else if (ArrayBuffer.isView(value)) buffers.add(value.buffer);
  else for (const item of Object.values(value)) transferable(item, buffers, seen);
  return buffers;
}

export function install(port, pending = []) {
  let here = false;
  const owner = {}, running = new Map();
  const reply = (id, reason) => port.postMessage({id, ok: false, error: {name: reason?.name || 'Error', code: reason?.code || 'JXL_INPUT', message: reason?.message || String(reason)}});
  const receive = message => {
    if (!message) return;
    if (message.cancel !== undefined) { running.get(message.cancel)?.abort(Object.assign(new Error('JPEG XL operation was canceled.'), {code: 'JXL_ABORTED'})); return; }
    if (!Number.isSafeInteger(message.id) || message.id < 1) return;
    const {id, operation, input, options, maxPixels, helpers, lane, alone} = message;
    const beside = lane === 1 && helpers && running.size - Number(here) < helpers.count;
    if (running.has(id) || (here && !beside)) { reply(id, Object.assign(new Error('The worker already has an active operation.'), {code: 'JXL_BUSY'})); return; }
    const controller = new AbortController();
    running.set(id, controller);
    if (!beside) here = true;
    const done = () => { running.delete(id); if (!beside) here = false; };
    Promise.resolve().then(() => run(operation, input, options, {maxPixels, helpers, owner, lane: beside ? 1 : 0, alone, signal: controller.signal, onProgress: progress => port.postMessage({id, progress})})).then(value => {
      done();
      try { port.postMessage({id, ok: true, value}, [...transferable(value)]); } catch (reason) { reply(id, reason); }
    }, reason => { done(); reply(id, reason); });
  };
  if (typeof port.addEventListener === 'function') {
    port.addEventListener('message', event => receive(event.data));
    port.start?.();
  } else port.on('message', receive);
  port.postMessage({ready: WORKER_PROTOCOL});
  for (const message of pending) receive(message);
}
