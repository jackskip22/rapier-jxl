// SPDX-License-Identifier: MIT
import * as resumable from 'rapier-jxl/resumable';
import {verify} from 'rapier-jxl/verify';
import {createEmDashJobStore, createEmDashCallCounter, storeFailure, acquireEmDashAdvance} from './job-store.mjs';
import {createWorkQueue} from './work-queue.mjs';
import {resourceFailure, canRetireJpeg} from './host-policy.mjs';
import {nodeEstimate} from './node-admission.mjs';
import {digest} from './digest.mjs';

const ID = /^[a-f0-9]{32}$/, text = new TextEncoder();
const fail = (code, message) => Object.assign(new Error(message), {code});
const keyOf = id => `jxl:job:${id}`;
const summary = result => { const {bytes, ...record} = result; return record; };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const MAX_CANDIDATE_BYTES = 8 * 1024 * 1024;
const candidateOf = value => record(value) && record(value.result) && !Object.hasOwn(value.result, 'bytes') &&
  !Object.hasOwn(value.result, 'verification') && Number.isSafeInteger(value.byteLength) &&
  value.byteLength >= 2 && value.byteLength <= MAX_CANDIDATE_BYTES &&
  Array.isArray(value.parts) && value.parts.length > 0 && value.parts.length <= 8 &&
  value.parts.every(part => /^[a-f0-9]{64}$/.test(part?.hash ?? '') && Number.isSafeInteger(part.length) &&
    part.length > 0 && part.length <= 1024 * 1024) &&
  value.parts.reduce((length, part) => length + part.length, 0) === value.byteLength &&
  ['original', 'main', 'variant'].includes(value.kind) && typeof value.replace === 'boolean' &&
  (value.kind !== 'variant' || Number.isSafeInteger(value.width) && value.width >= 16 && value.width <= 8192 && value.result.width === value.width);
const PERMANENT = new Set(['JXL_INPUT', 'JXL_OPTIONS', 'JXL_DIMENSIONS', 'JXL_JPEG', 'JXL_DECODE',
  'JXL_RECONSTRUCTION', 'JXL_UNSUPPORTED']);
// A host without a native decoder (Node reading a JPEG for a lossy goal) cannot read the format; the browser can.
const RETRY_LIMIT = 9;
const unreadable = error => error?.code === 'JXL_UNSUPPORTED' || error?.code === 'JXL_PLATFORM';

// A lossy copy of a JPEG needs its pixels. On Node they come from the picture's lossless JPEG XL read by the package's
// decoder, once per process and kept for the job's advances (a restart decodes again). Workers keep browser work.
const PART_BYTES = 1024 * 1024, JPEG_KEY = /\.(?:jpe?g|jpe|jfif)$/i;
const pixelCache = {id: null, value: null};
async function jpegPixels(media, command, signal, call) {
  const {input} = command, id = input.generation + ':' + input.sha256;
  if (pixelCache.id === id) return pixelCache.value;
  const bytes = new Uint8Array(input.byteLength);
  for (let offset = 0; offset < bytes.length; offset += PART_BYTES) {
    signal?.throwIfAborted();
    const part = await media.readSource(command.key, offset, Math.min(PART_BYTES, bytes.length - offset), {generation: input.generation, signal, call});
    if (!(part instanceof Uint8Array) || part.length !== Math.min(PART_BYTES, bytes.length - offset)) throw fail('JXL_IO', 'The JPEG could not be read.');
    bytes.set(part, offset);
  }
  if (await digest(bytes) !== input.sha256) throw fail('JXL_INPUT', 'The JPEG changed while it was read.');
  const [{recompress}, {decode}] = await Promise.all([import('rapier-jxl/jpeg'), import('rapier-jxl/decode')]);
  const kept = await recompress(bytes, {effort: 1});
  if (!(kept?.bytes instanceof Uint8Array)) throw fail('JXL_UNSUPPORTED', 'This JPEG has no lossless JPEG XL form.');
  signal?.throwIfAborted();
  const image = await decode(kept.bytes), data = new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength);
  if (data.length !== image.width * image.height * 4) throw fail('JXL_UNSUPPORTED', 'This JPEG has no plain pixel form.');
  const value = {data, input: {generation: input.generation, sha256: await digest(data), byteLength: data.length, kind: 'pixels',
    width: image.width, height: image.height}};
  pixelCache.id = id; pixelCache.value = value;
  return value;
}

// The public verifier enforces this source-pixel cap before JPEG/PNG sample allocation.
// Derive it from the existing measured photo bound; thumbnail dimensions never stand in for the original.
export function verificationPixelLimit(host, configured) {
  if (!Number.isSafeInteger(configured) || configured < 1 || host?.platform !== 'node' || host.cpuLimitMs !== null) return null;
  if (host.memoryBytes === undefined && host.memoryLimitBytes === null) return configured;
  const memory = host.memoryBytes ?? host.memoryLimitBytes;
  if (!Number.isSafeInteger(memory) || memory < 1) return null;
  const fits = pixels => {
    const estimate = nodeEstimate({operation: 'verify', options: {effort: 1}}, pixels);
    return Number.isSafeInteger(estimate) && estimate > 0 && Math.ceil(estimate * 1.1) <= memory;
  };
  if (!fits(1)) return null;
  let low = 1, high = configured;
  while (low < high) {
    const middle = low + Math.ceil((high - low) / 2);
    if (fits(middle)) low = middle; else high = middle - 1;
  }
  return low;
}

export function verificationAdmission(host, result, maxPixels) {
  const outputPixels = result?.width * result?.height;
  if (host?.platform === 'node' && host.cpuLimitMs === null &&
      Number.isSafeInteger(result?.width) && result.width > 0 &&
      Number.isSafeInteger(result?.height) && result.height > 0 &&
      Number.isSafeInteger(outputPixels) && Number.isSafeInteger(maxPixels) && maxPixels > 0 && outputPixels <= maxPixels) {
    if (host.memoryBytes === undefined && host.memoryLimitBytes === null) return null;
    const memory = host.memoryBytes ?? host.memoryLimitBytes;
    if (Number.isSafeInteger(memory) &&
        Math.ceil(nodeEstimate({operation: 'verify', options: {effort: 1}}, maxPixels) * 1.1) <= memory) return null;
  }
  return {code: 'JXL_UNSUPPORTED', operation: 'verify', reason: 'verification_resource_bound_missing',
    missing: [host?.cpuLimitMs !== null && 'unitCpu', (host?.memoryLimitBytes !== null || host?.memoryBytes !== undefined) && 'memory'].filter(Boolean),
    message: 'This host has no certified standalone-verification resource bound. The original remains available.'};
}

async function candidateResult(candidate, receipt, input, store, signal) {
  // The public driver has already verified preservation. Reassembly authenticates publication bytes only.
  if (!candidateOf(candidate)) throw fail('JXL_INPUT', 'The saved candidate exceeds its bounded part contract.');
  if (receipt?.verified !== true || receipt.source?.kind !== 'bytes' || receipt.source.digest !== 'sha256:' + input.sha256 ||
      !/^sha256:[a-f0-9]{64}$/.test(receipt.outputDigest ?? '') ||
      ['width', 'height', 'format', 'kept'].some(key => receipt[key] !== candidate.result[key]) ||
      JSON.stringify(receipt.fidelity) !== JSON.stringify(candidate.result.fidelity))
    throw fail('JXL_INPUT', 'The public verifier returned no matching candidate receipt.');
  const bytes = new Uint8Array(candidate.byteLength);
  let offset = 0;
  for (const ref of candidate.parts) {
    signal?.throwIfAborted();
    const part = await store.read(ref);
    if (!(part instanceof Uint8Array) || part.length !== ref.length)
      throw fail('JXL_IO', 'A verified candidate part is missing or truncated.');
    bytes.set(part, offset); offset += part.length;
  }
  signal?.throwIfAborted();
  if ('sha256:' + await digest(bytes) !== receipt.outputDigest)
    throw fail('JXL_INPUT', 'The candidate bytes changed after independent verification.');
  signal?.throwIfAborted();
  return {...candidate.result, bytes, verification: receipt};
}

// Recreate for each advance, whether requested by the page or the scheduled work loop.
// `ms` budgets cooperative encoder and verification steps. Store calls and one running unit may finish after it;
// the whole request's CPU and memory are measured separately on the actual host.
export function createEmDashJobRunner(ctx, {operations, media, scope = '', ms = 5000, driver = resumable, now = () => Date.now(), pixelSource = jpegPixels} = {}) {
  if (!Number.isFinite(ms) || ms <= 0 || ms > 60000 || typeof scope !== 'string' || !ctx?.cron || !ctx?.kv)
    throw fail('JXL_OPTIONS', 'Expected EmDash scheduling, versioned KV and an advance budget from 1 to 60000 ms.');
  const calls = createEmDashCallCounter();
  const work = createWorkQueue(ctx, {scope, call: action => calls.call(action)});
  const read = async id => {
    if (typeof id !== 'string' || !ID.test(id)) throw fail('JXL_INPUT', 'Expected the saved image job ID.');
    const current = await calls.call(() => ctx.kv.getVersioned(keyOf(id))) ?? {value: null, revision: null};
    if (current.value && current.value.command.scope !== scope) throw fail('JXL_INPUT', 'The job belongs to another media backend.');
    return current;
  };
  async function save(id, current, value) {
    const saved = await calls.call(() => ctx.kv.compareAndSet(keyOf(id), current.revision, value));
    if (saved?.applied === true) return {value, revision: saved.revision};
    if (saved?.applied === false) return read(id);
    throw fail('JXL_IO', 'The checkpoint write was not acknowledged.');
  }
  const browserExecution = async (reason, selected, signal) => ({location: 'browser', reason, settings: selected,
    archiveOriginals: canRetireJpeg(media.host) && (await media.originals.policy({signal, call: action => calls.call(action)})).admitting});
  function commandOf(value) {
    if (typeof value?.id !== 'string' || !ID.test(value.id) || typeof value.key !== 'string' || !value.key ||
        typeof value.operation !== 'string' || !Object.hasOwn(operations ?? {}, value.operation) ||
        typeof operations[value.operation] !== 'function' || value.scope !== scope || !record(value.input) ||
        value.options !== undefined && !record(value.options) ||
        value.settings !== undefined && !record(value.settings) ||
        value.archiveOnly !== undefined && (value.archiveOnly !== true || value.operation !== 'recompress' || value.delivery !== undefined || value.candidate !== undefined) ||
        value.candidate !== undefined && !candidateOf(value.candidate) ||
        value.delivery !== undefined && (!record(value.delivery) || !['encode', 'fit'].includes(value.delivery.operation) ||
          typeof operations[value.delivery.operation] !== 'function' || !record(value.delivery.options)) ||
        value.maxBytes !== undefined && (!Number.isSafeInteger(value.maxBytes) || value.maxBytes < 1) ||
        value.archive !== undefined && (!record(value.archive) || value.archive.id !== value.id ||
          value.archive.key !== value.key || value.archive.generation !== value.input.generation))
      throw fail('JXL_OPTIONS', 'Expected a job ID, original key and encoder operation.');
    const command = {id: value.id, key: value.key, scope, operation: value.operation, input: value.input, options: value.options ?? {},
      ...(value.settings !== undefined && {settings: value.settings}),
      ...(value.archiveOnly === true && {archiveOnly: true}),
      ...(value.candidate !== undefined && {candidate: value.candidate}),
      ...(value.delivery !== undefined && {delivery: value.delivery}),
      ...(value.maxBytes !== undefined && {maxBytes: value.maxBytes}),
      ...(value.archive !== undefined && {archive: {id: value.archive.id, key: value.archive.key, generation: value.archive.generation}})};
    let json;
    try { json = JSON.stringify(command, (_, item) => {
      if (['undefined', 'function', 'symbol', 'bigint'].includes(typeof item) || typeof item === 'number' && !Number.isFinite(item))
        throw fail('JXL_OPTIONS', 'Image requests contain JSON data.');
      return record(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item;
    }); } catch { throw fail('JXL_OPTIONS', 'Expected an acyclic JSON image request.'); }
    if (text.encode(json).length > 4096) throw fail('JXL_LIMIT', 'The image request exceeds the scheduler limit.');
    return JSON.parse(json);
  }
  async function ensure(command, current) {
    if (current.value) {
      if (JSON.stringify(current.value.command) !== JSON.stringify(command)) throw fail('JXL_INPUT', 'This job ID belongs to another request.');
      return current;
    }
    const refused = command.candidate && verificationAdmission(media.host, command.candidate?.result,
      verificationPixelLimit(media.host, media.maxPixels));
    const saved = await save(command.id, current, {command, checkpoint: command.archive ? {status: 'done'} : null,
      archive: command.archive ?? null, archiveState: command.archive ? {phase: 'prepared', error: null} : null,
      stage: command.candidate ? 'candidate' : command.operation === 'recompress' ? 'original' : 'delivery', originalPublication: null,
      candidateState: command.candidate ? {phase: refused ? 'blocked' : 'verifying', error: refused || null} : null,
      execution: null, result: null, publication: null, error: null, canceled: false});
    if (JSON.stringify(saved.value?.command) !== JSON.stringify(command)) throw fail('JXL_INPUT', 'This job ID belongs to another request.');
    return saved;
  }
  const view = current => current?.value ? {id: current.value.command.id, revision: current.revision,
    phase: current.value.canceled && !current.value.archive ? 'canceled' : current.value.error ? 'failed' : current.value.result !== null ? 'done'
      : current.value.execution?.location === 'browser' ? 'browser'
      : current.value.candidateState?.phase === 'blocked' ? 'blocked'
      : current.value.archiveState?.phase === 'blocked' ? 'blocked'
      : current.value.checkpoint?.status === 'done' ? 'publishing' : current.value.checkpoint ? 'converting' : 'queued',
    done: current.value.result !== null || !!current.value.error || current.value.execution?.location === 'browser',
    canceled: current.value.canceled && !current.value.archive,
    publishing: !current.value.canceled && !current.value.error && current.value.execution?.location !== 'browser' && current.value.result === null &&
      current.value.archiveState?.phase !== 'blocked' && current.value.candidateState?.phase !== 'blocked' && current.value.checkpoint?.status === 'done',
    result: current.value.result, publication: current.value.publication, error: current.value.error,
    ...(current.value.command.candidate?.kind === 'variant' && {width: current.value.command.candidate.width}),
    // A thread job's own progress (thread-driver.mjs), 0 to 1, while it converts; none where the driver reports none.
    ...(current.value.result === null && Number.isFinite(current.value.checkpoint?.progress) && current.value.checkpoint.status !== 'done' &&
      {progress: current.value.checkpoint.progress}),
    ...(current.value.retry && {retry: current.value.retry}),
    ...(current.value.execution ? {execution: current.value.execution} : current.value.command.settings ? {
      execution: {location: 'server', reason: null, settings: current.value.command.settings}} : {}),
    blocked: current.value.canceled || current.value.result !== null || current.value.error ? null
      : current.value.archiveState?.error ?? current.value.candidateState?.error ?? null} : null;

  // A job that has ended (done, failed, canceled, or handed to the browser) keeps none of its parts. Its work row stays
  // until that is acknowledged: a failed delete is shown as cleanupPending and the next wake repeats it.
  async function step(current, signal) {
    if (!current?.value) throw fail('JXL_INPUT', 'The image job is missing.');
    signal?.throwIfAborted();
    const id = current.value.command.id;
    const release = await acquireEmDashAdvance(ctx, {owner: id, scope, ms, now, calls});
    if (!release) return {...view(await read(id)), busy: true};
    try { return await advanceClaimed(await read(id), signal); }
    finally {
      // A lost release expires. A durably saved result remains successful if this advisory write fails.
      await release().catch(() => {});
    }
  }
  async function advanceClaimed(current, signal) {
    const was = current?.value, ended = !!was && !was.archive && !was.publication?.collect &&
      (was.result !== null || !!was.error || was.canceled || was.execution?.location === 'browser');
    const shown = await advanceOnce(current, signal), command = was?.command;
    // A job found already ended is cleaned below. A step that ends it, including archive completion and retired-publication collection, cleans here.
    if (!command || ended || !(shown?.done || shown?.canceled) || shown.publication?.collect) return shown;
    try { await clearParts(command); } catch (error) { signal?.throwIfAborted(); return {...shown, cleanupPending: true}; }
    return shown;
  }
  const clearParts = async command => {
    await driver.discard?.(command.id);
    return createEmDashJobStore(ctx, {calls, owner: command.id, now,
      readSource: () => { throw fail('JXL_IO', 'No source is read here.'); }}).clear();
  };
  async function advanceOnce(current, signal) {
    let job = current?.value;
    if (!job) throw fail('JXL_INPUT', 'The image job is missing.');
    signal?.throwIfAborted();
    const {command} = job;
    // A refused publication's retired payload is removed in its own call (media-storage.mjs collect).
    if (job.result !== null && job.publication?.collect) {
      await media.collect(job.publication.collect, {signal, call: action => calls.call(action)});
      const {collect, ...publication} = job.publication;
      return view(await save(command.id, current, {...job, publication}));
    }
    if (job.archive) {
      const next = await media.originals.advanceArchive(job.archive, {signal, cancel: job.canceled, call: action => calls.call(action)});
      signal?.throwIfAborted();
      if (next.done) {
        // A policy change can refuse an unarmed archive. Reuse the completed public-driver receipt in
        // the next advance and publish the ordinary selected delivery while physical JPEGs are kept.
        const retryDelivery = !command.archiveOnly && !job.canceled &&
          ['retirement_disabled', 'host_cpu_limit'].includes(next.publication.reason);
        const nextStage = !command.archiveOnly && !job.canceled && command.delivery && next.publication.stored === 'original';
        return view(await save(command.id, current, {...job, archive: null, archiveState: null,
          ...(retryDelivery ? {} : nextStage ? {stage: 'delivery', checkpoint: null, originalPublication: next.publication}
            : {result: next.publication.result, publication: next.publication})}));
      }
      const archiveState = {phase: next.phase, error: next.error ?? null};
      if (next.progressed === false && JSON.stringify(archiveState) === JSON.stringify(job.archiveState)) return view(current);
      return view(await save(command.id, current, {...job, archiveState}));
    }
    if (job.result !== null || job.error || job.canceled || job.execution?.location === 'browser') {
      // The work row goes only after the job's parts are gone; a failed delete is retried by the next wake.
      try { await clearParts(command); } catch (error) { signal?.throwIfAborted(); return {...view(current), cleanupPending: true}; }
      if (!command.archiveOnly) await work.remove('image', command.id);
      return view(current);
    }
    if (command.archiveOnly && (!canRetireJpeg(media.host) || !(await media.originals.policy({signal, call: action => calls.call(action)})).admitting))
      return view(await save(command.id, current, {...job, result: {fits: false, reason: {code: 'retirement_disabled'}},
        publication: {key: command.key, stored: null, reason: 'retirement_disabled'}}));
    const candidate = job.stage === 'candidate' ? command.candidate : null;
    let verificationMaxPixels;
    if (candidate) {
      const ceiling = verificationPixelLimit(media.host, media.maxPixels);
      // Resume the exact enforced cap that created this checkpoint. A changed host must not silently authorize
      // its older, larger allocation, nor reinterpret an opaque public checkpoint that lacks this host pin.
      verificationMaxPixels = job.checkpoint ? job.verificationMaxPixels : ceiling;
      const safe = Number.isSafeInteger(verificationMaxPixels) && verificationMaxPixels > 0 &&
        ceiling !== null && verificationMaxPixels <= ceiling;
      const refused = verificationAdmission(media.host, candidate.result, safe ? verificationMaxPixels : null);
      if (refused) {
        const candidateState = {phase: 'blocked', error: refused};
        return JSON.stringify(candidateState) === JSON.stringify(job.candidateState) ? view(current)
          : view(await save(command.id, current, {...job, candidateState}));
      }
      if (job.candidateState?.phase === 'blocked' && job.candidateState.error?.reason !== 'verification_resource_bound_missing') return view(current);
    }
    // A retryable failure waits out its backoff in the saved job, so the recurring wake never spins on it.
    if (job.retry && now() < job.retry.next) return view(current);
    const selected = job.stage === 'delivery' && command.delivery ? command.delivery : command;
    const operation = candidate ? verify : operations[selected.operation];
    const options = candidate ? {result: candidate.result, parts: candidate.parts,
      maxPixels: verificationMaxPixels} : selected.options;
    let pixels = null;
    const store = createEmDashJobStore(ctx, {calls, owner: command.id, readSource: (offset, length) => pixels
      ? pixels.data.slice(offset, offset + length)
      : media.readSource(command.key, offset, length, {generation: command.input.generation, signal,
        call: action => calls.call(action)})});
    const finishing = job.checkpoint?.status === 'done';
    let checkpoint, result, released = [];
    try {
      if (!candidate && job.stage === 'delivery' && selected.operation !== 'recompress' && command.input.kind === 'file' &&
          JPEG_KEY.test(command.key) && media.host?.platform === 'node')
        pixels = await pixelSource(media, command, signal, action => calls.call(action));
      const input = pixels?.input ?? command.input;
      if (!job.checkpoint) checkpoint = await driver.start({owner: command.id, operation, input, options, store, ...(!candidate && {verify})});
      else if (!finishing)
        ({checkpoint, released = []} = await driver.advance(job.checkpoint, {owner: command.id, operation, input, store, ...(!candidate && {verify}), budget: {ms}, signal}));
      else {
        const finished = await driver.finish(job.checkpoint, {owner: command.id, operation, input, store, signal});
        result = candidate ? await candidateResult(candidate, finished, command.input, store, signal) : finished;
      }
    } catch (thrown) {
      signal?.throwIfAborted();
      // The job store's own failure (JXL_IO), not the JXL_INTERNAL resumable wraps it in.
      const error = storeFailure(thrown);
      const resource = resourceFailure(error);
      if (candidate) {
        if (error?.code === 'JXL_DIMENSIONS' && verificationMaxPixels < media.maxPixels)
          return view(await save(command.id, current, {...job, candidateState: {phase: 'blocked', error: {
            code: error.code, message: String(error.message), operation: 'verify',
            reason: 'verification_pixel_limit', maxPixels: verificationMaxPixels}}}));
        if (resource || error?.code === 'JXL_UNSUPPORTED') return view(await save(command.id, current, {...job,
          candidateState: {phase: 'blocked', error: {code: error.code, message: String(error.message), operation: 'verify',
            reason: resource ? 'verification_' + resource + '_limit' : 'verification_unsupported'}}}));
        if (PERMANENT.has(error?.code) || error?.code === 'JXL_TARGET') return view(await save(command.id, current, {...job,
          error: {code: error.code, message: String(error.message), ...(error.verification && {verification: error.verification})}}));
        // The page and the scheduler may advance one job at once. The one whose checkpoint is saved first frees the parts
        // its new checkpoint no longer reaches, so the other can find one missing: its checkpoint is stale, and the saved
        // job, not that error, is the answer. (Every other path saves, and a stale save already returns the saved job.)
        const latest = await read(command.id);
        if (latest.revision !== current.revision) return view(latest);
        throw error;
      }
      if (resource && command.settings) return view(await save(command.id, current, {...job,
        execution: await browserExecution(resource, command.settings, signal), error: null}));
      // A format the host cannot read is still supported by the browser's native reader. The old saved job is
      // terminal, and the page claims a fresh delivery revision before uploading its independent result.
      if (job.stage === 'delivery' && unreadable(error) && command.settings) {
        return view(await save(command.id, current, {...job, execution: await browserExecution('format', command.settings, signal), error: null}));
      }
      if (error?.code === 'JXL_TARGET') {
        const prior = job.originalPublication;
        return view(await save(command.id, current, {...job,
          result: prior?.deliveryEligible ? prior.result : {fits: false, reason: {code: 'JXL_TARGET', message: String(error.message)}},
          publication: prior?.deliveryEligible ? prior : {key: command.key, stored: null, reason: 'JXL_TARGET'}}));
      }
      if (error?.name === 'AbortError') throw error;
      if (!PERMANENT.has(error?.code)) {
        // 1 s, 2 s, 4 s ... capped at 4 minutes; after the bound the image fails with the reason recorded.
        const attempts = (job.retry?.attempts ?? 0) + 1, reason = {code: String(error?.code ?? 'JXL_INTERNAL'), message: String(error?.message)};
        if (attempts > RETRY_LIMIT) return view(await save(command.id, current, {...job, retry: null,
          error: {...reason, retries: RETRY_LIMIT}}));
        return view(await save(command.id, current, {...job,
          retry: {attempts, next: now() + Math.min(1000 * 2 ** (attempts - 1), 240000), ...reason}}));
      }
      return view(await save(command.id, current, {...job, error: {code: error.code, message: String(error.message)}}));
    }
    if (job.retry) job = {...job, retry: null};
    if (!finishing) {
      const saved = await save(command.id, current, {...job, checkpoint,
        ...(candidate && {verificationMaxPixels, candidateState: {phase: 'verifying', error: null}})});
      // The checkpoint is kept: the parts it no longer reaches are not needed again.
      // A browser candidate's staged parts are the job's own input: reassembly reads them again at the end, so only the
      // terminal cleanup deletes them.
      const input = new Set((command.candidate?.parts ?? []).map(part => part.hash));
      const free = released.filter(ref => !input.has(ref.hash));
      if (free.length && saved.value?.checkpoint === checkpoint) await store.release(free);
      return view(saved);
    }
    // Saving the completed checkpoint ends cancellation before any rendition can be published.
    // Completion is its own call; a retry reuses the same publication identity.
    signal?.throwIfAborted();
    if (result.fits === true && result.verification?.verified !== true)
      throw fail('JXL_INPUT', 'The saved image job has no independent verification receipt.');
    if (command.archiveOnly && (result.fits !== true || result.kept !== 'jpeg-bytes' || result.fidelity !== 'exact')) {
      if (result.fits === true) throw fail('JXL_INPUT', 'An originals policy job must preserve exact JPEG bytes.');
      return view(await save(command.id, current, {...job, result: summary(result),
        publication: {key: command.key, stored: null, reason: result.reason?.code ?? 'JXL_TARGET'}}));
    }
    const over = command.maxBytes !== undefined && result.bytes?.byteLength > command.maxBytes;
    const publicationOptions = {source: command.input.sha256, expectedGeneration: command.input.generation,
      expectedDeliveryRevision: command.input.deliveryRevision, jobIdentity: command.id, receipt: result.verification,
      signal, call: action => calls.call(action), ...(pixels && {sourcePixels: pixels.input.sha256}),
      ...(candidate && {replace: candidate.replace, floor: candidate.floor})};
    if (candidate?.kind === 'variant') {
      const publication = over ? {key: command.key, width: candidate.width, stored: null, reason: 'JXL_TARGET'}
        : await media.attachVariant(command.key, candidate.width, result, publicationOptions);
      return view(await save(command.id, current, {...job, result: summary(result), publication}));
    }
    if (result.fits === true && result.kept === 'jpeg-bytes' && (job.stage === 'original' || candidate?.kind === 'original')) {
      const archiveAllowed = canRetireJpeg(media.host) && (await media.originals.policy({signal, call: action => calls.call(action)})).admitting;
      if (!archiveAllowed) {
        if (command.archiveOnly) return view(await save(command.id, current, {...job, result: summary(result),
          publication: {key: command.key, stored: null, reason: 'retirement_disabled'}}));
        const publication = over ? {key: command.key, stored: null, reason: 'JXL_TARGET'} :
          await media.attach(command.key, result, publicationOptions);
        const proceed = command.delivery && !publication?.collect && !['key_changed', 'delivery_changed'].includes(publication?.reason);
        return view(await save(command.id, current, {...job, ...(proceed
          ? {stage: 'delivery', checkpoint: null, originalPublication: publication?.stored === 'sidecar'
            ? {...publication, deliveryEligible: true} : null}
          : {result: summary(result), publication})}));
      }
      const before = await media.sourceHead(command.key, {signal, call: action => calls.call(action)});
      if (!before || before.generation !== command.input.generation || before.size !== command.input.byteLength)
        return view(await save(command.id, current, {...job, result: summary(result),
          publication: {key: command.key, stored: null, reason: 'key_changed'}}));
      const receipt = result.verification;
      if (receipt?.verified !== true) throw fail('JXL_INPUT', 'The saved JPEG job has no independent verification receipt.');
      const deliveryEligible = !command.archiveOnly && !over && result.bytes.byteLength < before.size;
      const archive = await media.originals.beginArchive(command.key, result, {receipt, source: command.input.sha256,
        expectedGeneration: command.input.generation, expectedDeliveryRevision: command.input.deliveryRevision,
        jobIdentity: command.id, storageOnly: command.archiveOnly === true, deliveryEligible,
        deliveryReason: command.archiveOnly ? null : over ? 'JXL_TARGET' : deliveryEligible ? null : 'not_smaller',
        signal, call: action => calls.call(action)});
      if (archive.refused && !command.archiveOnly && ['retirement_disabled', 'host_cpu_limit'].includes(archive.refused))
        return view(current); // A concurrent policy change is observed before the next completed-checkpoint publication.
      return view(await save(command.id, current, archive.refused ? {...job, result: summary(result), publication: archive.publication}
        : {...job, archive, archiveState: {phase: 'prepared', error: null}}));
    }
    const prior = job.originalPublication;
    if (prior?.deliveryEligible && (!result.fits || prior.jxlBytes <= result.bytes.byteLength))
      return view(await save(command.id, current, {...job, result: prior.result, publication: prior}));
    const publication = over ? {key: command.key, stored: null, reason: 'JXL_TARGET'} : result.fits === true
      ? await media.attach(command.key, result, publicationOptions) : null;
    return view(await save(command.id, current, {...job, result: summary(result), publication}));
  }
  return {
    calls, work,
    async queue(value) {
      const command = commandOf({...value, scope});
      if (command.archiveOnly) throw fail('JXL_OPTIONS', 'Originals policy work owns archive-only command recovery.');
      const current = await read(command.id);
      if (current.value) return view(await ensure(command, current));
      // The recurring intent recovers an interruption before the first checkpoint is saved.
      await work.schedule('image', command.id, command);
      return view(await ensure(command, current));
    },
    async advance(id, {signal} = {}) { return step(await read(id), signal); },
    async status(id) { return view(await read(id)); },
    async defer(id, execution) {
      let current = await read(id);
      const job = current.value;
      // An armed archive mutation first drains to its acknowledged state. The page never races its removal proof.
      if (!job || job.archive || job.candidateState || job.publication?.collect || job.canceled) return view(current);
      if (execution?.location !== 'browser' || !['cpu', 'memory', 'format'].includes(execution.reason) || !record(execution.settings))
        throw fail('JXL_OPTIONS', 'Expected the host-selected browser execution.');
      if (!job.result && !job.error) current = await save(id, current, {...job, execution});
      return view(current);
    },
    async cancel(id) {
      let current = await read(id);
      let attempt = 0;
      while (current.value && current.value.result === null && !current.value.error && current.value.execution?.location !== 'browser' &&
          current.value.checkpoint?.status !== 'done' && !current.value.canceled) {
        if (attempt++ === 8) throw fail('JXL_BUSY', 'The image job changed too often. Retry cancellation.');
        current = await save(id, current, {...current.value, canceled: true});
      }
      return view(current);
    },
    async resume(value, {signal, cancel = false} = {}) {
      const command = commandOf(value), id = command.id;
      if (typeof cancel !== 'boolean' || cancel && !command.archiveOnly)
        throw fail('JXL_OPTIONS', 'Only the originals controller cancels its private archive command through resume.');
      let current = await read(id);
      // The durable queue recovers an interruption before the initial checkpoint was acknowledged.
      current = await ensure(command, current);
      // Cancellation fences even a completed codec checkpoint. An already armed archive still drains through
      // advanceArchive(cancel:true); a not-yet-armed command cannot publish or retire the source afterwards.
      if (cancel && !current.value.canceled) {
        current = await save(id, current, {...current.value, canceled: true});
        if (!current.value.canceled) return view(current); // A concurrent checkpoint won; retry cancellation before any work.
      }
      return step(current, signal);
    },
  };
}
