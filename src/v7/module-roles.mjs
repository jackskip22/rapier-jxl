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
import {fail, snapshotOptions, pixelLimit, webgpuSetting, blobHead, abortable, callers, admitSignal, check} from './primitives.mjs';
import {configuredDecoder} from '../decoder-setting.mjs';
const MOVES = ['encode', 'fit', 'variants', 'capture'];
const buffersOf = input => {
  const views = ArrayBuffer.isView(input?.data) ? [input.data] : Array.isArray(input?.frames) ? input.frames.map(frame => frame?.data) : [];
  return [...new Set(views.filter(view => ArrayBuffer.isView(view)).map(view => view.buffer))];
};
const handing = call => function (input, options) {
  let taken;
  try { taken = options !== null && typeof options === 'object' ? Object.getOwnPropertyDescriptor(options, 'transfer') : undefined; }
  catch { return call.apply(this, arguments); }
  if (!taken) return call.apply(this, arguments);
  try {
    if (!('value' in taken) || taken.value !== true) throw fail('JXL_OPTIONS', 'transfer: true');
    const buffers = buffersOf(input);
    if (buffers.some(buffer => !(buffer instanceof ArrayBuffer) || buffer.detached))
      throw fail('JXL_INPUT', 'ArrayBuffer: not transferable');
    const rest = Object.create(Object.getPrototypeOf(options));
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(options))) if (key !== 'transfer') Object.defineProperty(rest, key, descriptor);
    for (const key of Object.getOwnPropertySymbols(options)) Object.defineProperty(rest, key, Object.getOwnPropertyDescriptor(options, key));
    return Promise.resolve(call.call(this, input, rest)).then(result => {
      try { structuredClone(buffers, {transfer: buffers}); } catch {}
      return result;
    });
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
  const helps = !((typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) || (typeof __RAPIER_JXL_JPEG__ !== 'undefined' && __RAPIER_JXL_JPEG__ === true) || (typeof __RAPIER_JXL_UNSTEPPED__ !== 'undefined' && __RAPIER_JXL_UNSTEPPED__ === true)) && !!(pool || own), keys = [...(webgpu ? ['webgpu'] : []), 'maxPixels', ...(helps ? ['helpers'] : [])];
  const ready = signal => retirement && abortable(retirement.promise, signal);
  const live = () => runtime ??= own ? own(ready) : moduleRuntime(raw, {name, gpu, ready,
    ...(pool && {helpers: async () => pool, helper: ownFile(roleName(name, 'helper'), url)})});
  const release = (ending, final) => new Promise(resolve => resolve(runtime.release(ending, final))).catch(cause => {
    if (own) throw cause;
    throw Object.assign(fail('JXL_WORKER', 'terminate() failed'), {cause});
  });
  const retire = () => {
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
    const helpers = !((typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) || (typeof __RAPIER_JXL_JPEG__ !== 'undefined' && __RAPIER_JXL_JPEG__ === true) || (typeof __RAPIER_JXL_UNSTEPPED__ !== 'undefined' && __RAPIER_JXL_UNSTEPPED__ === true)) && helps ? helperReservation(config.helpers) : undefined;
    const changed = reservation && (helpers?.count !== reservation.count || helpers?.memoryBytes !== reservation.memoryBytes);
    settings = Object.keys(config).length ? config : null; reservation = helpers; maxJobs = jobs;
    if (runtime && changed) retire();
  };
  const close = () => {
    if (closing) return closing;
    const ending = owner, taking = [...admissions], reason = shut(), held = retirement;
    owner = {};
    for (const admission of taking) admission.cancel(reason);
    return closing = (async () => {
      await Promise.all(taking.map(admission => admission.done));
      const results = await Promise.allSettled([held?.promise, runtime && release(ending, true)]);
      const failure = results.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
      if (retirement === held) retirement = null;
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
        try { result = settings || retirement ? run.apply(this, arguments) : fn.apply(this, arguments); }
        catch (reason) { settled(); throw reason; }
        return Promise.resolve(result).finally(settled);
      }
      if (!settings && !retirement) return fn.apply(this, arguments);
      return run.apply(this, arguments);
    };
    const run = function (input, options) {
      const configured = !!settings, config = settings ?? {}, helpers = reservation, heldOwner = owner,
        ending = retirement?.promise, first = running++ === 0;
      let lane = false, canceled, interrupt, finish;
      const admission = {done: new Promise(resolve => { finish = resolve; }),
        cancel(reason) { canceled = reason; interrupt?.(reason); }};
      admissions.add(admission);
      return (async () => {
        try {
          options = snapshotOptions(options, 'Options', ['signal', 'onProgress', 'onPreview', 'onEncoded']);
          admitSignal(options.signal); check(options.signal);
          if (canceled) throw canceled;
          const host = op !== 'prepare' && helps && typeof Blob === 'function' && input instanceof Blob && configuredDecoder() !== null ? jpegBlob(input) : false;
          const hostRead = host instanceof Promise ? await Promise.race([abortable(host, options.signal),
            new Promise((resolve, reject) => { interrupt = reject; if (canceled) reject(canceled); })]) : host;
          check(options.signal);
          if (canceled) throw canceled;
          admissions.delete(admission);
          const alone = running === 1;
          lane = op !== 'prepare' && helps && !!helpers && !first && !alone && lanes < helpers.count && !hostRead;
          if (lane) lanes++;
          const hooks = {signal: options.signal, onProgress: options.onProgress, onPreview: options.onPreview, onEncoded: options.onEncoded,
            maxPixels: config.maxPixels, webgpu: config.webgpu, helpers, owner: heldOwner, owned: false, lane, alone};
          const result = await (!configured ? fn.call(this, input, options) : op !== 'prepare' ? live().run(op, input, options, hooks) : (helps && helpers || gpu && config.webgpu === 'required')
            ? live().prepare(input ?? prepareOp, {webgpu: config.webgpu, owner: heldOwner, helpers}) : fn.call(this, input));
          if (ending) await abortable(ending, options.signal);
          check(options.signal);
          return result;
        } finally {
          running--; if (lane) lanes--;
          admissions.delete(admission); finish();
        }
      })();
    };
    return Object.defineProperties(MOVES.includes(op) ? handing(call) : call, Object.getOwnPropertyDescriptors(fn));
  };
  return {configure, close, wrap};
}
