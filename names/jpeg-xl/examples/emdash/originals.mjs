import {readAll} from 'jpeg-xl/storage';
import {restore} from 'jpeg-xl/jpeg';
import * as resumable from 'jpeg-xl/resumable';
import {verify} from 'jpeg-xl/verify';
import {digest} from './digest.mjs';
import {ENVELOPE_BYTES, ENVELOPE_PREFIX_BYTES, envelopeIdentity, wrapOriginal, unwrapOriginal} from './original-envelope.mjs';

const ROOT = '__rapier_jxl__/', OWNER = 'rapier-jxl/emdash';
const CONTROL = ROOT + 'originals.control.json', RECORDS = ROOT + 'originals.record.', RESTORES = ROOT + 'originals.restore.';
const ID = /^[a-f0-9]{32}$/, HASH = /^[a-f0-9]{64}$/, SHA = /^sha256:[a-f0-9]{64}$/;
const MAX_JSON = 32 * 1024, MAX_PART = 1024 * 1024, direct = action => action();
// Public readAll owns at most 256 MiB, including the private ownership envelope.
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024 - ENVELOPE_BYTES;
const utf8 = value => new TextEncoder().encode(value), uuid = () => crypto.randomUUID().replaceAll('-', '');
const fail = (code, message, cause) => Object.assign(new Error(message, cause ? {cause} : undefined), {code});
const jpeg = key => typeof key === 'string' && /\.(?:jpe?g|jpe|jfif)$/i.test(key) && !key.startsWith(ROOT) &&
  !key.includes('\\') && !key.includes('\0') && !key.split('/').some(part => !part || part === '.' || part === '..');
const cancel = body => { try { Promise.resolve(body?.cancel?.()).catch(() => {}); } catch {} };
const errorValue = (error, key) => ({code: error?.code ?? 'JXL_INTERNAL', message: String(error?.message ?? error), key});
const generation = file => typeof file?.version === 'string' && file.version ? digest(utf8(file.version)) : null;

// These capabilities are private adapter operations, never methods supplied by an HTTP request.
// Only a definitive control-CAS winner may dispatch an archive replacement. A saved "writing"
// state is NOT a lease and is never re-dispatched or expired: an acknowledgement or its unique
// marker is required to drain it. Losing that proof blocks removal without risking an original.
export function originalStorage(inner, {platform, scope, create, compareAndSet, head, replace,
  cache, maxInputBytes, maxPixels, delivery, preserveDelivery, maxDeliveryBytes = 8 * 1024 * 1024,
  allowRetirement = platform === 'node', driver = resumable, restoreOperation = restore} = {}) {
  if (!['node', 'cloudflare'].includes(platform) || typeof scope !== 'string' || !scope ||
      [create, compareAndSet, head, replace, delivery].some(value => typeof value !== 'function'))
    throw fail('JXL_OPTIONS', 'Original archives require the native conditional storage capabilities.');
  if (typeof restoreOperation !== 'function' || ['start', 'advance', 'finish'].some(name => typeof driver?.[name] !== 'function'))
    throw fail('JXL_OPTIONS', 'Original reconstruction requires the shared resumable driver and restore operation.');
  if (typeof allowRetirement !== 'boolean') throw fail('JXL_OPTIONS', 'Original retirement requires an explicit native host policy.');
  // A create-only write answers true, false, or {created: true, version} (the stored object's own version, used by copy
  // attach). Every original and archive write here reads only whether it created the object.
  const createWithVersion = create;
  create = async (...args) => { const answer = await createWithVersion(...args); return answer?.created === true ? true : answer; };
  if (preserveDelivery !== undefined && typeof preserveDelivery !== 'function')
    throw fail('JXL_OPTIONS', 'Original delivery preservation requires a private storage callback.');
  if (!Number.isSafeInteger(maxDeliveryBytes) || maxDeliveryBytes < 1 || maxDeliveryBytes > MAX_ARCHIVE_BYTES + ENVELOPE_BYTES)
    throw fail('JXL_OPTIONS', 'Original delivery preservation requires the native copy byte allowance.');

  async function dispatch(action, {signal, call = direct} = {}) {
    signal?.throwIfAborted();
    // Do not throw cancellation after a mutation has acknowledged its result. The caller must
    // persist that acknowledgement before respecting cancellation on its next operation.
    return call(action);
  }
  async function read(key, maxBytes, options = {}) {
    let file;
    try { file = await dispatch(() => inner.download(key, {signal: options.signal}), options); }
    catch (error) { if (error?.code === 'NOT_FOUND') return null; throw error; }
    const bytes = await readAll(file.body, {maxBytes, signal: options.signal});
    if (file.size !== bytes.length) throw fail('JXL_INPUT', 'Stored archive data has the wrong length.');
    return {...file, bytes};
  }
  async function json(key, options) {
    const file = await read(key, MAX_JSON, options);
    if (!file) return null;
    let value;
    try { value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(file.bytes)); }
    catch { throw fail('JXL_INPUT', 'An original archive record is not valid JSON.'); }
    return {value, etag: file.etag, size: file.size};
  }
  async function cas(key, previous, value, options = {}) {
    const bytes = utf8(JSON.stringify(value));
    if (bytes.length > MAX_JSON) throw fail('JXL_LIMIT', 'An original archive record exceeds its byte limit.');
    return dispatch(() => compareAndSet(key, bytes, {etag: previous?.etag ?? null,
      contentType: 'application/json', signal: options.signal}), options);
  }
  function validControl(value) {
    return value?.owner === OWNER && value.kind === 'originals-control' && value.scope === scope &&
      ID.test(value.siteId ?? '') && ID.test(value.revision ?? '') && ['enabled', 'retiring'].includes(value.mode) &&
      validPolicy(value.policy) &&
      (value.writer === null || ID.test(value.writer?.id ?? '') && typeof value.writer.key === 'string' &&
        ['archive', 'mutation', 'restore'].includes(value.writer.kind) && ['prepared', 'writing', 'cleaning', 'blocked'].includes(value.writer.phase) &&
        (value.writer.kind !== 'restore' || ID.test(value.writer.archive ?? ''))) &&
      (value.mode === 'enabled' ? value.removal === null : ID.test(value.removal?.id ?? '') &&
        ['policy', 'uninstall'].includes(value.removal.purpose) &&
        ['draining', 'restoring', 'verifying', 'complete', 'blocked'].includes(value.removal.phase) &&
        Number.isSafeInteger(value.removal.restored) && value.removal.restored >= 0 &&
        (value.removal.remaining === null || Number.isSafeInteger(value.removal.remaining) && value.removal.remaining >= 0) &&
        (value.removal.phase !== 'complete' || value.removal.remaining === 0 && value.writer === null));
  }
  function validPolicy(value) {
    return value && ID.test(value.id ?? '') && typeof value.enabled === 'boolean' && typeof value.desired === 'boolean' &&
      ['idle', 'restoring', 'archiving'].includes(value.phase) &&
      (value.cursor === null || typeof value.cursor === 'string' && !!value.cursor) &&
      ['processed', 'archived', 'kept', 'failed'].every(name => Number.isSafeInteger(value[name]) && value[name] >= 0) &&
      value.processed === value.archived + value.kept + value.failed &&
      (value.current === null || typeof value.current === 'object' && !Array.isArray(value.current) &&
        ID.test(value.current.jobId ?? '') && typeof value.current.item?.id === 'string' && jpeg(value.current.item.key) &&
        (value.current.nextCursor === null || typeof value.current.nextCursor === 'string' && !!value.current.nextCursor) &&
        (value.current.stage === 'prepare' && value.current.command === null || value.current.stage === 'run' &&
          value.current.command?.archiveOnly === true && value.current.command.id === value.current.jobId &&
          value.current.command.key === value.current.item.key)) &&
      (value.phase === 'archiving' ? value.enabled && value.desired : value.phase === 'restoring' ? value.enabled && !value.desired
        : value.enabled === value.desired && value.current === null);
  }
  const newPolicy = (enabled, id = uuid()) => ({id, enabled, desired: enabled, phase: enabled ? 'archiving' : 'idle',
    cursor: null, current: null, processed: 0, archived: 0, kept: 0, failed: 0, last: null, error: null});
  async function control(options = {}, initialize = true) {
    let saved = await json(CONTROL, options);
    if (!saved && initialize) {
      const value = {owner: OWNER, kind: 'originals-control', siteId: uuid(), scope,
        revision: uuid(), mode: 'enabled', writer: null, removal: null, policy: newPolicy(allowRetirement)};
      let uncertain;
      try { await cas(CONTROL, null, value, options); } catch (error) { uncertain = error; }
      saved = await json(CONTROL, options);
      if (!saved && uncertain) throw uncertain;
    }
    if (saved && !validControl(saved.value)) throw fail('JXL_INPUT', 'Original archive control is invalid; removal remains disabled.');
    if (!saved && initialize) throw fail('JXL_INTERNAL', 'Original archive control could not be created.');
    return saved;
  }
  async function updateControl(saved, mutate, options = {}) {
    const value = {...structuredClone(saved.value), revision: uuid()};
    mutate(value);
    const written = await cas(CONTROL, saved, value, options);
    return written === true ? value : null;
  }
  const recordKey = async (key, id) => RECORDS + await digest(utf8(key)) + '.' + id + '.json';
  const candidateKey = async (key, id) => ROOT + 'originals.payload.' + await digest(utf8(key)) + '.' + id + '.jxl';
  function validRecord(value) {
    return value?.owner === OWNER && value.kind === 'jpeg-original' && jpeg(value.source) && ID.test(value.id ?? '') &&
      HASH.test(value.generation ?? '') && HASH.test(value.sourceSha256 ?? '') && HASH.test(value.outputSha256 ?? '') &&
      typeof value.sourceVersion === 'string' && value.sourceVersion && typeof value.sourceEtag === 'string' && value.sourceEtag &&
      typeof value.sourcePhysicalVersion === 'string' && value.sourcePhysicalVersion &&
      typeof value.sourcePhysicalEtag === 'string' && value.sourcePhysicalEtag &&
      Number.isSafeInteger(value.originalBytes) && value.originalBytes > 0 && value.originalBytes <= maxInputBytes &&
      Number.isSafeInteger(value.jxlBytes) && value.jxlBytes > 0 && value.jxlBytes <= maxInputBytes &&
      ID.test(value.deliveryRevision ?? '') && typeof value.deliveryEligible === 'boolean' && typeof value.storageOnly === 'boolean' &&
      !(value.storageOnly && value.deliveryEligible) &&
      typeof value.staged === 'boolean' && ['prepared', 'writing', 'complete', 'blocked'].includes(value.staging) &&
      ['prepared', 'active', 'refused', 'restored'].includes(value.state) &&
      value.result?.format === 'jxl' && value.result.kept === 'jpeg-bytes' && value.result.fidelity === 'exact' &&
      Number.isSafeInteger(value.result.width) && Number.isSafeInteger(value.result.height) &&
      value.result.width > 0 && value.result.height > 0 && value.result.width * value.result.height <= maxPixels;
  }
  async function owned(key, id, options = {}) {
    const saved = await json(await recordKey(key, id), options);
    if (saved && (!validRecord(saved.value) || saved.value.source !== key || saved.value.id !== id ||
        saved.value.candidate !== await candidateKey(key, id)))
      throw fail('JXL_INPUT', 'The JPEG archive ownership record is invalid.');
    return saved;
  }
  async function updateRecord(saved, mutate, options = {}) {
    const value = structuredClone(saved.value); mutate(value);
    return await cas(await recordKey(value.source, value.id), saved, value, options) === true ? value : null;
  }
  async function physical(key, options = {}, retry = true) {
    let file;
    try { file = await dispatch(() => head(key, {signal: options.signal}), options); }
    catch (error) { if (error?.code === 'NOT_FOUND') return null; throw error; }
    if (!file) return null;
    if (!jpeg(key)) return {file, record: null, archived: false};
    let id = file.originalId, archived = file.representation === 'jxl';
    if (!ID.test(id ?? '')) {
      const prefix = await dispatch(() => inner.download(key, {range: {offset: 0, length: Math.min(file.size, ENVELOPE_PREFIX_BYTES)},
        signal: options.signal}), options);
      const bytes = await readAll(prefix.body, {maxBytes: ENVELOPE_PREFIX_BYTES, signal: options.signal});
      if (prefix.version !== file.version) {
        if (retry) return physical(key, options, false);
        throw fail('JXL_INPUT', 'The stored original changed during its read.');
      }
      const marker = envelopeIdentity(bytes);
      if (!marker) return {file, record: null, archived: false};
      id = marker.id; archived = true;
    }
    const saved = await owned(key, id, options), record = saved?.value;
    if (!record || archived && file.size !== record.jxlBytes + ENVELOPE_BYTES || !archived && file.size !== record.originalBytes)
      throw fail('JXL_INPUT', 'The stored JPEG representation has no matching ownership record.');
    if (archived && record.state === 'refused')
      throw fail('JXL_INPUT', 'A refused archive identity unexpectedly owns the source.');
    return {file, record, archived};
  }
  function logical(found) {
    if (!found) return null;
    const {file, record, archived} = found;
    return record ? {...file, size: record.originalBytes, contentType: 'image/jpeg',
      lastModified: record.lastModified ? new Date(record.lastModified) : undefined,
      etag: record.sourceEtag, version: record.sourceVersion, physicalVersion: file.version,
      archived, archiveId: record.id, sourceSha256: record.sourceSha256} : {...file, archived: false};
  }
  async function archivePayload(found, options = {}) {
    const file = await read(found.record.source, found.record.jxlBytes + ENVELOPE_BYTES, options);
    if (!file || file.version !== found.file.version) throw fail('JXL_INPUT', 'The archived original changed during its read.');
    return unwrapOriginal(file.bytes, found.record.id, found.record.jxlBytes);
  }
  const restoreKey = record => RESTORES + record.id + '.json';
  const restoreParts = (record, run = '') => RESTORES + record.id + '.' + (run ? run + '.' : '');
  const cacheKey = record => `${record.generation}.${record.sourceSha256}`;
  async function cachedOriginal(record, options) {
    const bytes = await cache?.get(cacheKey(record), {signal: options.signal});
    return bytes instanceof Uint8Array && bytes.length === record.originalBytes && await digest(bytes) === record.sourceSha256 ? bytes : null;
  }
  async function restoreState(record, options) {
    const saved = await json(restoreKey(record), options), value = saved?.value;
    if (value && (value.owner !== OWNER || value.kind !== 'jpeg-rebuild' || value.archive !== record.id ||
        value.source !== record.source || value.sha256 !== record.outputSha256 || !ID.test(value.run ?? '') ||
        !ID.test(value.revision ?? '') || !['running', 'cached', 'blocked'].includes(value.phase) ||
        typeof value.done !== 'boolean' || typeof value.version !== 'string' || !value.version ||
        value.checkpoint !== null && (typeof value.checkpoint !== 'object' || Array.isArray(value.checkpoint))))
      throw fail('JXL_INPUT', 'The original reconstruction checkpoint is invalid.');
    return saved;
  }
  async function saveRestore(record, saved, value, options) {
    value = {...value, revision: uuid()};
    try { return await cas(restoreKey(record), saved, value, options) === true; }
    catch (error) {
      // Immutable parts are saved first. Resolve a lost checkpoint acknowledgement by its
      // unique commit identity; never return an unacknowledged checkpoint to the caller.
      const actual = await restoreState(record, {...options, signal: undefined});
      if (actual?.value.revision === value.revision) return true;
      throw error;
    }
  }
  async function cleanRestoreParts(record, run, options) {
    const prefix = restoreParts(record, run);
    const page = await dispatch(() => inner.list({prefix, limit: 32, signal: options.signal}), options);
    for (const file of page.files) {
      if (!file.key.startsWith(prefix) || !file.key.endsWith('.part'))
        throw fail('JXL_INPUT', 'Original reconstruction cleanup found an unexpected object.');
      await dispatch(() => inner.delete(file.key, {signal: options.signal}), options);
    }
    return !page.nextCursor;
  }
  async function releaseRestore(record, run, options) {
    let saved = await restoreState(record, options);
    if (!saved) return true;
    if (saved.value.run !== run) return false;
    if (saved.value.phase !== 'cached') {
      if (!await saveRestore(record, saved, {...saved.value, phase: 'cached', done: true}, options)) return false;
      saved = await restoreState(record, options);
    }
    if (!saved || saved.value.run !== run) return false;
    if (saved.value.cleaned) return true;
    if (await cleanRestoreParts(record, run, options))
      return saveRestore(record, saved, {...saved.value, cleaned: true}, options);
    return false;
  }
  function restoreStore(found, run, options) {
    const {record, file: original} = found;
    async function range(offset, length) {
      const file = await dispatch(() => inner.download(record.source, {range: {offset, length}, signal: options.signal}), options);
      try {
        if (file.version !== original.version || file.size !== original.size)
          throw fail('JXL_INPUT', 'The archived original changed during reconstruction.');
        if (file.range?.offset !== offset || file.range.length !== length)
          throw fail('JXL_UNSUPPORTED', 'Original reconstruction requires native source ranges.');
        const bytes = await readAll(file.body, {maxBytes: length, signal: options.signal});
        if (bytes.length !== length) throw fail('JXL_INPUT', 'The archived original range is truncated.');
        return bytes;
      } catch (error) { cancel(file.body); throw error; }
    }
    // A request-local prefix read projects out the ownership box. The public operation sees
    // exactly the verified JXL payload, and its source hash still checks every byte it reads.
    let marker;
    const identity = async () => marker ??= (async () => {
      const value = envelopeIdentity(await range(0, Math.min(original.size, ENVELOPE_PREFIX_BYTES)));
      if (!value || value.id !== record.id) throw fail('JXL_INPUT', 'The original reconstruction identity changed.');
      return value;
    })();
    const partKey = ref => {
      if (!HASH.test(ref?.hash ?? '') || !Number.isSafeInteger(ref.length) || ref.length < 0 || ref.length > MAX_PART)
        throw fail('JXL_INPUT', 'Original reconstruction parts are immutable values of at most 1 MiB.');
      return restoreParts(record, run) + ref.hash + '.part';
    };
    const readPart = async ref => {
      const file = await read(partKey(ref), MAX_PART, options);
      if (!file || file.bytes.length !== ref.length) throw fail('JXL_IO', 'An original reconstruction part is missing.');
      return file.bytes;
    };
    const writePart = async (ref, bytes) => {
      const key = partKey(ref);
      if (!(bytes instanceof Uint8Array) || bytes.length !== ref.length)
        throw fail('JXL_INPUT', 'An original reconstruction part has the wrong length.');
      const created = await dispatch(() => create(key, bytes, {contentType: 'application/octet-stream', signal: options.signal}), options);
      if (created !== true && created !== false) throw fail('JXL_IO', 'The original reconstruction part write was not acknowledged.');
    };
    return {
      async readSource(offset, length) {
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 ||
            offset > record.jxlBytes - length) throw fail('JXL_INPUT', 'The original reconstruction source range is invalid.');
        const {offset: insertion} = await identity(), left = Math.max(0, Math.min(length, insertion - offset));
        const bytes = new Uint8Array(length);
        if (left) bytes.set(await range(offset, left));
        if (left < length) bytes.set(await range(offset + left + ENVELOPE_BYTES, length - left), left);
        return bytes;
      },
      read: readPart,
      readMany: refs => Promise.all(refs.map(readPart)),
      write: writePart,
      async writeMany(parts) { for (const {ref, bytes} of parts) await writePart(ref, bytes); },
    };
  }
  async function restoreAdvance(found, {ms = 5000, ...options} = {}) {
    if (!Number.isFinite(ms) || ms <= 0 || ms > 60000) throw fail('JXL_OPTIONS', 'Original reconstruction uses an advance budget from 1 to 60000 ms.');
    const {record} = found, cached = await cachedOriginal(record, options);
    if (cached) return {done: true, bytes: cached, cached: true};
    let saved = await restoreState(record, options);
    if (saved?.value.phase === 'cached') {
      // Cache eviction starts a new run, never a checkpoint whose parts were collected.
      if (!saved.value.cleaned && !await cleanRestoreParts(record, saved.value.run, options)) return {done: false};
      if (!await saveRestore(record, saved, {...saved.value, run: uuid(), phase: 'running', checkpoint: null,
        version: found.file.version, done: false, cleaned: false, error: null}, options)) return {done: false};
      saved = await restoreState(record, options);
    }
    if (!saved) {
      await saveRestore(record, null, {owner: OWNER, kind: 'jpeg-rebuild', archive: record.id, source: record.source,
        sha256: record.outputSha256, version: found.file.version, run: uuid(), phase: 'running',
        checkpoint: null, done: false, cleaned: false, error: null}, options);
      return {done: false};
    }
    const job = saved.value;
    if (job.version !== found.file.version) throw fail('JXL_INPUT', 'The archived source generation changed during reconstruction.');
    if (job.phase === 'blocked') throw fail(job.error?.code ?? 'JXL_INPUT', job.error?.message ?? 'Original reconstruction is blocked.');
    const input = {generation: record.id, sha256: record.outputSha256, byteLength: record.jxlBytes, kind: 'file'};
    const store = restoreStore(found, job.run, options), common = {operation: restoreOperation, input, store, verify, signal: options.signal};
    let checkpoint, done = false;
    try {
      if (!job.checkpoint) checkpoint = await driver.start({...common, options: {maxPixels}});
      else if (!job.done) ({checkpoint, done} = await driver.advance(job.checkpoint, {...common, budget: {ms}}));
      else {
        const result = await driver.finish(job.checkpoint, common), receipt = result?.verification;
        if (!(result?.bytes instanceof Uint8Array) || result.bytes.length !== record.originalBytes || result.format !== 'jpeg' ||
            result.kept !== 'jpeg-bytes' || result.fidelity !== 'exact' || receipt?.verified !== true ||
            receipt.kind !== 'jpeg-restore' || receipt.format !== 'jpeg' || receipt.kept !== 'jpeg-bytes' || receipt.fidelity !== 'exact' ||
            receipt.source?.kind !== 'bytes' || receipt.source.digest !== 'sha256:' + record.outputSha256 ||
            receipt.outputDigest !== 'sha256:' + record.sourceSha256 || receipt.restoredDigest !== 'sha256:' + record.sourceSha256 ||
            receipt.referenceDigest !== 'sha256:' + record.sourceSha256 || receipt.width !== record.result.width || receipt.height !== record.result.height)
          throw fail('JXL_INPUT', 'The stored archive did not rebuild its byte-exact JPEG original.');
        return {done: true, bytes: result.bytes, run: job.run};
      }
    } catch (error) {
      options.signal?.throwIfAborted();
      const latest = await restoreState(record, {...options, signal: undefined});
      if (latest?.value.run !== job.run || latest.value.phase === 'cached') return {done: false};
      if (['JXL_INPUT', 'JXL_OPTIONS', 'JXL_RECONSTRUCTION', 'JXL_JPEG', 'JXL_UNSUPPORTED'].includes(error?.code))
        await saveRestore(record, saved, {...job, phase: 'blocked', error: errorValue(error, record.source)}, {...options, signal: undefined});
      throw error;
    }
    await saveRestore(record, saved, {...job, checkpoint, done}, options);
    return {done: false};
  }
  async function restoredBytes(found, options = {}) {
    // A normal GET must return the original in this response. It drains the same resumable
    // operation, but is not a claim that a cold GET fits a Free Worker's 10 ms CPU allowance.
    for (;;) {
      options.signal?.throwIfAborted();
      const result = await restoreAdvance(found, options);
      if (!result.done) continue;
      if (!result.cached && await cache?.put(cacheKey(found.record), result.bytes, {signal: options.signal}) === true)
        await releaseRestore(found.record, result.run, options);
      else if (result.cached) {
        const saved = await restoreState(found.record, options);
        if (saved) await releaseRestore(found.record, saved.value.run, options);
      }
      return result.bytes;
    }
  }
  function rangeOf(range, size) {
    if (!range) return null;
    const offset = Number.isSafeInteger(range.suffix) ? Math.max(0, size - range.suffix) : range.offset ?? 0;
    const length = Number.isSafeInteger(range.suffix) ? size - offset : Math.min(range.length ?? size - offset, size - offset);
    return Number.isSafeInteger(offset) && offset >= 0 && offset < size && Number.isSafeInteger(length) && length > 0 ? {offset, length} : null;
  }
  async function download(key, options = {}, retry = true) {
    if (!jpeg(key)) return inner.download(key, options);
    const found = await physical(key, options);
    if (!found) throw fail('NOT_FOUND', 'Media file not found.');
    const meta = logical(found);
    if (!found.archived) {
      const file = await inner.download(key, options);
      if (file.version !== found.file.version) {
        cancel(file.body);
        if (retry) return download(key, options, false);
        throw fail('JXL_INPUT', 'The stored original changed during its read.');
      }
      return {...file, ...meta, body: file.body, ...(file.range ? {range: file.range} : {})};
    }
    const range = rangeOf(options.range, meta.size);
    let started = false;
    const body = new ReadableStream({async pull(controller) {
      if (started) return; started = true;
      try {
        const bytes = await restoredBytes(found, options);
        controller.enqueue(range ? bytes.subarray(range.offset, range.offset + range.length) : bytes);
        controller.close();
      } catch (error) { controller.error(error); }
    }}, {highWaterMark: 0});
    return {...meta, body, ...(range ? {range} : {})};
  }
  const summary = record => ({key: record.source, stored: 'original', reason: null,
    originalBytes: record.originalBytes, jxlBytes: record.jxlBytes, storedBytes: record.jxlBytes + ENVELOPE_BYTES,
    deliveryEligible: record.deliveryEligible, deliveryReason: record.deliveryReason, result: structuredClone(record.result)});
  const refusal = (key, reason, result) => ({key, stored: null, reason, ...(result ? {result: structuredClone(result)} : {})});
  async function releaseWriter(id, options = {}) {
    const saved = await control(options);
    if (saved.value.writer?.id !== id) return true;
    return !!await updateControl(saved, value => { value.writer = null; }, options);
  }
  async function blockWriter(saved, error, options = {}) {
    const errorObject = errorValue(error, saved.value.writer?.key ?? '');
    if (saved.value.writer?.phase === 'blocked' && saved.value.writer.error?.code === errorObject.code &&
        saved.value.writer.error?.message === errorObject.message) return false;
    return !!await updateControl(saved, value => {
      value.writer.phase = 'blocked'; value.writer.error = errorObject;
      if (value.removal) { value.removal.phase = 'blocked'; value.removal.error = errorObject; }
    }, options);
  }
  async function cleanRecord(saved, options = {}) {
    await dispatch(() => inner.delete(saved.value.candidate, {signal: options.signal}), options);
    return updateRecord(saved, value => { value.cleaned = true; }, options);
  }

  async function beginArchive(key, result, {source, expectedGeneration, expectedDeliveryRevision, jobIdentity,
    deliveryEligible = result?.fits === true, deliveryReason = null, receipt, storageOnly = false, ...options} = {}) {
    const refuse = reason => ({refused: reason, publication: refusal(key, reason, result && stripBytes(result))});
    if (!jpeg(key)) return refuse('not_jpeg_key');
    // A Free or unknown Worker cannot promise a cold original GET within its CPU allowance.
    // It keeps the uploaded JPEG; a reversible JXL remains eligible as a delivery copy.
    if (!allowRetirement) return refuse('host_cpu_limit');
    if (typeof storageOnly !== 'boolean') throw fail('JXL_OPTIONS', 'Original custody is a private server policy.');
    if (!HASH.test(source ?? '') || !HASH.test(expectedGeneration ?? '') || !ID.test(expectedDeliveryRevision ?? '') || !ID.test(jobIdentity ?? ''))
      throw fail('JXL_OPTIONS', 'An original archive requires the captured source, delivery revision and server job identity.');
    if (!(result?.bytes instanceof Uint8Array) || result.bytes.length < 2 || result.bytes.length > maxInputBytes ||
        result.format !== 'jxl' || result.kept !== 'jpeg-bytes' || result.fidelity !== 'exact') return refuse('not_reversible_jpeg');
    if (result.bytes.length > MAX_ARCHIVE_BYTES) return refuse('archive_byte_limit');
    if (receipt?.verified !== true || receipt.kind !== 'jpeg-restore' || receipt.kept !== 'jpeg-bytes' || receipt.fidelity !== 'exact' ||
        receipt.format !== 'jxl' || receipt.source?.kind !== 'bytes' || receipt.source.digest !== 'sha256:' + source ||
        receipt.referenceDigest !== 'sha256:' + source || receipt.restoredDigest !== 'sha256:' + source ||
        !SHA.test(receipt.outputDigest ?? '') || receipt.width !== result.width || receipt.height !== result.height)
      throw fail('JXL_INPUT', 'Original retirement requires its matching private independent verification receipt.');
    const checkpoint = {id: jobIdentity, key, generation: expectedGeneration};
    const prior = await owned(key, jobIdentity, options);
    if (prior) {
      if (prior.value.generation !== expectedGeneration || prior.value.sourceSha256 !== source ||
          prior.value.outputSha256 !== receipt.outputDigest.slice(7) || prior.value.jxlBytes !== result.bytes.length)
        throw fail('JXL_INPUT', 'The original archive identity was reused for different bytes.');
      if (prior.value.state !== 'prepared' || prior.value.staged === true) return checkpoint;
    }
    const gate = await control(options);
    if (gate.value.mode !== 'enabled' || !gate.value.policy.enabled || !gate.value.policy.desired) return refuse('retirement_disabled');
    const found = await physical(key, options), original = logical(found);
    if (!original || await generation(original) !== expectedGeneration) return refuse('key_changed');
    const policy = await delivery(key, expectedGeneration, options);
    if (!storageOnly && policy.mode !== 'copies' || policy.revision !== expectedDeliveryRevision) return refuse('delivery_changed');
    // This validates only container structure. The trusted receipt above binds the exact payload;
    // the UUID ownership box is stripped before serving or rebuilding it, without another hash pass.
    const wrapped = wrapOriginal(result.bytes, jobIdentity), candidate = await candidateKey(key, jobIdentity);
    const record = prior?.value ?? {owner: OWNER, kind: 'jpeg-original', id: jobIdentity, source: key,
      generation: expectedGeneration, sourceSha256: source, sourceVersion: original.version, sourceEtag: original.etag,
      sourcePhysicalVersion: found.file.version, sourcePhysicalEtag: found.file.etag,
      originalBytes: original.size, contentType: 'image/jpeg',
      lastModified: original.lastModified ? new Date(original.lastModified).toISOString() : null,
      cacheControl: original.cacheControl ?? null, outputSha256: receipt.outputDigest.slice(7), jxlBytes: result.bytes.length,
      deliveryRevision: expectedDeliveryRevision, deliveryEligible: !storageOnly && deliveryEligible === true, storageOnly,
      deliveryReason, result: stripBytes(result), receipt: structuredClone(receipt), candidate,
      state: 'prepared', staging: 'prepared', staged: false, cleaned: false, reason: null};
    if (!validRecord(record)) throw fail('JXL_INPUT', 'The original archive metadata is invalid.');
    if (!prior) {
      const metadataKey = await recordKey(key, jobIdentity);
      const recordBytes = utf8(JSON.stringify(record));
      if (recordBytes.length > MAX_JSON) throw fail('JXL_LIMIT', 'An original archive record exceeds its byte limit.');
      const created = await dispatch(() => create(metadataKey, recordBytes,
        {contentType: 'application/json', signal: options.signal}), options);
      if (created !== true) return beginArchive(key, result, {source, expectedGeneration, expectedDeliveryRevision, jobIdentity,
        deliveryEligible, deliveryReason, receipt, storageOnly, ...options});
    }
    let staged = await owned(key, jobIdentity, options);
    if (staged.value.state !== 'prepared' || staged.value.staged) return checkpoint;
    if (staged.value.staging !== 'prepared') {
      const existing = await read(candidate, wrapped.length, options);
      if (existing && existing.bytes.length === wrapped.length && envelopeIdentity(existing.bytes)?.id === jobIdentity)
        await updateRecord(staged, value => { value.staged = true; value.staging = 'complete'; value.stagingError = null; }, options);
      return checkpoint;
    }
    const armed = await updateRecord(staged, value => { value.staging = 'writing'; }, options);
    if (!armed) return checkpoint;
    let acknowledged = false, uncertain;
    try {
      acknowledged = await dispatch(() => create(candidate, wrapped,
        {contentType: 'image/jxl', signal: options.signal}), options) === true;
    } catch (error) { uncertain = error; }
    if (!acknowledged) {
      const existing = await read(candidate, wrapped.length, {...options, signal: undefined});
      acknowledged = existing && existing.bytes.length === wrapped.length && envelopeIdentity(existing.bytes)?.id === jobIdentity;
    }
    staged = await owned(key, jobIdentity, {...options, signal: undefined});
    if (staged.value.state === 'prepared') await updateRecord(staged, value => {
      value.staged = !!acknowledged; value.staging = acknowledged ? 'complete' : 'blocked';
      value.stagingError = acknowledged ? null : errorValue(uncertain ??
        fail('JXL_ARCHIVE_STAGE_UNRESOLVED', 'The prepared archive has no definitive staging acknowledgement.'), key);
    }, {...options, signal: undefined});
    return checkpoint;
  }
  function stripBytes(result) { const {bytes, ...metadata} = result; return structuredClone(metadata); }

  async function finishRefusal(saved, reason, options = {}, definitive = false) {
    saved = await owned(saved.value.source, saved.value.id, options);
    if (saved.value.state === 'active') return completeArchive(saved, options);
    if (saved.value.state === 'restored') return {done: true, phase: 'complete', progressed: false,
      publication: refusal(saved.value.source, 'retirement_disabled', saved.value.result)};
    if (saved.value.state !== 'refused') {
      const gate = await control(options), writer = gate.value.writer, id = saved.value.id;
      if (writer && writer.id !== id) return {done: false, phase: 'prepared', progressed: false, error: null};
      if (writer && ['writing', 'blocked'].includes(writer.phase) && !definitive)
        return {done: false, phase: writer.phase, progressed: false, error: writer.error ?? null};
      // Cancellation wins the same control CAS that arms the physical write. A stale reader
      // cannot retire a record or release its writer after another request armed that write.
      if (!(gate.value.mode === 'retiring' && !writer) && !(writer?.phase === 'cleaning' && writer.outcome === 'refused')) {
        const canceled = await updateControl(gate, value => { value.writer = {
          id, key: saved.value.source, kind: 'archive', phase: 'cleaning', outcome: 'refused', reason,
          generation: saved.value.generation, error: null}; }, options);
        if (!canceled) return {done: false, phase: 'prepared', progressed: false, error: null};
      }
    }
    const changed = saved.value.state === 'refused' ? saved.value : await updateRecord(saved,
      value => { value.state = 'refused'; value.reason = reason; }, options);
    if (!changed) return {done: false, phase: 'prepared', progressed: false, error: null};
    const latest = await owned(changed.source, changed.id, options);
    if (!latest.value.cleaned) await cleanRecord(latest, options);
    await releaseWriter(changed.id, options);
    return {done: true, phase: 'complete', progressed: true, publication: refusal(changed.source, reason, changed.result)};
  }
  async function completeArchive(saved, options = {}) {
    if (!saved.value.cleaned) {
      const changed = await cleanRecord(saved, options);
      if (!changed) return {done: false, phase: 'cleaning', progressed: false, error: null};
    }
    if (!await releaseWriter(saved.value.id, options)) return {done: false, phase: 'cleaning', progressed: false, error: null};
    return {done: true, phase: 'complete', progressed: true, publication: summary(saved.value)};
  }
  async function advanceArchive(checkpoint, options = {}) {
    const {key, id, generation: expectedGeneration} = checkpoint ?? {};
    if (!jpeg(key) || !ID.test(id ?? '') || !HASH.test(expectedGeneration ?? ''))
      throw fail('JXL_OPTIONS', 'Expected a saved original archive checkpoint.');
    let saved = await owned(key, id, options);
    if (!saved || saved.value.generation !== expectedGeneration) throw fail('JXL_INPUT', 'The original archive checkpoint is missing or changed.');
    if (saved.value.state === 'refused') return finishRefusal(saved, saved.value.reason, options);
    if (saved.value.state === 'restored') return {done: true, phase: 'complete', progressed: false,
      publication: refusal(key, 'retirement_disabled', saved.value.result)};
    if (saved.value.state === 'active') return completeArchive(saved, options);
    if (!saved.value.staged) {
      const gate = await control(options);
      if (gate.value.mode === 'retiring' || !gate.value.policy.enabled || !gate.value.policy.desired)
        return finishRefusal(saved, 'retirement_disabled', options);
      const existing = await read(saved.value.candidate, saved.value.jxlBytes + ENVELOPE_BYTES, options);
      if (existing && existing.bytes.length === saved.value.jxlBytes + ENVELOPE_BYTES && envelopeIdentity(existing.bytes)?.id === id) {
        const staged = await updateRecord(saved, value => { value.staged = true; value.staging = 'complete'; value.stagingError = null; }, options);
        return {done: false, phase: 'prepared', progressed: !!staged, error: null};
      }
      return {done: false, phase: 'blocked', progressed: false, error: saved.value.stagingError ??
        errorValue(fail('JXL_ARCHIVE_STAGE_UNRESOLVED', 'The prepared archive has no definitive staging acknowledgement.'), key)};
    }
    let gate = await control(options);
    if (options.cancel === true && (!gate.value.writer || gate.value.writer.id === id && gate.value.writer.phase === 'prepared'))
      return finishRefusal(saved, 'canceled', options);
    if (gate.value.writer && gate.value.writer.id !== id) return {done: false, phase: 'prepared', progressed: false, error: null};
    if (!gate.value.writer) {
      if (!allowRetirement) return finishRefusal(saved, 'host_cpu_limit', options);
      if (gate.value.mode !== 'enabled' || !gate.value.policy.enabled || !gate.value.policy.desired)
        return finishRefusal(saved, 'retirement_disabled', options);
      const acquired = await updateControl(gate, value => {
        value.writer = {id, key, kind: 'archive', phase: 'prepared', generation: expectedGeneration, error: null};
      }, options);
      return {done: false, phase: 'prepared', progressed: !!acquired, error: null};
    }
    const writer = gate.value.writer;
    if (writer.phase === 'cleaning' && writer.outcome === 'refused') return finishRefusal(saved, writer.reason, options);
    if (writer.phase === 'writing' || writer.phase === 'blocked') {
      const found = await physical(key, options);
      if (found?.archived && found.record.id === id) {
        const acknowledged = await updateRecord(saved, value => { value.state = 'active'; value.physicalVersion = found.file.version; }, options);
        return {done: false, phase: 'cleaning', progressed: !!acknowledged, error: null};
      }
      const error = fail('JXL_ARCHIVE_UNRESOLVED', 'A JPEG replacement has no definitive acknowledgement. Keep this integration installed.');
      const progressed = await blockWriter(gate, error, options);
      return {done: false, phase: 'blocked', progressed, error: errorValue(error, key)};
    }
    if (!allowRetirement) return finishRefusal(saved, 'host_cpu_limit', options);
    if (gate.value.mode !== 'enabled' || !gate.value.policy.enabled || !gate.value.policy.desired)
      return finishRefusal(saved, 'retirement_disabled', options);
    const found = await physical(key, options), record = saved.value;
    if (!found || found.file.version !== record.sourcePhysicalVersion || found.file.etag !== record.sourcePhysicalEtag)
      return finishRefusal(saved, 'key_changed', options);
    const policy = await delivery(key, expectedGeneration, options);
    if (!record.storageOnly && policy.mode !== 'copies' || policy.revision !== record.deliveryRevision)
      return finishRefusal(saved, 'delivery_changed', options);
    const candidate = await read(record.candidate, record.jxlBytes + ENVELOPE_BYTES, options);
    if (!candidate || candidate.bytes.length !== record.jxlBytes + ENVELOPE_BYTES || envelopeIdentity(candidate.bytes)?.id !== id)
      throw fail('JXL_INPUT', 'The prepared JPEG archive payload is missing or changed.');
    // The only archive write dispatch in the implementation. A retry that sees writing cannot enter here.
    const armed = await updateControl(gate, value => { value.writer.phase = 'writing'; }, options);
    if (!armed) return {done: false, phase: 'prepared', progressed: false, error: null};
    let acknowledged;
    try {
      acknowledged = await dispatch(() => replace(key, candidate.bytes, {expectedVersion: record.sourcePhysicalVersion,
        etag: record.sourcePhysicalEtag, contentType: 'image/jxl', originalId: id, representation: 'jxl',
        cacheControl: record.cacheControl, signal: options.signal}), {...options, signal: undefined});
    } catch (error) {
      const current = await control({...options, signal: undefined});
      if (current.value.writer?.id === id) await blockWriter(current, error, {...options, signal: undefined});
      return {done: false, phase: 'blocked', progressed: true, error: errorValue(error, key)};
    }
    if (acknowledged === null || acknowledged === false) return finishRefusal(saved, 'key_changed', {...options, signal: undefined}, true);
    const active = await updateRecord(saved, value => { value.state = 'active'; value.physicalVersion = acknowledged.version; }, {...options, signal: undefined});
    return {done: false, phase: 'cleaning', progressed: !!active, error: null};
  }

  function removalValue(saved) {
    if (!saved?.value.removal) return null;
    const {siteId, revision, writer, removal} = saved.value;
    return {id: removal.id, siteId, scope, phase: removal.phase, retirementDisabled: saved.value.mode === 'retiring',
      activeWriters: writer ? 1 : 0, remaining: removal.remaining, restored: removal.restored, error: removal.error ?? null,
      proof: removal.phase === 'complete' && !writer ? {kind: 'originals-restored', id: removal.id, siteId, scope,
        revision, remaining: 0, activeWriters: 0, retirementDisabled: true} : null};
  }
  function requireRemoval(saved, input) {
    const status = removalValue(saved);
    if (!status || input?.id !== status.id || input.siteId !== status.siteId || input.scope !== scope)
      throw fail('JXL_INPUT', 'The original-restoration operation or storage identity changed.');
    return status;
  }
  async function beginRemoval({id, ...options} = {}) {
    if (!ID.test(id ?? '')) throw fail('JXL_OPTIONS', 'Removal requires a 32-character operation identity.');
    const saved = await control(options);
    if (saved.value.removal) {
      if (saved.value.removal.purpose === 'uninstall') {
        if (saved.value.removal.id !== id) throw fail('JXL_INPUT', 'Another original-restoration operation is already active.');
        return removalValue(saved);
      }
      // Only the explicit uninstall request acquires the terminal removal gate. A switch's
      // restoration proof alone can never authorize rewriting the site's source configuration.
      await updateControl(saved, value => {
        value.removal.id = id; value.removal.purpose = 'uninstall'; value.policy.current = null;
        if (value.removal.phase === 'complete') Object.assign(value.policy,
          {enabled: false, desired: false, phase: 'idle', error: null});
      }, options);
    } else {
      await updateControl(saved, value => { value.mode = 'retiring'; value.removal = {
        id, purpose: 'uninstall', phase: 'draining', cursor: null, remaining: null, restored: 0, error: null};
        value.policy.desired = false; value.policy.phase = value.policy.enabled ? 'restoring' : 'idle';
        value.policy.current = null; value.policy.error = null;
      }, options);
    }
    const latest = await control(options);
    if (latest.value.removal?.id !== id || latest.value.removal?.purpose !== 'uninstall')
      throw fail('JXL_INPUT', 'Another original-restoration operation was started.');
    return removalValue(latest);
  }
  async function removalStatus(options = {}) {
    const saved = await control(options, false);
    return saved?.value.removal?.purpose === 'uninstall' ? removalValue(saved) : null;
  }
  async function acknowledgeRestore(saved, item, version, options) {
    if (item.value.state !== 'restored' || item.value.restoredVersion !== version) {
      if (!await updateRecord(item, value => { value.state = 'restored'; value.restoredVersion = version; }, options)) return false;
    }
    return !!await updateControl(saved, value => {
      value.writer.phase = 'cleaning'; value.writer.outcome = 'restore-complete'; value.writer.error = null;
      value.removal.restored++; value.removal.phase = 'restoring'; value.removal.error = null;
    }, options);
  }
  async function drainRestoreWriter(saved, options) {
    const writer = saved.value.writer, item = await owned(writer.key, writer.archive, options);
    if (!item) throw fail('JXL_INPUT', 'The pending original restoration lost its ownership record.');
    if (writer.phase === 'cleaning' && writer.outcome === 'restore-refused') {
      await releaseWriter(writer.id, options);
      return;
    }
    if (writer.phase === 'cleaning' && writer.outcome === 'restore-complete') {
      // The JPEG replacement has acknowledged its commit. Only now may its durable
      // reconstruction parts be collected. Keep the writer until that cleanup completes.
      const job = await restoreState(item.value, options);
      if (job && !await releaseRestore(item.value, job.value.run, options)) return;
      await releaseWriter(writer.id, options);
      return;
    }
    const found = await physical(writer.key, options);
    if (found && !found.archived && found.record?.id === writer.archive && found.file.representation === 'jpeg') {
      await acknowledgeRestore(saved, item, found.file.version, options);
      return;
    }
    // Neither a missing object nor its old JXL representation proves that an armed put
    // cannot still arrive. A unique restored marker or the original acknowledgement does.
    await blockWriter(saved, fail('JXL_ARCHIVE_UNRESOLVED',
      'A JPEG restoration has no definitive acknowledgement. Keep this integration installed.'), options);
  }
  async function advanceRemoval(input = {}) {
    const {signal, call = direct, ms = 5000} = input, options = {signal, call};
    if (!Number.isFinite(ms) || ms <= 0 || ms > 60000) throw fail('JXL_OPTIONS', 'Original reconstruction uses an advance budget from 1 to 60000 ms.');
    let saved = await control(options); requireRemoval(saved, input);
    if (saved.value.removal.phase === 'complete') return removalValue(saved);
    if (saved.value.writer) {
      if (saved.value.writer.kind === 'archive') {
        const writer = saved.value.writer;
        const result = await advanceArchive({key: writer.key, id: writer.id, generation: writer.generation}, options);
        saved = await control(options);
        if (result.phase === 'blocked') return removalValue(saved);
      } else if (saved.value.writer.kind === 'restore') {
        await drainRestoreWriter(saved, options);
        return removalValue(await control(options));
      } else if (saved.value.writer.phase === 'cleaning' && saved.value.writer.outcome === 'mutation-complete') {
        await releaseWriter(saved.value.writer.id, options);
        saved = await control(options);
      } else {
        const error = fail('JXL_ARCHIVE_UNRESOLVED', 'A source mutation has not acknowledged its completion. Keep this integration installed.');
        await blockWriter(saved, error, options); return removalValue(await control(options));
      }
      if (saved.value.writer) return removalValue(saved);
    }
    if (['draining', 'blocked'].includes(saved.value.removal.phase)) {
      await updateControl(saved, value => { value.removal.phase = 'restoring'; value.removal.cursor = null; value.removal.error = null; }, options);
      return removalValue(await control(options));
    }
    const page = await dispatch(() => inner.list({prefix: RECORDS, limit: 1,
      ...(saved.value.removal.cursor ? {cursor: saved.value.removal.cursor} : {}), signal}), options);
    let remaining = 0;
    for (const file of page.files) {
      const item = await json(file.key, options);
      if (!item || !validRecord(item.value) || await recordKey(item.value.source, item.value.id) !== file.key ||
          item.value.candidate !== await candidateKey(item.value.source, item.value.id))
        throw fail('JXL_INPUT', 'Original restoration found an invalid ownership record.');
      const record = item.value, found = await physical(record.source, options);
      if (found?.archived && found.record.id === record.id) {
        if (saved.value.removal.phase === 'verifying') { remaining++; continue; }
        if (saved.value.removal.purpose === 'policy' && record.deliveryEligible && record.deliveryPreserved !== saved.value.removal.id) {
          try {
            const selected = await delivery(record.source, record.generation, options);
            if (selected.mode === 'copies' && selected.revision === record.deliveryRevision) {
              if (!preserveDelivery) throw fail('JXL_UNSUPPORTED', 'The selected archive delivery cannot yet be preserved.');
              if (record.jxlBytes > maxDeliveryBytes)
                throw fail('JXL_LIMIT', 'The selected archive delivery exceeds the bounded copy limit. Keep this setting until it can be preserved.');
              const bytes = await archivePayload(found, options);
              const kept = await preserveDelivery(record.source, {...structuredClone(record.result), bytes}, {
                source: record.sourceSha256, expectedGeneration: record.generation, expectedDeliveryRevision: record.deliveryRevision,
                jobIdentity: record.id, receipt: structuredClone(record.receipt),
                 preservationId: saved.value.removal.id, ...options});
              if (kept?.preserved !== true) throw fail('JXL_IO', 'The selected archive delivery has no definitive preservation acknowledgement.');
            }
            await updateRecord(item, value => { value.deliveryPreserved = saved.value.removal.id; }, options);
          } catch (error) {
            signal?.throwIfAborted();
            await updateControl(saved, value => { value.removal.phase = 'blocked'; value.removal.error = errorValue(error, record.source); }, options);
          }
          // Saving a delivery copy and rebuilding a JPEG never share one cooperative advance.
          return removalValue(await control(options));
        }
        let result;
        try { result = await restoreAdvance(found, {ms, ...options}); }
        catch (error) {
          signal?.throwIfAborted();
          await updateControl(saved, value => { value.removal.phase = 'blocked'; value.removal.error = errorValue(error, record.source); }, options);
          return removalValue(await control(options));
        }
        if (!result.done) return removalValue(await control(options));
        const id = uuid(), armed = await updateControl(saved, value => {
          value.writer = {id, key: record.source, archive: record.id, kind: 'restore', phase: 'writing', error: null};
        }, options);
        if (!armed) return removalValue(await control(options));
        const settled = {...options, signal: undefined};
        let acknowledged;
        try {
          acknowledged = await dispatch(() => replace(record.source, result.bytes, {expectedVersion: found.file.version,
            etag: found.file.etag, contentType: 'image/jpeg', originalId: record.id, representation: 'jpeg',
            lastModified: record.lastModified ? new Date(record.lastModified) : undefined,
            cacheControl: record.cacheControl}), settled);
        } catch (error) {
          const latest = await control(settled);
          if (latest.value.writer?.id === id) await blockWriter(latest, error, settled);
          return removalValue(await control(settled));
        }
        const latest = await control(settled);
        if (latest.value.writer?.id !== id) throw fail('JXL_INPUT', 'The original restoration writer changed before acknowledgement.');
        if (acknowledged === null || acknowledged === false) {
          await updateControl(latest, value => {
            value.writer.phase = 'cleaning'; value.writer.outcome = 'restore-refused';
          }, settled);
        } else if (typeof acknowledged?.version === 'string' && acknowledged.version) {
          await acknowledgeRestore(latest, item, acknowledged.version, settled);
        } else await blockWriter(latest, fail('JXL_ARCHIVE_UNRESOLVED', 'The JPEG restoration returned no definitive write acknowledgement.'), settled);
        return removalValue(await control(settled));
      } else if (!record.cleaned && ['writing', 'blocked'].includes(record.staging)) {
        // Even an unarmed archive may have an outstanding immutable staging write. Its
        // absence cannot authorize forgetting it; reconcile its unique marker before cleanup.
        let candidate = await dispatch(() => head(record.candidate, {signal}), options).catch(error => {
          if (error?.code === 'NOT_FOUND') return null; throw error;
        });
        let acknowledged = false;
        if (candidate?.size === record.jxlBytes + ENVELOPE_BYTES) {
          const length = Math.min(candidate.size, ENVELOPE_PREFIX_BYTES);
          const prefix = await dispatch(() => inner.download(record.candidate, {range: {offset: 0, length}, signal}), options);
          const bytes = await readAll(prefix.body, {maxBytes: ENVELOPE_PREFIX_BYTES, signal});
          acknowledged = prefix.version === candidate.version && prefix.range?.offset === 0 && prefix.range.length === length &&
            bytes.length === length && envelopeIdentity(bytes)?.id === record.id;
        }
        if (acknowledged) await updateRecord(item, value => {
          value.staged = true; value.staging = 'complete'; value.stagingError = null;
        }, options);
        else await updateControl(saved, value => {
          value.removal.phase = 'blocked'; value.removal.error = errorValue(fail('JXL_ARCHIVE_STAGE_UNRESOLVED',
            'An original archive staging write has no definitive acknowledgement.'), record.source);
        }, options);
        return removalValue(await control(options));
      } else if (!record.cleaned && record.staged) {
        // This staging write acknowledged before its archive was refused. No physical
        // replacement can arm through the closed control gate, so its owned copy is collectible.
        await cleanRecord(item, options);
        return removalValue(await control(options));
      } else if (record.state === 'active' || record.state === 'prepared') {
        // All destructive archive writers have drained. A nonmatching current object can never be
        // overwritten later by this identity; there is no lease expiry or pending duplicate put.
        await updateRecord(item, value => {
          value.state = 'restored';
          if (value.staging === 'prepared') value.cleaned = true;
        }, options);
      }
    }
    await updateControl(saved, value => {
      const work = value.removal;
      if (work.phase === 'verifying') work.remaining += remaining;
      work.cursor = page.nextCursor ?? null;
      if (!page.nextCursor) {
        if (work.phase === 'restoring') { work.phase = 'verifying'; work.remaining = 0; }
        else if (work.remaining === 0) {
          work.phase = 'complete'; work.error = null;
          if (work.purpose === 'uninstall') Object.assign(value.policy,
            {enabled: false, desired: false, phase: 'idle', current: null, error: null});
        }
        else { work.phase = 'restoring'; work.remaining = null; }
      }
    }, options);
    return removalValue(await control(options));
  }

  function policyValue(saved) {
    const {policy, removal, writer, mode, revision} = saved.value;
    const error = removal?.error ?? policy.error ?? (!allowRetirement && policy.enabled
      ? {code: 'JXL_UNSUPPORTED', message: 'Restore existing JPEG archives under their recorded host allowance.'} : null);
    return {available: allowRetirement && removal?.purpose !== 'uninstall', enabled: policy.enabled, desired: policy.desired,
      phase: policy.phase, id: policy.id, revision,
      admitting: allowRetirement && mode === 'enabled' && policy.enabled && policy.desired,
      processed: policy.processed, archived: policy.archived, kept: policy.kept, failed: policy.failed,
      restored: removal?.restored ?? policy.restored ?? 0, last: policy.last,
      blocked: !!error || writer?.phase === 'blocked', error};
  }
  async function policy(options = {}) { return policyValue(await control(options)); }
  async function setPolicy({enabled, id, expectedId, ...options} = {}) {
    if (typeof enabled !== 'boolean' || !ID.test(id ?? '') || !ID.test(expectedId ?? ''))
      throw fail('JXL_OPTIONS', 'Choose the originals policy using its current saved identity.');
    const saved = await control(options), previous = saved.value.policy;
    if (previous.id !== expectedId) throw fail('JXL_POLICY_CHANGED', 'The originals setting changed. Read its current progress.');
    if (enabled && !allowRetirement) throw fail('JXL_UNSUPPORTED', 'This host must keep the original JPEG files.');
    if (saved.value.removal?.purpose === 'uninstall')
      throw fail('JXL_BUSY', 'Integration removal has closed the originals gate. Finish that removal first.');
    if (previous.desired === enabled) return policyValue(saved);
    if (previous.phase === 'restoring')
      throw fail('JXL_BUSY', 'Finish restoring the JPEG originals before changing this setting.');
    await updateControl(saved, value => {
      if (enabled) {
        value.mode = 'enabled'; value.removal = null; value.policy = newPolicy(true, id);
      } else {
        value.mode = 'retiring'; value.removal = {id, purpose: 'policy', phase: 'draining', cursor: null,
          remaining: null, restored: 0, error: null};
        value.policy = {...previous, id, desired: false, phase: 'restoring', cursor: null, error: null,
          // A saved image command must settle cancellation before its policy work may disappear.
          current: previous.current?.command ? previous.current : null};
      }
    }, options);
    if (!enabled && !previous.current?.command && !saved.value.writer &&
        !(await dispatch(() => inner.list({prefix: RECORDS, limit: 1, signal: options.signal}), options)).files.length) {
      // Nothing is archived: the restoration is a handful of bookkeeping steps and ends in this request.
      for (let step = 0; step < 6 && (await control(options)).value.policy.phase === 'restoring'; step++)
        await advancePolicy({id, ...options});
    }
    return policyValue(await control(options));
  }
  async function advancePolicy({id, ms = 5000, signal, call = direct, list, prepare, run} = {}) {
    if (!ID.test(id ?? '') || !Number.isFinite(ms) || ms <= 0 || ms > 60000)
      throw fail('JXL_OPTIONS', 'Expected the saved originals operation and its bounded advance budget.');
    const options = {signal, call};
    let saved = await control(options), selected = saved.value.policy;
    if (selected.id !== id) return null;
    if (selected.phase === 'idle' || saved.value.removal?.purpose === 'uninstall') return policyValue(saved);
    const saveError = async error => {
      const value = errorValue(error, selected.current?.item.key ?? '');
      if (JSON.stringify(value) !== JSON.stringify(selected.error))
        await updateControl(saved, next => { next.policy.error = value; }, options);
      return policyValue(await control(options));
    };
    if (selected.phase === 'restoring') {
      if (selected.current?.command) {
        if (typeof run !== 'function') throw fail('JXL_OPTIONS', 'Original archive cancellation requires its saved server runner.');
        try {
          const stopped = await run(selected.current.command, {ms, signal, cancel: true});
          // A stopped archive job whose part cleanup is still pending keeps its command: the next advance repeats it.
          if (!stopped || (stopped.done || stopped.canceled) && !stopped.cleanupPending)
            await updateControl(saved, value => { value.policy.current = null; value.policy.error = null; }, options);
          else if (stopped.phase === 'blocked') return saveError(stopped.blocked ?? stopped.error ??
            fail('JXL_ARCHIVE_UNRESOLVED', 'The previous archive operation still needs its write acknowledgement.'));
        } catch (error) { signal?.throwIfAborted(); return saveError(error); }
        return policyValue(await control(options));
      }
      const removal = removalValue(saved);
      if (!removal || saved.value.removal.purpose !== 'policy' || removal.id !== id)
        throw fail('JXL_INPUT', 'The originals switch lost its restoration operation.');
      await advanceRemoval({...removal, ms, ...options});
      saved = await control(options);
      if (saved.value.policy.id === id && saved.value.removal?.purpose === 'policy' &&
          saved.value.removal.phase === 'complete' && !saved.value.writer) {
        await updateControl(saved, value => {
          value.policy = {...value.policy, enabled: false, desired: false, phase: 'idle', current: null,
            restored: value.removal.restored, error: null};
          // Keep the integration installed. Only this CAS, after a zero-archive proof, makes
          // the effective switch say that physical JPEG files are kept.
          value.mode = 'enabled'; value.removal = null;
        }, options);
      }
      return policyValue(await control(options));
    }
    if (!allowRetirement) return saveError(fail('JXL_UNSUPPORTED', 'This host must keep the original JPEG files.'));
    if ([list, prepare, run].some(value => typeof value !== 'function'))
      throw fail('JXL_OPTIONS', 'Progressive archival requires the native media list and verified server runner.');
    const complete = async (outcome, reason = null) => {
      await updateControl(saved, value => {
        const item = value.policy.current;
        Object.assign(value.policy, {current: null, cursor: item.nextCursor, error: null,
          phase: item.nextCursor === null ? 'idle' : 'archiving', processed: value.policy.processed + 1,
          [outcome]: value.policy[outcome] + 1,
          last: {id: item.item.id, key: item.item.key, outcome, reason}});
      }, options);
      return policyValue(await control(options));
    };
    try {
      if (!selected.current) {
        const page = await list(selected.cursor, options);
        if (!page || !Array.isArray(page.items) || page.items.length > 1 ||
            page.nextCursor !== undefined && (typeof page.nextCursor !== 'string' || !page.nextCursor) ||
            page.nextCursor !== undefined && page.nextCursor === selected.cursor)
          throw fail('JXL_IO', 'The native JPEG list returned an invalid bounded page.');
        const item = page.items[0];
        if (!item) {
          if (page.nextCursor !== undefined) throw fail('JXL_IO', 'The native JPEG list returned an empty nonterminal page.');
          await updateControl(saved, value => { value.policy.phase = 'idle'; value.policy.error = null; }, options);
        } else {
          if (typeof item.id !== 'string' || !jpeg(item.key)) throw fail('JXL_INPUT', 'The native JPEG list returned an invalid original.');
          const jobId = (await digest(utf8(JSON.stringify(['originals', scope, id, item.id, item.key])))).slice(0, 32);
          await updateControl(saved, value => { value.policy.current = {item: structuredClone(item), jobId,
            nextCursor: page.nextCursor ?? null, stage: 'prepare', command: null}; value.policy.error = null; }, options);
        }
        return policyValue(await control(options));
      }
      const current = selected.current;
      if (current.stage === 'prepare') {
        const command = await prepare(current.item, {id: current.jobId, signal, call});
        if (command?.skip) return complete(command.skip === 'archived' ? 'archived' : 'kept', command.skip);
        if (!command || command.id !== current.jobId || command.key !== current.item.key || command.archiveOnly !== true)
          throw fail('JXL_INPUT', 'The original archive preparation returned a different server command.');
        await updateControl(saved, value => {
          value.policy.current.command = structuredClone(command); value.policy.current.stage = 'run'; value.policy.error = null;
        }, options);
        return policyValue(await control(options));
      }
      const job = await run(current.command, {ms, signal, cancel: false});
      if (!job) throw fail('JXL_IO', 'The saved original archive job is missing.');
      if (job.phase === 'blocked') return saveError(job.blocked ?? job.error ??
        fail('JXL_ARCHIVE_UNRESOLVED', 'The JPEG archive still needs its write acknowledgement.'));
      if ((job.done || job.canceled) && !job.cleanupPending) return complete(job.publication?.stored === 'original' ? 'archived' : job.error ? 'failed' : 'kept',
        job.error?.code ?? job.publication?.reason ?? job.execution?.reason ?? (job.canceled ? 'canceled' : null));
      if (job.cleanupPending) return policyValue(await control(options));
      // The image runner has its own checkpoint CAS. Record its revision here so the site's
      // scheduled pump can distinguish real progress from a concurrent or blocked advance.
      if (current.revision !== job.revision || selected.error)
        await updateControl(await control(options), value => {
          if (value.policy.id === id && value.policy.current?.jobId === current.jobId) {
            value.policy.current.revision = job.revision; value.policy.error = null;
          }
        }, options);
      return policyValue(await control(options));
    } catch (error) {
      signal?.throwIfAborted();
      if (selected.current?.stage === 'prepare' && ['JXL_INPUT', 'JXL_LIMIT', 'JXL_UNSUPPORTED', 'key_changed', 'NOT_FOUND'].includes(error?.code))
        return complete('kept', error.code);
      return saveError(error);
    }
  }

  const waitForWriter = (ms, signal) => new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, {once: true});
  });
  async function mutation(key, action, options = {}) {
    if (!jpeg(key)) return action();
    const id = uuid();
    let acquired;
    // A native write or archive handoff can settle over several requests. Eight acquisition attempts
    // bound contention; the seven asynchronous waits total 5750 ms, without extra archive advances.
    // Never expire a writer or drive its archive work here. Only its acknowledged release admits us.
    for (let attempt = 0; attempt < 8; attempt++) {
      if (attempt) await waitForWriter(Math.min(250 * 2 ** (attempt - 1), 1000), options.signal);
      const saved = await control(options);
      if (saved.value.mode === 'retiring' && saved.value.removal?.phase === 'complete') {
        if (saved.value.removal.purpose === 'uninstall') return action();
        throw fail('JXL_BUSY', 'The originals setting is committing its restored state. Retry this change.');
      }
      if (saved.value.writer) {
        if (saved.value.writer.phase === 'blocked' || attempt === 7)
          throw fail('JXL_BUSY', 'A JPEG source replacement is in progress. Retry this change.');
        continue;
      }
      acquired = await updateControl(saved, value => {
        value.writer = {id, key, kind: 'mutation', phase: 'writing', error: null};
      }, options);
      if (acquired) break;
    }
    if (!acquired) throw fail('JXL_BUSY', 'A JPEG source replacement started. Retry this change.');
    let result;
    try { result = await action(); }
    catch (error) {
      const latest = await control({...options, signal: undefined});
      if (latest.value.writer?.id === id) await blockWriter(latest, error, {...options, signal: undefined});
      throw error;
    }
    const settledOptions = {...options, signal: undefined};
    let durable = false;
    for (let attempt = 0; attempt < 3 && !durable; attempt++) {
      const latest = await control(settledOptions);
      if (latest.value.writer?.id !== id) { durable = true; break; }
      durable = !!await updateControl(latest, value => {
        value.writer.phase = 'cleaning'; value.writer.outcome = 'mutation-complete'; value.writer.error = null;
      }, settledOptions);
    }
    if (!durable || !await releaseWriter(id, settledOptions))
      throw fail('JXL_ARCHIVE_UNRESOLVED', 'The source changed, but its writer acknowledgement still needs reconciliation.');
    return result;
  }
  const originals = {
    platform,
    async state(options) { const saved = await control(options); return structuredClone(saved.value); },
    beginArchive, advanceArchive, beginRemoval, advanceRemoval, removalStatus, policy, setPolicy, advancePolicy,
    async advanceRestore(key, options = {}) {
      const found = await physical(key, options);
      if (!found) throw fail('NOT_FOUND', 'Media file not found.');
      return found.archived ? restoreAdvance(found, options) : {done: true, archived: false, bytes: null};
    },
    async info(key, options) {
      const found = await physical(key, options), file = logical(found);
      if (!file) return null;
      const record = found.record;
      return {archived: found.archived, generation: await generation(file), sourceSha256: record?.sourceSha256 ?? null,
        originalBytes: file.size, contentType: file.contentType, lastModified: file.lastModified, etag: file.etag,
        storedBytes: found.file.size, jxlBytes: found.archived ? record.jxlBytes : null,
        deliveryRevision: record?.deliveryRevision ?? null, deliveryEligible: found.archived && record.deliveryEligible,
        result: record?.result ?? null};
    },
    async rendition(key, options = {}) {
      const found = await physical(key, options), record = found?.record;
      if (!found?.archived || !record.deliveryEligible) return null;
      const selected = await delivery(key, record.generation, options);
      if (selected.mode !== 'copies' || selected.revision !== record.deliveryRevision) return null;
      const bytes = await archivePayload(found, options);
      return {...structuredClone(record.result), bytes};
    },
    async family(key, options = {}) {
      const prefix = RECORDS + await digest(utf8(key)) + '.', result = [];
      for (let cursor; ;) {
        const page = await dispatch(() => inner.list({prefix, limit: 100, ...(cursor ? {cursor} : {}), signal: options.signal}), options);
        for (const file of page.files) {
          const item = await json(file.key, options);
          if (!item || !validRecord(item.value) || item.value.source !== key) continue;
          result.push({key: file.key, size: item.size});
          const candidate = await dispatch(() => head(item.value.candidate, {signal: options.signal}), options).catch(error => {
            if (error?.code === 'NOT_FOUND') return null; throw error;
          });
          if (candidate) result.push({key: item.value.candidate, size: candidate.size});
          const partsPrefix = restoreParts(item.value);
          for (let partCursor; ;) {
            const parts = await dispatch(() => inner.list({prefix: partsPrefix, limit: 100,
              ...(partCursor ? {cursor: partCursor} : {}), signal: options.signal}), options);
            for (const part of parts.files) {
              if (part.key === restoreKey(item.value) || /^[a-f0-9]{32}\.[a-f0-9]{64}\.part$/.test(part.key.slice(partsPrefix.length)))
                result.push({key: part.key, size: part.size});
            }
            if (!parts.nextCursor) break;
            if (partCursor === parts.nextCursor) throw fail('JXL_INTERNAL', 'Storage repeated a reconstruction list cursor.');
            partCursor = parts.nextCursor;
          }
        }
        if (!page.nextCursor) return result;
        if (cursor === page.nextCursor) throw fail('JXL_INTERNAL', 'Storage repeated an archive list cursor.');
        cursor = page.nextCursor;
      }
    }
  };
  const store = new Proxy(inner, {get(target, property) {
    if (property === 'download') return download;
    if (property === 'head') return async (key, options) => logical(await physical(key, options));
    if (property === 'upload') return async options => {
      if (!jpeg(options.key)) return target.upload(options);
      const body = await readAll(options.body, {maxBytes: maxInputBytes, signal: options.signal});
      if (envelopeIdentity(body)) throw fail('JXL_INPUT', 'Private archived originals cannot be uploaded as JPEG sources.');
      return mutation(options.key, () => target.upload({...options, body}), options);
    };
    if (property === 'delete') return (key, options) => mutation(key, () => target.delete(key, options), options);
    const value = target[property]; return typeof value === 'function' ? value.bind(target) : value;
  }});
  return {store, originals};
}
