// SPDX-License-Identifier: MIT
import {driven} from './job-drive.mjs';
import {fault} from './fault.mjs';
import {varDCTSteps} from './vardct.mjs';
import {coefficientOrders} from './coefficient-effort.mjs';
import {TokenCounts} from './entropy.mjs';
import {stepOffloaded} from './offload.mjs';
import {describePlan} from './parallel-serve.mjs';
import {captureGroupBytes, captureSingleCandidateBytes} from './capture-codec.mjs';
import {CAPTURE_TOOLS_COMPLETE} from './capture-ans.mjs';
import {scoreBandTransfers, scoreBandReply} from './photo-band-storage.mjs';
import {zoneCellsReply} from './photo-zone-cells.mjs';
import {nodeMemoryBudget} from './memory-device.mjs';
import {gpuQueue} from './gpu-queue.mjs';

const CAPTURE_OR_UPLOAD = (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) || (typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true);
const CAPTURE_DEVICE_BYTES = 8 * 2 ** 30;
const hostBytes = (nav = globalThis.navigator) => Number.isFinite(nav?.deviceMemory) && nav.deviceMemory > 0 ? nav.deviceMemory * 2 ** 30 : nodeMemoryBudget();
export function captureCoders(limit, device = hostBytes()) {
  return limit >= 2 && device >= CAPTURE_DEVICE_BYTES ? {helpers: 2, caller: false} : {helpers: 0, caller: true};
}
function taskKey(task, idOf) {
  if (task.kind === 'score-band') return `score-band|${idOf(task.look)}|${task.y0}|${task.y1}`;
  if (!CAPTURE_OR_UPLOAD && (task.kind === 'shape-band' || task.kind === 'mask-band')) return `${task.kind}|${idOf(task.look)}|${task.by0}|${task.by1}`;
  if (!CAPTURE_OR_UPLOAD && task.kind === 'pack-band') return `pack-band|${idOf(task.look)}|${task.gy}`;
  if (task.kind === 'zone-cells' || task.kind === 'lf-code') return `${task.kind}|${idOf(task)}`;
  if (task.kind === 'fast-band') return `fast-band|${idOf(task.data)}|${task.width}|${task.quality}|${task.y}|${task.h}|${!!task.small}`;
  if (task.kind.startsWith('effort-ten')) { const {kind, data, pixels, payload, shape: s, ...rest} = task; return `${kind}|${idOf(data ?? pixels)}|${JSON.stringify(rest)}|${s ? [s.colour, +s.alpha, s.channels] : ''}`; }
  if (task.kind === 'band') return `band|${idOf(task.data)}|${idOf(task.color)}|${task.width}|${task.quality}|${task.y}|${task.h}|${task.from}|${task.to}|${!!task.fast}|${!!task.uploadFlat}|${!!task.uploadProfile}|${!!task.uploadGrain}|${!!task.small}`;
  const plan = describePlan(task.plan);
  if (task.kind === 'lf') return plan && `lf|${idOf(task.image)}|${plan.lf}|${plan.modularAns}|${plan.cflGroups ?? 64}|${task.g}`;
  return plan && `vardct|${idOf(task.image)}|${JSON.stringify({...plan, orders: plan.orders?.join() ?? null})}`;
}
const BIG = {'effort-ten': ['data'], 'effort-ten-tree': ['data'], 'score-band': [], 'shape-band': [], 'mask-band': [], 'pack-band': [], 'zone-cells': [], 'lf-code': [], orders: ['image'], band: ['data', 'target'], 'fast-band': ['data', 'target'], vardct: ['image'], lf: ['image'], count: ['image'], write: ['image']};
function rectangle(kind, pixels, stride, {x, y, width, height}, rest) {
  const own = new pixels.constructor(width * height * 4);
  for (let row = 0; row < height; row++) own.set(pixels.subarray(((y + row) * stride + x) * 4, ((y + row) * stride + x + width) * 4), row * width * 4);
  return [{kind, pixels: own, stride: width, rect: {x: 0, y: 0, width, height}, ...rest}, [], [own.buffer]];
}
function dcGroupCount({width, height, components}) {
  const hs = components.map(c => c.h), vs = components.map(c => c.v), log2 = v => v === 1 ? 0 : 1;
  const maxhs = log2(Math.max(...hs) / Math.min(...hs)), maxvs = log2(Math.max(...vs) / Math.min(...vs));
  const xBlocks = Math.ceil(width / (8 << maxhs)) << maxhs, yBlocks = Math.ceil(height / (8 << maxvs)) << maxvs;
  return Math.ceil(xBlocks / 256) * Math.ceil(yBlocks / 256);
}

const kept = promise => { promise.catch(() => {}); return promise; };
function relayTo(gpu, dispatch = gpu) {
  const trees = new Map();
  const relay = request => {
    if (request.used) { gpu.ran?.(); return null; }
    if (request.failure) { relay.failure ??= fault(request.failure.code ?? 'JXL_WEBGPU', request.failure.message); return null; }
    const {sid, ...asked} = request;
    if (sid !== undefined) {
      if (request.samples) trees.set(sid, request.samples);
      asked.samples = trees.get(sid);
      if (request.end || request.failed) trees.delete(sid);
      if (!asked.samples) return null;
    }
    return Promise.resolve().then(() => dispatch(asked)).catch(error => { relay.failure ??= error; return null; });
  };
  return relay;
}
function driver(owner, gpu = null, dispatch) {
  let ended = false;
  const pool = Object.create(owner);
  pool.run = (task, big, transfer, validate, onGpu) => ended ? Promise.resolve(undefined) : owner.run(task, big, transfer, validate, onGpu);
  const ids = new WeakMap(), memo = new Map();
  let next = 0;
  const idOf = value => { if (value === null || typeof value !== 'object') return String(value); let id = ids.get(value); if (id === undefined) ids.set(value, id = ++next); return id; };
  const message = task => task.kind.startsWith('effort-ten') ? {...task}
    : (task.kind === 'score-band' || task.kind === 'shape-band' || task.kind === 'mask-band' || task.kind === 'pack-band') ? {...task, look: null} : task.kind === 'zone-cells' || task.kind === 'lf-code' ? task : task.kind === 'lf' ? {kind: 'lf', image: task.image, plan: describePlan(task.plan), g: task.g}
    : task.kind === 'fast-band' ? {kind: 'fast-band', data: task.data, target: task.target, width: task.width, h: task.h, quality: task.quality, y: task.y, small: task.small}
    : task.kind === 'vardct' ? {kind: 'vardct', image: task.image, plan: describePlan(task.plan)}
    : {kind: 'band', data: task.data, target: task.target, width: task.width, h: task.h, quality: task.quality, color: task.color, fast: task.fast, uploadFlat: task.uploadFlat, uploadProfile: task.uploadProfile, uploadGrain: task.uploadGrain, from: task.from, to: task.to, y: task.y, small: task.small};
  const gates = new WeakMap(), bandRuns = new Map();
  const gated = (image, y0, y1, run) => {
    const gate = gates.get(image);
    if (!gate) return run();
    const under = gate.bands.filter(band => band.y < y1 && band.y + band.h > y0).map(band => band.run);
    return Promise.all(under).then(results => results.every(Boolean) ? undefined : gate.placed).then(run);
  };
  const lfGroup = (image, plan, g) => {
    const key = `lf|${idOf(image)}|${plan.lf}|${plan.modularAns}|${plan.cflGroups ?? 64}|${g}`, y0 = Math.floor(g / Math.ceil(Math.ceil(image.width / 8) / 256)) * 2048;
    if (!memo.has(key)) memo.set(key, kept(gated(image, y0, y0 + 2048, () => pool.run({kind: 'lf', image, plan: {...plan, orders: null, clusters: null, fast: false, ans: false}, g}, BIG.lf))));
    return memo.get(key);
  };
  const lfGroups = (image, plan) => Array.from({length: dcGroupCount(image)}, (_, g) => lfGroup(image, plan, g));
  const ranges = groups => { const n = Math.min(groups, pool.limit); return Array.from({length: n}, (_, k) => [Math.floor(k * groups / n), Math.floor((k + 1) * groups / n)]); };
  const countsFor = (image, plan) => {
    const key = `counts|${idOf(image)}|${plan.fast}|${plan.cflGroups ?? 64}|${plan.orders?.join() ?? null}`;
    let promise = memo.get(key);
    if (promise) return promise;
    const task = {kind: 'count', image, plan: {fast: plan.fast, ...(plan.cflGroups > 64 && {cflGroups: plan.cflGroups}), clusters: null, orders: plan.orders, ans: false, modularAns: false, lf: 0}};
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
    } else if (task.kind === 'score-band') promise = pool.run(msg, [], scoreBandTransfers(msg), result => scoreBandReply(msg, result));
    else if (task.kind === 'lf-code') promise = pool.run(msg, [], [], result => result?.bytes instanceof Uint8Array && Number.isSafeInteger(result.at));
    else if (task.kind === 'zone-cells') promise = pool.run(msg, [], [msg.rows.buffer], result => zoneCellsReply(msg, result));
    else if (!CAPTURE_OR_UPLOAD && task.kind === 'shape-band') promise = pool.run(msg, [], [msg.input], result => result?.chosen instanceof Int32Array && result.input instanceof ArrayBuffer && result.input.byteLength === msg.inputBytes);
    else if (!CAPTURE_OR_UPLOAD && task.kind === 'mask-band') promise = pool.run(msg, [], [msg.input], result => result?.hf instanceof Float64Array && result.input instanceof ArrayBuffer && result.input.byteLength === msg.inputBytes);
    else if (!CAPTURE_OR_UPLOAD && task.kind === 'pack-band') promise = pool.run(msg, [], [msg.input], result => Array.isArray(result?.packed?.groups) && result.input instanceof ArrayBuffer && result.input.byteLength === msg.inputBytes);
    else if (task.kind === 'lf') promise = lfGroup(task.image, msg.plan, task.g);
    else if (task.kind === 'effort-ten' && gpu) {
      const relay = relayTo(gpu, dispatch);
      promise = pool.run({...msg, device: gpu.mode ?? 'auto'}, BIG[task.kind], [], null, relay).then(bytes => { if (relay.failure) throw relay.failure; return bytes; });
    }
    else promise = pool.run(msg, BIG[task.kind], msg.pixels ? [msg.pixels.buffer] : []);
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
      if (!counted) return undefined;
      const parts = await Promise.all(ranges(request.groups).map(([from, to]) => pool.run({kind: 'write', image: request.image, plan, counts: counted, from, to}, BIG.write)));
      return parts.every(Boolean) ? {results: parts.flat(), errors: {}} : undefined;
    },
    async captureGroups({pixels, stride, rects, level, shape}) {
      const n = rects.length, results = new Array(n), {helpers: limit, caller} = captureCoders(pool.limit);
      let nextIdx = 0;
      const workerLoop = async () => {
        while (!ended && nextIdx < n) {
          const i = nextIdx++;
          const res = await pool.run(...rectangle('capture-group', pixels, stride, rects[i], {level, shape}));
          if (res instanceof Uint8Array) results[i] = res;
          else if (!ended && !pool.failure) results[i] = captureGroupBytes(pixels, stride, rects[i], level, shape, CAPTURE_TOOLS_COMPLETE);
          else return;
        }
      };
      const workers = Math.min(n, limit);
      const done = Promise.all(Array.from({length: workers}, () => workerLoop()));
      await new Promise(r => setTimeout(r, 0));
      while (caller && !ended && !pool.failure && nextIdx < n) {
        const i = nextIdx++;
        results[i] = captureGroupBytes(pixels, stride, rects[i], level, shape, CAPTURE_TOOLS_COMPLETE);
        if (nextIdx < n) await new Promise(r => setTimeout(r, 0));
      }
      await done;
      return !ended && !pool.failure && results.every(r => r instanceof Uint8Array) ? results : null;
    },
    async captureSingle({pixels, stride, rect, level, shape, choices}) {
      const n = choices.length, results = new Array(n), {helpers: limit, caller} = captureCoders(pool.limit);
      let nextIdx = 0;
      const workerLoop = async () => {
        while (!ended && nextIdx < n) {
          const i = nextIdx++;
          const res = await pool.run(...rectangle('capture-single', pixels, stride, rect, {level, shape, choice: choices[i]}));
          if (res instanceof Uint8Array) results[i] = res;
          else if (!ended && !pool.failure) results[i] = captureSingleCandidateBytes(pixels, stride, rect, level, shape, choices[i], CAPTURE_TOOLS_COMPLETE);
          else return;
        }
      };
      const workers = Math.min(n, limit);
      const done = Promise.all(Array.from({length: workers}, () => workerLoop()));
      await new Promise(r => setTimeout(r, 0));
      while (caller && !ended && !pool.failure && nextIdx < n) {
        const i = nextIdx++;
        results[i] = captureSingleCandidateBytes(pixels, stride, rect, level, shape, choices[i], CAPTURE_TOOLS_COMPLETE);
        if (nextIdx < n) await new Promise(r => setTimeout(r, 0));
      }
      await done;
      return !ended && !pool.failure && results.every(r => r instanceof Uint8Array) ? results : null;
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

function offloaded(pool, stage = null, gpu = null, dispatch) {
  if (!pool) return undefined;
  return Object.assign(driver(pool, gpu, dispatch), {step(steps, reply) {
    if (pool.failure) throw pool.failure;
    return stepOffloaded(steps, reply, pool.limit, stage);
  }});
}

export function parallelJob(steps, {signal, gpu, pool = null, kept = null, stage = null} = {}) {
  if (kept) { pool = kept; kept.busy = true; kept.hold?.(true); }
  const it = (async function* () {
    const device = gpu ? gpuQueue(gpu) : null;
    let ended = false;
    try { yield* driven(steps, signal, it, gpu, offloaded(pool, stage, gpu, device?.concurrent), device); ended = true; }
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
