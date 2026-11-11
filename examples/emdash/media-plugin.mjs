import {definePlugin, PluginRouteError} from 'emdash';
import {encode, fit} from 'rapier-jxl';
import {recompress} from 'rapier-jxl/jpeg';
import {activeStorage, activeStorageScope, isJpegKey, hasSidecar, INITIAL_DELIVERY} from './media-storage.mjs';
import {digest} from './digest.mjs';
import {EMDASH_JOB_STORAGE, createEmDashJobStore} from './job-store.mjs';
import {createEmDashJobRunner} from './job-runner.mjs';
import {createLibraryRun, LIBRARY_STORAGE} from './library-jobs.mjs';
import {WORK_STORAGE} from './work-queue.mjs';
import {runBackground, recoverWake} from './background.mjs';
import {settings, nativeImageJob} from './media-settings.mjs';
import {WORDS} from './media-words.mjs';
import {executionFor, hostLimits, requestBudget, deliveryOnly} from './host-policy.mjs';
import {createThreadDriver} from './thread-driver.mjs';
import {stageCandidate} from './browser-candidate.mjs';
export {DEFAULTS, settings} from './media-settings.mjs';

const ID = 'rapier-media', VERSION = '0.1.0';
const PAGES = [{path: '/jpeg-xl', label: WORDS.name, icon: 'image'}];
const ADMIN = {entry: './media-admin.mjs', pages: PAGES};
const MAX_BYTES = 8 * 1024 * 1024;
const UPLOAD_KEY = /^[0-9A-HJKMNP-TV-Z]{26}(?:\.[0-9A-HJKMNP-TV-Z]{26})*\.[a-z0-9]{1,8}$/i;
const fail = (status, code, message) => new PluginRouteError(code, message, status);
const serverImage = key => isJpegKey(key) || /\.png$/i.test(key);
const nativeOptions = (site, key, archiveOriginals = true) =>
  nativeImageJob(site, isJpegKey(key) ? 'image/jpeg' : 'image/png', archiveOriginals);
const mediaJobKey = async (scope, key, source) => 'jxl:media:' + await digest(new TextEncoder().encode(
  JSON.stringify([scope, key, source.generation, source.deliveryRevision])));
const pointerIds = value => [...new Set((value?.ids ?? [value?.id]).filter(id => /^[a-f0-9]{32}$/.test(id ?? '')))];
async function pointerState(service, value) {
  let active = null, last = null;
  const widths = new Set();
  const jobs = await Promise.all(pointerIds(value).map(id => service.status(id)));
  for (const job of jobs) {
    if (job && !job.done && !job.canceled) {
      active ??= job;
      if (Number.isSafeInteger(job.width)) widths.add(job.width);
    }
    if (job) last = job;
  }
  return {job: active ?? last, pendingWidths: [...widths].sort((a, b) => a - b)};
}
const pointerJob = async (service, value) => (await pointerState(service, value)).job;

function storage() {
  const value = activeStorage();
  if (!value) throw fail(500, 'storage_not_wrapped', 'Add rapier-jxl through jxl(emdash, {...}) in astro.config');
  return value;
}
// At most every 30 s on Node: a wake task a restart left locked is replaced (background.mjs recoverWake).
let wakeChecked = -Infinity;
async function checkWake(ctx, media, call) {
  if (media.originals?.platform !== 'node' || Date.now() - wakeChecked < 30000 || typeof ctx?.cron?.cancel !== 'function') return;
  wakeChecked = Date.now();
  try { await recoverWake(ctx, {active: nodePumps.has(media), call}); } catch {}
}
async function runner(ctx, options = {}) {
  const media = storage(), backend = activeStorageScope();
  if (!backend) throw fail(500, 'storage_scope', 'Native storage has no configured backend scope');
  const scope = await digest(new TextEncoder().encode(JSON.stringify([ID, backend])));
  const host = media.host ?? hostLimits(media.originals?.platform ?? 'node');
  // Node with no CPU allowance runs each image job in a worker thread (thread-driver.mjs); other hosts step it.
  const operations = {encode, fit, recompress};
  const service = createEmDashJobRunner(ctx, {media, scope, ms: requestBudget(host), operations,
    ...(host.platform === 'node' && host.cpuLimitMs === null && {driver: createThreadDriver(operations)}), ...options});
  await checkWake(ctx, media, action => service.calls.call(action));
  const queue = service.queue;
  service.queue = async command => {
    const pointer = await mediaJobKey(scope, command.key, command.input);
    let previous = await service.calls.call(() => ctx.kv.getVersioned(pointer)) ?? {value: null, revision: null};
    const job = await queue(command);
    if (command.candidate && !job.done && !job.canceled) {
      // Original, main and width candidates have distinct proofs. Retain every pending owner so a page reopened
      // during verification can still find the original's mutation fence instead of replacing its only pointer.
      for (let attempt = 0; attempt < 8; attempt++) {
        ctx.request?.signal?.throwIfAborted();
        const ids = pointerIds(previous.value);
        if (ids.includes(job.id)) return job;
        ids.push(job.id);
        const saved = await service.calls.call(() => ctx.kv.compareAndSet(pointer, previous.revision,
          {...previous.value, id: ids[0], ids}));
        if (saved?.applied === true) return job;
        if (saved?.applied !== false) throw fail(503, 'JXL_IO', 'The candidate job pointer was not acknowledged');
        previous = await service.calls.call(() => ctx.kv.getVersioned(pointer)) ?? {value: null, revision: null};
      }
      throw fail(409, 'JXL_BUSY', 'The candidate job pointer changed too often. Retry this request.');
    }
    // A revision owns its pointer. Compare against the value seen before queueing so a delayed old library run
    // cannot replace a newer run's pointer; terminal replays also leave it alone.
    if (!job.done && !job.canceled && previous.value?.id !== job.id) {
      const saved = await service.calls.call(() => ctx.kv.compareAndSet(pointer, previous.revision,
        {id: job.id, ...(job.execution && {execution: job.execution})}));
      if (saved?.applied !== true && saved?.applied !== false) throw fail(503, 'JXL_IO', 'The image job pointer was not acknowledged');
    }
    return job;
  };
  return Object.assign(service, {scope, host});
}

async function execution(service, ctx, id, selected) {
  const item = await service.calls.call(() => ctx.media.get(id));
  if (!item) throw fail(404, 'NOT_FOUND', 'The picture is missing');
  const archiveOriginals = (await archivePolicy(service, ctx)).admitting;
  return {...executionFor(service.host, selected, item, {archiveOriginals}), archiveOriginals};
}

async function archivePolicy(service, ctx) {
  // One read per request; every destructive archive arm independently checks the shared control CAS.
  service.originalsPolicy ??= storage().originals ? storage().originals.policy({signal: ctx.request?.signal,
    call: action => service.calls.call(action)}) : Promise.resolve({admitting: false});
  return service.originalsPolicy;
}

async function browserAdmission(service, ctx, {id, key, selected, expectedGeneration, expectedDeliveryRevision, automatic = false}) {
  const choice = await execution(service, ctx, id, selected);
  if (choice.location !== 'browser') return null;
  const media = storage(), signal = ctx.request?.signal, call = action => service.calls.call(action);
  const state = await media.deliveryState(key, {signal, call});
  if (!state || expectedGeneration !== undefined && (state.generation !== expectedGeneration || state.revision !== expectedDeliveryRevision))
    throw fail(409, 'key_changed', 'The picture or delivery setting changed');
  if (state.mode !== 'copies' || automatic && state.revision !== INITIAL_DELIVERY) return {skipped: true};
  const pointer = await mediaJobKey(service.scope, key, {generation: state.generation, deliveryRevision: state.revision});
  const previous = await call(() => ctx.kv.getVersioned(pointer)) ?? {value: null, revision: null};
  let prior = null;
  for (const jobId of pointerIds(previous.value)) {
    prior = await service.defer(jobId, choice);
    if (prior && !prior.done && !prior.canceled) return prior;
  }
  const saved = await call(() => ctx.kv.compareAndSet(pointer, previous.revision,
    {...previous.value, ...(prior && {id: prior.id}), execution: choice}));
  if (saved?.applied !== true && saved?.applied !== false) throw fail(503, 'JXL_IO', 'The browser work selection was not acknowledged');
  // A racing native admission owns the pointer. Refresh it instead of claiming that no server work remains.
  if (saved.applied === false) {
    const current = await call(() => ctx.kv.get(pointer));
    if (pointerIds(current).length) return pointerJob(service, current);
  }
  return {execution: choice, generation: state.generation, deliveryRevision: state.revision};
}
function jobRoute(request, permission, action, factory = runner) {
  return {methods: [request.body === 'none' ? 'GET' : 'POST'], request, permission,
    handler: async ctx => {
      try {
        return await action(await factory(ctx), ctx);
      } catch (error) {
        if (error instanceof PluginRouteError) throw error;
        const status = {JXL_INPUT: 400, JXL_OPTIONS: 400, JXL_POLICY_CHANGED: 409, JXL_BUSY: 409,
          JXL_LIMIT: 413, JXL_UNSUPPORTED: 422, JXL_IO: 503}[error?.code];
        if (status) throw new PluginRouteError(error.code, error.message, status);
        throw error;
      }
    }};
}
function target(ctx) {
  const query = new URL(ctx.request.url).searchParams, id = query.get('id'), key = query.get('key');
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/i.test(id ?? '') || !UPLOAD_KEY.test(key ?? ''))
    throw fail(400, 'media_id', 'Expected a media id and key');
  const replace = query.get('replace');
  if (replace !== null && replace !== 'true' && replace !== 'false') throw fail(400, 'JXL_OPTIONS', 'Expected replace=true or false');
  const expectedDeliveryRevision = query.get('deliveryRevision') ?? undefined;
  if (expectedDeliveryRevision !== undefined && !/^[a-f0-9]{32}$/.test(expectedDeliveryRevision))
    throw fail(400, 'JXL_OPTIONS', 'Expected the saved delivery revision');
  return {id, key, source: query.get('source'), expectedGeneration: query.get('generation') ?? undefined,
    expectedDeliveryRevision, replace: replace === 'true'};
}

export function inputResult(ctx) {
  const text = ctx.request.headers.get('x-rapier-result');
  if (!text || text.length > 8192) throw fail(400, 'JXL_INPUT', 'Expected a bounded result record');
  let metadata;
  try { metadata = JSON.parse(text); } catch { throw fail(400, 'JXL_INPUT', 'Invalid result record'); }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || 'bytes' in metadata)
    throw fail(400, 'JXL_INPUT', 'Send result metadata beside its byte body');
  return {...metadata, bytes: ctx.input};
}

// Attachment verifies the site's selected goal, never a fidelity supplied only by the request.
function floorOf(site) {
  if (site.exact) return 'exact';
  if (site.maxKilobytes > 0) return {quality: 1};
  return {quality: site.quality};
}
function selectedResult(ctx, site) {
  const result = inputResult(ctx);
  if (site.maxKilobytes && result.bytes?.byteLength > site.maxKilobytes * 1024)
    throw fail(422, 'JXL_TARGET', 'The copy exceeds the selected size limit');
  return result;
}

// Attachment compares this media identity with the captured storage generation.
async function bound(ctx, id, call = action => action()) {
  const file = await call(() => ctx.media.readBytes(id, {maxBytes: 16 * 1024 * 1024}));
  return digest(file.bytes);
}

// Native routes may use the supported runtime/repository API. Plugin MediaItem intentionally hides storageKey;
// neither a requested key nor its filename prefix establishes a relationship to the authenticated media ID.
async function nativeMediaItem(id) {
  const [{MediaRepository}, {getDb}] = await Promise.all([import('emdash'), import('emdash/runtime')]);
  return new MediaRepository(await getDb()).findById(id);
}
async function nativeMediaPage(cursor) {
  const [{MediaRepository}, {getDb}] = await Promise.all([import('emdash'), import('emdash/runtime')]);
  return new MediaRepository(await getDb()).findMany({mimeType: 'image/jpeg', status: 'ready', limit: 1,
    ...(cursor ? {cursor} : {})});
}
function binding(item, id, key) {
  if (!item || item.id !== id || item.status !== 'ready' || item.storageKey !== key ||
      !['image/jpeg', 'image/png'].includes(item.mimeType) ||
      (isJpegKey(key) ? item.mimeType !== 'image/jpeg' : !/\.png$/i.test(key) || item.mimeType !== 'image/png'))
    throw fail(409, 'key_changed', 'The picture is not the stored media item');
  // EmDash's computeContentHash uses sha1:<40 lowercase hex> for deduplication. It is a captured database identity
  // fence, not the request's SHA-256 and not a cryptographic fidelity proof.
  if (item.contentHash != null && !/^sha1:[a-f0-9]{40}$/.test(item.contentHash))
    throw fail(409, 'key_changed', 'The stored media identity is not supported');
  return JSON.stringify([item.id, item.storageKey, item.status, item.mimeType, item.size, item.contentHash ?? null]);
}
async function structuralCandidate(ctx, service, target, site, pointerKey, mediaItem, width) {
  const {id, key, source, expectedGeneration, expectedDeliveryRevision, replace} = target;
  if (!/^[a-f0-9]{64}$/.test(expectedGeneration ?? '') || !/^[a-f0-9]{32}$/.test(expectedDeliveryRevision ?? ''))
    throw fail(400, 'JXL_INPUT', 'Expected the captured source and delivery revision');
  const media = storage(), signal = ctx.request.signal, call = action => service.calls.call(action);
  const item = await call(() => mediaItem(id)), identity = binding(item, id, key);
  const result = selectedResult(ctx, site), selectedSettings = JSON.stringify(site);
  const fence = async () => {
    const current = await call(() => mediaItem(id));
    if (binding(current, id, key) !== identity) return 'key_changed';
    const pointer = await call(() => ctx.kv.get(pointerKey));
    const selected = settings(pointer?.execution?.settings ?? await call(() => ctx.kv.get('settings')));
    return JSON.stringify(selected) === selectedSettings ? null : 'settings_changed';
  };
  // Browser assurance remains result.browserVerification. Never forward any request value as `receipt`, or queue
  // server verification on Free. This operation can only create a generation-bound delivery copy.
  try {
    return await media.attachDelivery(key, result, {source, expectedGeneration, expectedDeliveryRevision,
      replace, settings: site, ...(width !== undefined && {width}), floor: floorOf(site), signal, call, fence});
  } catch (error) {
    if (error instanceof PluginRouteError) throw error;
    const status = {JXL_INPUT: 422, JXL_DIMENSIONS: 422, JXL_TARGET: 422, JXL_OPTIONS: 400,
      JXL_LIMIT: 413, JXL_UNSUPPORTED: 422, JXL_IO: 503}[error?.code];
    if (status) throw fail(status, error.code, error.message);
    throw error;
  }
}

async function pendingCandidate(ctx, width, mediaItem = nativeMediaItem) {
  if (width !== undefined && (!Number.isSafeInteger(width) || width < 16 || width > 8192))
    throw fail(422, 'JXL_DIMENSIONS', 'The responsive width must be from 16 to 8192.');
  const {id, key, source, expectedGeneration, expectedDeliveryRevision, replace} = target(ctx);
  const service = await runner(ctx), media = storage(), signal = ctx.request.signal;
  const call = action => service.calls.call(action);
  const pointerKey = await mediaJobKey(service.scope, key,
    {generation: expectedGeneration, deliveryRevision: expectedDeliveryRevision});
  const pointer = await call(() => ctx.kv.get(pointerKey));
  const site = settings(pointer?.execution?.settings ?? await call(() => ctx.kv.get('settings')));
  if (deliveryOnly(service.host)) return structuralCandidate(ctx, service,
    {id, key, source, expectedGeneration, expectedDeliveryRevision, replace}, site, pointerKey, mediaItem, width);
  const submitted = inputResult(ctx), original = width === undefined && isJpegKey(key) && submitted.kept === 'jpeg-bytes';
  const archive = original && (await archivePolicy(service, ctx)).admitting;
  const result = original ? submitted : selectedResult(ctx, site), exact = result.fidelity === 'exact' || result.fidelity?.maxError === 0;
  if (width !== undefined && (!Number.isSafeInteger(width) || width < 16 || result.width !== width))
    throw fail(422, 'JXL_DIMENSIONS', 'The responsive copy has the wrong width');
  if (result.fits !== true || !['jpeg-bytes', 'pixels', 'lossy'].includes(result.kept) ||
      !Number.isSafeInteger(result.width) || !Number.isSafeInteger(result.height) || result.width < 1 || result.height < 1 ||
      result.width * result.height > media.maxPixels || archive && !exact)
    throw fail(422, 'JXL_INPUT', 'Expected the selected image result');
  const floor = archive ? 'exact' : floorOf(site);
  if (!exact && (floor === 'exact' || !Number.isFinite(result.fidelity?.quality) || result.fidelity.quality > 100 ||
      result.fidelity.quality < floor.quality))
    throw fail(422, 'JXL_TARGET', 'The copy does not meet the selected fidelity');
  if (await bound(ctx, id, call) !== source) throw fail(409, 'key_changed', 'The picture changed');
  const before = await media.sourceHead(key, {signal, call}), selected = await media.deliveryState(key, {signal, call});
  if (!before || before.generation !== expectedGeneration || !selected || selected.generation !== expectedGeneration ||
      selected.revision !== expectedDeliveryRevision || selected.mode !== 'copies')
    throw fail(409, 'key_changed', 'The picture or delivery setting changed');
  if (original && !archive && site.maxKilobytes > 0 && result.bytes.byteLength > site.maxKilobytes * 1024)
    return {key, stored: null, reason: 'JXL_TARGET'};
  if (!archive && width === undefined && result.bytes.byteLength >= before.size)
    return {key, stored: null, reason: 'not_smaller'};
  const input = {generation: expectedGeneration, sha256: source, byteLength: before.size,
    deliveryRevision: expectedDeliveryRevision, kind: 'file'};
  // The candidate is staged under its own job's ID, so no part is shared with another job. The ID names the request
  // and the candidate's bytes, never its staged parts.
  const {bytes: candidateBytes, verification: ignoredReceipt, ...candidateMeta} = result;
  const byteLength = candidateBytes.byteLength, over = site.maxKilobytes > 0 && byteLength > site.maxKilobytes * 1024;
  const deliveryEligible = !over && byteLength < before.size;
  const shape = {kind: archive ? 'original' : width === undefined ? 'main' : 'variant', replace,
    floor, ...(width !== undefined && {width}), ...(archive && {deliveryEligible,
      deliveryReason: over ? 'JXL_TARGET' : deliveryEligible ? null : 'not_smaller'})};
  const jobId = (await digest(new TextEncoder().encode(JSON.stringify(['browser-candidate', service.scope, key, input, shape,
    JSON.parse(JSON.stringify(candidateMeta)), await digest(candidateBytes), byteLength])))).slice(0, 32);
  const prior = await service.status(jobId);
  if (prior) return {key, ...(width !== undefined && {width}), stored: 'pending', job: prior,
    ...(archive && {deliveryEligible, deliveryReason: shape.deliveryReason})};
  const store = createEmDashJobStore(ctx, {calls: service.calls, owner: jobId, readSource: (offset, length) =>
    media.readSource(key, offset, length, {generation: expectedGeneration, signal, call})});
  const staged = await stageCandidate(store, result, {signal});
  const candidate = {...staged, ...shape};
  const job = await service.queue({id: jobId, key, input, operation: archive ? 'recompress' : 'encode', options: {},
    settings: site, candidate, ...(site.maxKilobytes && {maxBytes: site.maxKilobytes * 1024})});
  return {key, ...(width !== undefined && {width}), stored: 'pending', job,
    ...(archive && {deliveryEligible, deliveryReason: candidate.deliveryReason})};
}

export async function libraryRow(store, {id, key}) {
  if (!UPLOAD_KEY.test(key ?? '')) return {id, key, state: 'external'};
  const family = await store.family(key), main = family.find(file => file.key === key);
  if (!main) return {id, key, state: 'missing'};
  const stored = family.reduce((bytes, file) => bytes + file.size, 0);
  const policy = await store.deliveryState(key);
  if (!policy) return hasSidecar(key) ? {id, key, state: 'missing'} :
    {id, key, widths: 0, original: main.size, delivery: main.size, saved: 0, stored, result: null, state: 'other'};
  const copies = await store.currentCopies(key);
  const variantWidths = [...new Set(copies.filter(file => file.kind === 'variant').map(file => file.width))].sort((a, b) => a - b);
  const widths = variantWidths.length;
  const archived = isJpegKey(key) ? await store.originals.info(key) : null;
  const archiveDelivery = archived?.archived && archived.deliveryEligible && policy.mode === 'copies' &&
    policy.revision === archived.deliveryRevision;
  // The reversible archive and selected delivery have independent lifetimes. The storage adapter chooses the
  // smallest eligible main result, including the archive when it satisfies this delivery revision.
  const side = hasSidecar(key) ? await store.sidecar(key) : null;
  const original = archived?.archived ? archived.originalBytes : main.size;
  const delivery = side?.bytes.length ?? (archiveDelivery ? archived.jxlBytes : original);
  const {bytes: ignored, ...result} = side ?? {};
  return {id, key, widths, variantWidths, original, delivery, saved: Math.max(0, original - delivery), stored,
    result: side ? result : null, generation: policy.generation, deliveryRevision: policy.revision, mode: policy.mode,
    state: policy.mode === 'original' ? 'original' : side ? 'sidecar' : isJpegKey(key) ? 'jpeg' : hasSidecar(key) ? 'plain' : 'other'};
}

// Queue a job on the stored original, bound to the media item's own bytes.
async function admit(service, ctx, {id, key, jobId, operation, options, maxBytes, delivery, settings: selected, automatic = false,
  expectedGeneration, expectedDeliveryRevision}) {
  const call = action => service.calls.call(action), signal = ctx.request?.signal;
  if (selected) {
    const browser = await browserAdmission(service, ctx, {id, key, selected, expectedGeneration, expectedDeliveryRevision, automatic});
    if (browser) return browser.skipped ? null : browser;
  }
  const snapshot = await storage().sourceSnapshot(key, {signal, call});
  // An explicit conversion or restore owns its fresh revision even if the upload hook was delayed.
  if (automatic && snapshot && (snapshot.delivery.mode !== 'copies' || snapshot.delivery.revision !== INITIAL_DELIVERY)) return null;
  if (!snapshot || snapshot.source.sha256 !== await bound(ctx, id, call)) throw fail(409, 'key_changed', 'The picture changed');
  if (expectedGeneration !== undefined && (snapshot.source.generation !== expectedGeneration ||
      snapshot.source.deliveryRevision !== expectedDeliveryRevision || snapshot.delivery.mode !== 'copies'))
    throw fail(409, 'key_changed', 'The picture or delivery setting changed');
  if (automatic) {
    const pointer = await mediaJobKey(service.scope, key, snapshot.source);
    const previous = await call(() => ctx.kv.get(pointer));
    if (/^[a-f0-9]{32}$/.test(previous?.id ?? '')) {
      const existing = await service.status(previous.id);
      if (existing) return existing;
    }
  }
  signal?.throwIfAborted();
  // The stored original is an encoded file: rapier-jxl/resumable decodes it in the job's own steps.
  const input = {...snapshot.source, kind: 'file'};
  jobId ??= (await digest(new TextEncoder().encode(JSON.stringify(['image', key, input.generation, input.deliveryRevision])))).slice(0, 32);
  return service.queue({id: jobId, key, operation, options, input, ...(maxBytes !== undefined && {maxBytes}),
    ...(delivery && {delivery}), ...(selected && {settings: selected})});
}

async function library(ctx, options = {}) {
  const service = await runner(ctx, options);
  return Object.assign(createLibraryRun(ctx, {scope: service.scope, service,
    prepare: async (item, selected, call) => {
      const browser = await browserAdmission(service, ctx, {id: item.id, key: item.key, selected});
      if (browser?.execution?.location === 'browser' || !serverImage(item.key)) return null;
      if (browser?.id && !browser.done && !browser.canceled) return {wait: true};
      const snapshot = await storage().sourceSnapshot(item.key, {signal: ctx.request?.signal, call});
      let seen;
      try { seen = await bound(ctx, item.id, call); } catch (error) {
        // Log the picture's stored state against the read time; the library retries this read with its back-off.
        const files = await storage().family(item.key).catch(() => []);
        console.warn('[rapier-media] media read failed', JSON.stringify({id: item.id, key: item.key, at: new Date().toISOString(),
          error: String(error?.message), files: files.map(({key, size, lastModified}) => ({key, size, lastModified}))}));
        throw error;
      }
      if (!snapshot || snapshot.source.sha256 !== seen)
        throw fail(409, 'key_changed', 'The picture changed');
      if (snapshot.delivery?.mode === 'original') return {skip: 'original', originalBytes: snapshot.source.byteLength};
      return {key: item.key, ...nativeOptions(selected, item.key, (await archivePolicy(service, ctx)).admitting),
        input: {...snapshot.source, kind: 'file'}};
    },
    validate: async (item, call) => {
      const state = await storage().deliveryState(item.key, {signal: ctx.request?.signal, call}), input = item.command.input;
      if (state?.generation !== input.generation) return 'key_changed';
      return state.mode !== 'copies' || state.revision !== input.deliveryRevision ? 'delivery_changed' : null;
    }}), {calls: service.calls});
}

async function originalsService(ctx, options = {}, {mediaItem = nativeMediaItem, mediaPage = nativeMediaPage} = {}) {
  const service = await runner(ctx, options), media = storage(), originals = media.originals;
  if (!originals) throw fail(422, 'JXL_UNSUPPORTED', 'Original storage requires the native conditional adapter.');
  const signal = ctx.request?.signal, call = action => service.calls.call(action);
  const read = () => originals.policy({signal, call});
  const status = async () => {
    const value = await read();
    if (value.available && value.phase !== 'idle') await service.work.schedule('originals', value.id);
    return value;
  };
  const resume = (id, {signal: advanceSignal = signal} = {}) => originals.advancePolicy({id,
    ms: options.ms ?? requestBudget(service.host), signal: advanceSignal, call,
    list: async cursor => {
      const page = await call(() => mediaPage(cursor));
      if (!page || !Array.isArray(page.items) || page.items.length > 1)
        throw fail(503, 'JXL_IO', 'The native media repository returned an invalid JPEG page.');
      return {items: page.items.map(item => ({id: item.id, key: item.storageKey,
        identity: binding(item, item.id, item.storageKey)})), ...(page.nextCursor && {nextCursor: page.nextCursor})};
    },
    prepare: async (item, {id: jobId, signal}) => {
      const row = await call(() => mediaItem(item.id));
      if (binding(row, item.id, item.key) !== item.identity) return {skip: 'key_changed'};
      const known = await originals.info(item.key, {signal, call});
      if (!known) return {skip: 'missing'};
      if (known.archived) return {skip: 'archived'};
      const selected = settings(await call(() => ctx.kv.get('settings')));
      const choice = executionFor(service.host, selected, row, {work: {
        operation: 'recompress', options: {effort: selected.effort}}});
      // Eligibility of the switch never relaxes the operation's independently certified CPU/memory admission.
      if (choice.location !== 'server') return {skip: 'browser_' + choice.reason};
      const snapshot = await media.sourceSnapshot(item.key, {signal, call});
      if (!snapshot || snapshot.source.generation !== known.generation ||
          binding(await call(() => mediaItem(item.id)), item.id, item.key) !== item.identity) return {skip: 'key_changed'};
      return {id: jobId, key: item.key, scope: service.scope, archiveOnly: true, operation: 'recompress',
        options: {effort: selected.effort}, input: {...snapshot.source, kind: 'file'}, settings: selected};
    },
    run: (command, advance) => service.resume(command, advance)});
  return {calls: service.calls, status, resume,
    async save(input) {
      if (!input || typeof input.enabled !== 'boolean' || !/^[a-f0-9]{32}$/.test(input.id ?? '') ||
          Object.keys(input).some(key => !['enabled', 'id'].includes(key)))
        throw fail(400, 'JXL_OPTIONS', 'Choose the originals policy using its current saved identity.');
      const current = await read();
      if (current.id !== input.id) throw fail(409, 'JXL_POLICY_CHANGED', 'The originals setting changed. Read its current progress.');
      if (input.enabled && !current.available) throw fail(422, 'JXL_UNSUPPORTED', 'This host must keep the original JPEG files.');
      if (current.desired === input.enabled && current.phase === 'idle') return current;
      const id = current.desired === input.enabled ? current.id : crypto.randomUUID().replaceAll('-', '');
      // The immutable scheduled intent comes first. A crash after the control CAS can never strand
      // an accepted switch transition, and an orphan intent simply sees a different policy ID.
      await service.work.schedule('originals', id);
      return originals.setPolicy({enabled: input.enabled, id, expectedId: input.id, signal, call});
    }};
}

function preferenceRoute(mediaItem = nativeMediaItem) {
  return {methods: ['POST'], request: {body: 'json', maxBytes: 4096}, permission: 'media:upload', handler: async ctx => {
    const {id, key, generation, deliveryRevision, mode, inheritSettings = false} = ctx.input ?? {};
    if (typeof id !== 'string' || !/^[0-9A-HJKMNP-TV-Z]{26}$/i.test(id) || typeof key !== 'string' || !UPLOAD_KEY.test(key) ||
        typeof generation !== 'string' || !/^[a-f0-9]{64}$/.test(generation) ||
        typeof deliveryRevision !== 'string' || !/^[a-f0-9]{32}$/.test(deliveryRevision) || !['original', 'copies'].includes(mode) ||
        typeof inheritSettings !== 'boolean')
      throw fail(400, 'JXL_INPUT', 'Expected the picture and its saved delivery revision');
    const media = storage();
    let capturedIdentity;
    if (deliveryOnly(media.host)) {
      capturedIdentity = binding(await mediaItem(id), id, key);
      const before = await media.physicalSourceHead(key, {signal: ctx.request.signal});
      const state = await media.deliveryState(key, {signal: ctx.request.signal});
      if (!before || before.generation !== generation || !state || state.generation !== generation || state.revision !== deliveryRevision)
        throw fail(409, 'key_changed', 'The picture or delivery setting changed');
    } else {
      const snapshot = await media.sourceSnapshot(key, {signal: ctx.request.signal});
      if (!snapshot || snapshot.source.generation !== generation || snapshot.source.deliveryRevision !== deliveryRevision ||
          snapshot.source.sha256 !== await bound(ctx, id)) throw fail(409, 'key_changed', 'The picture changed');
    }
    try {
      const state = await media[mode === 'original' ? 'restoreOriginal' : 'resumeCopies'](key,
        {expectedGeneration: generation, expectedRevision: deliveryRevision, signal: ctx.request.signal});
      if (capturedIdentity !== undefined && binding(await mediaItem(id), id, key) !== capturedIdentity)
        throw fail(409, 'key_changed', 'The picture changed');
      let captured;
      if (mode === 'copies') {
        const service = await runner(ctx), call = action => service.calls.call(action);
        const oldKey = await mediaJobKey(service.scope, key, {generation, deliveryRevision});
        const prior = inheritSettings ? await call(() => ctx.kv.get(oldKey)) : null;
        const site = settings(prior?.execution?.settings ?? await call(() => ctx.kv.get('settings')));
        captured = await execution(service, ctx, id, site);
        const pointer = await mediaJobKey(service.scope, key, {generation: state.generation, deliveryRevision: state.revision});
        const saved = await call(() => ctx.kv.compareAndSet(pointer, null, {execution: captured}));
        if (saved?.applied === false) captured = {...((await call(() => ctx.kv.get(pointer)))?.execution ?? captured),
          archiveOriginals: (await archivePolicy(service, ctx)).admitting};
        else if (saved?.applied !== true) throw fail(503, 'JXL_IO', 'The selected conversion settings were not acknowledged');
      }
      return {generation: state.generation, mode: state.mode, deliveryRevision: state.revision,
        ...(captured && {execution: captured})};
    } catch (error) {
      if (error?.code === 'JXL_INPUT') throw fail(409, 'key_changed', error.message);
      const status = {JXL_UNSUPPORTED: 422, JXL_IO: 503}[error?.code];
      if (status) throw fail(status, error.code, error.message);
      throw error;
    }
  }};
}

// Native uploads resume the selected PNG goal. JPEGs keep their bytes until the shared server reader supplies pixels.
const FILE_URL = /\/_emdash\/api\/media\/file\/([0-9A-HJKMNP-TV-Z]{26}(?:\.[0-9A-HJKMNP-TV-Z]{26})*\.[a-z0-9]{1,8})$/i;
export async function afterUpload(event, ctx) {
  const {id, url} = event?.media ?? {}, key = FILE_URL.exec(typeof url === 'string' ? url : '')?.[1];
  if (!key || !serverImage(key) || !/^[0-9A-HJKMNP-TV-Z]{26}$/i.test(id ?? '')) return null;
  const service = await runner(ctx), site = settings(await service.calls.call(() => ctx.kv.get('settings')));
  return admit(service, ctx, {id, key, ...nativeOptions(site, key, (await archivePolicy(service, ctx)).admitting), automatic: true});
}

const nodePumps = new WeakMap();
async function scheduled(event, ctx, repositories) {
  const media = storage(), platform = media.originals.platform;
  if (platform === 'node' && nodePumps.has(media)) return nodePumps.get(media);
  const run = async () => {
    const service = await runner(ctx);
    return runBackground({event, platform, scope: service.scope, work: service.work,
      wakeMs: requestBudget(service.host, true), stepMs: requestBudget(service.host), cpuLimitMs: service.host.cpuLimitMs,
      runner: options => runner(ctx, options), library: options => library(ctx, options),
      originals: options => originalsService(ctx, options, repositories)});
  };
  if (platform !== 'node') return run();
  const pending = run(); nodePumps.set(media, pending);
  try { return await pending; } finally { if (nodePumps.get(media) === pending) nodePumps.delete(media); }
}

export function createPlugin({mediaItem = nativeMediaItem, mediaPage = nativeMediaPage} = {}) {
  if ([mediaItem, mediaPage].some(value => typeof value !== 'function'))
    throw new TypeError('Native media identity uses server repository readers.');
  const originalPolicy = (ctx, options) => originalsService(ctx, options, {mediaItem, mediaPage});
  return definePlugin({id: ID, version: VERSION, capabilities: ['media:read', 'media:bytes:read'], admin: ADMIN,
    storage: {...EMDASH_JOB_STORAGE, ...LIBRARY_STORAGE, ...WORK_STORAGE},
    // EmDash's timeout races the handler without canceling it. The pump owns the real host deadline (every wake ends at
    // its allowance); this largest valid JavaScript timer never cuts a wake short behind a retry.
    hooks: {cron: {handler: (event, ctx) => scheduled(event, ctx, {mediaItem, mediaPage}), timeout: 0x7fffffff},
      'media:afterUpload': afterUpload},
    routes: {
      available: {methods: ['GET'], request: {body: 'none'}, public: true, handler: async () => ({available: true})},
      'originals-policy': jobRoute({body: 'none'}, 'media:read', run => run.status(), originalPolicy),
      'save-originals-policy': jobRoute({body: 'json', maxBytes: 512}, 'media:upload',
        (run, ctx) => run.save(ctx.input), originalPolicy),
      'originals-advance': jobRoute({body: 'json', maxBytes: 256}, 'media:upload', async (run, ctx) => {
        const value = await run.resume(ctx.input?.id);
        if (!value) throw fail(409, 'JXL_POLICY_CHANGED', 'The originals setting changed. Read its current progress.');
        return value;
      }, originalPolicy),
      'removal-start': jobRoute({body: 'json', maxBytes: 1024}, 'plugins:manage',
        (originals, ctx) => originals.beginRemoval(ctx.input ?? {}), () => storage().originals),
      'removal-advance': jobRoute({body: 'json', maxBytes: 1024}, 'plugins:manage',
        (originals, ctx) => originals.advanceRemoval(ctx.input ?? {}), () => storage().originals),
      'removal-status': jobRoute({body: 'none'}, 'plugins:manage',
        originals => originals.removalStatus(), () => storage().originals),
      'library-start': jobRoute({body: 'json', maxBytes: 4096}, 'media:upload', async (run, ctx) =>
        run.start({...ctx.input, settings: settings(await run.calls.call(() => ctx.kv.get('settings')))}), library),
      'library-append': jobRoute({body: 'json', maxBytes: 64 * 1024}, 'media:upload', (run, ctx) => run.append(ctx.input ?? {}), library),
      'library-run': jobRoute({body: 'json', maxBytes: 256}, 'media:upload', (run, ctx) => run.control(ctx.input ?? {}), library),
      'library-advance': jobRoute({body: 'json', maxBytes: 256}, 'media:upload', (run, ctx) => run.advance(ctx.input?.id), library),
      'library-status': jobRoute({body: 'none'}, 'media:read', run => run.status(), library),
      delivery: preferenceRoute(mediaItem),
      'media-convert': jobRoute({body: 'json', maxBytes: 1024}, 'media:upload', async (service, ctx) => {
        const {id, key, generation, deliveryRevision} = ctx.input ?? {};
        if (typeof id !== 'string' || !/^[0-9A-HJKMNP-TV-Z]{26}$/i.test(id) || typeof key !== 'string' ||
            !UPLOAD_KEY.test(key) || !serverImage(key) || typeof generation !== 'string' || !/^[a-f0-9]{64}$/.test(generation) ||
            typeof deliveryRevision !== 'string' || !/^[a-f0-9]{32}$/.test(deliveryRevision))
          throw fail(400, 'JXL_INPUT', 'Choose a stored JPEG or PNG and its saved delivery revision');
        const pointer = await mediaJobKey(service.scope, key, {generation, deliveryRevision});
        const captured = await service.calls.call(() => ctx.kv.get(pointer));
        const site = settings(captured?.execution?.settings ?? await service.calls.call(() => ctx.kv.get('settings')));
        return admit(service, ctx, {id, key, expectedGeneration: generation,
          expectedDeliveryRevision: deliveryRevision, ...nativeOptions(site, key, (await archivePolicy(service, ctx)).admitting)});
      }),
      'job-start': jobRoute({body: 'json', maxBytes: 4096}, 'media:upload', async (service, ctx) => {
        const {id, key, jobId, operation, options} = ctx.input ?? {};
        if (typeof id !== 'string' || !/^[0-9A-HJKMNP-TV-Z]{26}$/i.test(id) || typeof key !== 'string' || !UPLOAD_KEY.test(key) ||
            typeof jobId !== 'string' || !/^[a-f0-9]{32}$/.test(jobId) || !['encode', 'fit', 'recompress'].includes(operation) ||
            options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options)))
          throw fail(400, 'JXL_INPUT', 'Expected a media id, storage key and image job id');
        const site = settings(await service.calls.call(() => ctx.kv.get('settings')));
        const item = await service.calls.call(() => ctx.media.get(id));
        if (!item) throw fail(404, 'NOT_FOUND', 'The picture is missing');
        const policy = executionFor(service.host, {...site, effort: options?.effort ?? site.effort}, item,
          {work: {operation, options: {...options, effort: options?.effort ?? site.effort}}});
        if (policy.location === 'browser')
          throw fail(422, 'JXL_UNSUPPORTED', 'This host requires the selected browser conversion route for this picture.');
        return admit(service, ctx, {id, key, jobId, operation, options});
      }),
      'job-status': jobRoute({body: 'none'}, 'media:read', (service, ctx) =>
        service.status(new URL(ctx.request.url).searchParams.get('job'))),
      'job-advance': jobRoute({body: 'json', maxBytes: 256}, 'media:upload', (service, ctx) =>
        service.advance(ctx.input?.job, {signal: ctx.request.signal})),
      'job-cancel': jobRoute({body: 'json', maxBytes: 256}, 'media:upload', (service, ctx) => service.cancel(ctx.input?.job)),
      settings: {methods: ['GET'], request: {body: 'none'}, permission: 'media:read',
        handler: async ctx => settings(await ctx.kv.get('settings'))},
      'save-settings': {methods: ['POST'], request: {body: 'json', maxBytes: 4096}, permission: 'media:upload', handler: async ctx => {
        const value = settings(ctx.input); await ctx.kv.set('settings', value); return value;
      }},
      library: {methods: ['POST'], request: {body: 'json', maxBytes: 64 * 1024}, permission: 'media:read', handler: async ctx => {
        const items = ctx.input?.items;
        if (!Array.isArray(items) || items.length > 8 || items.some(item =>
            !item || typeof item !== 'object' || Array.isArray(item) ||
            typeof item.id !== 'string' || !/^[0-9A-HJKMNP-TV-Z]{26}$/i.test(item.id) ||
            item.key != null && typeof item.key !== 'string'))
          throw fail(400, 'library_page', 'Send at most 8 media item records');
        const rows = [], service = await runner(ctx), selected = settings(await service.calls.call(() => ctx.kv.get('settings')));
        for (const item of items) {
          const row = await libraryRow(storage(), item);
          const pointer = row.generation && row.deliveryRevision
            ? await ctx.kv.get(await mediaJobKey(service.scope, item.key, row)) : null;
          const {job, pendingWidths} = await pointerState(service, pointer);
          // A job that ended by handing its picture to the browser says so, whatever the pointer recorded at admission.
          const choice = (job?.execution?.location === 'browser' ? job.execution : job && !job.done && !job.canceled ? job.execution : pointer?.execution ?? job?.execution) ??
            await execution(service, ctx, item.id, selected);
          rows.push({...row, pendingWidths, execution: {...choice, archiveOriginals: (await archivePolicy(service, ctx)).admitting},
            nativeJob: job ? {id: job.id} : null});
        }
        return {items: rows};
      }},
      variant: {methods: ['POST'], request: {body: 'bytes', maxBytes: MAX_BYTES}, permission: 'media:upload', handler: ctx =>
        pendingCandidate(ctx, Number(new URL(ctx.request.url).searchParams.get('width')), mediaItem)},
      attach: {methods: ['POST'], request: {body: 'bytes', maxBytes: MAX_BYTES}, permission: 'media:upload',
        handler: ctx => pendingCandidate(ctx, undefined, mediaItem)}
    }});
}
