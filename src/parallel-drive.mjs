// SPDX-License-Identifier: MIT
import {driven} from './job-drive.mjs';
import {varDCTSteps} from './vardct.mjs';
import {coefficientOrders} from './coefficient-effort.mjs';
import {TokenCounts} from './entropy.mjs';
import {stepOffloaded} from './offload.mjs';
import {describePlan} from './parallel-serve.mjs';

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
  const learnedWait = new WeakMap();
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
      if (learning.length) {
        const image = learning[0].image, wait = learnedWait.get(image) ?? gated(image, 0, Infinity,
          () => pool.run({kind: 'orders', image}, BIG.orders)).then(orders => orders ?? coefficientOrders(image.components));
        learnedWait.set(image, kept(wait.then(orders => {
          for (const task of learning) { const learnt = {...task, plan: {...task.plan, orders}}, key = taskKey(learnt, idOf); if (key) submit(learnt, key); }
          return orders;
        })));
      }
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

function offloaded(pool) {
  if (!pool) return undefined;
  return Object.assign(driver(pool), {step(steps, reply) {
    if (pool.failure) throw pool.failure;
    return stepOffloaded(steps, reply, pool.limit);
  }});
}

export function parallelJob(steps, {signal, gpu, pool = null, kept = null} = {}) {
  if (kept) { pool = kept; kept.busy = true; }
  const it = (async function* () {
    let ended = false;
    try { yield* driven(steps, signal, it, gpu, offloaded(pool)); ended = true; }
    finally {
      pool?.release(!ended);
      const stays = kept && !kept.once, retired = stays ? pool.retired() : pool?.close();
      try { if (retired) await (ended ? retired : retired.catch(() => {})); }
      finally {
        if (kept) kept.busy = false;
        if (stays) pool.idle();
      }
    }
  })();
  it.bytes = null; it.hurry = false;
  return it;
}


export async function drain(steps, pool, signal) {
  const it = {hurry: false};
  for await (const _ of driven(steps, signal, it, undefined, offloaded(pool)));
  return it.bytes;
}
