// SPDX-License-Identifier: MIT
import {effortJob} from './effort-job.mjs';
import {searchV6} from './photo-v6-search.mjs';
import {captureAnswer} from './screen-floor.mjs';
import {jpegSteps} from './jpeg-job.mjs';
import {jpegEffortSteps} from './jpeg-effort.mjs';
import {jpegAnsEffortSteps} from './jpeg-ans-effort.mjs';
import {answer, guard} from './admit.mjs';
import {varDCTSteps} from './vardct.mjs';
import {coefficientOrders} from './coefficient-effort.mjs';
import {TokenCounts} from './entropy.mjs';
import {kernelMode} from './kernels.mjs';
import {stepOffloaded} from './offload.mjs';
import {describePlan, serveParallel} from './parallel-serve.mjs';
export {describePlan, serveParallel};

const canShare = () => typeof SharedArrayBuffer === 'function' && globalThis.crossOriginIsolated !== false;
function portable(value, copies) {
  if (value === null || typeof value !== 'object') return typeof value === 'function' || typeof value === 'symbol' ? undefined : value;
  if (copies.has(value)) return copies.get(value);
  let out;
  if (ArrayBuffer.isView(value)) {
    if (!canShare() || value.buffer instanceof SharedArrayBuffer) out = value;
    else { out = new value.constructor(new SharedArrayBuffer(value.byteLength)); out.set(value); }
  } else if (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype) {
    out = Array.isArray(value) ? [] : {};
    for (const [k, v] of Object.entries(value)) { const p = portable(v, copies); if (p === undefined && v !== undefined) return undefined; out[k] = p; }
  } else return undefined;
  copies.set(value, out);
  return out;
}

export function workerPool(spawn, count) {
  const members = [], queue = [], inputIds = new Map(), pending = new Map(), retiring = new Set();
  let retireFailure = null;
  let serial = 0, closed = false, copies = new WeakMap();
  const end = worker => {
    let result;
    try { result = worker.terminate(); } catch (error) { result = Promise.reject(error); }
    const retired = Promise.resolve(result).then(() => { retiring.delete(retired); pump(); }, error => { retiring.delete(retired); retireFailure ??= error; pump(); });
    retiring.add(retired);
  };
  const finish = (job, value) => { pending.delete(job.id); job.resolve(value); };
  const listen = (worker, receive, fail) => { worker.onmessage = event => receive(event.data); worker.onerror = event => { event?.preventDefault?.(); fail(); }; };
  const drop = member => {
    if (member.dead) return;
    member.dead = true;
    members.splice(members.indexOf(member), 1);
    end(member.worker);
    if (member.busy) { finish(member.busy, undefined); member.busy = null; }
  };
  const stop = () => {
    closed = true;
    for (const job of queue.splice(0)) finish(job, undefined);
    for (const member of members.splice(0)) { member.dead = true; end(member.worker); if (member.busy?.lease) member.busy.resolve(); }
    for (const job of [...pending.values()]) finish(job, undefined);
  };
  const start = () => {
    const member = {worker: spawn(), busy: null, sent: new Set(), dead: false};
    members.push(member);
    try {
      listen(member.worker, reply => {
        if (member.busy?.lease) { member.busy.answer(reply); return; }
        const job = member.busy;
        if (!job || reply.id !== job.id) return;
        if (reply.progress !== undefined) { job.onProgress?.(reply.progress); return; }
        member.busy = null;
        if (job) finish(job, job.whole ? reply : reply.error ? undefined : reply.result);
        pump();
      }, () => { drop(member); pump(); });
      member.worker.postMessage({pool: 'parallel', kernels: kernelMode()});
    } catch (error) { drop(member); throw error; }
    return member;
  };
  const tryStart = () => {
    try { return start(); }
    catch (error) {
      count = members.length;
      if (error?.code === 'JXL_WORKER_LEASE') { api.failure = error; stop(); }
      return null;
    }
  };
  const inputId = value => {
    let id = inputIds.get(value);
    if (id === undefined) {
      const shared = portable(value, copies);
      if (shared === undefined) return undefined;
      inputIds.set(value, id = {n: inputIds.size, shared});
    }
    return id;
  };
  function pump() {
    while (queue.length && !closed && members.filter(m => m.busy).length < api.limit) {
      let member = members.find(m => !m.busy);
      if (!member && members.length + retiring.size < count) member = tryStart();
      if (!member) break;
      const job = queue.shift();
      member.busy = job;
      try {
        for (const input of job.inputs) if (!member.sent.has(input.n)) { member.worker.postMessage({pool: 'parallel', input: input.n, value: input.shared}); member.sent.add(input.n); }
        member.worker.postMessage({pool: 'parallel', id: job.id, task: job.task});
      } catch { member.busy = null; finish(job, undefined); }
    }
    if (!members.length && !retiring.size) for (const job of [...queue.splice(0), ...pending.values()]) finish(job, undefined);
  }
  const api = {
    count, limit: count, failure: null,
    get waiting() { return pending.size; },
    run(task, big) {
      if (closed) return Promise.resolve(undefined);
      const ins = [], message = {...task};
      for (const field of big) {
        if (task[field] == null) continue;
        const id = inputId(task[field]);
        if (!id) return Promise.resolve(undefined);
        ins.push(id); message[field] = id.n;
      }
      let job;
      const promise = new Promise(resolve => {
        job = {id: ++serial, task: message, inputs: ins, resolve};
        pending.set(job.id, job); queue.push(job); pump();
      });
      promise.job = job;
      return promise;
    },
    whole(task, onProgress) {
      if (closed) return Promise.resolve(undefined);
      let job;
      const promise = new Promise(resolve => {
        job = {id: ++serial, task, inputs: [], resolve, onProgress, whole: true};
        pending.set(job.id, job); queue.push(job); pump();
      });
      promise.cancel = () => {
        const at = queue.indexOf(job), member = members.find(m => m.busy === job);
        if (at !== -1) { queue.splice(at, 1); finish(job, undefined); }
        else if (member) { drop(member); pump(); }
      };
      return promise;
    },
    trim(n) { for (const member of members.filter(m => !m.busy).slice(0, Math.max(0, members.length - n))) drop(member); return api.retired(); },
    lease() {
      if (closed) return [];
      return members.filter(m => !m.busy).map(member => {
        const waiting = new Map(), stopped = {error: {name: 'Error', message: 'A JPEG XL helper stopped.'}};
        const lease = member.busy = {id: ++serial, lease: true, ended: false, waiting,
          answer: reply => {
            waiting.get(reply.ticket)?.(reply); waiting.delete(reply.ticket);
            if (lease.ended && !waiting.size && member.busy === lease) { member.busy = null; pump(); }
          },
          resolve: () => { for (const resolve of waiting.values()) resolve(stopped); waiting.clear(); }};
        const send = (message, transfer = []) => new Promise(resolve => {
          if (member.dead) { resolve(stopped); return; }
          waiting.set(message.ticket, resolve);
          try { member.worker.postMessage(message, transfer); } catch { waiting.delete(message.ticket); resolve(stopped); }
        });
        return {member, send};
      });
    },
    unlease(leased) {
      for (const {member} of leased) {
        const lease = member.busy;
        if (!lease?.lease) continue;
        lease.ended = true;
        if (!lease.waiting.size) member.busy = null;
      }
      pump();
    },
    warm() { while (!closed && members.length < count && tryStart()); },
    promote(promise) {
      for (const dep of promise.deps ?? []) this.promote(dep);
      const at = queue.indexOf(promise.job);
      if (at > 0) queue.unshift(...queue.splice(at, 1));
    },
    release(stop = false) {
      for (const job of queue.splice(0)) finish(job, undefined);
      if (stop) for (const member of members.filter(m => m.busy)) {
        member.dead = true; members.splice(members.indexOf(member), 1);
        end(member.worker);
        finish(member.busy, undefined); member.busy = null;
      }
      for (const member of members) for (const n of member.sent) try { member.worker.postMessage({pool: 'parallel', drop: n}); } catch {}
      for (const member of members) member.sent.clear();
      inputIds.clear(); copies = new WeakMap();
    },
    async retired() {
      while (retiring.size) await Promise.all([...retiring]);
      if (retireFailure) throw retireFailure;
    },
    hold(on) { for (const member of members) member.worker.hold?.(on); },
    get closed() { return closed; },
    close() { stop(); return api.retired(); },
  };
  return api;
}

function taskKey(task, idOf) {
  if (task.kind === 'fast-band') return `fast-band|${idOf(task.data)}|${task.width}|${task.quality}|${task.y}|${task.h}`;
  if (task.kind === 'band') return `band|${idOf(task.data)}|${idOf(task.color)}|${task.width}|${task.quality}|${task.y}|${task.h}|${task.from}|${task.to}`;
  const plan = describePlan(task.plan);
  if (task.kind === 'lf') return plan && `lf|${idOf(task.image)}|${plan.lf}|${plan.modularAns}|${task.g}`;
  return plan && `vardct|${idOf(task.image)}|${JSON.stringify({...plan, orders: plan.orders?.join() ?? null})}`;
}
const BIG = {orders: ['image'], band: ['data', 'target'], 'fast-band': ['data', 'target'], vardct: ['image'], lf: ['image'], count: ['image'], write: ['image'], ac: ['model']};
function dcGroupCount({width, height, components}) {
  const hs = components.map(c => c.h), vs = components.map(c => c.v), log2 = v => v === 1 ? 0 : 1;
  const maxhs = log2(Math.max(...hs) / Math.min(...hs)), maxvs = log2(Math.max(...vs) / Math.min(...vs));
  const xBlocks = Math.ceil(width / (8 << maxhs)) << maxhs, yBlocks = Math.ceil(height / (8 << maxvs)) << maxvs;
  return Math.ceil(xBlocks / 256) * Math.ceil(yBlocks / 256);
}

const kept = promise => { promise.catch(() => {}); return promise; };

function driver(owner) {
  let ended = false;
  const pool = Object.create(owner);
  pool.run = (task, big) => ended ? Promise.resolve(undefined) : owner.run(task, big);
  const ids = new WeakMap(), memo = new Map();
  let next = 0;
  const idOf = value => { if (value === null || typeof value !== 'object') return String(value); let id = ids.get(value); if (id === undefined) ids.set(value, id = ++next); return id; };
  const message = task => task.kind === 'lf' ? {kind: 'lf', image: task.image, plan: describePlan(task.plan), g: task.g}
    : task.kind === 'fast-band' ? {kind: 'fast-band', data: task.data, target: task.target, width: task.width, h: task.h, quality: task.quality, y: task.y}
    : task.kind === 'vardct' ? {kind: 'vardct', image: task.image, plan: describePlan(task.plan)}
    : {kind: 'band', data: task.data, target: task.target, width: task.width, h: task.h, quality: task.quality, color: task.color, from: task.from, to: task.to, y: task.y};
  const gates = new WeakMap(), bandRuns = new Map();
  const gated = (image, y0, y1, run) => {
    const gate = gates.get(image);
    if (!gate) return run();
    const under = gate.bands.filter(band => band.y < y1 && band.y + band.h > y0).map(band => band.run);
    return Promise.all(under).then(results => results.every(Boolean) ? undefined : gate.placed).then(run);
  };
  const lfGroup = (image, plan, g) => {
    const key = `lf|${idOf(image)}|${plan.lf}|${plan.modularAns}|${g}`, y0 = Math.floor(g / Math.ceil(Math.ceil(image.width / 8) / 256)) * 2048;
    if (!memo.has(key)) memo.set(key, kept(gated(image, y0, y0 + 2048, () => pool.run({kind: 'lf', image, plan: {...plan, orders: null, clusters: null, fast: false, ans: false}, g}, BIG.lf))));
    return memo.get(key);
  };
  const lfGroups = (image, plan) => Array.from({length: dcGroupCount(image)}, (_, g) => lfGroup(image, plan, g));
  const ranges = groups => { const n = Math.min(groups, pool.limit); return Array.from({length: n}, (_, k) => [Math.floor(k * groups / n), Math.floor((k + 1) * groups / n)]); };
  const countsFor = (image, plan) => {
    const key = `counts|${idOf(image)}|${plan.fast}|${plan.orders?.join() ?? null}`;
    let promise = memo.get(key);
    if (promise) return promise;
    const task = {kind: 'count', image, plan: {fast: plan.fast, clusters: null, orders: plan.orders, ans: false, modularAns: false, lf: 0}};
    const parts = ranges(Math.ceil(image.width / 256) * Math.ceil(image.height / 256)).map(([from, to]) => gated(image, 0, Infinity, () => pool.run({...task, from, to}, BIG.count)));
    promise = Promise.all(parts).then(results => {
      if (!results.every(Boolean)) return undefined;
      const [first, ...rest] = results;
      Object.setPrototypeOf(first.counts, TokenCounts.prototype);
      for (const part of rest) {
        first.counts.merge(part.counts);
        part.blockCounts.forEach((from, c) => { const into = first.blockCounts[c]; if (from) for (let i = 0; i < from.length; i++) if (from[i] > into[i]) into[i] = from[i]; });
      }
      return first;
    });
    promise.deps = parts;
    memo.set(key, kept(promise));
    return promise;
  };
  const learnedWait = new WeakMap(), learned = new WeakMap();
  const submit = (task, key) => {
    let promise = memo.get(key);
    if (promise) return promise;
    const msg = message(task);
    if (task.kind === 'vardct') {
      const counts = countsFor(task.image, msg.plan), lf = msg.plan.lf && msg.plan.modularAns ? lfGroups(task.image, msg.plan) : [];
      promise = Promise.all([counts, ...lf]).then(([counted, ...groups]) =>
        pool.run({...msg, ...(counted && {counts: counted}), ...(lf.length && groups.every(Boolean) && {lf: groups})}, BIG.vardct));
      promise.deps = [counts, ...lf];
    } else if (task.kind === 'lf') promise = lfGroup(task.image, msg.plan, task.g);
    else promise = pool.run(msg, BIG[task.kind]);
    memo.set(key, kept(promise));
    return promise;
  };
  return {
    end() { ended = true; },
    async count(task) {
      const plan = describePlan(task.plan), merged = plan && await countsFor(task.image, plan);
      return merged && [merged];
    },
    async groups(request) {
      const plan = describePlan(request.plan), counted = plan && await countsFor(request.image, plan);
      if (counted) {
        const parts = await Promise.all(ranges(request.groups).map(([from, to]) => pool.run({kind: 'write', image: request.image, plan, counts: counted, from, to}, BIG.write)));
        if (parts.every(Boolean)) return {results: parts.flat(), errors: {}};
      }
      const parts = await Promise.all(ranges(request.groups).map(([from, to]) => {
        const datas = [];
        for (let g = from; g < to; g++) datas.push(request.job(g).data);
        return pool.run({kind: 'ac', model: request.model, groups: datas}, BIG.ac);
      }));
      if (!parts.every(Boolean)) return undefined;
      return {results: parts.flat(), errors: {}};
    },
    prefetch(tasks, after) {
      if (after) {
        let placed; const image = tasks.find(task => task.image)?.image;
        if (image) gates.set(image, {bands: after.map(band => ({y: band.y, h: band.h, run: bandRuns.get(band)})), placed: new Promise(resolve => { placed = resolve; }), resolve: () => placed()});
      }
      for (const task of tasks) { const plan = task.kind === 'vardct' && describePlan(task.plan); if (plan?.lf && plan.modularAns) lfGroups(task.image, plan); }
      const learning = tasks.filter(task => task.kind === 'vardct' && task.plan.orders === 'learned');
      tasks = tasks.filter(task => !learning.includes(task));
      if (learning.length) { const image = learning[0].image; learnedWait.set(image, kept(gated(image, 0, Infinity, () => pool.run({kind: 'orders', image}, BIG.orders)).then(orders => {
        learned.set(image, orders ?? coefficientOrders(image.components));
        for (const task of learning) { const learnt = {...task, plan: {...task.plan, orders: learned.get(image)}}, key = taskKey(learnt, idOf); if (key) submit(learnt, key); }
      }))); }
      for (const task of tasks) {
        const key = taskKey(task, idOf), promise = key && submit(task, key);
        if (promise && (task.kind === 'band' || task.kind === 'fast-band')) bandRuns.set(task, promise);
      }
    },
    placed(image) { gates.get(image)?.resolve(); },
    async run(task) {
      if (task.kind === 'count') return this.count(task);
      if (task.kind === 'vardct') await learnedWait.get(task.image);
      const key = taskKey(task, idOf);
      if (!key) return undefined;
      const promise = submit(task, key);
      pool.promote?.(promise);
      const result = await promise;
      memo.delete(key);
      return result;
    },
  };
}

async function* driven(steps, pool, signal, it, gpu) {
  const offload = pool && driver(pool);
  const settle = promise => !signal ? promise : new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, {once: true});
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); });
  });
  let step, reply, last, done = false;
  try {
    while (!(step = guard(() => {
      signal?.throwIfAborted();
      if (pool?.failure) throw pool.failure;
      return pool ? stepOffloaded(steps, reply, pool.limit) : steps.next(reply);
    })).done) {
      const value = step.value;
      reply = undefined;
      if (typeof value === 'number') { yield last = value; reply = it.hurry; }
      else if (value?.capture) reply = await settle(captureAnswer(value.capture));
      else if (value?.gpu) reply = gpu ? await settle(gpu(value.gpu)) : null;
      else if (value?.offload === 'prefetch') offload.prefetch(value.tasks, value.after);
      else if (value?.offload === 'placed') offload.placed(value.image);
      else if (value?.offload === 'groups') reply = await settle(offload.groups(value));
      else if (value?.offload === 'run') reply = await settle(offload.run(value.task));
    }
    done = true;
    if (last < 1) yield 1;
    it.bytes = answer(step.value);
  } finally {
    offload?.end();
    if (!done) try { steps.return?.(); } catch {}
  }
}

export function parallelJob(steps, {workers = 0, spawn, signal, gpu, pool: kept} = {}) {
  const pool = kept ?? (workers >= 2 ? workerPool(spawn, workers) : null);
  if (kept) kept.busy = true;
  const it = (async function* () {
    let ended = false;
    try { yield* driven(steps, pool, signal, it, gpu); ended = true; }
    finally {
      pool?.release(!ended);
      const stays = kept && !kept.once, retired = stays ? pool.retired() : pool?.close();
      try { if (retired) await (ended ? retired : retired.catch(() => {})); }
      finally {
        if (kept) kept.busy = false;
        if (stays) idle(pool);
      }
    }
  })();
  it.bytes = null; it.hurry = false;
  return it;
}

const helperPools = new WeakMap();
const dropped = typeof FinalizationRegistry === 'function' ? new FinalizationRegistry(pool => pool.close().catch(() => {})) : null;
const residentHelpers = reservation => Math.min(reservation.count, Math.floor(reservation.memoryBytes / (44 * 1048576)));
function ownerPool(owner, reservation, spawn) {
  let pool = helperPools.get(owner);
  if (!pool || pool.closed) { helperPools.set(owner, pool = workerPool(spawn, residentHelpers(reservation))); dropped?.register(owner, pool); }
  return pool;
}
export async function helperPool(owner, reservation, pixels) {
  const limit = reservedHelpers(reservation, pixels);
  const spawn = await spawnParallelWorker();
  let pool = ownerPool(owner, reservation, spawn);
  if (pool.busy || pool.jobs) return Object.assign(workerPool(spawn, reservation.count), {limit, once: true});
  pool.hold(true);
  pool.limit = limit;
  await pool.trim(limit);
  return pool;
}
export function closeHelpers(owner) {
  const pool = helperPools.get(owner);
  return pool ? pool.close() : Promise.resolve();
}

export async function helperJob(owner, reservation, task, {signal, onProgress} = {}) {
  const pool = ownerPool(owner, reservation, await spawnParallelWorker());
  if (signal?.aborted) throw signal.reason;
  pool.hold(true); pool.limit = pool.count; pool.jobs = (pool.jobs ?? 0) + 1;
  const reply = pool.whole(task, onProgress), abort = () => reply.cancel();
  signal?.addEventListener('abort', abort, {once: true});
  try {
    const answer = await reply;
    if (signal?.aborted) { await pool.retired().catch(() => {}); throw signal.reason; }
    if (!answer) { await pool.retired().catch(() => {}); throw pool.failure ?? Object.assign(new Error('A JPEG XL helper stopped.'), {code: 'JXL_WORKER'}); }
    if (answer.error) throw Object.assign(new Error(answer.error.message), {name: answer.error.name, code: answer.error.code});
    return answer.result;
  } finally {
    signal?.removeEventListener('abort', abort);
    if (!--pool.jobs && !pool.busy) idle(pool);
  }
}

export async function splitOnIdle(owner, reservation, request, signal) {
  const spawn = await spawnParallelWorker();
  if (signal?.aborted) return undefined;
  const pool = ownerPool(owner, reservation, spawn);
  pool.warm();
  const leased = pool.lease();
  if (!leased.length) return undefined;
  pool.hold(true); pool.jobs = (pool.jobs ?? 0) + 1;
  try { return await (await import('./photo-split.mjs')).encodeSplit(request.data, request.width, request.height, request.quality, leased, {signal}); }
  catch (error) { if (signal?.aborted) throw error; return undefined; }
  finally { pool.unlease(leased); if (!--pool.jobs && !pool.busy) idle(pool); }
}

function idle(pool) {
  if (!pool.closed) pool.hold(false);
}

async function drain(steps, pool, signal) {
  const it = {hurry: false};
  for await (const _ of driven(steps, pool, signal, it));
  return it.bytes;
}

const helperBytes = pixels => 44 * 1048576 + 4 * pixels + (canShare() ? 0 : 26 * pixels);
const helpersWithin = (budget, pixels) => Math.floor((budget - 16 * pixels) / helperBytes(pixels));

const HELPER_PIXELS = 524288;
export const reservedHelpers = (reservation, pixels) => reservation && pixels >= HELPER_PIXELS ? Math.max(0, Math.min(reservation.count, helpersWithin(reservation.memoryBytes, pixels))) : 0;

const nodeBuiltin = name => globalThis.process?.getBuiltinModule?.(name);

async function memoryWorkers(pixels) {
  let budget;
  try { budget = globalThis.navigator?.deviceMemory ? navigator.deviceMemory * 268435456 : nodeBuiltin('node:os').freemem() / 2; } catch { return Infinity; }
  return Math.max(1, helpersWithin(budget, pixels));
}

export const defaultWorkers = async () => {
  if (globalThis.navigator?.hardwareConcurrency) return navigator.hardwareConcurrency;
  try { return nodeBuiltin('node:os').availableParallelism(); } catch { return 1; }
};
export async function spawnParallelWorker() {
  if (typeof Worker === 'function') return () => new Worker(new URL('./parallel-worker.mjs', import.meta.url), {type: 'module'});
  const threads = nodeBuiltin('node:worker_threads');
  if (!threads) throw Object.assign(new Error('Helpers in Node need Node 20.16 or later.'), {code: 'JXL_WORKER'});
  const {Worker: NodeWorker} = threads;
  const flags = globalThis.process.execArgv, execArgv = flags.some(flag => flag.startsWith('--input-type')) ? flags.filter(flag => !flag.startsWith('--input-type')) : undefined;
  return () => {
    const worker = new NodeWorker(new URL('./parallel-worker.mjs', import.meta.url), {execArgv}), host = {
      postMessage: (message, transfer) => worker.postMessage(message, transfer),
      terminate: () => worker.terminate(),
      hold: on => on ? worker.ref() : worker.unref(),
      set onmessage(f) { worker.removeAllListeners('message'); if (f) worker.on('message', data => f({data})); },
      set onerror(f) { worker.removeAllListeners('error'); worker.removeAllListeners('exit'); if (f) { worker.on('error', f); worker.on('exit', () => f()); } },
    };
    return host;
  };
}

export function createParallelEncoder({workers, spawn} = {}) {
  let pool, spawner, count, busy = Promise.resolve();
  const ready = (async () => {
    count = workers ?? await defaultWorkers();
    spawner = spawn ?? await spawnParallelWorker();
    if (count >= 2) { pool = workerPool(spawner, count); pool.warm(); }
  })();
  return {
    encode(data, width, height, options, {signal} = {}) {
      const run = busy.then(async () => {
        await ready;
        const steps = effortJob(data, width, height, options, false, undefined, searchV6);
        if (!pool) return drain(steps, null, signal);
        pool.limit = Math.min(count, await memoryWorkers(width * height));
        let ended = false;
        try { const bytes = await drain(steps, pool, signal); ended = true; return bytes; }
        finally { pool.release(!ended); }
      });
      busy = run.catch(() => {});
      return run;
    },
    transcode(jpeg, options, {signal, ans = false} = {}) {
      const run = busy.then(async () => {
        await ready;
        if (pool) pool.limit = count;
        const shown = {}, steps = jpegSteps(jpeg, options, ans ? jpegAnsEffortSteps : jpegEffortSteps, fields => Object.assign(shown, fields));
        let ended = false;
        const bytes = pool ? await drain(steps, pool, signal).then(value => { ended = true; return value; }).finally(() => pool.release(!ended)) : await drain(steps, null, signal);
        return {bytes, ...shown};
      });
      busy = run.catch(() => {});
      return run;
    },
    async close() { await ready; await pool?.close(); },
  };
}

export async function encodeParallel(data, width, height, options, {workers, spawn, signal} = {}) {
  const encoder = createParallelEncoder({workers, spawn});
  try { return await encoder.encode(data, width, height, options, {signal}); }
  finally { await encoder.close(); }
}
