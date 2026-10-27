// SPDX-License-Identifier: MIT
import {LIMITS} from './bits.mjs';
import {fault} from './admit.mjs';

export {LIMITS};

const allowed = new Set(['signal', 'worker']);
let pool;

function fail(code, message) { return Object.assign(new Error(message), {code}); }

function own(data) {
  const copy = new Uint8Array(data.length);
  copy.set(data);
  return copy;
}

function endpoint() {
  if (pool) return pool;
  const thread = new Worker(new URL('./capture-worker.mjs', import.meta.url), {type: 'module'});
  let next = 0;
  const pending = new Map();
  thread.onmessage = ({data}) => {
    const job = pending.get(data?.id);
    if (!job) return;
    pending.delete(data.id);
    if (data.ok) job.resolve(data.bytes);
    else job.reject(Object.assign(new Error(data.error.message), data.error));
  };
  thread.onerror = () => {
    for (const job of pending.values()) job.reject(fail('JXL_WORKER', 'The JPEG XL worker failed.'));
    pending.clear();
    pool = null;
  };
  pool = (body, transfer) => new Promise((resolve, reject) => {
    const id = ++next;
    pending.set(id, {resolve, reject});
    if (body.signal?.aborted) { pending.delete(id); reject(fail('JXL_ABORTED', 'JPEG XL encoding was canceled.')); return; }
    body.signal?.addEventListener('abort', () => thread.postMessage({id, operation: 'cancel'}), {once: true});
    thread.postMessage({...body, id, signal: undefined}, transfer);
  });
  return pool;
}

const owned = new WeakMap();
function post(thread, pixels, width, height, signal) {
  let slot = owned.get(thread);
  if (!slot) {
    let next = 0;
    const pending = new Map();
    thread.addEventListener('message', ({data}) => {
      const job = pending.get(data?.id);
      if (!job) return;
      pending.delete(data.id);
      if (data.ok) job.resolve(data.bytes);
      else job.reject(Object.assign(new Error(data.error.message), data.error));
    });
    slot = body => new Promise((resolve, reject) => {
      const id = ++next;
      pending.set(id, {resolve, reject});
      thread.postMessage({...body, id}, [body.data.buffer]);
    });
    owned.set(thread, slot);
  }
  if (signal?.aborted) return Promise.reject(fail('JXL_ABORTED', 'JPEG XL encoding was canceled.'));
  return slot({operation: 'capture', width, height, data: pixels});
}

function inline(data, width, height, options) {
  return import('./capture-encode.mjs').then(({encodeCaptureBytes}) => encodeCaptureBytes(data, width, height, options));
}

/** Lossless JPEG XL for a capture. On a document the encode runs in a module worker, one picture at a time. */
export async function encodeCapture(data, width, height, options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw fault('JXL_INPUT', 'Capture options are an object.');
  for (const key of Object.keys(options)) if (!allowed.has(key)) throw fault('JXL_INPUT', `Unknown capture option ${key}.`);
  const onWorker = options.worker !== false && (options.worker || typeof document !== 'undefined');
  if (!onWorker || typeof Worker === 'undefined') return inline(data, width, height, options);
  const pixels = own(data);
  if (options.worker instanceof Worker) return post(options.worker, pixels, width, height, options.signal);
  return endpoint()({operation: 'capture', width, height, data: pixels, signal: options.signal}, [pixels.buffer]);
}
