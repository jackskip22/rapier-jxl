// SPDX-License-Identifier: MIT
import {shownEntry} from './entry-name.mjs';
import {hostPendingBytes, record, measure, snapshot} from './ownership.mjs';
import {fail, declared, callers, isCaller, PIXELS, abortError, progressOf, abortable, pixelLimit, dimensions, object, snapshotOptions, admitSignal, check, isBlob} from './primitives.mjs';
import {open2d, read2d} from './canvas-2d.mjs';
import {isPlainRecord} from './records.mjs';
import {setDecoder} from '../decoder-setting.mjs';
import {WORKER_PROTOCOL} from './protocol.mjs';
import {BUILD_VERSION} from '../build-version.mjs';
import {INTERFACES} from '../wasm-interfaces.mjs';
import {elsewhere, program, relocatable} from './worker-start.mjs';
import {simd} from './simd-probe.mjs';

const S_KEYS = ['helpers', 'webgpu', 'maxPixels', 'maxPendingBytes', 'maxPendingJobs', 'workerFactory', 'workerStartupTimeout'];
const SETTINGS = /* @__PURE__ */ new Set(S_KEYS);
const IN_PLACE = /* @__PURE__ */ new Set([...S_KEYS.slice(0, 3), ...S_KEYS.slice(5), ...S_KEYS.slice(3, 5)]);
const WASM_KEY = /* @__PURE__ */ Symbol.for('rapier-jxl/' + BUILD_VERSION + ' wasm ' + Object.entries(INTERFACES).map(([k, v]) => k + ':' + v).join(';'));
const REPLACED = /* @__PURE__ */ Symbol();
const isFn = v => typeof v === 'function', isObj = v => !!v && typeof v === 'object', isInt = Number.isSafeInteger, noop = () => {};
const optErr = m => fail('JXL_OPTIONS', m), workErr = m => fail('JXL_WORKER', m), memErr = m => fail('JXL_MEMORY', m);
const closedErr = () => fail('JXL_CLOSED', "Queue closed; submit the work to a new queue.");
const isBitmap = v => isFn(globalThis.ImageBitmap) && v instanceof ImageBitmap || isFn(globalThis.VideoFrame) && v instanceof VideoFrame;
const overBytes = (need, max, cur) => {
  if (need > max - cur) throw memErr(`maxPendingBytes ${max}: need ${need} B`);
};

export const isResult = v => isObj(v) && isInt(v.width) && v.width > 0 && isInt(v.height) && v.height > 0 && Array.isArray(v.measurements) &&
  (v.bytes instanceof Uint8Array && v.bytes.byteLength > 0 && typeof v.kept === 'string' && v.meetsTarget === !v.reason ||
    v.bytes === null && v.kept === null && v.meetsTarget === false && isObj(v.reason));

function transfers(v, out = new Set(), seen = new Set()) {
  if (!isObj(v) || seen.has(v) || isBlob(v) || isBitmap(v)) return out;
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
  throw optErr("workerFactory: Worker instance");
}

function positive(v, def, name) {
  const n = v === undefined ? def : v;
  if (!isInt(n) || n < 1) throw optErr(`${name}: positive safe integer`);
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
    return Object.assign(fail('JXL_INTERNAL', m || "queue:job"), {cause: r});
  } catch { return r; }
}

function started(make, cleanup) {
  try { return make(); }
  catch (cause) { cleanup?.(); throw Object.assign(workErr("worker: same-origin|blob: worker-src|workerFactory"), {cause}); }
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
  w.addEventListener('error', e => { done(); if (blocked) Object.defineProperties(e, {code: {value: 'JXL_WORKER'}, message: {value: "CSP worker-src: allow blob:"}}); }, {once: true});
  const term = w.terminate;
  w.terminate = function () { done(); return term.call(this); };
  return w;
}

function checkKeys(cfg, allowed, suffix = '') {
  object(cfg, 'config');
  const bad = Object.keys(cfg).filter(k => !allowed.has(k));
  if (bad.length) throw optErr('unknown options: ' + bad.join(', ') + ';' + suffix + ' allowed: ' + [...allowed].join(', '));
}

const checkSupported = async (f, gpu, needW) => f === 'webgpu' ? (gpu ? gpu() : false)
  : f !== undefined ? Promise.reject(optErr("feature: use supported()|supported('webgpu')"))
  : simd() && (!needW || isFn(globalThis.Worker));

function validateSettings(cfg, caps, inPlace = false) {
  checkKeys(cfg, inPlace ? IN_PLACE : SETTINGS, inPlace ? ' in a worker the module runs in place:' : '');
  const {workerFactory: wf, helpers: rawH, webgpu: gpu} = cfg;
  if (wf !== undefined && !isFn(wf)) throw optErr("workerFactory: function");
  let helpers;
  const hg = () => {
    if (rawH !== undefined && !caps.helpers) throw optErr("helpers: unsupported module");
    helpers = rawH !== undefined ? caps.helpers(rawH) : undefined;
    if (gpu !== undefined && !caps.gpu) throw optErr("webgpu: unsupported module");
    if (gpu !== undefined && gpu !== 'required' && gpu !== false) throw optErr("webgpu: required|false|omit");
  };
  if (!inPlace) hg();
  const maxBytes = positive(cfg.maxPendingBytes, inPlace ? 1 : hostPendingBytes(), 'maxPendingBytes');
  let maxPixels;
  if (!inPlace) {
    maxPixels = positive(cfg.maxPixels, PIXELS, 'maxPixels');
    if (maxPixels > PIXELS) throw optErr('maxPixels: <= ' + PIXELS);
  }
  const maxJobs = positive(cfg.maxPendingJobs, 32, 'maxPendingJobs');
  const startupMs = positive(cfg.workerStartupTimeout, 15000, 'workerStartupTimeout');
  if (startupMs > 2147483647) throw optErr("workerStartupTimeout: <=2147483647 ms");
  if (inPlace) { hg(); maxPixels = pixelLimit(cfg.maxPixels); }
  else if (!wf && !isFn(globalThis.Worker)) throw workErr("workers: page/worker or workerFactory");
  return [wf, helpers, gpu, maxBytes, maxPixels, maxJobs, startupMs];
}

const LIVE = new Set(['signal', 'onProgress', 'onPreview', 'onEncoded', 'onFrame']);
const isCanvas = v => isFn(globalThis.OffscreenCanvas) && v instanceof OffscreenCanvas || isFn(globalThis.HTMLCanvasElement) && v instanceof HTMLCanvasElement;
const dropBitmaps = made => made.forEach(v => v.then(b => { try { if (isFn(globalThis.ImageBitmap) && b instanceof ImageBitmap) b.close(); } catch {} }, noop));
function holdArgs(args, budget, maxPixels, half, reserve, made) {
  let left = budget;
  const taken = isObj(args[1]) ? Object.getOwnPropertyDescriptor(args[1], 'transfer') : undefined;
  if (taken && (!('value' in taken) || taken.value !== true)) throw optErr('transfer: true');
  const options = snapshotOptions(args[1], 'Options', [...LIVE]);
  if (args.length > 1) args[1] = options;
  const {signal, transfer, readAs} = options;
  admitSignal(signal); check(signal);
  if (options.maxPixels !== undefined) maxPixels = Math.min(maxPixels, pixelLimit(options.maxPixels));
  let read = false;
  const charge = need => { overBytes(need, budget, budget - left); left -= need; };
  const copies = args.map((arg, i) => {
    if (isCanvas(arg)) {
      dimensions(arg.width, arg.height, maxPixels);
      const context = isFn(arg.getContext) && open2d(arg);
      const bytes = arg.width * arg.height * (half && context?.getContextAttributes?.().colorType === 'float16' ? 8 : 4);
      charge(bytes);
      if (context) {
        read = true;
        return () => {
          const {width, height} = arg;
          dimensions(width, height, maxPixels);
          const isHalf = half && context.getContextAttributes?.().colorType === 'float16';
          if (width * height * (isHalf ? 8 : 4) > bytes) throw memErr("image: raise maxPendingBytes");
          if (readAs !== undefined && readAs !== 'srgb' && readAs !== 'display-p3') throw optErr("readAs: srgb or display-p3");
          return read2d(context, width, height, readAs, isHalf);
        };
      }
      return () => {
        if (isFn(globalThis.createImageBitmap)) { try { const bitmap = createImageBitmap(arg).catch(() => arg); made.push(bitmap); return bitmap; } catch {} }
        return arg;
      };
    }
    try {
      let plain = arg, live;
      if (isPlainRecord(arg)) {
        plain = {}; live = {};
        for (const [key, d] of record(arg)) (LIVE.has(key) ? live : plain)[key] = d.value;
      }
      const plans = new Map();
      charge(measure(plain, maxPixels, plans, left));
      return transfer && i === 0 ? () => arg : () => {
        const copy = snapshot(plain, plans);
        return live ? {...copy, ...live} : copy;
      };
    } catch (error) { if (error?.code === 'JXL_MEMORY' || error?.code === 'JXL_DIMENSIONS') throw error; return () => arg; }
  });
  check(signal);
  reserve(budget - left);
  const held = copies.map(copy => copy());
  if (read && isObj(held[1])) delete held[1].readAs;
  return {held, signal};
}

function inPlaceDoor(spec, caps) {
  let own = null, loading = null, settings = null, closing = null, gen = 0, retained = 0;
  const pending = new Set();
  const cold = () => [...pending].some(call => call.cold);
  const idleCfg = () => {
    if (closing) throw optErr("The module is closing; await close() before configuring it.");
    if (loading || cold()) throw optErr("active call: settle or close()");
  };
  const release = call => {
    if (!pending.delete(call)) return;
    retained -= call.bytes;
    call.clear?.();
    dropBitmaps(call.made);
    call.made.length = 0;
  };
  const shut = () => fail('JXL_CLOSED', "The module is closing; call again once close() has resolved.");
  const load = () => own ? Promise.resolve(own) : loading ??= spec.load().then(m => {
    if (settings) m.configure(settings);
    return own = m;
  }).finally(() => { loading = null; });
  return Object.freeze({
    inPlace: true,
    configure(cfg = {}) {
      idleCfg();
      validateSettings(cfg, caps, true);
      if (own) own.configure(cfg);
      settings = Object.keys(cfg).length ? {...cfg} : null;
    },
    call: name => (...args) => {
      if (closing) return Promise.reject(shut());
      if (pending.size >= (settings?.maxPendingJobs ?? Infinity)) return Promise.reject(memErr('Calls at maxPendingJobs; wait or raise it.'));
      const call = {cold: !own, bytes: 0, made: []};
      pending.add(call);
      try {
        if (own) return Promise.resolve(own[name](...args)).finally(() => release(call));
        let held, signal;
        call.clear = () => { held = null; };
        const born = gen, live = () => { check(signal); if (born !== gen) throw shut(); };
        const canceled = new Promise((_, reject) => { call.cancel = () => { try { check(signal); throw shut(); } catch (error) { reject(error); } }; });
        canceled.catch(noop);
        ({held, signal} = holdArgs(args, (settings?.maxPendingBytes ?? hostPendingBytes()) - retained, settings?.maxPixels ?? PIXELS,
          name === 'fit' || name === 'variants' || name === 'encode' && spec.module !== 'rapier-jxl/animation',
          bytes => {
            if (born !== gen) throw shut();
            overBytes(bytes, settings?.maxPendingBytes ?? hostPendingBytes(), retained);
            call.bytes = bytes; retained += bytes;
          }, call.made));
        live();
        const ready = Promise.all([load(), ...held.map((value, i) => Promise.resolve(value).then(value => { if (held) held[i] = value; }))]);
        return abortable(Promise.race([ready, canceled]), signal).then(([m]) => {
          live(); call.cold = false;
          const values = held; held = null;
          return m[name](...values);
        }).finally(() => release(call));
      } catch (error) { release(call); return Promise.reject(error); }
    },
    close() {
      if (closing) return closing;
      if (!own && !loading && !pending.size) return Promise.resolve();
      const loaded = loading ?? Promise.resolve(own);
      gen++;
      for (const call of pending) if (call.cold) call.cancel?.();
      return closing = loaded.then(m => m?.close(), () => {}).finally(() => { closing = null; });
    },
    supported: f => checkSupported(f, caps.gpu, false),
    decoder: idleCfg,
  });
}

export const decoderOf = door => door.inPlace ? (...args) => { door.decoder(); setDecoder(...args); } : () => {
  throw fail('JXL_UNSUPPORTED', "configureDecoder: Node|Deno|Bun|edge only");
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
    if (!isInt(data.inputSequence) || data.inputSequence !== (j.S ?? 0) + 1) throw workErr('worker input sequence: invalid');
    if (j.l) throw aborted(j.c.signal);
    const prev = j.E ?? 0, bytes = data.inputBytes;
    if (!isInt(bytes) || bytes < prev) throw workErr('worker input bytes: invalid');
    const added = bytes - prev;
    overBytes(added, maxBytes, retained());
    addBytes(added); j.b += added; j.E = bytes; j.S = data.inputSequence; ok = true;
  } catch (e) {
    const classified = declared(e);
    err = {code: typeof classified?.code === 'string' && classified.code.startsWith('JXL_') ? classified.code : 'JXL_INTERNAL', message: String(classified?.message ?? 'input reservation')};
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

  let deviceWorker = false, watching = false;
  const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
  const idle = () => !closed && !stopping && !preparing && !queue.length && !running.size && !held.size;
  const retire = () => { if (idle()) { deviceWorker = false; stopThread(); } };
  const onVisibility = () => { if (hidden() && deviceWorker && thread) { clearTimeout(idleTimer); retire(); } };
  const deviceHeld = on => {
    deviceWorker = on;
    if (on && !watching && typeof document !== 'undefined' && isFn(document.addEventListener)) { watching = true; document.addEventListener('visibilitychange', onVisibility); }
  };
  const rest = () => {
    clearTimeout(idleTimer);
    if (thread) (idleTimer = setTimeout(retire, !deviceWorker ? 60000 : hidden() ? 0 : 300000)).unref?.();
  };

  const release = j => {
    if (j.l || j.q) return;
    j.l = true; retained -= j.b; j.x = j.p = null;
    if (j.v) { replies?.clear(j); j.v = null; }
    j.F = j.G = null;
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

  const frame = (j, value, index, ack) => {
    if (j.d || !j.F) return;
    j.G = Promise.resolve(j.G).then(async () => { if (j.d) return; await j.F(value, index); ack?.(); }).catch(r => { cancel(j, r); });
  };

  const complete = async (j, ok, val) => {
    if (j.f) return;
    j.f = true;
    try {
      if (ok) { progress(j, 1); await j.w?.finish(); if (j.z) await abortable(j.z, j.c.signal); if (j.G) await abortable(j.G, j.c.signal); }
      settle(j, ok, val);
    } catch (r) { settle(j, false, r, true); }
    finally { release(j); }
  };

  function stopThread(reason = Object.assign(workErr("worker: restart"), {[REPLACED]: true})) {
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
    const msg = unloaded ? `worker: copy ${file ?? "the module's own file"} beside bundle or workerFactory`
      : "worker: restart";
    stopThread(fail(typeof ev?.code === 'string' && ev.code.startsWith('JXL_') ? ev.code : 'JXL_WORKER', ev?.message || ev?.error?.message || msg));
    schedule();
  }

  function send(cur, j) {
    if (!cur.r() || !j.t || j.m || j.d || thread !== cur || running.get(j.i) !== j) return;
    try {
      cur.w.postMessage({id: j.i, operation: j.o, input: j.x, options: j.p, ...(isBitmap(j.x) && {bitmap: true}), ...(j.v && {preview: true}), ...(j.F && {frames: true}), maxPixels, helpers, webgpu, lane: j.L, alone: j.A}, [...transfers([j.x, j.p])]);
      j.m = true; j.x = j.p = null;
    } catch (r) { try { complete(j, false, r); } finally { stopThread(); } }
  }

  function openThread() {
    if (thread) return thread;
    let w;
    try { w = factory(); if (w && isFn(w.then)) Promise.resolve(w).catch(noop); }
    catch (cause) { throw callers(cause); }
    if (!w || !isFn(w.postMessage) || !isFn(w.terminate)) throw optErr("workerFactory: fresh Worker per call");
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
          if (data.ready !== WORKER_PROTOCOL) return crash(cur, {code: 'JXL_WORKER', message: "worker protocol: mismatch"});
          if (data.module !== spec.module) return crash(cur, {code: 'JXL_WORKER', message: `worker module ${data.module ? shownEntry(data.module) : "unnamed"}: use ${shownEntry(spec.module)}`});
          ready = true; clearTimeout(timer);
          for (const j of running.values()) send(cur, j);
          return;
        }
        if (data?.configurationError) return crash(cur, data.configurationError);
        if (!ready) return crash(cur, {code: 'JXL_WORKER', message: "worker: reply before ready"});
        if (data?.prepared === true) {
          const wt = waiters.get(data.attempt);
          if (!wt) return;
          waiters.delete(data.attempt);
          data.ok === true ? wt[0]() : wt[1](fail(data.error?.code || 'JXL_WASM', data.error?.message || 'WebAssembly SIMD: enable'));
          return;
        }
        const j = running.get(data?.id);
        if (!j) return;
        if (caps.expand && 'inputBytes' in data) return caps.expand(j, data, maxBytes, () => retained, n => { retained += n; }, r => crash(cur, r), m => w.postMessage(m));
        if ('progress' in data) return progress(j, data.progress);
        if ('frame' in data) { frame(j, data.frame, data.frameIndex, () => { if (thread === cur && running.get(j.i) === j && !j.d) w.postMessage({id: j.i, frameAck: data.frameSequence}); }); return; }
        if (replies && 'preview' in data) {
          return replies.handle(j, data, r => cancel(j, r), () => { if (thread === cur && running.get(j.i) === j && !j.d) w.postMessage({id: j.i, previewAck: data.previewSequence}); });
        }
        if (data.ok === true || data.ok === false) deviceHeld(data.device === true);
        if (data.ok === true) {
          const ok = !checkResult || checkResult(data.value, j.o);
          complete(j, ok, ok ? data.value : workErr("worker result: invalid"));
        } else if (data.ok === false) {
          complete(j, false, Object.assign(new Error(data.error?.message || 'worker: retry operation'), {name: data.error?.name || 'Error', code: data.error?.code || 'JXL_WORKER'}));
        } else crash(cur, {message: 'worker reply: invalid'});
      }));
      offs.push(listen(w, 'error', e => crash(cur, e)), listen(w, 'messageerror', e => crash(cur, e)));
      if (isFn(w.on) && isFn(w.off)) offs.push(listen(w, 'exit', () => crash(cur)));
      timer = setTimeout(() => crash(cur, {code: 'JXL_WORKER', message: `worker startup ${startupMs}ms: check URL/CSP/workerStartupTimeout`}), startupMs);
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
    if (!isObj(options) || Array.isArray(options)) throw optErr("options: object");
    let fields;
    try { fields = record(options); }
    catch (r) { throw !r?.code || r.code === 'JXL_INPUT' ? optErr("options: plain data fields") : r; }
    const {signal, onProgress, onPreview, onFrame, ...params} = Object.fromEntries(fields.map(([k, d]) => [k, d.value]));
    if (admitSignal(signal) && !isFn(signal.removeEventListener)) throw optErr("signal: AbortSignal");
    if (onProgress !== undefined && !isFn(onProgress)) throw optErr("onProgress: function");
    if (onPreview !== undefined && !isFn(onPreview)) throw optErr("onPreview: function");
    if (onFrame !== undefined && !isFn(onFrame)) throw optErr("onFrame: function");
    check(signal);
    if (queue.length + running.size + held.size >= maxJobs) throw memErr("maxPendingJobs: queue full");
    const optPlans = new Map();
    let optBytes;
    try { optBytes = measure(params, Number.MAX_SAFE_INTEGER, optPlans); }
    catch (r) { throw r?.code === 'JXL_INPUT' ? optErr("callbacks: onProgress|onPreview|onFrame") : r; }
    overBytes(inBytes + optBytes, maxBytes, retained);
    return [signal, onProgress, onPreview, params, optBytes, optPlans, onFrame];
  }

  function submit(op, input, options = {}, acquire = null, area = 0) {
    try {
      const [signal, onProgress, onPreview, params, optBytes, optPlans, onFrame] = admit(options);
      if (onFrame !== undefined && op !== 'decode') throw optErr("onFrame: decode only");
      if (onPreview !== undefined && !replies?.ops.has(op)) throw optErr("onPreview: unsupported operation");
      spec.admitInput?.(op, input);
      const inPlans = new Map(), bytes = measure(input, maxPixels, inPlans) + optBytes;
      overBytes(bytes, maxBytes, retained);
      if (op === 'encode') caps.frames?.(input, inPlans);
      const moved = new Map(), ownIn = snapshot(input, inPlans, undefined, moved), ownOpt = snapshot(params, optPlans, undefined, moved);
      return new Promise((resolve, reject) => {
        const px = lanes && op === 'encode' && ArrayBuffer.isView(ownIn?.data) ? ownIn.width * ownIn.height : 0;
        const j = {i: ++nextId, o: op, x: ownIn, p: ownOpt, b: bytes, n: px, a: px || area, s: signal, g: onProgress, v: onPreview, F: onFrame, y: resolve, r: reject, d: false, l: false, u: -1, c: new AbortController()};
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
      if (!spec.operations.includes(op)) return Promise.reject(optErr("prepare operation: " + spec.operations.join(', ')));
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
      if (watching) { watching = false; document.removeEventListener('visibilitychange', onVisibility); }
      const reason = closedErr(), taking = [...queue, ...running.values(), ...held].map(j => j.q).filter(Boolean);
      for (const j of [...queue]) cancel(j, reason, false);
      for (const j of [...running.values()]) cancel(j, reason, false);
      stopThread();
      return closing = Promise.allSettled([stopping, ended, ...taking]).then(list => {
        const bad = list.find(o => o.status === 'rejected');
        if (bad) throw Object.assign(workErr("worker: cleanup failed"), {cause: bad.reason});
      });
    },
  };
}

export function queueDoor(spec, caps = {}) {
  if (isFn(globalThis.WorkerGlobalScope) && globalThis instanceof WorkerGlobalScope) return inPlaceDoor(spec, caps);
  let parsed = null, q = null, closing = null;
  const active = () => {
    if (closing) throw fail('JXL_CLOSED', "closing");
    return q ??= makeQueue(parsed ??= validateSettings({}, caps), spec, caps);
  };
  return Object.freeze({
    queue: active,
    configure(cfg = {}) {
      const next = validateSettings(cfg, caps);
      if (closing) throw optErr("closing: await close()");
      if (q && !q.idle()) throw optErr("active call: settle or close()");
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
