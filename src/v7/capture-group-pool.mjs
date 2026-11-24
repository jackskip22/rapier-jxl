// SPDX-License-Identifier: MIT
import {startWorker} from './worker-start.mjs';
const IDLE = 60000;
const HELPER_BYTES = 48 << 20;
const nodeThreads = () => { try { return globalThis.process?.getBuiltinModule?.('node:worker_threads'); } catch { return undefined; } };
const nodeOs = () => { try { return globalThis.process?.getBuiltinModule?.('node:os'); } catch { return undefined; } };

export const settledAll = promises => Promise.allSettled(promises).then(results => {
  const failed = results.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
});

function start(file) {
  if (typeof Worker === 'function') {
    const worker = startWorker(file);
    return {post: (message, transfer) => worker.postMessage(message, transfer), end: () => worker.terminate(), hold() {},
      listen: (receive, fail) => { worker.onmessage = event => receive(event.data); worker.onerror = event => { event?.preventDefault?.(); fail(); }; }};
  }
  const threads = nodeThreads();
  if (!threads) return null;
  const flags = globalThis.process.execArgv, execArgv = flags.some(flag => flag.startsWith('--input-type')) ? flags.filter(flag => !flag.startsWith('--input-type')) : undefined;
  const worker = new threads.Worker(file.url(), {execArgv, workerData: file.role});
  return {post: (message, transfer) => worker.postMessage(message, transfer), end: () => worker.terminate(), hold: on => on ? worker.ref() : worker.unref(),
    listen: (receive, fail) => { worker.on('message', receive); worker.on('error', fail); worker.on('exit', fail); }};
}

export function groupHelpers(file) {
  const pools = new Map(), ending = new Map();
  let serial = 0;
  const poolFor = (owner, {count = 0, memoryBytes = Infinity} = {}) => {
    let pool = pools.get(owner);
    if (!pool) {
      const size = Math.max(0, Math.min(count, Math.floor(memoryBytes / HELPER_BYTES)));
      pool = {members: [], size, timer: 0, retiring: [], queue: []};
      pools.set(owner, pool);
    }
    return pool;
  };
  const drop = (pool, member) => {
    if (member.dead) return;
    member.dead = true;
    const retired = (async () => {
      let timer;
      try {
        if (member.up === undefined) await Promise.race([member.announced, new Promise(done => { timer = setTimeout(done, 2000); })]);
      } finally { clearTimeout(timer); }
      return member.host.end();
    })();
    retired.catch(() => {});
    pool.retiring.push(retired);
    pool.members.splice(pool.members.indexOf(member), 1);
    member.ready(false);
    lost(pool, member);
  };
  const end = owner => {
    const pool = pools.get(owner);
    if (!pool) return;
    pools.delete(owner); clearTimeout(pool.timer);
    for (const member of [...pool.members]) drop(pool, member);
    const all = settledAll([ending.get(owner), ...pool.retiring]);
    all.catch(() => {});
    ending.set(owner, all);
  };
  async function release(owner, final = false) {
    end(owner);
    const all = ending.get(owner);
    if (final) ending.delete(owner);
    try { await all; }
    catch (cause) { throw Object.assign(new Error('worker stop failed: close() and retry', {cause}), {code: 'JXL_WORKER'}); }
  }
  const idle = (owner, pool) => { if (pools.get(owner) === pool && !pool.queue.length && !pool.members.some(member => member.task)) { pool.timer = setTimeout(() => end(owner), IDLE); pool.timer.unref?.(); } };
  const spawn = pool => {
    let host;
    try { host = start(file); } catch { host = null; }
    if (!host) return null;
    const member = {host, task: null};
    member.started = new Promise(done => { member.ready = done; });
    member.announced = new Promise(done => { member.announce = done; });
    pool.members.push(member);
    try {
      host.listen(data => {
        if (data?.ready) {
          if (data.module === file.module && data.protocol === file.protocol) {
            try { host.post({groupsInit: true, wasmModules: file.wasm?.(false)}); return; } catch {}
          }
          host.hold(false); member.announce(); member.ready(false); drop(pool, member); return;
        }
        if (data?.configured || data?.refused) {
          host.hold(false); member.announce(); member.ready(!!data.configured);
          if (data.refused) drop(pool, member); else { member.up = true; pump(pool); }
          return;
        }
        receive(pool, member, data);
      }, () => { member.announce(); drop(pool, member); });
    } catch { member.announce(); drop(pool, member); return null; }
    return member;
  };
  const started = pool => Promise.all(pool.members.map(member => member.started)).then(ready => ready.some(Boolean));

  async function warm(owner, reservation) {
    const pool = poolFor(owner, reservation);
    clearTimeout(pool.timer);
    while (pool.members.length < pool.size && spawn(pool));
    try { return await started(pool); } finally { idle(owner, pool); }
  }

  const aheadCap = pool => {
    const nav = globalThis.navigator, lowMem = nav?.deviceMemory > 0 && nav.deviceMemory <= 4;
    const cores = nav?.hardwareConcurrency || nodeOs()?.availableParallelism?.() || 2;
    return Math.max(1, Math.min(pool.size, lowMem ? 1 : cores - 1));
  };
  const pump = pool => {
    const cap = aheadCap(pool);
    let aheadBusy = 0;
    for (const member of pool.members) if (member.task?.request.ahead) aheadBusy++;
    for (const member of pool.members) {
      if (member.dead || member.task || !member.up) continue;
      let at = pool.queue.findIndex(t => !t.request.ahead);
      if (at < 0 && aheadBusy < cap) at = pool.queue.findIndex(t => t.request.ahead);
      if (at < 0) break;
      const [task] = pool.queue.splice(at, 1);
      if (task.request.ahead) aheadBusy++;
      member.task = task; task.member = member; task.id = ++serial; member.host.hold(true);
      try { const [message, transfer] = task.pack(task.id); member.host.post(message, transfer); }
      catch { drop(pool, member); }
    }
  };
  const receive = (pool, member, data) => {
    const task = member.task;
    if (!task || data?.ticket !== task.id) return;
    if (!(data.bytes instanceof Uint8Array)) { drop(pool, member); return; }
    member.task = null; task.member = null; member.host.hold(false);
    task.done(data.bytes);
    pump(pool);
  };
  const lost = (pool, member) => {
    const task = member.task;
    member.task = null;
    if (task) { task.member = null; pool.queue.unshift(task); }
    if (!pool.members.some(other => !other.dead)) { for (const task of pool.queue.splice(0)) task.request.settle(null); return; }
    pump(pool);
  };
  async function answer(owner, reservation, request, signal) {
    const pool = poolFor(owner, reservation);
    clearTimeout(pool.timer);
    if (signal?.aborted) return null;
    const count = request.regions ? request.regions.length : request.rects.length;
    const pack = index => id => {
      if (request.regions) {
        const {source, stride, cropRect, pixels: given, exact: mask, ...job} = request.regions[index];
        let pixels;
        if (given) pixels = new Uint8Array(given);
        else {
          pixels = new Uint8Array(cropRect.width * cropRect.height * 4);
          for (let row = 0; row < cropRect.height; row++) {
            const from = ((cropRect.y + row) * stride + cropRect.x) * 4;
            pixels.set(source.subarray(from, from + cropRect.width * 4), row * cropRect.width * 4);
          }
        }
        const exact = mask && new Uint8Array(mask);
        return [{region: {...job, ticket: id, pixels, ...(exact && {exact})}}, [pixels.buffer, ...(exact ? [exact.buffer] : [])]];
      }
      const {pixels, stride, rects, level, shape} = request, rect = rects[index], own = new Uint8Array(rect.width * rect.height * 4);
      for (let row = 0; row < rect.height; row++) {
        const from = ((rect.y + row) * stride + rect.x) * 4;
        own.set(pixels.subarray(from, from + rect.width * 4), row * rect.width * 4);
      }
      return [{groups: {ticket: id, pixels: own, width: rect.width, height: rect.height, level, shape}}, [own.buffer]];
    };
    let settled = false, settle;
    const result = new Promise(resolve => { settle = value => { if (!settled) { settled = true; resolve(value); } }; });
    const mine = {settle, ahead: Boolean(request.ahead && !request.promoted)}, out = new Array(count), tasks = [];
    let left = count;
    for (let index = 0; index < count; index++) tasks.push({request: mine, pack: pack(index), member: null, id: 0, done: bytes => { out[index] = bytes; if (--left === 0) settle(out); }});
    request.promote = () => {
      if (!mine.ahead || settled) return;
      mine.ahead = false;
      const active = tasks.reduce((n, t) => n + (t.member && !t.member.dead ? 1 : 0), 0);
      while (pool.members.length < Math.min(pool.size, left + active) && spawn(pool));
      pump(pool);
    };
    const abort = () => {
      pool.queue = pool.queue.filter(task => task.request !== mine);
      for (const task of tasks) if (task.member && !task.member.dead) { task.member.task = null; drop(pool, task.member); }
      settle(null);
    };
    signal?.addEventListener('abort', abort, {once: true});
    try {
      const limit = mine.ahead ? aheadCap(pool) : pool.size;
      while (pool.members.length < Math.min(limit, count) && spawn(pool));
      if (!pool.members.some(member => member.up)) { settle(null); return await result; }
      if (!settled) { pool.queue.push(...tasks); pump(pool); }
      return await result;
    } finally {
      signal?.removeEventListener?.('abort', abort);
      pool.queue = pool.queue.filter(task => task.request !== mine);
      for (const task of tasks) if (task.member && !task.member.dead) { task.member.task = null; drop(pool, task.member); }
      idle(owner, pool);
    }
  }
  return {answer, warm, release};
}
