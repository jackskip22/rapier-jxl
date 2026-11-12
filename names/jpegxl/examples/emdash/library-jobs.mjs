// SPDX-License-Identifier: MIT
import {digest} from './digest.mjs';
import {settings as normalizeSettings} from './media-settings.mjs';

export const LIBRARY_STORAGE = {jxl_library: {indexes: []}};
const ID = /^[a-f0-9]{32}$/, MEDIA = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
const KEY = /^[0-9A-HJKMNP-TV-Z]{26}(?:\.[0-9A-HJKMNP-TV-Z]{26})*\.[a-z0-9]{1,8}$/i;
const fail = (code, message) => Object.assign(new Error(message), {code});
const RETRY_LIMIT = 9;
const terminal = state => state === 'done' || state === 'canceled';
const normalize = items => {
  if (!Array.isArray(items) || !items.length || items.length > 100)
    throw fail('JXL_INPUT', 'Send 1 to 100 selected images.');
  return items.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw fail('JXL_INPUT', 'Expected a media id and storage key.');
    const {id, key, name} = item;
    if (typeof id !== 'string' || !MEDIA.test(id) || typeof key !== 'string' || !KEY.test(key) ||
        name !== undefined && typeof name !== 'string')
      throw fail('JXL_INPUT', 'Expected a media id and storage key.');
    return {id, key, name: name ?? key};
  });
};

// One bounded selection page and one original at a time. The image runner owns encoding and publication.
export function createLibraryRun(ctx, {scope, service, prepare, validate, now = () => Date.now()}) {
  const pages = ctx.storage?.jxl_library;
  if (!scope || typeof pages?.get !== 'function' || typeof pages?.compareAndSet !== 'function' ||
      typeof pages?.put !== 'function' || typeof prepare !== 'function' || typeof validate !== 'function')
    throw fail('JXL_OPTIONS', 'Expected EmDash library storage and the image job runner.');
  const call = action => service.calls.call(action), runKey = `jxl:library:${scope}`;
  const pageKey = (id, page) => `${scope}:${id}:${page}`;
  const read = async () => await call(() => ctx.kv.getVersioned(runKey)) ?? {value: null, revision: null};
  const view = row => {
    if (!row?.value) return null;
    const {id, state, expected, pages, total, processed, converted, kept, failed, browser, before, after, current, last} = row.value;
    return {id, revision: row.revision, state, expected, pages, total, processed, converted, kept, failed, browser, before, after,
      cleanupPending: row.value.cleanup !== null,
      saved: Math.max(0, before - after), current: current ? {id: current.id, key: current.key, name: current.name,
        jobId: current.jobId, stage: current.stage, ...(current.retry && {retry: current.retry.attempts})} : null, last};
  };
  async function save(row, value) {
    const changed = await call(() => ctx.kv.compareAndSet(runKey, row.revision, value));
    if (changed?.applied === true) return {value, revision: changed.revision};
    if (changed?.applied === false) return read();
    throw fail('JXL_IO', 'The library checkpoint was not acknowledged.');
  }
  function own(row, id) {
    if (typeof id !== 'string' || !ID.test(id) || row.value?.id !== id)
      throw fail('JXL_INPUT', 'This library run is no longer current.');
    return row.value;
  }
  const schedule = id => service.work.schedule('library', id);
  // A tiny closed marker fences delayed create-only append requests after the selection data is retired.
  const close = (id, page) => call(() => pages.put(pageKey(id, page), {closed: true}));
  const clean = run => close(run.id, run.cleanup);
  function completed(run, outcome, job) {
    const item = run.current, publication = job?.publication;
    const before = job?.originalBytes ?? (job?.done ? item.command?.input.byteLength ?? 0 : 0);
    const converted = (publication?.stored === 'sidecar' || publication?.stored === 'original' && publication.deliveryEligible) && Number.isSafeInteger(publication.jxlBytes) &&
      publication.jxlBytes > 0 && publication.jxlBytes < before;
    const state = outcome ?? (job?.execution?.location === 'browser' ? 'browser' : converted ? 'converted' : job?.error ? 'failed' : job?.canceled ? 'canceled' : 'kept');
    const after = state === 'converted' ? publication.jxlBytes : before;
    const next = {...run, current: null, processed: run.processed + 1,
      converted: run.converted + Number(state === 'converted'), kept: run.kept + Number(state === 'kept'),
      failed: run.failed + Number(state === 'failed'), browser: run.browser + Number(state === 'browser'),
      before: run.before + before, after: run.after + after,
      last: {id: item.id, key: item.key, name: item.name, state, reason: job?.error?.code ?? job?.reason ?? publication?.reason ?? publication?.deliveryReason ??
        (publication?.stored === 'sidecar' && !converted ? 'not_smaller' : job?.result?.reason?.code ?? null)}};
    if (run.offset + 1 === item.pageLength) Object.assign(next, {page: run.page + 1, offset: 0, cleanup: run.page});
    else next.offset++;
    if (next.processed === next.total && ['running', 'paused'].includes(next.state)) next.state = 'done';
    return next;
  }
  async function advance(id, row) {
    row ??= await read();
    const run = own(row, id);
    if (run.cleanup !== null) {
      await clean(run);
      return view(await save(row, {...run, cleanup: null}));
    }
    if (terminal(run.state)) {
      await service.work.remove('library', id);
      return view(row);
    }
    if (run.state === 'preparing') return view(row);
    if (run.state === 'canceling') {
      if (run.current?.command) {
        // Persist a canceled job so a concurrent queue cannot recreate it later.
        await service.queue(run.current.command);
        const job = await service.cancel(run.current.jobId);
        if (!job?.canceled && !job?.done) return view(row);
        return view(await save(row, completed(run, undefined, job)));
      }
      // Include the next page: its write may have succeeded before its checkpoint was acknowledged.
      if (run.page <= run.pages) {
        await close(run.id, run.page);
        return view(await save(row, {...run, current: null, page: run.page + 1, offset: 0}));
      }
      return view(await save(row, {...run, state: 'canceled', current: null}));
    }
    if (!run.current) {
      // Keep the recurring intent while paused; a stale pause must not cancel a concurrent resume.
      if (run.state === 'paused') return view(row);
      if (run.processed === run.total) return view(await save(row, {...run, state: 'done'}));
      const page = await call(() => pages.get(pageKey(id, run.page))), item = page?.items?.[run.offset];
      if (!item) {
        const latest = await read();
        if (latest.revision !== row.revision) return view(latest);
        throw fail('JXL_IO', 'A selected image page is missing.');
      }
      const jobId = (await digest(new TextEncoder().encode(JSON.stringify([scope, id, item.id, item.key])))).slice(0, 32);
      return view(await save(row, {...run, current: {...item, jobId, stage: 'prepare', pageLength: page.items.length, command: null}}));
    }
    const item = run.current;
    if (item.stage === 'prepare') {
      let command;
      // A failed read of one picture is transient: it waits out the saved back-off, then fails that item with its reason.
      if (item.retry && now() < item.retry.next) return view(row);
      try { command = await prepare(item, run.settings, call); }
      catch (error) {
        ctx.request?.signal?.throwIfAborted();
        if (!['JXL_INPUT', 'JXL_OPTIONS', 'JXL_LIMIT', 'JXL_UNSUPPORTED', 'key_changed', 'NOT_FOUND'].includes(error?.code)) {
          const attempts = (item.retry?.attempts ?? 0) + 1, reason = String(error?.message ?? error).slice(0, 200);
          if (attempts <= RETRY_LIMIT) return view(await save(row, {...run, current: {...item,
            retry: {attempts, next: now() + Math.min(1000 * 2 ** (attempts - 1), 240000), reason}}}));
          const failed = completed(run, 'failed', {reason: 'JXL_IO'});
          return view(await save(row, {...failed, last: {...failed.last, reason}}));
        }
        return view(await save(row, completed(run, 'failed', {reason: error.code})));
      }
      if (command === null) return view(await save(row, completed(run, 'browser')));
      if (command.wait) return view(row);
      if (command.skip) return view(await save(row, completed(run, 'kept', {reason: command.skip, originalBytes: command.originalBytes})));
      return view(await save(row, {...run, current: {...item, stage: 'queue', command: {...command, id: item.jobId}}}));
    }
    if (item.stage === 'queue') {
      await service.queue(item.command);
      return view(await save(row, {...run, current: {...item, stage: 'waiting'}}));
    }
    const job = await service.status(item.jobId);
    if (!job) throw fail('JXL_IO', 'The saved image job is missing.');
    if (item.invalid) {
      const stopped = job.done || job.canceled ? job : await service.cancel(item.jobId);
      if (!stopped?.canceled && !stopped?.done) return view(row);
      return view(await save(row, completed(run, item.invalid === 'key_changed' ? 'failed' : 'kept',
        {reason: item.invalid, originalBytes: item.invalid === 'key_changed' ? 0 : item.command.input.byteLength})));
    }
    if (job.done && job.publication?.reason === 'key_changed')
      return view(await save(row, completed(run, 'failed', {reason: 'key_changed'})));
    if (job.done || job.canceled) return view(await save(row, completed(run, undefined, job)));
    const changed = await validate(item, call);
    if (!changed) return view(row);
    // Persist the reason before cancellation, including an interrupted cancellation acknowledgement.
    // The existing runner still owns cancellation and its final publication fence.
    return view(await save(row, {...run, current: {...item, invalid: changed}}));
  }
  return {
    status: async () => view(await read()),
    async start({id, total, settings}) {
      if (typeof id !== 'string' || !ID.test(id) || !Number.isSafeInteger(total) || total < 1 ||
          !settings || typeof settings !== 'object' || Array.isArray(settings))
        throw fail('JXL_INPUT', 'Expected a library run id, the number of selected images, and the site settings.');
      const selectedSettings = normalizeSettings(settings);
      const row = await read(), old = row.value;
      if (old?.id === id) {
        if (old.expected !== total) throw fail('JXL_INPUT', 'The saved selection has a different size.');
        return view(row);
      }
      if (old && !terminal(old.state)) throw fail('JXL_INPUT', 'Finish or cancel the current library run first.');
      if (old?.cleanup !== null && old?.cleanup !== undefined) await clean(old);
      if (old) await service.work.remove('library', old.id);
      return view(await save(row, {id, scope, state: 'preparing', expected: total, settings: selectedSettings, pages: 0, total: 0,
        page: 0, offset: 0, lastId: '', cleanup: null, current: null, last: null,
        processed: 0, converted: 0, kept: 0, failed: 0, browser: 0, before: 0, after: 0}));
    },
    async append({id, page, items}) {
      const selection = normalize(items), row = await read(), run = own(row, id);
      if (!Number.isSafeInteger(page) || page < 0 || page > run.pages)
        throw fail('JXL_INPUT', 'Append the next selection page.');
      const key = pageKey(id, page), data = {items: selection};
      if (page < run.pages) {
        const prior = await call(() => pages.get(key));
        if (JSON.stringify(prior) !== JSON.stringify(data)) throw fail('JXL_INPUT', 'This selection page is already saved.');
        return view(row);
      }
      if (run.state !== 'preparing' || run.total + selection.length > run.expected)
        throw fail('JXL_INPUT', 'The library selection is closed.');
      let previous = run.lastId;
      for (const item of selection) {
        const normalized = item.id.toUpperCase();
        if (normalized <= previous) throw fail('JXL_INPUT', 'Select each media id once, in ascending order.');
        previous = normalized;
      }
      const put = await call(() => pages.compareAndSet(key, null, data));
      if (put?.applied !== true) {
        if (put?.applied !== false) throw fail('JXL_IO', 'The selection page was not acknowledged.');
        const prior = await call(() => pages.get(key));
        if (JSON.stringify(prior) !== JSON.stringify(data)) throw fail('JXL_INPUT', 'This selection page has different images.');
      }
      return view(await save(row, {...run, pages: page + 1, total: run.total + selection.length, lastId: previous}));
    },
    async control({id, action}) {
      if (!['resume', 'pause', 'cancel'].includes(action)) throw fail('JXL_INPUT', 'Choose resume, pause, or cancel.');
      let row = await read();
      for (let attempt = 0; attempt < 3; attempt++) {
        const run = own(row, id);
        if (terminal(run.state) || run.state === 'canceling') return view(row);
        if (action === 'resume' && run.total !== run.expected) throw fail('JXL_INPUT', 'Finish queuing the selected images first.');
        if (action === 'pause' && run.state === 'preparing') return view(row);
        // Schedule before the checkpoint so an interrupted acknowledgement cannot strand an accepted run.
        if (action !== 'pause') await schedule(id);
        const state = {resume: 'running', pause: 'paused', cancel: 'canceling'}[action];
        const saved = await save(row, {...run, state});
        if (saved.value?.id !== id || saved.value?.state === state) return view(saved);
        row = saved;
      }
      throw fail('JXL_IO', 'The library run changed; read its current progress.');
    },
    advance,
    async resume(id) {
      if (typeof id !== 'string' || !ID.test(id)) throw fail('JXL_INPUT', 'Expected the saved library run ID.');
      const row = await read();
      if (row.value?.id !== id) {
        await service.work.remove('library', id);
        return null;
      }
      return advance(id, row);
    },
  };
}
