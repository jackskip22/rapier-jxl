// SPDX-License-Identifier: MIT
// On Node with no CPU allowance an image job runs whole in a worker thread, with the same start/advance/finish shape
// as rapier-jxl/resumable. Resumable steps at effort 7 ran 33-45 s an advance against a 5 s budget on the server's own
// thread, so the site stopped answering for 10-20 s at a time and a 3 MP picture took over 40 minutes.
// Here an advance only waits for the thread, up to its budget; the file and its verification receipt are the ordinary
// encode's and verify's, the receipt naming the job's source as resumable's does. One job runs at a time in a process
// (the measured admission is per job). A restart loses only the running thread: the next advance starts it again.
// Browser candidates use the same worker for ordinary verification; their immutable uploaded parts stay owned by the job.
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import * as resumable from 'jpeg-xl/resumable';
import {verify} from 'jpeg-xl/verify';
import {digest} from './digest.mjs';

const PART = 1024 * 1024, READ = 1024 * 1024, KEEP_MS = 10 * 60 * 1000;
const fail = (code, message) => Object.assign(new Error(message), {code});
const tasks = new Map();

function threads() {
  const builtin = globalThis.process?.getBuiltinModule;
  const module = typeof builtin === 'function' ? builtin('node:worker_threads') : null;
  if (!module?.Worker) throw fail('JXL_PLATFORM', 'The thread driver needs Node worker threads.');
  return module;
}

async function readInput(input, store, signal) {
  const bytes = new Uint8Array(input.byteLength);
  for (let at = 0; at < bytes.length; at += READ) {
    signal?.throwIfAborted();
    const length = Math.min(READ, bytes.length - at), part = await store.readSource(at, length);
    if (!(part instanceof Uint8Array) || part.length !== length) throw fail('JXL_IO', 'The source could not be read.');
    bytes.set(part, at);
  }
  if (await digest(bytes) !== input.sha256) throw fail('JXL_INPUT', 'The source changed while it was read.');
  return bytes;
}

// Astro bundles this file into dist/server. A relative worker URL then points at that bundle and the
// site never encodes. Resolve the package that is installed beside the server, and only then the file beside this module.
export function threadWorkerURL(moduleUrl = import.meta.url) {
  try {
    const root = createRequire(moduleUrl).resolve('jpeg-xl/package.json');
    return new URL('./examples/emdash/thread-worker.mjs', pathToFileURL(root));
  } catch { return new URL('./thread-worker.mjs', moduleUrl); }
}

async function readCandidate(options, store, signal) {
  const refs = options.parts;
  const parts = store.readMany ? await store.readMany(refs) : await Promise.all(refs.map(ref => store.read(ref)));
  signal?.throwIfAborted();
  if (!Array.isArray(parts) || parts.length !== refs.length) throw fail('JXL_IO', 'A candidate part is missing.');
  let length = 0;
  for (const [i, part] of parts.entries()) {
    if (!(part instanceof Uint8Array) || part.length !== refs[i].length) throw fail('JXL_IO', 'A candidate part is missing or truncated.');
    if (await digest(part) !== refs[i].hash) throw fail('JXL_INPUT', 'A candidate part changed before verification.');
    length += part.length;
  }
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const part of parts) { bytes.set(part, at); at += part.length; }
  signal?.throwIfAborted();
  return bytes;
}

const threadKey = (owner, operation, input, options) =>
  digest(new TextEncoder().encode(JSON.stringify([owner, operation, input, options])));

function verificationReceipt(checkpoint, input) {
  const receipt = checkpoint.receipt, result = checkpoint.options.result;
  const kind = 'bytes';
  if (receipt?.verified !== true || receipt.source?.kind !== kind || receipt.source.digest !== 'sha256:' + input.sha256 ||
      !/^sha256:[a-f0-9]{64}$/.test(receipt.outputDigest ?? '') ||
      ['width', 'height', 'format', 'kept'].some(key => receipt[key] !== result[key]) ||
      JSON.stringify(receipt.fidelity) !== JSON.stringify(result.fidelity) ||
      JSON.stringify(receipt.transform) !== JSON.stringify(result.transform) ||
      JSON.stringify(receipt.readAs) !== JSON.stringify(result.readAs))
    throw fail('JXL_INPUT', 'The completed verification does not describe its candidate and original.');
  return receipt;
}

function run(job, progress) {
  const {Worker} = threads();
  return new Promise((resolve, reject) => {
    const worker = new Worker(threadWorkerURL(), {workerData: job,
      transferList: [job.bytes.buffer, ...(job.candidate ? [job.candidate.buffer] : [])]});
    let stopping = false;
    const complete = (value, error) => {
      if (stopping) return;
      stopping = true;
      Promise.resolve(worker.terminate()).then(() => error ? reject(error) : resolve(value), reject);
    };
    worker.on('message', value => {
      if (stopping) return;
      if (typeof value?.progress === 'number') { progress(value.progress); return; }
      complete(value, value?.error && Object.assign(new Error(value.error.message), value.error));
    });
    worker.once('error', error => complete(null, error));
    worker.once('exit', code => {
      if (!stopping) { stopping = true; reject(fail('JXL_INTERNAL', `The encoder thread exited (${code}).`)); }
    });
  });
}

// One owner holds the input, worker and unfinished output until its part write is acknowledged.
// Completed entries keep only a receipt or immutable part references, never another job's bytes.
let slot = null;
function releaseSlot(task) {
  if (slot === task) slot = null;
  task.availableResolve?.(); task.availableResolve = null;
}
function discardTask(task) {
  task.discarded = true;
  if (tasks.get(task.key) === task) tasks.delete(task.key);
  clearTimeout(task.timer);
  if (task.settled && !task.writing) { task.value = null; releaseSlot(task); }
}
function launch(checkpoint, read) {
  const {key, owner, operation} = checkpoint;
  const task = {key, owner, settled: false, discarded: false, value: null, durable: null,
    writing: null, error: null, timer: null, progress: 0};
  task.available = new Promise(resolve => { task.availableResolve = resolve; });
  slot = task; tasks.set(key, task);
  task.promise = (async () => {
    const job = await read();
    return task.discarded ? null : run(job, value => { task.progress = value; });
  })().then(value => { task.value = value; }, error => { task.error = error; }).finally(() => {
    task.settled = true;
    if (task.discarded) { task.value = null; releaseSlot(task); return; }
    if (task.error || operation === 'verify') releaseSlot(task);
    task.timer = setTimeout(() => discardTask(task), KEEP_MS);
    task.timer.unref?.();
  });
  return task;
}

async function persistOutput(task, store) {
  if (task.durable) return task.durable;
  if (!task.writing) task.writing = (async () => {
    const {bytes, record} = task.value, items = [];
    for (let at = 0; at < bytes.length; at += PART) {
      const part = bytes.subarray(at, Math.min(bytes.length, at + PART));
      items.push({ref: {hash: await digest(part), length: part.length}, bytes: part});
    }
    if (items.length) await store.writeMany(items);
    task.durable = {record, parts: items.map(item => item.ref)};
    task.value = null; releaseSlot(task);
    return task.durable;
  })();
  const writing = task.writing;
  try { return await writing; }
  finally {
    if (task.writing === writing) task.writing = null;
    if (task.discarded) { task.value = null; releaseSlot(task); }
  }
}

const waitFor = (pending, ms, signal) => new Promise((resolve, reject) => {
  signal?.throwIfAborted();
  let settled = false;
  const finish = (settle, value) => {
    if (settled) return;
    settled = true; clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    settle(value);
  };
  const abort = () => finish(reject, signal.reason);
  const timer = setTimeout(() => finish(resolve), ms);
  signal?.addEventListener('abort', abort, {once: true});
  pending.then(value => finish(resolve, value), error => finish(reject, error));
});

// The running job and the kept results, for tests.
export const threadDriverState = () => ({running: slot?.key ?? null, tasks: tasks.size,
  outputBuffers: [...tasks.values()].filter(task => task.value?.bytes instanceof Uint8Array).length});
export function createThreadDriver(operations, base = resumable) {
  const nameOf = operation => operation === verify ? 'verify' : Object.keys(operations).find(name => operations[name] === operation) ?? null;
  const ours = checkpoint => checkpoint?.driver === 'thread';
  return {
    discard(owner) {
      for (const task of tasks.values()) if (task.owner === owner) discardTask(task);
    },
    async start(context) {
      const name = nameOf(context.operation);
      if (!name || name !== 'verify' && !context.verify || name === 'verify' && context.input?.kind !== 'file') return base.start(context);
      const {owner, input, options = {}} = context;
      if (!/^[a-f0-9]{32}$/.test(owner ?? '')) throw fail('JXL_OPTIONS', 'The thread job needs its storage owner.');
      if (!['file', 'pixels', undefined].includes(input?.kind)) throw fail('JXL_INPUT', 'The thread driver reads a stored file or pixels.');
      // Reuse the public stored-verification validator, without inspecting its checkpoint internals.
      if (name === 'verify') await base.start(context);
      const key = await threadKey(owner, name, input, options);
      return {driver: 'thread', status: 'running', key, owner, operation: name, options};
    },
    async advance(checkpoint, context) {
      if (!ours(checkpoint)) return base.advance(checkpoint, context);
      const {input, store, budget, signal} = context;
      if (context.owner !== checkpoint.owner || nameOf(context.operation) !== checkpoint.operation ||
          await threadKey(context.owner, checkpoint.operation, input, checkpoint.options) !== checkpoint.key)
        throw fail('JXL_INPUT', 'The thread checkpoint belongs to another operation or original.');
      if (checkpoint.status === 'done') return {checkpoint, released: [], done: true};
      let task = tasks.get(checkpoint.key);
      if (!task) {
        if (slot) await waitFor(slot.available, Math.max(1, Math.min(budget?.ms ?? 5000, 60000)), signal);
        if (slot) return {checkpoint, released: [], done: false};
        task = tasks.get(checkpoint.key);
      }
      if (!task) {
        task = launch(checkpoint, async () => ({name: checkpoint.operation, input, options: checkpoint.options,
          bytes: await readInput(input, store, signal),
          ...(checkpoint.operation === 'verify' && {candidate: await readCandidate(checkpoint.options, store, signal)})}));
      }
      if (!task.settled) await waitFor(task.promise, Math.max(1, Math.min(budget?.ms ?? 5000, 60000)), signal);
      // The thread's own progress (its operation's fractions, then verify's), for the plug-in's row.
      if (task.discarded) return {checkpoint, released: [], done: false};
      if (!task.settled) return {checkpoint: {...checkpoint, progress: task.progress}, released: [], done: false};
      // An unacknowledged write retains the sole output buffer for the next advance.
      if (task.error) {
        if (tasks.get(checkpoint.key) === task) tasks.delete(checkpoint.key);
        clearTimeout(task.timer); throw task.error;
      }
      if (checkpoint.operation === 'verify') {
        const completed = {...checkpoint, status: 'done', receipt: task.value.receipt};
        verificationReceipt(completed, input);
        return {checkpoint: completed, released: [], done: true};
      }
      const durable = await persistOutput(task, store);
      return task.discarded ? {checkpoint, released: [], done: false}
        : {checkpoint: {...checkpoint, status: 'done', ...durable}, released: [], done: true};
    },
    async finish(checkpoint, context) {
      if (!ours(checkpoint)) return base.finish(checkpoint, context);
      if (checkpoint.status !== 'done') throw fail('JXL_INPUT', 'The image job has not finished.');
      if (context.owner !== checkpoint.owner || nameOf(context.operation) !== checkpoint.operation ||
          await threadKey(context.owner, checkpoint.operation, context.input, checkpoint.options) !== checkpoint.key)
        throw fail('JXL_INPUT', 'The thread checkpoint belongs to another operation or original.');
      if (checkpoint.operation === 'verify') return verificationReceipt(checkpoint, context.input);
      const parts = checkpoint.parts.length ? await context.store.readMany(checkpoint.parts) : [];
      const length = checkpoint.parts.reduce((sum, ref) => sum + ref.length, 0), bytes = new Uint8Array(length);
      let at = 0;
      // Every part is checked against its name, and the whole file against the receipt's output digest.
      if (!Array.isArray(parts) || parts.length !== checkpoint.parts.length) throw fail('JXL_IO', 'A finished part is missing.');
      for (const [index, part] of parts.entries()) {
        if (!(part instanceof Uint8Array) || part.length !== checkpoint.parts[index].length || await digest(part) !== checkpoint.parts[index].hash)
          throw fail('JXL_INPUT', 'A finished part changed after verification.');
        bytes.set(part, at); at += part.length;
      }
      if ('sha256:' + await digest(bytes) !== checkpoint.record?.verification?.outputDigest)
        throw fail('JXL_INPUT', 'The finished file does not match its verification receipt.');
      return {...checkpoint.record, bytes};
    },
  };
}
