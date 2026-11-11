// The native page uses EmDash's media API and Kumo controls. Uploads stay in Media.
import {createElement as h, useEffect, useRef, useState} from 'react';
import {Button, Collapsible, Dialog, DropdownMenu, Input, LayerCard, Meter, Popover, Switch, Tabs} from '@cloudflare/kumo';
import {Progress} from '@cloudflare/kumo/primitives/progress';
import {NumberField} from '@cloudflare/kumo/primitives/number-field';
import {apiFetch} from 'emdash/plugin-utils';
import {createApi, check, createLibraryClient, createQueue, createSettings, rewriteAndRead, workerResult} from './admin-work.mjs';
import {DEFAULTS} from './media-settings.mjs';
import {deliveryWidths} from './deliver.mjs';
import {WORDS, words} from './media-words.mjs';

const api = createApi(apiFetch), ROUTE = '/_emdash/api/plugins/rapier-media';
const SERVER = new Set(['image/jpeg', 'image/png']), BROWSER = new Set(['image/webp', 'image/avif']);
const column = gap => ({display: 'flex', flexDirection: 'column', gap});
const line = {display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10};
const size = n => n < 1024 ? `${n} ${WORDS.bytes}` : n >= 1048576 ? `${(n / 1048576).toFixed(1)} ${WORDS.megabytes}` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} ${WORDS.kilobytes}`;
const saving = row => row.before > 0 ? Math.max(0, 1 - row.after / row.before) : 0;
const identity = item => ({id: item.mediaId ?? item.id, key: item.storageKey});
const query = item => new URLSearchParams({...identity(item), generation: item.generation, deliveryRevision: item.deliveryRevision}).toString();
const REASONS = {not_smaller: WORDS.alreadySmall, restore_differs: WORDS.notExact, too_large: WORDS.tooLarge, too_large_to_defer: WORDS.tooLarge,
  key_changed: WORDS.changed, missing: WORDS.missing, JXL_JPEG: WORDS.notSupported, JXL_UNSUPPORTED: WORDS.notSupported, JXL_TARGET: WORDS.overTarget, no_frame: WORDS.notPicture,
  delivery_changed: WORDS.changed, original: WORDS.original};
const why = reason => REASONS[reason] ?? WORDS.failed;
const failure = error => error.name === 'AbortError' ? WORDS.canceled : error.phase === 'rewrite' ? WORDS.linksNotUpdated : why(error.code);
const activeRun = run => run && ['preparing', 'running', 'paused', 'canceling'].includes(run.state);
const post = (path, body, signal) => api(ROUTE + path, {method: 'POST', signal, type: 'application/json', body: JSON.stringify(body)});
const runsInBrowser = row => BROWSER.has(row.mimeType) || row.execution?.location === 'browser';
const browserReady = row => !row.nativeJob || Boolean(row.job?.done && !row.job?.canceled && !row.job?.publishing && !row.job?.blocked);
const pollingJob = job => !job?.done && !job?.canceled && !job?.blocked && !job?.advanceError;

const originalsActive = value => value?.phase === 'restoring' || value?.phase === 'archiving';
const originalsStamp = value => JSON.stringify([value?.id, value?.revision, value?.enabled, value?.desired,
  value?.phase, value?.processed, value?.error, value?.blocked]);
const originalsError = (error, phase) => Object.assign(new Error(error?.message ?? String(error)),
  {code: error?.code, status: error?.status, phase});

// This client only reads and advances the server's durable policy. A requested setting never replaces its
// confirmed enabled state; keeping files is shown only after the server has restored every archived original.
function createOriginalsClient({request, change = () => {}}) {
  const control = new AbortController();
  let value = null, busy = false, held = null, wanted, tail = Promise.resolve(), disposed = false;
  const view = () => ({value, loaded: value !== null, busy, error: value?.error || value?.blocked
    ? originalsError(value.error ?? value.blocked, 'originals-advance') : held?.error ?? null});
  const report = () => {if (!disposed) change(view());};
  const call = (path, body) => request(ROUTE + path, {signal: control.signal,
    ...(body === undefined ? {} : {method: 'POST', type: 'application/json', body: JSON.stringify(body)})});
  const accept = next => {
    check(control.signal);
    if (!next || typeof next.available !== 'boolean' || typeof next.enabled !== 'boolean' || typeof next.desired !== 'boolean'
      || !['idle', 'restoring', 'archiving'].includes(next.phase)) throw new Error('The originals policy is unavailable.');
    if (held && held.stamp !== originalsStamp(next)) held = null;
    if (wanted !== undefined && next.desired === wanted) wanted = undefined;
    value = next; report(); return value;
  };
  const serial = (phase, action) => {
    const pending = tail.then(async () => {
      check(control.signal); busy = true; report();
      try {return await action();}
      catch (error) {
        check(control.signal);
        if (error?.status === 409) {
          wanted = undefined; accept(await call('/originals-policy'));
          if (phase === 'originals-advance') return value;
        }
        held = {stamp: originalsStamp(value), error: originalsError(error, phase)}; report(); throw held.error;
      } finally {busy = false; report();}
    });
    tail = pending.catch(() => {}); return pending;
  };
  const advance = async (explicit = false) => originalsActive(value) && (explicit || !view().error)
    ? accept(await call('/originals-advance', {id: value.id})) : value;
  return {
    view,
    load: () => serial('originals-load', async () => accept(await call('/originals-policy'))),
    tick: () => serial('originals-advance', async () => {accept(await call('/originals-policy')); return advance();}),
    save: enabled => serial('originals-save', async () => {
      if (typeof enabled !== 'boolean') throw new TypeError('The originals policy is a boolean.');
      if (!value) accept(await call('/originals-policy'));
      if (enabled && !value.available || value.phase === 'restoring') return value;
      wanted = enabled; held = null;
      accept(await call('/save-originals-policy', {enabled, id: value.id})); wanted = undefined; return value;
    }),
    retry: () => serial('originals-save', async () => {
      accept(await call('/originals-policy')); held = null;
      if (wanted !== undefined || originalsActive(value) || value.error || value.blocked) {
        const enabled = wanted ?? value.desired;
        if (enabled && !value.available) return value;
        accept(await call('/save-originals-policy', {enabled, id: value.id})); wanted = undefined;
      }
      return advance(true);
    }),
    dispose() {disposed = true; control.abort();}
  };
}
function originalsControl({value, loaded, busy, error}) {
  return {checked: loaded ? !value.enabled : undefined,
    disabled: !loaded || !value.available || busy || value.phase === 'restoring',
    transitioning: busy || originalsActive(value) && !error};
}
function useOriginals() {
  const [state, setState] = useState({value: null, loaded: false, busy: false, error: null});
  const owner = useRef(null), wake = useRef(() => {});
  useEffect(() => {
    const client = createOriginalsClient({request: api, change: setState}); owner.current = client;
    let timer, running = false, again = false, closed = false;
    const poll = async () => {
      if (closed) return;
      if (running) {again = true; return;}
      running = true;
      try {await client.tick();} catch {}
      finally {
        running = false;
        if (!closed) {const current = client.view(); timer = setTimeout(poll,
          again ? 0 : originalsActive(current.value) && !current.error ? 1500 : 10000); again = false;}
      }
    };
    wake.current = () => {clearTimeout(timer); void poll();};
    const focus = () => {if (document.visibilityState === 'visible') wake.current();};
    window.addEventListener('focus', focus); document.addEventListener('visibilitychange', focus); void poll();
    return () => {closed = true; clearTimeout(timer); client.dispose(); owner.current = null; wake.current = () => {};
      window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus);};
  }, []);
  const perform = async action => {try {await action(owner.current);} catch {} finally {wake.current();}};
  return {...state, setKeep: keep => perform(client => client?.save(!keep)), retry: () => perform(client => client?.retry())};
}

async function fetchFile(item, signal) {
  check(signal);
  const response = await fetch(`/_emdash/api/media/file/${encodeURIComponent(item.storageKey)}`,
    {signal, credentials: 'same-origin', cache: 'no-store', headers: {Accept: item.mimeType}});
  check(signal);
  if (!response.ok) throw new Error(`${response.status}`);
  const blob = await response.blob(); check(signal);
  return new File([blob], item.filename, {type: item.mimeType});
}
async function download(item, signal) {
  const file = await fetchFile(item, signal), url = URL.createObjectURL(file), a = document.createElement('a');
  a.href = url; a.download = item.filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function readStored(item, signal) {
  const {items: [stored]} = await post('/library', {items: [identity(item)]}, signal);
  return stored;
}
function measured(item, stored, job = null) {
  const converted = stored.state === 'sidecar', terminal = job?.done || job?.canceled;
  const execution = stored.execution ?? job?.execution;
  const reason = job?.error?.code ?? job?.blocked?.code ?? job?.publication?.deliveryReason ?? job?.publication?.reason ?? job?.result?.reason?.code;
  return {record: stored, generation: stored.generation, deliveryRevision: stored.deliveryRevision, mode: stored.mode, execution,
    before: stored.original, after: stored.delivery, stored: stored.stored, widths: stored.widths ?? 0, converted,
    nativeJob: stored.nativeJob, job, activity: stored.mode !== 'original' && job && !terminal && !job.blocked && !job.advanceError ? 'server' : null,
    state: stored.mode === 'original' ? WORDS.original : job?.canceled ? WORDS.canceled
      : job?.blocked ? why(reason) : job?.advanceError ? why(job.advanceError.code) : converted ? WORDS.done
      : terminal ? execution?.location === 'browser' ? WORDS.waiting : why(reason) : stored.state === 'missing' ? WORDS.missing
      : SERVER.has(item.mimeType) || BROWSER.has(item.mimeType) ? WORDS.waiting : WORDS.notSupported};
}
async function attach(path, record, signal) {
  const {bytes, ...description} = record;
  return api(path, {method: 'POST', body: bytes, signal, type: 'application/octet-stream',
    headers: {'x-rapier-result': JSON.stringify(description)}});
}
async function browserConvert(item, selected, signal, update, widthsOnly = false, explicit = false, claimed = false) {
  let captured = await readStored(item, signal);
  if (captured.mode === 'original' && !explicit || widthsOnly && captured.state !== 'sidecar') return captured;
  // Queued work cannot claim a newer source or delivery decision with its older settings.
  if (item.generation && captured.generation !== item.generation || item.deliveryRevision && captured.deliveryRevision !== item.deliveryRevision
    || claimed && captured.mode !== 'copies')
    throw Object.assign(new Error('The picture or delivery setting changed.'), {code: 'key_changed'});
  if (!widthsOnly && !claimed) {
    // A fresh revision owns this main conversion; older upload work cannot publish over it.
    captured = {...captured, ...await post('/delivery', {...identity(item), generation: captured.generation,
      deliveryRevision: captured.deliveryRevision, mode: 'copies', inheritSettings: !explicit}, signal)};
  }
  const deliveryOnly = captured.execution?.deliveryOnly === true;
  const archiveOriginals = captured.execution?.archiveOriginals === true;
  if (!widthsOnly || deliveryOnly) selected = captured.execution?.settings ?? selected;
  const main = captured.result && {width: captured.result.width, height: captured.result.height, kept: captured.result.kept};
  if (widthsOnly) {
    // Reopening the page continues only unfinished widths of this captured source and delivery revision.
    // A server job owns pending widths; the browser must not encode them while their publication is in flight.
    const widths = deliveryWidths(main?.width, selected.widths, [...(captured.variantWidths ?? []), ...(captured.pendingWidths ?? [])]);
    if (!widths.length) return captured;
    selected = {...selected, widths};
  }
  update({...measured(item, captured), activity: 'browser', state: WORDS.convertingBrowser, progress: null});
  const file = await fetchFile(item, signal);
  // Other hosts first verify and publish the main candidate; only then can its responsive copies be submitted.
  const workerSettings = !widthsOnly && !deliveryOnly ? {...selected, widths: []} : selected;
  const made = await workerResult(() => new Worker(new URL('./media-worker.mjs', import.meta.url), {type: 'module'}),
    {file, settings: workerSettings, archiveOriginals, ...(deliveryOnly && {deliveryOnly: true}), ...(widthsOnly && {widthsOnly: true, main})},
    {signal, progress: progress => update({progress: Math.max(0, Math.min(1, progress))})});
  if (deliveryOnly && [made.result, ...made.copies].some(result => result?.fits && result.browserVerification?.verified !== true))
    throw Object.assign(new Error('The browser verifier did not verify this delivery.'), {code: 'JXL_INPUT'});
  const bound = {...item, generation: captured.generation, deliveryRevision: captured.deliveryRevision};
  // A JPEG's exact archive is independent of its selected delivery goal. A missed Size limit must not discard it.
  let original;
  if (!widthsOnly && archiveOriginals && !deliveryOnly && made.original?.fits)
    original = await attach(`${ROUTE}/attach?${query(bound)}&source=${made.source}`, made.original, signal);
  if (original?.stored === 'pending' && !original.job?.id) throw new Error('Archive publication returned no saved job');
  let result = {stored: widthsOnly ? 'sidecar' : 'original', reason: made.result?.reason?.code};
  if (!widthsOnly && archiveOriginals && !deliveryOnly && made.archiveIsDelivery) {
    if (!original) throw new Error('The selected JPEG archive was not submitted.');
    result = original;
  } else if (!widthsOnly && made.result?.fits)
    result = await attach(`${ROUTE}/attach?${query(bound)}&source=${made.source}`, made.result, signal);
  const variants = [];
  if (result.stored === 'sidecar') for (const copy of made.copies) if (copy.fits)
    variants.push(await attach(`${ROUTE}/variant?${query(bound)}&width=${copy.width}&source=${made.source}`, copy, signal));
  const stored = await readStored(item, signal);
  const submitted = [original, result, ...variants];
  const pending = submitted.find(reply => reply?.stored === 'pending' && reply.job?.id === stored.nativeJob?.id);
  if (pending) {
    if (!pending.job?.id) throw new Error('Publication returned no saved job');
    // A successful upload can still be awaiting its durable verification and publication.
    update({...measured(item, stored, pending.job), progress: null});
    return stored;
  }
  update({...measured(item, stored), activity: null, progress: null,
    state: stored.mode === 'original' ? WORDS.original : stored.state === 'sidecar' ? WORDS.done : made.over ? WORDS.overTarget : why(result.reason)});
  return stored;
}

function useQueue() {
  const [rows, setRows] = useState([]), [state, setState] = useState({busy: false, paused: false}), [status, setStatus] = useState(null);
  const owner = useRef(null), rowsRef = useRef(rows); rowsRef.current = rows;
  const update = (id, patch) => setRows(old => old.map(row => row.id === id ? {...row, ...patch} : row));
  function current() {
    return owner.current ??= createQueue({change: setState,
      start: (item, cancel) => update(item.id, {cancel}), finish: item => update(item.id, {cancel: null}),
      fail: (item, error) => {
        if (item.status) setStatus(failure(error));
        else setRows(old => old.map(row => row.id === item.id ? {...row, activity: null, progress: null,
          state: row.mode === 'original' ? WORDS.original : failure(error)} : row));
      }});
  }
  useEffect(() => () => { owner.current?.dispose(); owner.current = null; }, []);
  return {rows, rowsRef, setRows, update, status, ...state,
    run(items, task, options) { setStatus(null); return current().run(items, task, options); },
    togglePause: () => current().togglePause(), cancel: () => current().cancel()};
}
function useBackground() {
  const [state, setState] = useState({run: null, error: null}), [busy, setBusy] = useState(false), [stopping, setStopping] = useState(false), owner = useRef(null);
  useEffect(() => {
    const client = createLibraryClient({request: api, change: setState}); owner.current = client;
    let closed = false, timer;
    const poll = async () => {
      try { await client.advance(); } catch {}
      if (!closed) timer = setTimeout(poll, 1500);
    };
    void poll();
    return () => { closed = true; clearTimeout(timer); client.dispose(); owner.current = null; };
  }, []);
  const perform = async action => {
    setBusy(true);
    try { await action(owner.current); } catch {} finally { setBusy(false); }
  };
  return {...state, busy, stopping, start: items => perform(client => client.start(items)), control: async action => {
    if (action === 'cancel') setStopping(true);
    try { await perform(client => client.control(action)); } finally { setStopping(false); }
  }};
}

function useImages({settings, loaded, ready, background, importBusy, blocked}) {
  const queue = useQueue(), [complete, setComplete] = useState(false), [error, setError] = useState(null);
  const latest = useRef(), refresh = useRef(() => {}), attempted = useRef(new Set()), scheduled = useRef(new Set()), actions = useRef(null);
  const records = useRef(new Map()), jobViews = useRef(new Map()), dirty = useRef(new Set()), broadcast = useRef(() => {});
  useEffect(() => { const control = new AbortController(); actions.current = control; return () => control.abort(); }, []);
  latest.current = {settings, ready, background, importBusy, blocked, queue};
  const stamp = (row, selected, widthsOnly) => JSON.stringify([row.id, row.generation, row.deliveryRevision, selected, widthsOnly]);
  const enqueue = (row, selected, widthsOnly, explicit = false, claimed = false) => {
    const key = stamp(row, selected, widthsOnly);
    if (explicit) attempted.current.delete(key);
    if (scheduled.current.has(row.id) || attempted.current.has(key)) return;
    scheduled.current.add(row.id); attempted.current.add(key);
    void queue.run([row], async (item, signal) => {
      await browserConvert(item, selected, signal, patch => {
        if (patch.generation) attempted.current.add(stamp({...item, ...patch}, selected, widthsOnly));
        if (patch.record) records.current.set(item.id, patch.record);
        if (patch.job && patch.nativeJob?.id) jobViews.current.set(patch.nativeJob.id, patch.job);
        queue.update(item.id, patch);
      }, widthsOnly, explicit, claimed);
    }).finally(() => { scheduled.current.delete(row.id); dirty.current.add(row.id); broadcast.current(row.id); refresh.current(); });
  };
  useEffect(() => {
    if (!loaded) return;
    const control = new AbortController(), jobs = jobViews.current, failedAdvances = new Map();
    const checkpoint = job => JSON.stringify([job?.revision, job?.phase, job?.done, job?.canceled, job?.publishing]);
    let catalog = new Map(), initialized = false, fullRequested = true, discoverRequested = true;
    let timer, running = false, again = false, nextJob = 0, nextAudit = 0, lastDiscovery = 0, lastAudit = 0, lastCatalog = 0;
    let libraryProgress = '';
    const channel = new BroadcastChannel('rapier-media');
    const wake = () => { discoverRequested = true; refresh.current(); };
    channel.onmessage = ({data}) => {
      if (typeof data?.id !== 'string') return;
      dirty.current.add(data.id); if (!catalog.has(data.id)) discoverRequested = true; refresh.current();
    };
    const focus = () => { if (document.visibilityState === 'visible') wake(); };
    window.addEventListener('focus', wake); document.addEventListener('visibilitychange', focus);
    broadcast.current = id => channel.postMessage({id});

    async function mediaCatalog() {
      const next = new Map(), seenCursors = new Set();
      for (let cursor; ;) {
        const page = await api(`/_emdash/api/media?mimeType=image%2F&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, {signal: control.signal});
        for (const item of page.items) {
          next.set(item.id, item);
          if (JSON.stringify(catalog.get(item.id)) !== JSON.stringify(item)) dirty.current.add(item.id);
        }
        const nextCursor = page.nextCursor;
        if (!nextCursor) break;
        if (seenCursors.has(nextCursor) || nextCursor === cursor) throw new Error('Media pagination repeated a cursor');
        seenCursors.add(nextCursor); cursor = nextCursor;
      }
      check(control.signal);
      for (const id of records.current.keys()) if (!next.has(id)) records.current.delete(id);
      for (const id of dirty.current) if (!next.has(id)) dirty.current.delete(id);
      catalog = next; fullRequested = false; lastCatalog = Date.now();
    }
    async function readRows(ids) {
      const unique = [...new Set(ids)].filter(id => catalog.has(id));
      for (const id of ids) if (!catalog.has(id)) dirty.current.delete(id);
      for (let offset = 0; offset < unique.length; offset += 8) {
        const selected = unique.slice(offset, offset + 8), items = selected.map(id => catalog.get(id));
        const began = selected.map(id => records.current.get(id));
        const result = await post('/library', {items: items.map(identity)}, control.signal);
        for (let i = 0; i < selected.length; i++) {
          const id = selected[i], current = records.current.get(id), incoming = result.items[i];
          if (current && current !== began[i] && JSON.stringify(incoming) !== JSON.stringify(current)) { dirty.current.add(id); continue; }
          records.current.set(id, incoming); dirty.current.delete(id);
        }
      }
    }
    function jobFor(stored) {
      const id = stored?.nativeJob?.id, job = id && jobs.get(id);
      if (!job) return null;
      const failed = failedAdvances.get(id);
      if (failed && checkpoint(job) !== failed.checkpoint) failedAdvances.delete(id);
      const libraryError = latest.current.background.error;
      const error = failedAdvances.get(id) ?? (libraryError?.jobId === id && libraryError.jobRevision === job.revision ? libraryError : null);
      return error && !job.done && !job.canceled ? {...job, advanceError: {code: error.code}} : job;
    }
    function rows() {
      return [...catalog.values()].map(item => {
        const stored = records.current.get(item.id);
        return {...item, name: item.filename, ...(stored ? measured(item, stored, jobFor(stored))
          : {state: WORDS.waiting, converted: false, before: item.size, activity: null})};
      });
    }
    function publish(observed) {
      const found = rows();
      queue.setRows(previous => {
        const old = new Map(previous.map(row => [row.id, row]));
        return found.map(row => {
          const prior = old.get(row.id), began = observed.get(row.id);
          if (prior?.action || prior && began && (prior.generation !== began[0] || prior.deliveryRevision !== began[1]) &&
              (row.generation !== prior.generation || row.deliveryRevision !== prior.deliveryRevision)) return prior;
          if (!prior || prior.generation !== row.generation || prior.deliveryRevision !== row.deliveryRevision) return row;
          return {...row, ...(prior.activity === 'browser' && {activity: prior.activity, state: prior.state, progress: prior.progress}),
            ...(prior.cancel && {cancel: prior.cancel}),
            ...(!row.nativeJob && !row.converted && !row.activity && prior.state !== WORDS.waiting && {state: prior.state})};
        });
      });
      return found;
    }
    const rotate = (items, start, count) => items.length ? Array.from({length: Math.min(count, items.length)}, (_, i) => items[(start + i) % items.length]) : [];
    async function poll() {
      if (running) { again = true; return; }
      running = true; clearTimeout(timer);
      const observed = new Map(queue.rowsRef.current.map(row => [row.id, [row.generation, row.deliveryRevision]]));
      try {
        const now = Date.now();
        if (fullRequested || now - lastCatalog >= 60000) await mediaCatalog();
        if (!initialized) {
          // No total is presented until the initial catalog and every stored row have been read.
          await readRows([...catalog.keys()]); publish(observed); initialized = true; lastDiscovery = now; lastAudit = now; discoverRequested = false; setComplete(true);
        } else if (discoverRequested || now - lastDiscovery >= 10000) {
          // The host exposes a counted first page. A changed count or new identity triggers metadata reconciliation.
          const head = await api('/_emdash/api/media?mimeType=image%2F&limit=8&page=1', {signal: control.signal});
          if (head.totalCount !== catalog.size || head.items.some(item => !catalog.has(item.id))) await mediaCatalog();
          else for (const item of head.items) {
            if (JSON.stringify(catalog.get(item.id)) !== JSON.stringify(item)) dirty.current.add(item.id);
            catalog.set(item.id, item);
          }
          for (const item of head.items) dirty.current.add(item.id);
          lastDiscovery = now; discoverRequested = false;
        }
        const run = latest.current.background.run, progress = JSON.stringify([run?.id, run?.processed]);
        if (progress !== libraryProgress) {
          if (run?.last?.id) dirty.current.add(run.last.id);
          libraryProgress = progress;
        }
        if (run?.current?.id) dirty.current.add(run.current.id);
        const unsettled = [...catalog.keys()].filter(id => {
          const stored = records.current.get(id);
          return stored?.nativeJob?.id && pollingJob(jobFor(stored));
        });
        const active = rotate(unsettled, nextJob, 8); nextJob += active.length;
        const audits = now - lastAudit >= 10000 ? rotate([...catalog.keys()], nextAudit, 8) : [];
        if (audits.length) { nextAudit += audits.length; lastAudit = now; }
        await readRows([...active, ...[...dirty.current].slice(0, 8), ...audits]);
        const statusIds = new Set([...active, ...audits].map(id => records.current.get(id)?.nativeJob?.id).filter(Boolean));
        for (const id of statusIds) {
          const job = jobs.get(id);
          if (!job?.done && !job?.canceled) jobs.set(id, await api(`${ROUTE}/job-status?job=${encodeURIComponent(id)}`, {signal: control.signal}));
        }
        let found = publish(observed); setError(null);
        const pending = found.filter(row => row.activity === 'server' && row.nativeJob?.id !== latest.current.background.run?.current?.jobId);
        if (pending.length) {
          const row = pending[nextJob++ % pending.length];
          try {
            const job = await post('/job-advance', {job: row.nativeJob.id}, control.signal);
            jobs.set(row.nativeJob.id, job); failedAdvances.delete(row.nativeJob.id);
          } catch (error) {
            check(control.signal);
            // The failed request is not a terminal backend state. A real changed checkpoint permits retry.
            failedAdvances.set(row.nativeJob.id, {checkpoint: checkpoint(row.job), code: error.code});
          }
          await readRows([row.id]); found = publish(observed);
        }
        const current = latest.current;
        if (current.ready && !current.importBusy) for (const row of found) {
          if (row.mode === 'original' || !row.generation || row.activity || current.blocked.has(row.id)) continue;
          const selected = row.execution?.deliveryOnly ? row.execution.settings : current.settings;
          const missing = row.converted ? deliveryWidths(row.record.result?.width ?? row.width, selected.widths,
            [...(row.record.variantWidths ?? []), ...(row.record.pendingWidths ?? [])]) : [];
          if (row.converted && row.execution?.deliveryOnly && JSON.stringify(selected.widths) !== JSON.stringify(current.settings.widths))
            enqueue(row, structuredClone(current.settings), false, true);
          else if (row.converted && missing.length) enqueue(row, structuredClone(selected), true);
          else if (!row.converted && runsInBrowser(row) && browserReady(row))
            enqueue(row, structuredClone(row.execution?.settings ?? current.settings), false);
        }
      } catch (failure) { if (!control.signal.aborted) setError(failure); }
      finally {
        running = false;
        if (!control.signal.aborted) {
          const active = activeRun(latest.current.background.run) || latest.current.queue.busy || dirty.current.size || [...records.current.values()].some(stored => {
            return stored.nativeJob?.id && pollingJob(jobFor(stored));
          });
          timer = setTimeout(poll, again ? 0 : active ? 1500 : 10000); again = false;
        }
      }
    }
    refresh.current = options => {
      if (options?.full) fullRequested = true;
      if (options?.discover) discoverRequested = true;
      clearTimeout(timer); void poll();
    };
    void poll();
    return () => {
      control.abort(); clearTimeout(timer); channel.close(); broadcast.current = () => {};
      window.removeEventListener('focus', wake); document.removeEventListener('visibilitychange', focus); refresh.current = () => {};
    };
  }, [loaded]);
  useEffect(() => {
    if (background.run?.current?.id) dirty.current.add(background.run.current.id);
    if (background.run?.last?.id) dirty.current.add(background.run.last.id);
    refresh.current();
  }, [background.run?.id, background.run?.current?.jobId, background.run?.processed, background.error]);
  useEffect(() => { if (ready) refresh.current(); }, [ready, JSON.stringify(settings)]);
  const act = async (row, action) => {
    queue.update(row.id, {action: true});
    try { await action(actions.current.signal); setError(null); }
    catch (failure) { queue.update(row.id, {state: failure.name === 'AbortError' ? WORDS.canceled : why(failure.code)}); setError(failure); }
    finally { queue.update(row.id, {action: false}); dirty.current.add(row.id); broadcast.current(row.id); refresh.current(); }
  };
  const delivery = (row, mode) => act(row, async signal => {
    row.cancel?.();
    const stored = await readStored(row, signal);
    if (mode === 'copies' && BROWSER.has(row.mimeType)) {
      enqueue({...row, ...measured(row, stored)}, structuredClone(settings), false, true);
      return;
    }
    const selected = await post('/delivery', {...identity(row), generation: stored.generation, deliveryRevision: stored.deliveryRevision, mode}, signal);
    const current = {...row, ...selected};
    const fresh = await readStored(row, signal); records.current.set(row.id, fresh); queue.update(row.id, measured(row, fresh));
    if (mode === 'copies') {
      attempted.current.delete(stamp(current, settings, true));
      if (SERVER.has(row.mimeType)) {
        const job = await post('/media-convert', {...identity(current), generation: current.generation, deliveryRevision: current.deliveryRevision}, signal);
        if (job.execution?.location === 'browser') {
          const admitted = {...fresh, execution: job.execution};
          records.current.set(row.id, admitted);
          enqueue({...current, ...measured(row, admitted)}, structuredClone(job.execution.settings), false, true, true);
        } else {
          if (!job.id) throw new Error('Server conversion returned no saved job.');
          jobViews.current.set(job.id, job);
          queue.update(row.id, {nativeJob: {id: job.id}, job, activity: job.done ? null : 'server'});
        }
      }
    }
  });
  return {queue, complete, error, refresh: () => refresh.current({discover: true}), delivery, scheduled: id => scheduled.current.has(id),
    download: row => act(row, signal => download(row, signal)),
    cancel: row => act(row, async signal => {
      if (row.cancel) row.cancel();
      else if (row.nativeJob?.id) await post('/job-cancel', {job: row.nativeJob.id}, signal);
    })};
}

function Info({label, text, side = 'bottom'}) {
  return h(Popover, null,
    h(Popover.Trigger, {render: h(Button, {variant: 'outline', shape: 'circle', size: 'sm',
      'aria-label': words(WORDS.about, {label}), className: 'rapier-info-button'})},
      h('span', {'aria-hidden': true}, WORDS.infoGlyph)),
    h(Popover.Content, {side, align: 'center', className: 'rapier-info-popup'},
      h(Popover.Title, {className: 'sr-only'}, label), h(Popover.Description, null, text)));
}
function Card({title, info, children, action, ...props}) {
  return h(LayerCard, {...props, style: {...column(14), padding: 18, borderRadius: 12, ...props.style}},
    title && h('div', {style: {...line, justifyContent: 'space-between'}},
      h('div', {style: {...line, gap: 8}}, h('h2', {className: 'text-base font-semibold'}, title), info && h(Info, {label: title, text: info})), action), children);
}
function Background({background, stage, disabled}) {
  const {run, error, busy} = background;
  if (!activeRun(run) && !error) return null;
  const preparing = run?.state === 'preparing';
  const state = run?.state === 'paused' && run.current ? WORDS.pausing
    : ({preparing: WORDS.preparing, running: WORDS.convertingImages, paused: WORDS.paused, canceling: WORDS.canceling}[run?.state]);
  const count = preparing ? run.total : run?.processed, total = preparing ? run.expected : run?.total;
  return h('div', {style: column(10)},
    run && h('div', {style: {...line, justifyContent: 'center'}}, h('span', {role: 'status'}, state),
      run.state === 'running' && h(Button, {size: 'sm', variant: 'secondary', disabled: busy, onClick: () => background.control('pause')}, WORDS.pause),
      run.state === 'paused' && h(Button, {size: 'sm', variant: 'secondary', disabled: busy, onClick: () => background.control('resume')}, WORDS.resume),
      preparing && h(Button, {size: 'sm', disabled: busy || disabled, onClick: stage}, WORDS.continue),
      ['preparing', 'running', 'paused'].includes(run.state) && h(Button, {size: 'sm', variant: 'secondary', disabled: background.stopping || busy && !preparing,
        onClick: () => background.control('cancel')}, WORDS.cancel)),
    run && h(Meter, {label: words(WORDS.countOfTotal, {count, total}), value: total ? Math.round(100 * count / total) : 0, showValue: false}),
    h('p', {className: 'text-sm text-kumo-subtle'}, WORDS.serverNote),
    error && h('p', {role: 'alert'}, WORDS.queueError));
}
function YourImages({images, background, ready, onImport}) {
  const {rows} = images.queue, converted = rows.filter(row => row.converted);
  const saved = converted.reduce((sum, row) => sum + Math.max(0, row.before - row.after), 0);
  const originalBytes = converted.reduce((sum, row) => sum + row.before, 0);
  const percent = originalBytes ? Math.round(100 * saved / originalBytes) : 0;
  const older = rows.filter(row => SERVER.has(row.mimeType) && !runsInBrowser(row) && row.generation && row.mode !== 'original' && !row.converted && !row.nativeJob);
  const pending = rows.some(row => row.activity || row.job && !row.job.done && !row.job.canceled || row.state === WORDS.waiting && row.mode !== 'original' && (SERVER.has(row.mimeType) || BROWSER.has(row.mimeType)));
  const stage = () => background.start(older);
  return h(Card, {'aria-label': WORDS.imagesLabel, style: {textAlign: 'center', gap: 16}},
    images.complete ? h('div', {style: column(4)},
      h('p', {className: 'font-semibold', style: {fontSize: 36, lineHeight: 1.2, letterSpacing: '-0.025em'}}, words(WORDS.saved, {size: size(saved)})),
      h('p', {className: 'text-sm text-kumo-subtle'}, words(converted.length === 1 ? WORDS.image : WORDS.images, {count: converted.length, percent})))
      : h('p', {className: 'text-kumo-subtle', role: 'status'}, WORDS.loadingImages),
    h(Background, {background, stage, disabled: !ready || !older.length}),
    images.complete && !activeRun(background.run) && h('div', {style: column(7)},
      !rows.length ? h('p', {className: 'text-sm text-kumo-subtle'}, WORDS.emptyImages, h('a', {href: '/_emdash/admin/media', className: 'underline'}, WORDS.media), WORDS.sentenceEnd)
        : older.length ? h('div', {style: column(7)},
          h(Button, {variant: 'primary', className: 'w-full', style: {justifyContent: 'center'}, disabled: !ready || background.busy, onClick: stage}, words(older.length === 1 ? WORDS.convertOlderOne : WORDS.convertOlder, {count: older.length})),
          h('p', {className: 'text-sm text-kumo-subtle'}, WORDS.serverNote))
        : !pending && rows.every(row => row.converted) && h('p', {className: 'text-sm text-kumo-subtle'}, WORDS.allConverted)),
    h('div', {style: {display: 'flex', justifyContent: 'center'}}, h(Button, {variant: 'ghost', className: 'rapier-import-link', onClick: onImport}, WORDS.importWordPress)),
    images.error && h('div', {role: 'alert', style: {...line, justifyContent: 'center'}}, h('p', {className: 'text-sm'}, WORDS.imagesError),
      h(Button, {size: 'sm', variant: 'secondary', onClick: images.refresh}, WORDS.retry)));
}
function RowActions({row, images, ready}) {
  return h(DropdownMenu, null,
    h(DropdownMenu.Trigger, {render: h(Button, {size: 'sm', variant: 'ghost', 'aria-label': words(WORDS.actionsFor, {name: row.name}), style: {fontSize: 23, width: 28}})}, WORDS.menuGlyph),
    h(DropdownMenu.Content, null,
      h(DropdownMenu.Item, {disabled: row.action || !row.storageKey, onClick: () => images.download(row)}, WORDS.downloadOriginal),
      h(DropdownMenu.Item, {disabled: !row.generation || row.mode === 'original' || row.action, onClick: () => images.delivery(row, 'original')}, WORDS.useOriginal),
      h(DropdownMenu.Item, {disabled: !ready || !row.generation || row.activity || row.job?.blocked || row.job?.publishing || images.scheduled(row.id) || row.action || !SERVER.has(row.mimeType) && !BROWSER.has(row.mimeType),
        onClick: () => images.delivery(row, 'copies')}, WORDS.makeSmaller)));
}
function ConversionProgress({row, images}) {
  const label = row.activity === 'browser' ? WORDS.convertingBrowser : row.job?.publishing ? WORDS.savingCopy : WORDS.converting;
  return h('div', {style: column(5)},
    h('div', {style: {...line, justifyContent: 'space-between', gap: 4}}, h('span', {className: 'text-xs text-kumo-subtle'}, label),
      h(Button, {size: 'xs', variant: 'ghost', disabled: row.action || row.job?.publishing, onClick: () => images.cancel(row), 'aria-label': words(WORDS.cancelImage, {name: row.name})}, WORDS.cancel)),
    // A server job's own progress where its driver reports one (thread-driver.mjs on Node); else the moving bar.
    h(Progress.Root, {value: row.activity === 'browser' ? (Number.isFinite(row.progress) ? Math.round(row.progress * 100) : null)
      : !row.job?.publishing && Number.isFinite(row.job?.progress) ? Math.round(row.job.progress * 100) : null, 'aria-label': label},
      h(Progress.Track, {className: 'bg-kumo-fill', style: {height: 4, overflow: 'hidden', borderRadius: 10}},
        h(Progress.Indicator, {className: 'rapier-progress bg-kumo-brand', style: {height: '100%', borderRadius: 10}}))));
}
function Recent({images, ready}) {
  const {queue} = images, [visible, setVisible] = useState(6);
  const controls = queue.busy && h('div', {style: line},
    h(Button, {size: 'sm', variant: 'ghost', onClick: queue.togglePause}, queue.paused ? WORDS.resume : WORDS.pause),
    h(Button, {size: 'sm', variant: 'ghost', onClick: queue.cancel}, WORDS.cancel));
  return h(Card, {title: WORDS.recent, action: controls, style: {gap: 0}},
    !queue.rows.length && h('p', {className: 'text-sm text-kumo-subtle', style: {paddingTop: 14}}, images.complete ? WORDS.emptyRecent : WORDS.loadingImages),
    queue.rows.slice(0, visible).map((row, i) => h('div', {key: row.id, className: 'border-t border-kumo-line',
      style: {display: 'flex', gap: 12, marginTop: i === 0 ? 14 : 0, paddingTop: 12, paddingBottom: i === Math.min(queue.rows.length, visible) - 1 ? 0 : 12}},
      h('img', {src: row.storageKey ? `/_emdash/api/media/file/${encodeURIComponent(row.storageKey)}` : undefined, alt: '', loading: 'lazy',
        style: {width: 40, height: 40, objectFit: 'cover', borderRadius: 6, flexShrink: 0}}),
      h('div', {style: {...column(3), minWidth: 0, flex: 1}},
        h('div', {style: {display: 'flex', alignItems: 'flex-start', gap: 8}},
          h('div', {style: {...column(3), minWidth: 0, flex: 1}},
            h('p', {className: 'text-sm font-medium', style: {overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}, title: row.name}, row.name),
            h('p', {className: 'text-xs text-kumo-subtle'}, Number.isFinite(row.before) ? row.converted ? words(WORDS.deliverySizes, {before: size(row.before), after: size(row.after)}) : size(row.before) : row.state)),
          row.converted && h('span', {className: 'rapier-saving text-sm font-medium', style: {paddingTop: 1, whiteSpace: 'nowrap'}}, words(WORDS.percentSaved, {percent: Math.round(100 * saving(row))})),
          h(RowActions, {row, images, ready})),
        row.activity ? h(ConversionProgress, {row, images})
          : ![WORDS.done, WORDS.waiting].includes(row.state) && h('span', {className: 'text-xs text-kumo-subtle'}, row.state)))),
    queue.rows.length > visible && h('div', {style: {paddingTop: 16}}, h(Button, {variant: 'ghost', size: 'sm', onClick: () => setVisible(n => n + 20)}, WORDS.showMore)));
}
function Stepper({label, id, value, min, max, unit, disabled, change, blur}) {
  return h(NumberField.Root, {id, value, min, max, step: 1, smallStep: 1, disabled, required: true,
    format: {useGrouping: false, maximumFractionDigits: 0}, onValueChange: change, onBlur: blur},
    h(NumberField.Group, {className: 'rapier-stepper border border-kumo-line', style: {display: 'flex', alignItems: 'center', height: 36, borderRadius: 8, overflow: 'hidden'}},
      h(NumberField.Decrement, {render: h(Button, {variant: 'ghost', shape: 'square', 'aria-label': words(WORDS.decrease, {label}), className: 'border-r border-kumo-line', style: {borderRadius: 0, width: 34, height: 34}})}, WORDS.minusGlyph),
      h(NumberField.Input, {'aria-label': label, className: 'text-kumo-default', style: {width: unit ? 58 : 44, height: 34, padding: 0, textAlign: 'center', background: 'transparent', outline: 'none', fontSize: 14}}),
      unit && h('span', {className: 'text-xs text-kumo-subtle', style: {paddingRight: 6}}, unit),
      h(NumberField.Increment, {render: h(Button, {variant: 'ghost', shape: 'square', 'aria-label': words(WORDS.increase, {label}), className: 'border-l border-kumo-line', style: {borderRadius: 0, width: 34, height: 34}})}, WORDS.plusGlyph)));
}
function Settings({settings, save, error, loaded, retry, draft}) {
  const [widths, setWidths] = useState(settings.widths.join(', ')), [widthsError, setWidthsError] = useState(false);
  const [quality, setQuality] = useState(settings.quality), [effort, setEffort] = useState(settings.effort);
  const [choosingLimit, setChoosingLimit] = useState(false), [limit, setLimit] = useState(settings.maxKilobytes || null);
  const goal = choosingLimit ? 'limit' : settings.exact ? 'exact' : settings.maxKilobytes > 0 ? 'limit' : 'look';
  useEffect(() => setWidths(settings.widths.join(', ')), [settings.widths.join()]);
  useEffect(() => setQuality(settings.quality), [settings.quality]);
  useEffect(() => setEffort(settings.effort), [settings.effort]);
  useEffect(() => setLimit(settings.maxKilobytes || null), [settings.maxKilobytes]);
  useEffect(() => { if (error) { setChoosingLimit(false); setQuality(settings.quality); setEffort(settings.effort); setLimit(settings.maxKilobytes || null); draft(false); } }, [error]);
  function choose(value) {
    if (!loaded) return;
    setQuality(settings.quality); setEffort(settings.effort);
    if (value === 'limit') { setChoosingLimit(true); draft(!(settings.maxKilobytes > 0)); }
    else { setChoosingLimit(false); draft(false); save({exact: value === 'exact', maxKilobytes: 0}); }
  }
  function numeric(key, value) {
    ({quality: setQuality, effort: setEffort, maxKilobytes: setLimit}[key])(value); draft(invalid({...{quality, effort, maxKilobytes: limit}, [key]: value}));
    if (validNumber(key, value)) save(key === 'maxKilobytes' ? {exact: false, maxKilobytes: value} : {[key]: value});
  }
  const validNumber = (key, value) => Number.isSafeInteger(value) && value >= 1 && value <= ({quality: 100, effort: 9, maxKilobytes: 1 << 20}[key]);
  const invalid = value => !validNumber('effort', value.effort) || goal === 'look' && !validNumber('quality', value.quality)
    || goal === 'limit' && !validNumber('maxKilobytes', value.maxKilobytes);
  function restore(key) {
    if (key === 'quality' && !validNumber('quality', quality)) { setQuality(settings.quality); draft(invalid({quality: settings.quality, effort, maxKilobytes: limit})); }
    if (key === 'effort' && !validNumber('effort', effort)) { setEffort(settings.effort); draft(invalid({quality, effort: settings.effort, maxKilobytes: limit})); }
  }
  function saveWidths() {
    const values = widths.split(/[\s,]+/).filter(Boolean).map(Number);
    const valid = values.length <= 16 && values.every(w => Number.isSafeInteger(w) && w >= 16 && w <= 8192);
    setWidthsError(!valid); if (valid) save({widths: values});
  }
  const rowStyle = {...line, justifyContent: 'space-between', paddingBlock: 12, gap: 8};
  const label = (name, info, id) => h('div', {style: {...line, gap: 8}}, h('label', {htmlFor: id, className: 'text-sm'}, name), info && h(Info, {label: name, text: info}));
  return h(Card, {title: WORDS.mode, info: WORDS.modeInfo, style: {gap: 0}},
    h('div', {role: 'group', 'aria-label': WORDS.mode, style: {marginTop: 14}}, h(Tabs, {variant: 'segmented', value: goal, onValueChange: choose, className: 'w-full', listClassName: 'w-full',
      tabs: [['look', WORDS.sameLook], ['exact', WORDS.exact], ['limit', WORDS.sizeLimit]].map(([value, label]) => ({value, label, className: 'flex-1',
        render: props => h('button', {...props, style: {...props.style, flex: '1 1 0', justifyContent: 'center'}, disabled: !loaded, id: `rapier-goal-${value}`, 'aria-controls': `rapier-goal-panel-${value}`})}))})),
    h('section', {role: 'tabpanel', id: `rapier-goal-panel-${goal}`, 'aria-labelledby': `rapier-goal-${goal}`},
      goal === 'look' ? h('div', {className: 'border-t border-kumo-line', style: rowStyle}, label(WORDS.quality, WORDS.qualityInfo, 'rapier-quality'),
        h(Stepper, {label: WORDS.quality, id: 'rapier-quality', value: quality, min: 1, max: 100, disabled: !loaded, change: value => numeric('quality', value), blur: () => restore('quality')}))
        : goal === 'limit' && h('div', {className: 'border-t border-kumo-line', style: rowStyle}, label(WORDS.sizeLimit, WORDS.sizeLimitInfo, 'rapier-limit'),
          h(Stepper, {label: WORDS.sizeLimit, id: 'rapier-limit', value: limit, min: 1, max: 1 << 20, unit: WORDS.kilobytes, disabled: !loaded, change: value => numeric('maxKilobytes', value)}))),
    h('div', {className: 'border-t border-kumo-line', style: rowStyle}, label(WORDS.effort, WORDS.effortInfo, 'rapier-effort'),
      h(Stepper, {label: WORDS.effort, id: 'rapier-effort', value: effort, min: 1, max: 9, disabled: !loaded, change: value => numeric('effort', value), blur: () => restore('effort')})),
    h(Collapsible.Root, {className: 'border-t border-kumo-line'},
      h('div', {style: {...rowStyle, paddingBottom: 0}}, label(WORDS.sizes, WORDS.sizesInfo),
        h(Collapsible.Trigger, {render: h(Button, {variant: 'ghost', className: 'text-kumo-subtle', style: {fontSize: 14, paddingRight: 0}})},
          words(settings.widths.length === 1 ? WORDS.sizeCountOne : WORDS.sizeCount, {count: settings.widths.length}), ' ', WORDS.arrowGlyph)),
      h(Collapsible.Panel, {style: {paddingTop: 14}}, h(Input, {label: WORDS.widths, disabled: !loaded, value: widths,
        description: WORDS.widthsDescription, error: widthsError ? WORDS.widthsError : undefined, onChange: e => setWidths(e.target.value), onBlur: saveWidths}))),
    error && h('p', {role: 'alert', style: {paddingTop: 12}}, ['settings-save', 'originals-save'].includes(error.phase) ? WORDS.settingsNotSaved : WORDS.settingsUnavailable),
    !loaded && !error && h('p', {role: 'status', style: {paddingTop: 12}}, WORDS.loadingSettings),
    error && (!loaded || error.phase?.startsWith('originals-')) && h(Button, {variant: 'secondary', onClick: retry}, WORDS.retry));
}

function WordPress({open, setOpen, ready, refresh, setImportBusy, blocked}) {
  const queue = useQueue(), input = useRef(), [found, setFound] = useState(null), [message, setMessage] = useState(null);
  async function choose(event) {
    const file = event.target.files[0]; event.target.value = '';
    if (!file) return;
    setFound(null); setMessage(null);
    await queue.run([{id: 'analyze', status: true}], async (_, signal) => {
      const form = new FormData(); form.append('file', file);
      const analysis = await api('/_emdash/api/import/wordpress/analyze', {method: 'POST', body: form, signal});
      setFound(analysis.attachments.items);
    });
  }
  const start = () => queue.run([{id: 'import', status: true}], async (_, signal) => {
    setImportBusy(true); setMessage(WORDS.importingImages);
    try {
      const result = await api('/_emdash/api/import/wordpress/media', {method: 'POST', signal, type: 'application/json',
        body: JSON.stringify({attachments: found, stream: false})});
      for (const item of result.imported) blocked.current.add(item.mediaId);
      setMessage(WORDS.updatingLinks);
      const imported = await rewriteAndRead(result, {signal,
        rewrite: (urlMap, signal) => api('/_emdash/api/import/wordpress/rewrite-urls', {method: 'POST', signal, type: 'application/json', body: JSON.stringify({urlMap})}),
        read: async (id, signal) => (await api(`/_emdash/api/media/${id}`, {signal})).item});
      for (const item of imported) blocked.current.delete(item.id);
      check(signal); setMessage(words(imported.length === 1 ? WORDS.importedImage : WORDS.importedImages, {count: imported.length}));
      setFound(null); refresh();
    } finally { setImportBusy(false); }
  }, {onError: error => setMessage(error.phase === 'rewrite' ? WORDS.importLinksError : failure(error))});
  return h(Dialog.Root, {open, onOpenChange: setOpen},
    h(Dialog, {style: {width: 'min(32rem, calc(100vw - 32px))', maxWidth: 'calc(100vw - 32px)', padding: 24}},
      h('div', {style: column(16)},
        h(Dialog.Title, null, WORDS.importWordPress),
        h(Dialog.Description, null, WORDS.importDescription),
        h('div', {style: line}, h(Button, {variant: 'secondary', disabled: queue.busy || !ready, onClick: () => input.current.click()}, WORDS.chooseExport),
          h('input', {ref: input, type: 'file', accept: '.xml,application/xml,text/xml', hidden: true, onChange: choose}),
          found && h('span', {className: 'text-sm'}, words(found.length === 1 ? WORDS.foundImage : WORDS.foundImages, {count: found.length}))),
        found && h(Button, {variant: 'primary', disabled: queue.busy || !ready || !found.length, onClick: start}, words(WORDS.importCount, {count: found.length})),
        (message || queue.status) && h('p', {role: 'status', className: 'text-sm'}, message ?? queue.status),
        h('div', {style: {...line, justifyContent: 'flex-end'}},
          queue.busy && h(Button, {variant: 'secondary', onClick: queue.cancel}, WORDS.cancelImport),
          h(Dialog.Close, {render: h(Button, {variant: 'secondary'})}, WORDS.close)))));
}

function ImagesPage() {
  const [settings, setSettings] = useState(DEFAULTS), [settingsError, setSettingsError] = useState(null);
  const [settingsState, setSettingsState] = useState({loaded: false, busy: false});
  const [draft, setDraft] = useState(false), [importOpen, setImportOpen] = useState(false), [importBusy, setImportBusy] = useState(false);
  const writer = useRef(null), blocked = useRef(new Set()), background = useBackground(), originals = useOriginals();
  useEffect(() => {
    const own = createSettings(DEFAULTS, {
      read: signal => api(`${ROUTE}/settings`, {signal}),
      write: (value, signal) => post('/save-settings', value, signal),
      change: ({value, error, loaded, busy}) => { setSettings(value); setSettingsError(error); setSettingsState({loaded, busy}); }});
    writer.current = own; void own.load().catch(() => {});
    return () => { own.dispose(); writer.current = null; };
  }, []);
  const ready = settingsState.loaded && !settingsState.busy && !draft;
  const images = useImages({settings, loaded: settingsState.loaded, ready, background, importBusy, blocked: blocked.current});
  useEffect(() => {images.refresh();}, [originals.value?.enabled, originals.value?.desired, originals.value?.phase]);
  return h('div', {className: 'rapier-images', style: {...column(16), width: '100%', maxWidth: 600, marginInline: 'auto', paddingBottom: 8}},
    h('style', null, '.rapier-saving{color:#168341}[data-mode="dark"] .rapier-saving{color:#67d693}.rapier-info-button{width:20px!important;height:20px!important;min-width:20px;padding:0!important;color:var(--text-color-kumo-subtle);font-family:Georgia,serif;font-style:italic;font-size:12px;line-height:1}.rapier-info-popup{max-width:min(300px,calc(100vw - 32px));padding:12px!important;background:var(--color-kumo-contrast)!important;color:var(--text-color-kumo-inverse)!important;font-size:14px;line-height:1.45}.rapier-info-popup p{color:inherit}.rapier-import-link{color:var(--text-color-kumo-link)!important;height:auto;padding-block:0}.rapier-stepper:focus-within{outline:2px solid var(--color-kumo-focus);outline-offset:2px}.rapier-progress[data-indeterminate]{width:35%;animation:rapier-progress 1.4s ease-in-out infinite}@keyframes rapier-progress{from{transform:translateX(-110%)}to{transform:translateX(390%)}}@media(max-width:640px){.rapier-title{font-size:20px}}@media(prefers-reduced-motion:reduce){.rapier-progress[data-indeterminate]{animation:none}}'),
    h('header', {style: {...line, justifyContent: 'center', flexWrap: 'nowrap', gap: 8, paddingBlock: 4, textAlign: 'center'}},
      h('h1', {className: 'rapier-title text-2xl font-semibold', style: {lineHeight: 1.25, letterSpacing: '-0.025em'}}, WORDS.name),
      h(Info, {label: WORDS.name, text: WORDS.titleInfo})),
    h(YourImages, {images, background, ready, onImport: () => setImportOpen(true)}),
    h(Settings, {settings, save: patch => void writer.current?.save(patch).catch(() => {}), error: settingsError ?? originals.error,
      loaded: settingsState.loaded, draft: setDraft, retry: () => settingsError || !settingsState.loaded
        ? void writer.current?.load().catch(() => {}) : originals.retry()}),
    h(Recent, {images, ready}),
    h('footer', {className: 'text-sm text-kumo-subtle', style: {...line, justifyContent: 'center', gap: 8, paddingBlock: 2}},
      originals.loaded && h(Switch, {id: 'rapier-originals', size: 'sm', 'aria-label': WORDS.originals,
        ...originalsControl(originals), onCheckedChange: originals.setKeep}),
      h('label', {htmlFor: 'rapier-originals'}, WORDS.originals), h(Info, {label: WORDS.originals,
        text: WORDS.originalsInfo + (originals.value?.available === false ? ' ' + WORDS.originalsPaid : ''), side: 'top'})),
    h(WordPress, {open: importOpen, setOpen: setImportOpen, ready, refresh: images.refresh, setImportBusy, blocked}));
}
export const pages = {'/jpeg-xl': ImagesPage};
