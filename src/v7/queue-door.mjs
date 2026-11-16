// SPDX-License-Identifier: MIT
import {hostPendingBytes, record, measure, snapshot} from './ownership.mjs';
import {fail, declared, callers, isCaller, PIXELS, abortError, progressOf, abortable, pixelLimit} from './primitives.mjs';
import {WORKER_PROTOCOL} from './protocol.mjs';
import {BUILD_VERSION} from '../build-version.mjs';
import {INTERFACES} from '../wasm-interfaces.mjs';
import {elsewhere, program, relocatable} from './worker-start.mjs';
import {simd} from './simd-probe.mjs';

const SETTINGS = /* @__PURE__ */ new Set(['helpers', 'webgpu', 'maxPixels', 'maxPendingBytes', 'maxPendingJobs', 'workerFactory', 'workerStartupTimeout']);
const IN_PLACE = /* @__PURE__ */ new Set(['helpers', 'webgpu', 'maxPixels', 'workerFactory', 'workerStartupTimeout', 'maxPendingBytes', 'maxPendingJobs']);
const WASM_KEY = /* @__PURE__ */ Symbol.for('rapier-jxl/' + BUILD_VERSION + ' wasm ' + Object.entries(INTERFACES).map(([k, v]) => k + ':' + v).join(';'));
const REPLACED = /* @__PURE__ */ Symbol();
const isFn = v => typeof v === 'function', isObj = v => !!v && typeof v === 'object', isInt = Number.isSafeInteger, noop = () => {};
const optErr = m => fail('JXL_OPTIONS', m), workErr = m => fail('JXL_WORKER', m), memErr = m => fail('JXL_MEMORY', m);
const closedErr = () => fail('JXL_CLOSED', "Queue closed; submit the work to a new queue.");
const isBitmap = v => isFn(globalThis.ImageBitmap) && v instanceof ImageBitmap || isFn(globalThis.VideoFrame) && v instanceof VideoFrame;
const overBytes = (need, max, cur) => {
  if (need > max - cur) throw memErr(`Pending input is over maxPendingBytes (${max} B; need ${need} B): send less or raise it.`);
};

export const isResult = v => isObj(v) && isInt(v.width) && v.width > 0 && isInt(v.height) && v.height > 0 && Array.isArray(v.measurements) &&
  (v.bytes instanceof Uint8Array && v.bytes.byteLength > 0 && typeof v.kept === 'string' && v.meetsTarget === !v.reason ||
    v.bytes === null && v.kept === null && v.meetsTarget === false && isObj(v.reason));

function transfers(v, out = new Set(), seen = new Set()) {
  if (!isObj(v) || seen.has(v) || isFn(globalThis.Blob) && v instanceof Blob || isBitmap(v)) return out;
  seen.add(v);
  if (v instanceof ArrayBuffer || isFn(globalThis.MessagePort) && v instanceof MessagePort) out.add(v);
  else if (ArrayBuffer.isView(v)) out.add(v.buffer);
  else for (const x of Object.values(v)) transfers(x, out, seen);
  return out;
}

function listen(t, type, cb) {
  if (isFn(t.addEventListener) && isFn(t.removeEventListener)) {
    t.addEventListener(type, cb);
    return () => t.removeEventListener(type, cb);
  }
  if (isFn(t.on) && isFn(t.off)) {
    const fn = type === 'message' ? v => cb({data: v}) : cb;
    t.on(type, fn);
    return () => t.off(type, fn);
  }
  throw optErr("workerFactory returned no Worker; return a Worker instance.");
}

function positive(v, def, name) {
  const n = v === undefined ? def : v;
  if (!isInt(n) || n < 1) throw optErr(`Invalid ${name}; use a positive safe integer.`);
  return n;
}

const aborted = sig => {
  try { return callers(sig?.reason === undefined ? abortError() : sig.reason); }
  catch (r) { return callers(r); }
};

function coded(r, sig) {
  try {
    if (r === null || typeof r !== 'object' && !isFn(r)) return r;
    if (isCaller(r) || sig && Object.is(r, sig.reason) || typeof r.code === 'string' && r.code.startsWith('JXL_')) return r;
    const memory = declared(r);
    if (memory?.code === 'JXL_MEMORY') return memory;
    let m = '';
    try { m = String(r.message ?? ''); } catch {}
    return Object.assign(fail('JXL_INTERNAL', m || "Image job failed; report the input and options."), {cause: r});
  } catch { return r; }
}

function started(make, cleanup) {
  try { return make(); }
  catch (cause) { cleanup?.(); throw Object.assign(workErr("Worker did not start; serve the package from the page origin, allow blob: in worker-src, or pass workerFactory."), {cause}); }
}

function browserWorker(spec) {
  if (!spec.url) return started(spec.worker);
  const url = started(spec.url);
  if (!elsewhere(url)) return relocatable(() => started(spec.worker), url, {role: spec.role});
  const src = URL.createObjectURL(new Blob([program(url.href)], {type: 'text/javascript'}));
  let blocked = false;
  const onCsp = e => { if (e.disposition === 'enforce' && e.effectiveDirective === 'worker-src' && (e.blockedURI === 'blob' || e.blockedURI === src)) blocked = true; };
  const done = () => { globalThis.document?.removeEventListener('securitypolicyviolation', onCsp); URL.revokeObjectURL(src); };
  globalThis.document?.addEventListener('securitypolicyviolation', onCsp);
  const w = started(() => new Worker(src, {type: 'module', ...spec.role && {name: spec.role}}), done);
  w.addEventListener('message', done, {once: true});
  w.addEventListener('error', e => { done(); if (blocked) Object.defineProperties(e, {code: {value: 'JXL_WORKER'}, message: {value: "CSP blocks the worker; allow blob: in worker-src."}}); }, {once: true});
  const term = w.terminate;
  w.terminate = function () { done(); return term.call(this); };
  return w;
}

function checkKeys(cfg, allowed, suffix = '') {
  if (!isObj(cfg) || Array.isArray(cfg)) throw optErr("Invalid configuration; pass an object.");
  const bad = Object.keys(cfg).filter(k => !allowed.has(k));
  if (bad.length) throw optErr('Unknown configuration options: ' + bad.join(', ') + ';' + suffix + ' use only ' + [...allowed].join(', ') + '.');
}

const checkSupported = async (f, gpu, needW) => f === 'webgpu' ? (gpu ? gpu() : false)
  : f !== undefined ? Promise.reject(optErr("Feature is unknown; call supported() or supported('webgpu')."))
  : simd() && (!needW || isFn(globalThis.Worker));

function validateSettings(cfg, caps) {
  checkKeys(cfg, SETTINGS);
  const {workerFactory: wf, helpers: rawH, webgpu: gpu} = cfg;
  if (wf !== undefined && !isFn(wf)) throw optErr("Invalid workerFactory; pass a function.");
  if (rawH !== undefined && !caps.helpers) throw optErr("This module has no encoding work for helpers; remove helpers.");
  const helpers = caps.helpers && rawH !== undefined ? caps.helpers(rawH) : undefined;
  if (gpu !== undefined && !caps.gpu) throw optErr("This module has no WebGPU work; remove webgpu.");
  if (gpu !== undefined && gpu !== 'required' && gpu !== false) throw optErr("Invalid webgpu; use 'required', false, or omit it.");
  const maxBytes = positive(cfg.maxPendingBytes, hostPendingBytes(), 'maxPendingBytes');
  const maxPixels = positive(cfg.maxPixels, PIXELS, 'maxPixels');
  if (maxPixels > PIXELS) throw optErr('maxPixels is at most ' + PIXELS + ' (16,384 x 16,384).');
  const maxJobs = positive(cfg.maxPendingJobs, 32, 'maxPendingJobs');
  const startupMs = positive(cfg.workerStartupTimeout, 15000, 'workerStartupTimeout');
  if (startupMs > 2147483647) throw optErr("Invalid workerStartupTimeout; use at most 2147483647 ms.");
  if (!wf && !isFn(globalThis.Worker)) throw workErr("Workers are unavailable here; use a page or worker, or pass workerFactory.");
  return [wf, helpers, gpu, maxBytes, maxPixels, maxJobs, startupMs];
}

function inPlaceDoor(spec, caps) {
  let own = null, loading = null, settings = null, dec = null;
  const load = () => own ? Promise.resolve(own) : loading ??= spec.load().then(m => {
    if (settings) m.configure(settings);
    if (dec) m.configureDecoder(...dec);
    return own = m;
  }).finally(() => { loading = null; });
  return Object.freeze({
    inPlace: true,
    configure(cfg = {}) {
      checkKeys(cfg, IN_PLACE, ' in a worker the module runs in place:');
      if (cfg.helpers !== undefined && !caps.helpers) throw optErr("This module has no encoding work for helpers; remove helpers.");
      if (cfg.helpers !== undefined) caps.helpers(cfg.helpers);
      if (cfg.webgpu !== undefined && !caps.gpu) throw optErr("This module has no WebGPU work; remove webgpu.");
      if (cfg.webgpu !== undefined && cfg.webgpu !== 'required' && cfg.webgpu !== false) throw optErr("Invalid webgpu; use 'required', false, or omit it.");
      if (cfg.maxPixels !== undefined) pixelLimit(cfg.maxPixels);
      if (own) own.configure(cfg);
      settings = Object.keys(cfg).length ? {...cfg} : null;
    },
    call: name => (...args) => load().then(m => m[name](...args)),
    close: () => own ? own.close() : Promise.resolve(),
    supported: f => checkSupported(f, caps.gpu, false),
    decoder(...args) { if (own) return own.configureDecoder(...args); dec = args; },
  });
}

export const decoderOf = door => door.inPlace ? (...args) => door.decoder(...args) : () => {
  throw fail('JXL_UNSUPPORTED', "A browser queue uses its native decoder; call configureDecoder only in Node, Deno, Bun, or an edge host.");
};

export function helperLanes(defaultEffort = 7) {
  return helpers => {
    if (!helpers) return null;
    const beside = helpers.memoryBytes - helpers.count * 46137344;
    let here = null, wide = null;
    return {
      lane(j, running) {
        if (wide || (j.o === 'fit' || j.o === 'variants') && running.size) return -1;
        if (!here) return 0;
        if (!j.n || running.size > helpers.count) return -1;
        let px = j.n;
        for (const o of running.values()) if (o !== here) px += o.n;
        return px * 56 <= beside ? 1 : -1;
      },
      take(j, where, qLen, rSize) {
        const prep = j.o === 'fit' || j.o === 'variants';
        const {effort = defaultEffort, fidelity} = j.o === 'encode' && j.p || {};
        const exact = fidelity === 'exact' || isObj(fidelity) && fidelity.quality === 100;
        const alone = !rSize && (prep || qLen === 1) && (prep || j.o === 'encode' && j.a >= 500000 && effort >= 7 && !exact);
        if (where === 0) here = j;
        if (alone) wide = j;
        return alone;
      },
      free(j) { if (here === j) here = null; if (wide === j) wide = null; },
    };
  };
}

export function inputExpansion(j, data, maxBytes, retained, addBytes, crash, post) {
  if (j.d) return;
  let ok = false, err;
  try {
    if (!isInt(data.inputSequence) || data.inputSequence !== (j.S ?? 0) + 1) throw workErr('Invalid worker input sequence.');
    if (j.l) throw aborted(j.c.signal);
    const prev = j.E ?? 0, bytes = data.inputBytes;
    if (!isInt(bytes) || bytes < prev) throw workErr('Invalid worker input bytes.');
    const added = bytes - prev;
    overBytes(added, maxBytes, retained());
    addBytes(added); j.b += added; j.E = bytes; j.S = data.inputSequence; ok = true;
  } catch (e) {
    const classified = declared(e);
    err = {code: typeof classified?.code === 'string' && classified.code.startsWith('JXL_') ? classified.code : 'JXL_INTERNAL', message: String(classified?.message ?? 'Input reservation refused.')};
    if (err.code === 'JXL_WORKER') { crash(err); return; }
  }
  try { post({id: j.i, inputAck: data.inputSequence, ok, ...(!ok && {error: err})}); }
  catch (e) { crash(e); }
}

function makeQueue([userFactory, helpers, webgpu, maxBytes, maxPixels, maxJobs, startupMs], baseSpec, caps) {
  let spec = helpers?.count && baseSpec.helpers?.url ? {...baseSpec, ...baseSpec.helpers} : baseSpec;
  let factory = userFactory || (() => browserWorker(spec));
  const file = (() => { try { return spec.url?.().pathname.split('/').pop(); } catch {} })();
  let lanes = caps.lanes?.(helpers);
  const replies = caps.previews, checkResult = caps.result;
  let closed = false, nextId = 0, retained = 0, scheduled = false, thread = null, stopping = null, ended, failed, closing = null, idleTimer, preparing = 0;
  const queue = [], running = new Map(), held = new Set();

  const schedule = () => {
    if (scheduled || closed || stopping || !queue.length || (lanes ? lanes.lane(queue[0], running) < 0 : running.size)) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; pump(); });
  };

  const rest = () => {
    clearTimeout(idleTimer);
    if (thread) (idleTimer = setTimeout(() => { if (!closed && !stopping && !preparing && !queue.length && !running.size && !held.size) stopThread(); }, 60000)).unref?.();
  };

  const release = j => {
    if (j.l || j.q) return;
    j.l = true; retained -= j.b; j.x = j.p = null;
    if (j.v) { replies?.clear(j); j.v = null; }
    running.delete(j.i); lanes?.free(j);
    schedule(); rest();
  };

  const settle = (j, ok, val, caller = false) => {
    if (j.d) return;
    const out = !ok && !caller ? (() => { try { return declared(coded(val, j.c.signal)); } catch { return val; } })() : val;
    j.d = true;
    if (j.v) replies?.clear(j);
    try { j.s?.removeEventListener('abort', j.h); } catch {}
    ok ? j.y(out) : j.r(out);
  };

  const cancel = (j, reason, caller = true) => {
    if (j.d) return;
    settle(j, false, reason, caller);
    j.c.abort(reason);
    if (j.f) return;
    if (running.get(j.i) === j) {
      if (!j.t || !j.m) release(j);
      else if (running.size > 1) { try { thread?.w.postMessage({cancel: j.i}); } catch { stopThread(); } }
      else { stopThread(); release(j); }
    } else {
      const at = queue.indexOf(j);
      if (at !== -1) queue.splice(at, 1);
      if (j.q) held.add(j);
      release(j);
    }
  };

  const progress = (j, f) => {
    if (j.d || !Number.isFinite(f) || f < 0 || f > 1 || f <= j.u) return;
    j.u = f;
    try { (j.w ??= progressOf(j.g, j.c.signal, r => cancel(j, r)))?.(f); }
    catch (r) { cancel(j, r); }
  };

  const complete = async (j, ok, val) => {
    if (j.f) return;
    j.f = true;
    try {
      if (ok) { progress(j, 1); await j.w?.finish(); if (j.z) await abortable(j.z, j.c.signal); }
      settle(j, ok, val);
    } catch (r) { settle(j, false, r, true); }
    finally { release(j); }
  };

  function stopThread(reason = Object.assign(workErr("JPEG XL worker stopped; start a fresh worker and retry."), {[REPLACED]: true})) {
    const old = thread;
    if (!old) return;
    thread = null;
    const res = old.x(reason, e => { failed ??= {reason: e}; });
    const end = new Promise(r => r(res)).then(noop, e => { failed ??= {reason: e}; throw e; });
    end.catch(noop);
    ended = Promise.allSettled([ended, end]).then(() => { if (failed) throw failed.reason; });
    ended.catch(noop);
    if (res && (typeof res === 'object' || isFn(res))) {
      const wait = end.catch(noop).finally(() => { if (stopping === wait) stopping = null; schedule(); });
      stopping = wait;
    }
    for (const j of [...running.values()]) complete(j, false, reason);
  }

  function crash(cur, ev) {
    if (thread !== cur) return;
    const unloaded = !cur.r() && ev?.type === 'error' && !ev.message && !ev.error;
    const msg = unloaded ? `The JPEG XL worker did not load. Copy ${file ?? "the module's own file"} from the package's dist folder beside the bundle, or pass workerFactory.`
      : "JPEG XL worker stopped; start a fresh worker and retry.";
    stopThread(fail(typeof ev?.code === 'string' && ev.code.startsWith('JXL_') ? ev.code : 'JXL_WORKER', ev?.message || ev?.error?.message || msg));
    schedule();
  }

  function send(cur, j) {
    if (!cur.r() || !j.t || j.m || j.d || thread !== cur || running.get(j.i) !== j) return;
    try {
      cur.w.postMessage({id: j.i, operation: j.o, input: j.x, options: j.p, ...(isBitmap(j.x) && {bitmap: true}), ...(j.v && {preview: true}), maxPixels, helpers, webgpu, lane: j.L, alone: j.A}, [...transfers([j.x, j.p])]);
      j.m = true; j.x = j.p = null;
    } catch (r) { try { complete(j, false, r); } finally { stopThread(); } }
  }

  function openThread() {
    if (thread) return thread;
    let w;
    try { w = factory(); if (w && isFn(w.then)) Promise.resolve(w).catch(noop); }
    catch (cause) { throw callers(cause); }
    if (!w || !isFn(w.postMessage) || !isFn(w.terminate)) throw optErr("workerFactory reused a Worker; return a fresh Worker for each call.");
    let ready = false, timer = null, attempt = 0;
    const offs = [], preps = new Map(), waiters = new Map();
    const cur = thread = {
      w, r: () => ready,
      p(op) {
        const hit = preps.get(op);
        if (hit) return hit;
        const n = ++attempt;
        const pr = new Promise((yes, no) => {
          waiters.set(n, [yes, no]);
          try { w.postMessage({prepare: op, attempt: n, webgpu, helpers}); } catch (r) { crash(cur, r); }
        });
        preps.set(op, pr);
        pr.catch(() => { if (preps.get(op) === pr) preps.delete(op); });
        return pr;
      },
      x(reason, onErr) {
        clearTimeout(timer);
        for (const [, no] of waiters.values()) no(reason);
        for (const off of offs) { try { off(); } catch (e) { onErr(e); } }
        try { return w.terminate(); } catch (e) { return Promise.reject(e); }
      },
    };
    try {
      offs.push(listen(w, 'message', ({data}) => {
        if (thread !== cur) return;
        if (data?.ready !== undefined) {
          if (ready && data.ready === WORKER_PROTOCOL) return;
          if (data.ready !== WORKER_PROTOCOL) return crash(cur, {code: 'JXL_WORKER', message: "Worker uses a different protocol; use the worker from this package."});
          if (data.module !== spec.module) return crash(cur, {code: 'JXL_WORKER', message: `Worker runs ${data.module ?? "no named module"}; use the worker for ${spec.module}.`});
          ready = true; clearTimeout(timer);
          for (const j of running.values()) send(cur, j);
          return;
        }
        if (data?.configurationError) return crash(cur, data.configurationError);
        if (!ready) return crash(cur, {code: 'JXL_WORKER', message: "Worker replied before it was ready; use the worker from this package."});
        if (data?.prepared === true) {
          const wt = waiters.get(data.attempt);
          if (!wt) return;
          waiters.delete(data.attempt);
          data.ok === true ? wt[0]() : wt[1](fail(data.error?.code || 'JXL_WASM', data.error?.message || 'WebAssembly preparation failed; enable WebAssembly SIMD and retry.'));
          return;
        }
        const j = running.get(data?.id);
        if (!j) return;
        if (caps.expand && 'inputBytes' in data) return caps.expand(j, data, maxBytes, () => retained, n => { retained += n; }, r => crash(cur, r), m => w.postMessage(m));
        if ('progress' in data) return progress(j, data.progress);
        if (replies && 'preview' in data) {
          return replies.handle(j, data, r => cancel(j, r), () => { if (thread === cur && running.get(j.i) === j && !j.d) w.postMessage({id: j.i, previewAck: data.previewSequence}); });
        }
        if (data.ok === true) {
          const ok = !checkResult || checkResult(data.value, j.o);
          complete(j, ok, ok ? data.value : workErr("Worker returned an invalid result; restart it and report the input."));
        } else if (data.ok === false) {
          complete(j, false, Object.assign(new Error(data.error?.message || 'The JPEG XL operation failed; restart the worker and retry.'), {name: data.error?.name || 'Error', code: data.error?.code || 'JXL_WORKER'}));
        } else crash(cur, {message: 'The JPEG XL worker returned an invalid reply; restart it and report the reproducing input.'});
      }));
      offs.push(listen(w, 'error', e => crash(cur, e)), listen(w, 'messageerror', e => crash(cur, e)));
      if (isFn(w.on) && isFn(w.off)) offs.push(listen(w, 'exit', () => crash(cur)));
      timer = setTimeout(() => crash(cur, {code: 'JXL_WORKER', message: `Worker was not ready in ${startupMs} ms: check its URL and CSP, or raise workerStartupTimeout.`}), startupMs);
      timer.unref?.();
      const mods = globalThis[WASM_KEY];
      if (mods) w.postMessage({wasmModules: {...mods}});
    } catch (r) { stopThread(r?.code === 'JXL_OPTIONS' ? r : undefined); throw r; }
    return cur;
  }

  function begin(j) {
    if (j.e) return complete(j, false, j.e);
    if (j.k) { j.x = j.k; j.k = null; }
    j.t = true;
    try {
      const cur = openThread();
      if (!cur.r() && j.o !== 'encode') cur.p(j.o).catch(noop);
      send(cur, j);
    } catch (r) { stopThread(); complete(j, false, r); }
  }

  function pump() {
    while (!closed && !stopping && queue.length) {
      const j = queue[0], where = lanes ? lanes.lane(j, running) : running.size ? -1 : 0;
      if (where < 0) return;
      const alone = lanes ? lanes.take(j, where, queue.length, running.size) : true;
      queue.shift(); running.set(j.i, j);
      j.L = where; j.A = alone;
      progress(j, 0);
      if (j.d) { release(j); continue; }
      if (!j.q) begin(j);
    }
  }

  function admit(options = {}, inBytes = 0) {
    if (closed) throw closedErr();
    if (!isObj(options) || Array.isArray(options)) throw optErr("Invalid options; pass an object.");
    let fields;
    try { fields = record(options); }
    catch (r) { throw !r?.code || r.code === 'JXL_INPUT' ? optErr("Invalid options; pass plain data fields.") : r; }
    const {signal, onProgress, onPreview, ...params} = Object.fromEntries(fields.map(([k, d]) => [k, d.value]));
    if (signal !== undefined && (!signal || !isFn(signal.addEventListener) || !isFn(signal.removeEventListener) || typeof signal.aborted !== 'boolean'))
      throw optErr("Invalid signal; pass an AbortSignal.");
    if (onProgress !== undefined && !isFn(onProgress)) throw optErr("Invalid onProgress; pass a function.");
    if (onPreview !== undefined && !isFn(onPreview)) throw optErr("Invalid onPreview; pass a function.");
    if (signal?.aborted) throw aborted(signal);
    if (queue.length + running.size + held.size >= maxJobs) throw memErr("Queue full; wait or raise maxPendingJobs.");
    const optPlans = new Map();
    let optBytes;
    try { optBytes = measure(params, Number.MAX_SAFE_INTEGER, optPlans); }
    catch (r) { throw r?.code === 'JXL_INPUT' ? optErr("Invalid option data; put callbacks in onProgress or onPreview.") : r; }
    overBytes(inBytes + optBytes, maxBytes, retained);
    return [signal, onProgress, onPreview, params, optBytes, optPlans];
  }

  function submit(op, input, options = {}, acquire = null, area = 0) {
    try {
      const [signal, onProgress, onPreview, params, optBytes, optPlans] = admit(options);
      if (onPreview !== undefined && !replies?.ops.has(op)) throw optErr("This operation has no previews; remove onPreview.");
      spec.admitInput?.(op, input);
      const inPlans = new Map(), bytes = measure(input, maxPixels, inPlans) + optBytes;
      overBytes(bytes, maxBytes, retained);
      if (op === 'encode') caps.frames?.(input, inPlans);
      const moved = new Map(), ownIn = snapshot(input, inPlans, undefined, moved), ownOpt = snapshot(params, optPlans, undefined, moved);
      return new Promise((resolve, reject) => {
        const px = lanes && op === 'encode' && ArrayBuffer.isView(ownIn?.data) ? ownIn.width * ownIn.height : 0;
        const j = {i: ++nextId, o: op, x: ownIn, p: ownOpt, b: bytes, n: px, a: px || area, s: signal, g: onProgress, v: onPreview, y: resolve, r: reject, d: false, l: false, u: -1, c: new AbortController()};
        j.h = () => cancel(j, aborted(signal));
        retained += bytes; queue.push(j);
        acquire?.(j, () => { held.delete(j); if (j.d) release(j); else if (running.get(j.i) === j && !j.t) begin(j); }, inputBytes => {
          if (j.d) throw aborted(j.c.signal);
          if (!isInt(inputBytes) || inputBytes < 0) throw fail('JXL_INTERNAL', 'Invalid acquired input reservation.');
          const added = inputBytes + optBytes - j.b;
          overBytes(Math.max(0, added), maxBytes, retained);
          retained += added; j.b += added;
        });
        try { if (!j.d) signal?.addEventListener('abort', j.h, {once: true}); if (signal?.aborted) j.h(); }
        catch (r) { cancel(j, r); }
        schedule();
      });
    } catch (r) { return Promise.reject(declared(r)); }
  }

  return {
    get maxPixels() { return maxPixels; }, get maxPendingBytes() { return maxBytes; }, admit, submit,
    idle: () => !closed && !preparing && !queue.length && !running.size && !held.size,
    reconfigure([nextFactory, nextHelpers, nextGpu, nextMaxBytes, nextMaxPixels, nextMaxJobs, nextStartup]) {
      const changed = nextFactory !== userFactory || nextGpu !== webgpu || nextStartup !== startupMs ||
        nextHelpers?.count !== helpers?.count || nextHelpers?.memoryBytes !== helpers?.memoryBytes;
      userFactory = nextFactory; helpers = nextHelpers; webgpu = nextGpu;
      maxBytes = nextMaxBytes; maxPixels = nextMaxPixels; maxJobs = nextMaxJobs; startupMs = nextStartup;
      spec = helpers?.count && baseSpec.helpers?.url ? {...baseSpec, ...baseSpec.helpers} : baseSpec;
      factory = userFactory || (() => browserWorker(spec));
      lanes = caps.lanes?.(helpers);
      if (changed && thread) stopThread();
    },
    prepare(op = spec.operations[0]) {
      if (closed) return Promise.reject(closedErr());
      if (!spec.operations.includes(op)) return Promise.reject(optErr("Invalid prepare operation; use " + spec.operations.join(', ') + '.'));
      preparing++;
      return (async () => {
        await null;
        for (;;) {
          while (stopping) await stopping;
          if (closed) throw closedErr();
          try { return await openThread().p(op); }
          catch (r) { if (!r?.[REPLACED] || closed) throw r; }
        }
      })().finally(() => { preparing--; rest(); }).catch(r => { throw closed ? closedErr() : declared(coded(r)); });
    },
    close() {
      if (closing) return closing;
      closed = true; clearTimeout(idleTimer);
      const reason = closedErr(), taking = [...queue, ...running.values(), ...held].map(j => j.q).filter(Boolean);
      for (const j of [...queue]) cancel(j, reason, false);
      for (const j of [...running.values()]) cancel(j, reason, false);
      stopThread();
      return closing = Promise.allSettled([stopping, ended, ...taking]).then(list => {
        const bad = list.find(o => o.status === 'rejected');
        if (bad) throw Object.assign(workErr("Worker cleanup failed; check its termination and listener methods."), {cause: bad.reason});
      });
    },
  };
}

export function queueDoor(spec, caps = {}) {
  if (isFn(globalThis.WorkerGlobalScope) && globalThis instanceof WorkerGlobalScope) return inPlaceDoor(spec, caps);
  let parsed = null, q = null, closing = null;
  const active = () => {
    if (closing) throw fail('JXL_CLOSED', "Queue is closing; call again once close() has resolved.");
    return q ??= makeQueue(parsed ??= validateSettings({}, caps), spec, caps);
  };
  return Object.freeze({
    queue: active,
    configure(cfg = {}) {
      const next = validateSettings(cfg, caps);
      if (closing) throw optErr("Queue is closing; await close() before calling configure().");
      if (q && !q.idle()) throw optErr("A call is active; wait for pending work to settle or await close() before calling configure().");
      parsed = next;
      if (q) q.reconfigure(next);
    },
    call: name => name === 'prepare'
      ? (...args) => { try { return active().prepare(...args); } catch (e) { return Promise.reject(e); } }
      : (input, options) => {
          try {
            const cur = active();
            if (isObj(options) && options.maxPixels !== undefined) pixelLimit(options.maxPixels);
            return cur.submit(name, input, options);
          } catch (e) { return Promise.reject(e); }
        },
    close() {
      if (closing) return closing;
      const ending = q; q = null;
      return ending ? closing = ending.close().finally(() => { closing = null; }) : Promise.resolve();
    },
    supported: f => checkSupported(f, caps.gpu, true),
  });
}

