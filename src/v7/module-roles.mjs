// SPDX-License-Identifier: MIT
export const roleName = (module, role) => module + ' ' + role;

export function workerRole() {
  if (typeof WorkerGlobalScope === 'function' && globalThis instanceof WorkerGlobalScope) return typeof globalThis.name === 'string' ? globalThis.name : '';
  let threads;
  try { threads = globalThis.process?.getBuiltinModule?.('node:worker_threads'); } catch {}
  if (!threads || threads.isMainThread) return '';
  return typeof threads.workerData === 'string' ? threads.workerData : typeof threads.threadName === 'string' ? threads.threadName : '';
}

const classic = () => { try { globalThis.importScripts('about:blank'); return true; } catch (error) { return !(error instanceof TypeError); } };

const here = () => globalThis.location && globalThis.location.protocol !== 'blob:' ? globalThis.location.href : import.meta.url;
const served = url => () => {
  const found = url();
  return found.protocol === 'file:' && globalThis.location && !['file:', 'blob:'].includes(globalThis.location.protocol) ? new URL(globalThis.location.href) : found;
};
export const ownFile = (role, given = () => new URL(here())) => {
  const url = served(given);
  return Object.freeze({role, url, worker: () => new Worker(url(), {type: classic() ? 'classic' : 'module', name: role})});
};

export function serveRole(module, roles) {
  const role = workerRole();
  if (!role.startsWith(module + ' ')) return;
  const serve = roles[role.slice(module.length + 1)];
  if (serve) serve();
}

import {moduleRuntime} from './module-runtime.mjs';
import {helperReservation} from './helper-reservation.mjs';
import {fail, object, snapshotOptions, pixelLimit, webgpuSetting, blobHead, abortable, callers, admitSignal, check, isBlob, declared} from './primitives.mjs';
import {configuredDecoder} from '../decoder-setting.mjs';
import {liveView, arrayBufferBytes} from './bytes.mjs';
const MOVES = ['encode', 'fit', 'variants', 'capture'];
const ownValue = (target, key) => {
  if (!target || typeof target !== 'object') return undefined;
  let d;
  try { d = Object.getOwnPropertyDescriptor(target, key); } catch (error) { throw callers(error); }
  return d && 'value' in d ? d.value : undefined;
};
const buffersOf = input => {
  const data = ownValue(input, 'data'), frames = ownValue(input, 'frames');
  const views = ArrayBuffer.isView(data) ? [data] : Array.isArray(frames) ? frames.map(frame => ownValue(frame, 'data')) : [];
  return [...new Set(views.filter(view => ArrayBuffer.isView(view)).map(view => {
    const buffer = liveView(view)?.[0];
    if (!buffer || arrayBufferBytes(buffer) === null) throw fail('JXL_INPUT', 'ArrayBuffer: not transferable');
    return buffer;
  }))];
};
const handing = call => function (input, options) {
  let taken;
  try { taken = options !== null && typeof options === 'object' ? Object.getOwnPropertyDescriptor(options, 'transfer') : undefined; }
  catch (error) { return Promise.reject(callers(error)); }
  if (!taken) return call.apply(this, arguments);
  try {
    object(options);
    if (!('value' in taken) || taken.value !== true && taken.value !== undefined) throw fail('JXL_OPTIONS', 'transfer: true');
    const buffers = taken.value === true ? buffersOf(input) : null;
    const rest = Object.create(Object.getPrototypeOf(options));
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(options))) if (key !== 'transfer') Object.defineProperty(rest, key, descriptor);
    for (const key of Object.getOwnPropertySymbols(options)) Object.defineProperty(rest, key, Object.getOwnPropertyDescriptor(options, key));
    const result = Promise.resolve(call.call(this, input, rest));
    return buffers ? result.then(value => {
      try { structuredClone(buffers, {transfer: buffers}); }
      catch (cause) { throw Object.assign(fail('JXL_INPUT', 'ArrayBuffer: copy before transfer'), {cause}); }
      return value;
    }) : result;
  } catch (error) { return Promise.reject(error); }
};
const jpegBlob = blob => {
  let type;
  try { type = blob.type; } catch (reason) { throw callers(reason); }
  if (typeof type !== 'string') throw fail('JXL_INPUT', 'blob.type: string');
  return type ? /^image\/p?jpe?g$/i.test(type) : blobHead(blob).then(head => head[0] === 255 && head[1] === 216, () => false);
};
const QUEUED = /* @__PURE__ */ new Set(['workerFactory', 'workerStartupTimeout', 'maxPendingBytes', 'maxPendingJobs']);
const queued = (key, value) => {
  if (key === 'workerFactory' ? typeof value !== 'function' : !(Number.isSafeInteger(value) && value > 0 && (key !== 'workerStartupTimeout' || value <= 2147483647)))
    throw fail('JXL_OPTIONS', `Invalid ${key}; ${key === 'workerFactory' ? 'pass a function' : 'use a positive whole number'}.`);
};
export function inPlace(name, raw, {gpu = false, webgpu = !!gpu, pool, url, prepareOp, runtime: own} = {}) {
  let settings = null, reservation, owner = {}, running = 0, lanes = 0, runtime = null, closing = null, retirement = null, maxJobs = Infinity, pending = 0;
  const admissions = new Set();
  const helps = !((typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) || (typeof __RAPIER_JXL_JPEG__ !== 'undefined' && __RAPIER_JXL_JPEG__ === true) || (typeof __RAPIER_JXL_NO_HELPERS__ !== 'undefined' && __RAPIER_JXL_NO_HELPERS__ === true)) && !!(pool || own), keys = [...(webgpu ? ['webgpu'] : []), 'maxPixels', ...(helps ? ['helpers'] : [])];
  const ready = !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) ? signal => retirement && abortable(retirement.promise, signal) : undefined;
  const live = () => runtime ??= !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && own ? own(ready) : moduleRuntime(raw, {name, gpu,
    ...(!(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && {ready, ...(pool && {helpers: async () => pool, helper: ownFile(roleName(name, 'helper'), url)})})});
  const release = (typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) ? null : (ending, final) => new Promise(resolve => resolve(runtime.release(ending, final))).catch(cause => {
    if (own) throw cause;
    throw Object.assign(fail('JXL_WORKER', 'terminate() failed'), {cause});
  });
  const retire = (typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) ? null : () => {
    if (retirement) return;
    let settle;
    const held = retirement = {promise: new Promise(resolve => { settle = resolve; })};
    held.promise.then(() => { if (retirement === held) retirement = null; }, () => {});
    settle(release(owner, false));
  };
  const shut = () => fail('JXL_CLOSED', 'closing');
  const configure = given => {
    const config = snapshotOptions(given, 'options');
    for (const key of Object.keys(config)) {
      if (QUEUED.has(key)) { if (config[key] !== undefined) queued(key, config[key]); continue; }
      if (!keys.includes(key)) throw fail('JXL_OPTIONS', `unknown option: ${key} (allowed: ${keys.join(', ')})`);
    }
    if (closing) throw fail('JXL_OPTIONS', 'closing: wait for close()');
    if (running || pending) throw fail('JXL_OPTIONS', 'configure: call active');
    const jobs = config.maxPendingJobs ?? Infinity;
    for (const key of QUEUED) delete config[key];
    pixelLimit(config.maxPixels); webgpuSetting(config.webgpu);
    const helpers = !((typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) || (typeof __RAPIER_JXL_JPEG__ !== 'undefined' && __RAPIER_JXL_JPEG__ === true) || (typeof __RAPIER_JXL_NO_HELPERS__ !== 'undefined' && __RAPIER_JXL_NO_HELPERS__ === true)) && helps ? helperReservation(config.helpers) : undefined;
    const changed = !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && reservation && (helpers?.count !== reservation.count || helpers?.memoryBytes !== reservation.memoryBytes);
    settings = Object.keys(config).length ? config : null; reservation = helpers; maxJobs = jobs;
    if (!(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && runtime && changed) retire();
  };
  const close = () => {
    if (closing) return closing;
    const ending = owner, taking = [...admissions], reason = shut(), held = !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) ? retirement : null;
    owner = {};
    for (const admission of taking) admission.cancel(reason);
    return closing = (async () => {
      await Promise.all(taking.map(admission => admission.done));
      const results = await Promise.allSettled([held?.promise, !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && runtime && release(ending, true)]);
      if (!(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true)) {
        const failure = results.find(result => result.status === 'rejected');
        if (failure) throw failure.reason;
        if (retirement === held) retirement = null;
      }
    })().finally(() => { closing = null; });
  };
  const wrap = op => {
    const fn = raw[op];
    const call = function (input, options) {
      if (closing) return Promise.reject(shut());
      if (maxJobs !== Infinity) {
        if (pending >= maxJobs) return Promise.reject(fail('JXL_MEMORY', 'Calls at maxPendingJobs; wait or raise it.'));
        pending++;
        const settled = () => { pending--; };
        let result;
        try { result = settings || (!(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && retirement) ? run.apply(this, arguments) : fn.apply(this, arguments); }
        catch (reason) { settled(); throw reason; }
        return Promise.resolve(result).finally(settled);
      }
      if (!settings && ((typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) || !retirement)) return fn.apply(this, arguments);
      return run.apply(this, arguments);
    };
    const run = function (input, options) {
      const configured = !!settings, config = settings ?? {}, helpers = reservation, heldOwner = owner,
        ending = !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) ? retirement?.promise : undefined, first = running++ === 0;
      let lane = false, canceled, interrupt, finish;
      const admission = {done: new Promise(resolve => { finish = resolve; }),
        cancel(reason) { canceled = reason; interrupt?.(reason); }};
      admissions.add(admission);
      return (async () => {
        try {
          options = snapshotOptions(options, 'Options', ['signal', 'onProgress', 'onPreview', 'onEncoded']);
          admitSignal(options.signal); check(options.signal);
          if (canceled) throw canceled;
          let hostRead = false;
          if (!(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true)) {
            const host = op !== 'prepare' && helps && isBlob(input) && configuredDecoder() !== null ? jpegBlob(input) : false;
            hostRead = host instanceof Promise ? await Promise.race([abortable(host, options.signal),
              new Promise((resolve, reject) => { interrupt = reject; if (canceled) reject(canceled); })]) : host;
          }
          check(options.signal);
          if (canceled) throw canceled;
          admissions.delete(admission);
          const alone = running === 1;
          if (!(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true)) {
            lane = op !== 'prepare' && helps && !!helpers && !first && !alone && lanes < helpers.count && !hostRead;
            if (lane) lanes++;
          }
          const hooks = {signal: options.signal, onProgress: options.onProgress, onPreview: options.onPreview, onEncoded: options.onEncoded,
            maxPixels: config.maxPixels, webgpu: config.webgpu, helpers, owner: heldOwner, owned: false, lane, alone};
          const result = await (!configured ? fn.call(this, input, options) : op !== 'prepare' ? live().run(op, input, options, hooks) : !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && (helps && helpers || gpu && config.webgpu === 'required')
            ? live().prepare(input ?? prepareOp, {webgpu: config.webgpu, owner: heldOwner, helpers}) : fn.call(this, input));
          if (!(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && ending) await abortable(ending, options.signal);
          check(options.signal);
          return result;
        } finally {
          running--; if (!(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && lane) lanes--;
          admissions.delete(admission); finish();
        }
      })();
    };
    return Object.defineProperties(MOVES.includes(op) ? handing(call) : call, Object.getOwnPropertyDescriptors(fn));
  };
  return {configure, close, wrap};
}

