const canceled = () => new DOMException('Canceled', 'AbortError');
export function check(signal) { if (signal?.aborted) throw canceled(); }
const atPhase = (error, phase) => error?.name === 'AbortError' ? error
  : Object.assign(new Error(error?.message ?? String(error), {cause: error}), {code: error?.code, phase});

export const createApi = send => async (path, {method = 'GET', body, signal, type, headers = {}} = {}) => {
  check(signal);
  const response = await send(path, {method, body, signal, credentials: 'same-origin', cache: 'no-store',
    headers: {Accept: 'application/json', ...(type ? {'Content-Type': type} : {}), ...headers}});
  check(signal);
  const raw = await response.text();
  let json;
  try { json = JSON.parse(raw); } catch { json = {}; }
  check(signal);
  if (!response.ok || json?.success === false) throw Object.assign(new Error(json?.error?.message ?? `${response.status}`),
    {code: json?.error?.code, status: response.status, detail: raw.slice(0, 4096)});
  return json && typeof json === 'object' && Object.hasOwn(json, 'data') ? json.data : json;
};

// One drain owns a mounted tab. New batches append; cancel also settles rows which have not started.
export function createQueue({change = () => {}, start = () => {}, finish = () => {}, fail = () => {}} = {}) {
  let pending = [], active = null, busy = false, paused = false, wake = null, disposed = false;
  const changed = () => { if (!disposed) change({busy, paused}); };
  function failed(entry, error) {
    if (entry.failed) return;
    entry.failed = true;
    if (!disposed) { fail(entry.item, error); entry.onError?.(error); }
  }
  function settled(entry) {
    entry.parent?.removeEventListener('abort', entry.stop);
    if (!disposed) finish(entry.item);
    if (!--entry.batch.remaining) entry.batch.resolve();
  }
  function stop(entry) {
    entry.control.abort();
    failed(entry, canceled());
  }
  async function drain() {
    try {
      while (pending.length) {
        if (paused) await new Promise(resolve => { wake = resolve; });
        const entry = pending.shift();
        if (!entry) continue;
        active = entry;
        try {
          check(entry.control.signal);
          if (!disposed) start(entry.item, () => stop(entry));
          await entry.task(entry.item, entry.control.signal);
          check(entry.control.signal);
        } catch (error) { failed(entry, entry.control.signal.aborted ? canceled() : error); }
        finally { active = null; settled(entry); }
      }
    } finally { busy = false; paused = false; wake = null; changed(); }
  }
  function run(items, task, {signal, onError} = {}) {
    if (!items.length) return Promise.resolve();
    let resolve;
    const done = new Promise(r => { resolve = r; }), batch = {remaining: items.length, resolve};
    for (const item of items) {
      const entry = {item, task, batch, onError, parent: signal, control: new AbortController()};
      entry.stop = () => stop(entry);
      if (disposed || signal?.aborted) { stop(entry); settled(entry); }
      else { signal?.addEventListener('abort', entry.stop, {once: true}); pending.push(entry); }
    }
    if (pending.length && !busy) { busy = true; changed(); void drain(); }
    return done;
  }
  function cancel() {
    const rest = pending; pending = [];
    if (active) stop(active);
    for (const entry of rest) { stop(entry); settled(entry); }
    paused = false; wake?.(); wake = null; changed();
  }
  return {run, cancel,
    togglePause() {
      if (!busy) return;
      paused = !paused;
      if (!paused) { wake?.(); wake = null; }
      changed();
    },
    dispose() { disposed = true; cancel(); }
  };
}

// Detaching handlers and checking settled prevents a queued worker event from continuing an aborted job.
export function workerResult(createWorker, message, {signal, progress} = {}) {
  return new Promise((resolve, reject) => {
    let worker, settled = false;
    const done = (result, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', stop);
      if (worker) { worker.onmessage = worker.onerror = null; worker.terminate(); }
      result(value);
    };
    const stop = () => done(reject, canceled());
    try {
      check(signal);
      worker = createWorker();
      worker.onmessage = ({data}) => {
        if (settled || signal?.aborted) return;
        if ('progress' in data) { progress?.(data.progress); return; }
        data.error ? done(reject, Object.assign(new Error(data.error.message), {code: data.error.code})) : done(resolve, data);
      };
      worker.onerror = event => done(reject, new Error(event.message));
      signal?.addEventListener('abort', stop, {once: true});
      check(signal);
      worker.postMessage(message);
    } catch (error) { done(reject, error); }
  });
}

// Only confirmed values form the next write. A failed patch is removed rather than silently retried with a later one.
export function createSettings(initial, {read, write, change = () => {}}) {
  let confirmed = structuredClone(initial), pending = [], busy = false, loaded = false, loading = null, error = null, disposed = false;
  const control = new AbortController();
  const value = () => pending.reduce((current, entry) => ({...current, ...entry.patch}), structuredClone(confirmed));
  const changed = () => { if (!disposed) change({value: value(), confirmed: structuredClone(confirmed), loaded, busy, error}); };
  async function load() {
    if (loaded) return confirmed;
    if (loading) return loading;
    loading = (async () => {
      try {
        check(control.signal);
        const result = await Promise.resolve().then(() => { check(control.signal); return read(control.signal); });
        check(control.signal);
        confirmed = structuredClone(result); loaded = true; error = null; changed();
        return confirmed;
      } catch (failure) { error = failure; changed(); throw failure; }
      finally { loading = null; }
    })();
    return loading;
  }
  async function drain() {
    busy = true; changed();
    try {
      try { await load(); }
      catch (failure) {
        for (const entry of pending.splice(0)) entry.reject(failure);
        changed(); return;
      }
      while (pending.length) {
        const entry = pending[0];
        try {
          check(control.signal);
          const result = await write({...confirmed, ...entry.patch}, control.signal);
          check(control.signal);
          confirmed = structuredClone(result); error = null; entry.resolve(confirmed);
        } catch (failure) { error = atPhase(failure, 'settings-save'); entry.reject(error); }
        pending.shift(); changed();
      }
    } finally { busy = false; changed(); }
  }
  return {load,
    save(patch) {
      if (disposed) return Promise.reject(canceled());
      let resolve, reject;
      const done = new Promise((yes, no) => { resolve = yes; reject = no; });
      pending.push({patch: structuredClone(patch), resolve, reject}); error = null; changed();
      if (!busy) void drain();
      return done;
    },
    dispose() { disposed = true; control.abort(); }
  };
}

// Rewriting imported post URLs is a barrier: no conversion is queued if it fails or is canceled.
export async function rewriteAndRead(result, {rewrite, read, signal}) {
  check(signal);
  try { await rewrite(result.urlMap, signal); }
  catch (error) { check(signal); throw atPhase(error, 'rewrite'); }
  check(signal);
  const items = [];
  for (const imported of result.imported) {
    check(signal);
    items.push(await read(imported.mediaId, signal));
    check(signal);
  }
  return items;
}

// Closing the page stops requests; the server keeps the accepted selection and scheduled jobs.
export function createLibraryClient({request, change = () => {}}) {
  const route = '/_emdash/api/plugins/rapier-media', controller = new AbortController();
  const failedAdvances = new Map();
  const checkpoint = job => JSON.stringify([job?.revision, job?.phase, job?.done, job?.canceled, job?.publishing]);
  let run = null, tail = Promise.resolve(), disposed = false, interruptStaging = false;
  const report = error => { if (!disposed) change({run, error}); };
  const accept = value => { check(controller.signal); run = value; report(null); return run; };
  const call = (path, body) => request(route + path, {signal: controller.signal,
    ...(body === undefined ? {} : {method:'POST', type:'application/json', body:JSON.stringify(body)})});
  const serial = action => {
    const result = tail.then(() => { check(controller.signal); return action(); });
    tail = result.catch(error => { if (!disposed) report(error); });
    return result;
  };
  return {
    load: () => serial(async () => accept(await call('/library-status'))),
    start: items => {
      interruptStaging = false;
      return serial(async () => {
      const selected = items.map(item => ({id:item.mediaId ?? item.id, key:item.storageKey, name:item.name ?? item.filename}))
        .sort((a,b) => a.id.toUpperCase() < b.id.toUpperCase() ? -1 : a.id.toUpperCase() > b.id.toUpperCase() ? 1 : 0);
      if (!selected.length) return run;
      accept(await call('/library-status'));
      const id = run?.state === 'preparing' ? run.id : crypto.randomUUID().replaceAll('-', '');
      accept(await call('/library-start', {id, total:selected.length}));
      for (let offset=0, page=0; offset<selected.length; offset+=8, page++) {
        if (interruptStaging) return run;
        accept(await call('/library-append', {id, page, items:selected.slice(offset,offset+8)}));
      }
      return interruptStaging ? run : accept(await call('/library-run', {id, action:'resume'}));
      });
    },
    control(action) {
      if (action === 'cancel') interruptStaging = true;
      return serial(async () => {
        if (action === 'resume') failedAdvances.clear();
        return run ? accept(await call('/library-run', {id:run.id, action})) : null;
      });
    },
    advance: () => serial(async () => {
      accept(await call('/library-status'));
      if (!run || !['running','canceling','paused'].includes(run.state) || run.state === 'paused' && !run.current) return run;
      const current = run.current?.jobId;
      let failed;
      if (run.current?.stage === 'waiting' && run.state !== 'canceling') {
        const job = await call(`/job-status?job=${encodeURIComponent(current)}`), observed = checkpoint(job);
        const blocked = failedAdvances.get(current);
        if (blocked && blocked.checkpoint !== observed) failedAdvances.delete(current);
        if (!job?.done && !job?.canceled && job?.phase !== 'blocked') {
          failed = failedAdvances.get(current)?.error;
          if (!failed) try { await call('/job-advance', {job:current}); }
          catch (error) {
            check(controller.signal);
            failed = Object.assign(error, {jobId: current, jobRevision: job?.revision});
            failedAdvances.set(current, {checkpoint: observed, error: failed});
          }
        }
      }
      accept(await call('/library-advance', {id:run.id}));
      // Retire a replaced source even when its old encoder step rejects it.
      if (failed && run.current?.jobId === current) throw failed;
      if (run.current?.jobId !== current) failedAdvances.delete(current);
      return run;
    }),
    dispose() { disposed = true; controller.abort(); }
  };
}
