import {header, inspect} from 'jpegxl/metadata';
import {readAll} from './read-all.mjs';
import {digest} from './digest.mjs';
import {originalStorage} from './originals.mjs';
import {hostLimits, canRetireJpeg, deliveryOnly} from './host-policy.mjs';
import {originalGeometry, structuralDelivery, headerIncomplete, SOURCE_HEADER_BYTES, EXTENDED_SOURCE_HEADER_BYTES} from './structural-delivery.mjs';
import {COLOR_HEADER_BYTES, colorOf, isColor, sameColor, checkable} from './color.mjs';

const ACTIVE = Symbol.for('rapier-jxl.emdash.storage');
export function registerStorage(storage, scope) {
  if (typeof scope !== 'string' || !scope.length) throw new TypeError('Native storage requires its configured backend scope.');
  globalThis[ACTIVE] = {storage, scope};
  return storage;
}
export const activeStorage = () => globalThis[ACTIVE]?.storage ?? null;
export const activeStorageScope = () => globalThis[ACTIVE]?.scope ?? null;
export const isJpegKey = key => /\.(?:jpe?g|jpe|jfif)$/i.test(key);
export const hasSidecar = key => /\.(?:jpe?g|jpe|jfif|png|webp|avif)$/i.test(key);
const IMAGE = /\.(?:jpe?g|jpe|jfif|png|webp|avif)$/i;
const HASH = /^[a-f0-9]{64}$/;
const COPY_ID = /^[a-f0-9]{32}$/;
export const INITIAL_DELIVERY = '00000000000000000000000000000000';
const ROOT = '__rapier_jxl__/';
const OWNER = 'rapier-jxl/emdash';
const BOUNDED_COPY_BYTES = 8 * 1024 * 1024, MAX_STORAGE_BYTES = 256 * 1024 * 1024, MAX_RECORD_BYTES = 16 * 1024;
const utf8 = value => new TextEncoder().encode(value);
const same = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);
const direct = action => action();
const failure = (code, message, cause) => Object.assign(new Error(message, cause === undefined ? undefined : {cause}), {code});
function publicKey(key) {
  if (typeof key !== 'string' || !key || key.includes('\\') || key.includes('\0') ||
      key.split('/').some(part => !part || part === '.' || part === '..') || key.startsWith(ROOT))
    throw failure('JXL_INPUT', "Invalid media key; use a key within public storage.");
  return key;
}

// The reserved namespace is immutable outside this adapter. create() atomically refuses an existing key.
// Ownership records, never filename matches, authorize delivery and generation-specific cleanup.
// A claimed fidelity at least as strict as the server's floor: 'exact' only meets 'exact'; {quality: q} is met by
// 'exact' or a quality of q or more.
function meetsFloor(fidelity, floor) {
  if (fidelity === 'exact' || fidelity?.maxError === 0 || fidelity?.quality === 100) return true;
  if (floor === 'exact') return false;
  return typeof floor?.quality === 'number' && typeof fidelity?.quality === 'number' && fidelity.quality >= floor.quality;
}

export function withMediaCopies(inner, {maxPixels, maxInputBytes = 32 * 1024 * 1024, create, compareAndSet, originalBackend,
  cpuLimitMs, memoryLimitBytes} = {}) {
  if (maxPixels !== undefined && (!Number.isSafeInteger(maxPixels) || maxPixels < 1))
    throw failure('JXL_OPTIONS', "Invalid maxPixels; use a positive safe integer.");
  if (create !== undefined && typeof create !== 'function') throw failure('JXL_OPTIONS', "Invalid create; supply an atomic create-only function.");
  if (compareAndSet !== undefined && typeof compareAndSet !== 'function')
    throw failure('JXL_OPTIONS', "Invalid compareAndSet; supply a conditional write function.");
  let originals;
  const physicalStore = inner;
  const host = hostLimits(originalBackend?.platform ?? 'node', {cpuLimitMs, memoryLimitBytes});
  // The whole-byte copy path has no measured finite-host peak yet. An unconstrained Node host
  // uses its configured input allowance; finite hosts retain the existing copy bound.
  const unboundedNode = host.platform === 'node' && host.cpuLimitMs === null && host.memoryLimitBytes === null;
  const maxCopyBytes = Math.min(maxInputBytes, unboundedNode ? MAX_STORAGE_BYTES : BOUNDED_COPY_BYTES);
  if (originalBackend) {
    const wrapped = originalStorage(inner, {...originalBackend, create, compareAndSet, maxInputBytes, maxPixels,
      maxDeliveryBytes: maxCopyBytes,
      allowRetirement: canRetireJpeg(host),
      preserveDelivery: (key, result, options) => preserveArchiveDelivery(key, result, options),
      delivery: (key, generation, options = {}) => delivery(key, generation, options.signal, options.call)});
    inner = wrapped.store; originals = wrapped.originals;
  }
  async function io(action, signal) {
    signal?.throwIfAborted();
    try { const result = await action(); signal?.throwIfAborted(); return result; }
    catch (error) {
      signal?.throwIfAborted();
      if (error?.code === 'NOT_FOUND' || error?.code?.startsWith('JXL_')) throw error;
      throw failure('JXL_INTERNAL', "Invalid image result; report the input and options.", error);
    }
  }
  async function files(prefix, signal, call = direct) {
    const all = [], seen = new Set();
    for (let cursor; ;) {
      const page = await io(() => call(() => inner.list({prefix, limit: 100, signal, ...(cursor ? {cursor} : {})})), signal);
      all.push(...page.files.filter(file => file.key.startsWith(prefix)));
      if (!page.nextCursor) return all;
      if (seen.has(page.nextCursor)) throw failure('JXL_INTERNAL', "Invalid image result; report the input and options.");
      seen.add(page.nextCursor); cursor = page.nextCursor;
    }
  }
  async function read(key, maxBytes, signal, call = direct) {
    let file;
    try { file = await io(() => call(() => inner.download(key, {signal})), signal); }
    catch (error) { if (error?.code === 'NOT_FOUND') return null; throw error; }
    const bytes = await io(() => readAll(file.body, {maxBytes, signal}), signal);
    if (Number.isSafeInteger(file.size) && file.size !== bytes.length)
      throw failure('JXL_INPUT', "Wrong copy length; reload its record and retry.");
    return {...file, bytes, size: bytes.length};
  }
  const base = async key => ROOT + await digest(utf8(key)) + '.';
  const deliveryKey = async (key, generation) => await base(key) + generation + '.delivery.json';
  async function delivery(key, generation, signal, call = direct) {
    const keyName = await deliveryKey(key, generation);
    let file;
    try { file = await io(() => call(() => inner.download(keyName, {signal})), signal); }
    catch (error) {
      if (error?.code === 'NOT_FOUND') return {mode: 'copies', revision: INITIAL_DELIVERY, etag: null, size: 0};
      throw error;
    }
    let bytes;
    try { bytes = await io(() => readAll(file.body, {maxBytes: 2048, signal}), signal); }
    catch (error) {
      signal?.throwIfAborted();
      if (['JXL_INPUT', 'JXL_LIMIT'].includes(error?.code)) return {mode: 'original', revision: null, etag: null, size: 0};
      throw error;
    }
    let value;
    try { value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)); } catch {}
    if (value?.owner !== OWNER || value.kind !== 'delivery' || value.source !== key || value.generation !== generation ||
        Number.isSafeInteger(file.size) && file.size !== bytes.length ||
        !COPY_ID.test(value.revision ?? '') || !['copies', 'original'].includes(value.mode))
      return {mode: 'original', revision: null, etag: null, size: bytes.length};
    return {mode: value.mode, revision: value.revision, etag: file.etag, size: bytes.length};
  }
  const versionOf = file => typeof file?.version === 'string' && file.version.length ? digest(utf8(file.version)) : null;
  async function sourceHead(key, {signal, range, call = direct} = {}) {
    publicKey(key); signal?.throwIfAborted();
    let file, failed = false;
    try {
      const headed = typeof inner.head === 'function';
      file = await io(() => call(() => headed ? inner.head(key, {signal}) : inner.download(key, {signal, ...(range ? {range} : {})})));
      if (!file) return null;
      signal?.throwIfAborted();
      if (range && !headed && (file?.range?.offset !== range.offset || file.range.length !== range.length))
        throw failure('JXL_UNSUPPORTED', "Wrong source range; use a backend with range reads.");
      const version = await versionOf(file);
      if (range && !version) throw failure('JXL_UNSUPPORTED', "Missing generation; pass the captured source generation.");
      return {generation: version, size: file.size};
    } catch (error) {
      failed = true;
      signal?.throwIfAborted();
      if (error?.code === 'NOT_FOUND') return null;
      throw error;
    } finally {
      try { if (typeof file?.body?.cancel === 'function') await io(() => file.body.cancel()); }
      catch (error) { if (!failed) { signal?.throwIfAborted(); throw error; } }
      signal?.throwIfAborted();
    }
  }
  const generation = async (key, options) => (await sourceHead(key, options))?.generation ?? null;
  // Free publication reads the physical retained JPEG/PNG. Never pass this read through a logical archive download:
  // an existing archive on a host whose allowance changed must not trigger a cold restore inside a 10 ms request.
  async function physicalHead(key, {signal, call = direct} = {}) {
    if (!deliveryOnly(host) || typeof originalBackend?.head !== 'function')
      throw failure('JXL_UNSUPPORTED', "Missing host or source reader; configure a Free Worker with a storage head() function.");
    const file = await io(() => call(() => originalBackend.head(key, {signal})), signal);
    return file ? {generation: await versionOf(file), size: file.size} : null;
  }
  const sourceMimeType = key => isJpegKey(key) ? 'image/jpeg' : /\.png$/i.test(key) ? 'image/png' : null;
  async function readPhysicalHeader(key, before, limit, {signal, call = direct} = {}) {
    const length = Math.min(limit, before.size);
    const file = await io(() => call(() => physicalStore.download(key, {range: {offset: 0, length}, signal})), signal);
    try {
      if (file?.range?.offset !== 0 || file.range.length !== length)
        throw failure('JXL_UNSUPPORTED', "Wrong header range; use a backend with range reads.");
      if (file.size !== before.size || await versionOf(file) !== before.generation)
        throw failure('JXL_INPUT', "Original changed; reload its record and retry.");
      const bytes = await io(() => readAll(file.body, {maxBytes: length, signal}), signal);
      if (bytes.length !== length) throw failure('JXL_INPUT', "Wrong header length; reread the requested range.");
      return bytes;
    } finally { try { await file?.body?.cancel?.(); } catch {} }
  }
  async function originalHeader(key, before, {signal, call = direct} = {}) {
    if (!Number.isSafeInteger(before?.size) || before.size < 8 || before.size > maxInputBytes || !before.generation)
      throw failure('JXL_LIMIT', "Missing source size or generation; read both first.");
    const mimeType = sourceMimeType(key);
    let bytes = await readPhysicalHeader(key, before, SOURCE_HEADER_BYTES, {signal, call});
    try { return {geometry: originalGeometry(bytes, {mimeType, maxPixels}), bytes}; }
    catch (error) { if (!error?.incomplete || before.size <= SOURCE_HEADER_BYTES) throw error; }
    bytes = await readPhysicalHeader(key, before, EXTENDED_SOURCE_HEADER_BYTES, {signal, call});
    return {geometry: originalGeometry(bytes, {mimeType, maxPixels, maxHeaderBytes: EXTENDED_SOURCE_HEADER_BYTES}), bytes};
  }
  // An object's first bytes for its color (color.mjs): bounded to 64 KiB, or 256 KiB once when a JPEG/PNG header spans
  // past 64 KiB before SOS/IDAT. A backend that ignores the range, a short body, or another version gives null.
  async function firstBytes(key, size, version, {signal, call = direct} = {}, limit = COLOR_HEADER_BYTES) {
    const length = Math.min(limit, size);
    let file;
    try { file = await io(() => call(() => inner.download(key, {range: {offset: 0, length}, signal})), signal); }
    catch (error) { if (error?.code === 'NOT_FOUND') return null; throw error; }
    try {
      if (file?.range?.offset !== 0 || file.range.length !== length) return null;
      if (version && await digest(utf8(file.version ?? file.etag ?? '')) !== version) return null;
      const bytes = await io(() => readAll(file.body, {maxBytes: length, signal}), signal);
      return bytes.length === length ? bytes : null;
    } finally { try { await file?.body?.cancel?.(); } catch {} }
  }
  async function sourceHeader(key, before, options) {
    const first = await firstBytes(key, before.size, before.generation, options, COLOR_HEADER_BYTES);
    if (!first || before.size <= COLOR_HEADER_BYTES || !headerIncomplete(first, sourceMimeType(key))) return first;
    return firstBytes(key, before.size, before.generation, options, EXTENDED_SOURCE_HEADER_BYTES);
  }
  // A copy whose record binds no version (made before records did) is read whole once and checked against its record's
  // digest, as payload() does, so a header is never read from another object.
  async function copyHeader(owned, signal, call = direct) {
    if (owned.version) return firstBytes(owned.key, owned.bytes, owned.version, {signal, call});
    const bytes = await payload(owned, signal, call, true);
    return bytes ? bytes.subarray(0, Math.min(COLOR_HEADER_BYTES, bytes.length)) : null;
  }
  async function snapshot(key, {signal, call = direct} = {}) {
    publicKey(key);
    if (typeof call !== 'function') throw failure('JXL_OPTIONS', "Invalid storage dispatcher; pass a function.");
    const file = await read(key, maxInputBytes, signal, call);
    if (!file) return null;
    const sha256 = await digest(file.bytes);
    const generation = await versionOf(file);
    signal?.throwIfAborted();
    return {...file, sha256, generation};
  }
  async function deliveryState(key, {signal, call = direct, generation: capturedGeneration} = {}) {
    publicKey(key);
    const captured = capturedGeneration !== undefined ? capturedGeneration : await generation(key, {signal, call});
    if (!captured) return null;
    const state = await delivery(key, captured, signal, call);
    return {generation: captured, mode: state.mode, revision: state.revision};
  }
  async function selectDelivery(key, mode, {expectedGeneration, expectedRevision, signal, call = direct} = {}) {
    publicKey(key);
    if (!HASH.test(expectedGeneration ?? '') || !COPY_ID.test(expectedRevision ?? '') || typeof call !== 'function')
      throw failure('JXL_OPTIONS', "Invalid revision; refresh the library.");
    if (!compareAndSet) throw failure('JXL_UNSUPPORTED', "Conditional writes unavailable; configure compare-and-set writes.");
    if (await generation(key, {signal, call}) !== expectedGeneration)
      throw failure('JXL_INPUT', "Picture changed; refresh the library.");
    const prior = await delivery(key, expectedGeneration, signal, call);
    if (prior.revision !== expectedRevision || prior.etag === undefined)
      throw failure('JXL_INPUT', "Delivery setting changed; refresh the library.");
    const revision = crypto.randomUUID().replaceAll('-', ''), policyKey = await deliveryKey(key, expectedGeneration);
    const value = {owner: OWNER, kind: 'delivery', source: key, generation: expectedGeneration, revision, mode};
    let written, uncertain;
    try {
      written = await io(() => call(() => compareAndSet(policyKey, utf8(JSON.stringify(value)),
        {etag: prior.etag, contentType: 'application/json', signal})), signal);
    } catch (error) { uncertain = error; }
    if (uncertain) {
      const observed = await delivery(key, expectedGeneration, signal, call);
      if (observed.revision !== revision || observed.mode !== mode) throw uncertain;
    } else if (written !== true) throw failure('JXL_INPUT', "Delivery setting changed; refresh the library.");
    if (await generation(key, {signal, call}) !== expectedGeneration)
      throw failure('JXL_INPUT', "Picture changed; refresh the library.");
    return {generation: expectedGeneration, revision, mode};
  }
  async function readSource(key, offset, length, {generation: expectedGeneration, signal, call = direct} = {}) {
    publicKey(key); signal?.throwIfAborted();
    if (typeof call !== 'function') throw failure('JXL_OPTIONS', "Invalid storage dispatcher; pass a function.");
    if (typeof expectedGeneration !== 'string' || !HASH.test(expectedGeneration))
      throw failure('JXL_OPTIONS', "Missing generation; pass the captured source generation.");
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || offset > maxInputBytes - length)
      throw failure('JXL_LIMIT', "Range exceeds maxInputBytes; raise it or request fewer bytes.");
    let file;
    try {
      // Keep the returned body reachable if cancellation arrives during the download.
      file = await io(() => call(() => inner.download(key, {range: {offset, length}, signal})));
      signal?.throwIfAborted();
      if (!Number.isSafeInteger(file?.size) || file.size < 1)
        throw failure('JXL_INPUT', "Missing source size; supply its byte length.");
      if (file.size > maxInputBytes || offset > file.size - length)
        throw failure('JXL_LIMIT', "Range exceeds source or maxInputBytes; request fewer bytes.");
      if (file.range?.offset !== offset || file.range.length !== length)
        throw failure('JXL_UNSUPPORTED', "Wrong source range; use a backend with range reads.");
      const version = await versionOf(file);
      if (!version) throw failure('JXL_UNSUPPORTED', "Missing generation; pass the captured source generation.");
      if (version !== expectedGeneration) throw failure('JXL_INPUT', "Source changed; reload its record and retry.");
      const bytes = await io(() => readAll(file.body, {maxBytes: length, signal}), signal);
      if (bytes.length !== length) throw failure('JXL_INPUT', "Wrong source length; reread the requested range.");
      // A one-byte check also stays bounded for adapters that buffer downloads.
      if (await generation(key, {signal, range: {offset: 0, length: 1}, call}) !== expectedGeneration)
        throw failure('JXL_INPUT', "Source changed; reload its record and retry.");
      return bytes;
    } catch (error) {
      signal?.throwIfAborted();
      if (error?.code === 'NOT_FOUND') throw failure('JXL_INPUT', "Source changed; reload its record and retry.");
      throw error;
    } finally {
      try { Promise.resolve(file?.body?.cancel?.(signal?.aborted ? signal.reason : undefined)).catch(() => {}); } catch {}
    }
  }
  const original = file => file?.sha256 ?? null;
  async function record(file, key, prefix, signal, call = direct) {
    if (typeof file?.key !== 'string' || !file.key.startsWith(prefix)) return null;
    const match = /^([a-f0-9]{64})\.(main|w([1-9][0-9]*))\.([a-f0-9]{32})\.([a-f0-9]{64})\.json$/.exec(file.key.slice(prefix.length));
    if (!match) return null;
    let stored, value;
    try {
      stored = await read(file.key, MAX_RECORD_BYTES, signal, call);
      if (!stored) return null;
      value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(stored.bytes));
    } catch (error) {
      signal?.throwIfAborted();
      if (error?.code === 'JXL_INTERNAL') throw error;
      return null;
    }
    const result = value?.result;
    if (value?.owner !== OWNER || value.source !== key || value.generation !== match[1] || value.identity !== match[4] || value.sha256 !== match[5] ||
        !COPY_ID.test(value.deliveryRevision ?? '') ||
        (value.preservedFor !== undefined && !COPY_ID.test(value.preservedFor)) ||
        (value.version !== undefined && !HASH.test(value.version)) ||
        ((value.color !== undefined || value.sourceColor !== undefined) && !(isColor(value.color) && isColor(value.sourceColor))) ||
        !['active', 'retired'].includes(value.state) ||
        !Number.isSafeInteger(value.bytes) || value.bytes < 2 || value.bytes > maxCopyBytes ||
        result?.format !== 'jxl' || result.meetsTarget !== true || !['jpeg-bytes', 'pixels', 'lossy'].includes(result.kept) ||
        !Number.isSafeInteger(result.width) || !Number.isSafeInteger(result.height) ||
        result.width < 1 || result.height < 1 || !Number.isSafeInteger(result.width * result.height) ||
        maxPixels !== undefined && result.width * result.height > maxPixels ||
        (match[2] === 'main' ? value.kind !== 'sidecar' : value.kind !== 'variant' || result.width !== Number(match[3]))) return null;
    return {...value, width: result.width, height: result.height, key: file.key.slice(0, -5) + '.jxl', recordKey: file.key, recordBytes: stored.bytes, recordSize: stored.size,
      size: value.bytes, lastModified: file.lastModified};
  }
  async function records(key, generation, signal, slot = '', includeRetired = false, call = direct, listed = null) {
    const prefix = await base(publicKey(key)), targetPrefix = prefix + (generation ? generation + '.' : '') + (slot ? slot + '.' : ''), result = [];
    const entries = listed ? listed.filter(file => file.key.startsWith(targetPrefix)) : await files(targetPrefix, signal, call);
    for (const file of entries) {
      const owned = await record(file, key, prefix, signal, call);
      if (owned && (!generation || owned.generation === generation) && (includeRetired || owned.state === 'active')) result.push(owned);
    }
    return result;
  }
  // `checked` hashes the body against its stored checksum: attach and restoration do; the public GET does not (its copy was
  // checked when attached, and it serves the stored bytes with that checksum as the tag).
  async function payload(owned, signal, call = direct, checked = true, object = false) {
    let file;
    try { file = await read(owned.key, maxCopyBytes, signal, call); }
    catch (error) { if (['JXL_INPUT', 'JXL_LIMIT'].includes(error?.code) && !signal?.aborted) return null; throw error; }
    if (!file || file.size !== owned.bytes || checked && await digest(file.bytes) !== owned.sha256) return null;
    // An unhashed read is bound to the object attached: its stored version must be the one the record names.
    if (!checked && owned.version && (typeof (file.version ?? file.etag) !== 'string' || await digest(utf8(file.version ?? file.etag)) !== owned.version)) return null;
    let info;
    try { info = header(file.bytes); } catch { return null; }
    const rotated = info.orientation >= 5;
    if ((rotated ? info.height : info.width) !== owned.width || (rotated ? info.width : info.height) !== owned.height) return null;
    signal?.throwIfAborted();
    return object ? {bytes: file.bytes, version: file.version ?? file.etag} : file.bytes;
  }
  function ownership(owned, state) {
    return {owner: OWNER, source: owned.source, generation: owned.generation, identity: owned.identity,
      sha256: owned.sha256, bytes: owned.bytes, result: owned.result, kind: owned.kind, deliveryRevision: owned.deliveryRevision,
      ...(owned.preservedFor && {preservedFor: owned.preservedFor}),
      ...(owned.color && {color: owned.color, sourceColor: owned.sourceColor}), ...(owned.version && {version: owned.version}), state};
  }
  const retiredBytes = owned => utf8(JSON.stringify(ownership(owned, 'retired')));
  async function stateOf(owned, signal, call = direct) {
    const file = await read(owned.recordKey, MAX_RECORD_BYTES, signal, call);
    if (!file) return 'absent';
    // The copy's object version is bound into the record when it is attached; every other field must match exactly.
    let bare = file.bytes;
    try { const value = JSON.parse(new TextDecoder().decode(file.bytes)); if (value && typeof value.version === 'string') { delete value.version; bare = utf8(JSON.stringify(value)); } } catch { /* compared as written */ }
    const plain = {...owned}; delete plain.version;
    if (same(bare, retiredBytes(plain))) return 'retired';
    if (same(bare, utf8(JSON.stringify(ownership(plain, 'active'))))) return 'active';
    return 'changed';
  }
  // Retire an ownership record (terminal for its identity): false if it changed.
  async function retireRecord(owned, signal, call = direct) {
    const state = await stateOf(owned, signal, call);
    if (state === 'changed') return false;
    if (state !== 'retired') {
      let uncertain;
      try { await io(() => call(() => inner.upload({key: owned.recordKey, body: retiredBytes(owned),
        contentType: 'application/json', signal}))); }
      catch (error) { uncertain = error; }
      if (uncertain) {
        let observed;
        try { observed = await stateOf(owned, signal, call); }
        catch { throw uncertain; }
        if (observed !== 'retired') throw uncertain;
      }
    }
    return true;
  }
  async function remove(owned, signal, call = direct) {
    // The restoration identity is written in the immutable create-only ownership record.
    // A replacement at the same revision cannot retire it until the source generation changes.
    if (owned.preservedFor && await generation(owned.source, {signal, call}) === owned.generation) return false;
    // Admission is create-only; retirement is terminal for this identity.
    // Never delete an ownership key.
    if (!await retireRecord(owned, signal, call)) return false;
    // A delayed create for this retired identity may leave an orphan. It cannot
    // become active; reconciliation may collect it, but no later identity shares it.
    let file;
    try { file = await read(owned.key, maxCopyBytes, signal, call); }
    catch (error) { if (['JXL_INPUT', 'JXL_LIMIT'].includes(error?.code) && !signal?.aborted) return true; throw error; }
    if (!file || file.size !== owned.bytes || await digest(file.bytes) !== owned.sha256) return true;
    let uncertain;
    try { await io(() => call(() => inner.delete(owned.key, {signal})), signal); }
    catch (error) { uncertain = error; }
    if (uncertain && await read(owned.key, maxCopyBytes, signal, call)) throw uncertain;
    return true;
  }
  async function deliver(owned, bytes, signal, call = direct) {
    // Reconcile only refused or uncertain creates.
    let state, created, uncertain;
    try { created = await io(() => call(() => create(owned.key, bytes, {contentType: 'image/jxl', signal}))); }
    catch (error) { uncertain = error; }
    signal?.throwIfAborted();
    // create() answers true, or {created: true, version}: the stored object's own version, no extra read.
    const made = value => value === true || value?.created === true;
    if (!made(created)) {
      // Only an existing object or uncertain acknowledgement needs reconciliation.
      state = await stateOf(owned, signal, call);
      if (state === 'retired' || state === 'changed') return state;
      // An uncertain acknowledgement (or an existing object) is reconciled by reading the object: that same read names
      // its version, which the record then binds, exactly as an acknowledged create's answer does.
      const found = await payload(owned, signal, call, true, true);
      if (!found) {
        if (uncertain) throw uncertain;
        return 'changed';
      }
      if (state === 'active') return 'active';
      if (typeof found.version === 'string' && found.version) created = {created: false, version: found.version};
    }
    // Bind the record to the stored object's own version: a later GET refuses any other object, with no hashing.
    // (Records made before this, and stores whose create answers plain true and whose reads name no version, stay unbound.)
    if (!owned.version && typeof created?.version === 'string' && created.version) {
      const version = await digest(utf8(created.version)), bound = {...owned, version}, bytes = utf8(JSON.stringify(ownership(bound, 'active')));
      if (bytes.length + 1 <= MAX_RECORD_BYTES) { owned.version = version; owned.recordBytes = bytes; owned.recordSize = bytes.length; }
    }
    uncertain = undefined; created = undefined;
    try { created = await io(() => call(() => create(owned.recordKey, owned.recordBytes,
      {contentType: 'application/json', signal}))); }
    catch (error) { uncertain = error; }
    signal?.throwIfAborted();
    if (made(created)) return 'active'; // Acknowledged atomic create owns these exact bytes.
    state = await stateOf(owned, signal, call);
    if (state === 'absent' && uncertain) throw uncertain;
    return state;
  }
  async function dropGeneration(key, previous, signal) {
    if (previous) for (const owned of await records(key, previous, signal, '', true)) await remove(owned, signal);
  }
  async function current(key, {signal} = {}) {
    try {
      const value = await generation(key, {signal});
      if (!value) return [];
      const selected = await delivery(key, value, signal);
      return selected.mode === 'copies' ? (await records(key, value, signal)).filter(file => file.deliveryRevision === selected.revision) : [];
    } catch (error) { if (error?.code === 'JXL_LIMIT' && !signal?.aborted) return []; throw error; }
  }
  async function attach(key, result, {source, expectedGeneration, expectedDeliveryRevision = INITIAL_DELIVERY,
    signal, replace = false, jobIdentity, floor, receipt: verified, sourcePixels, call = direct, fence} = {}, variant, structural, preservedFor) {
    publicKey(key);
    const {width, height} = result ?? {};
    const refused = reason => ({key, ...(variant ? {width} : {}), stored: null, reason});
    signal?.throwIfAborted();
    if (typeof call !== 'function') throw failure('JXL_OPTIONS', "Invalid storage dispatcher; pass a function.");
    if (fence !== undefined && typeof fence !== 'function') throw failure('JXL_OPTIONS', "Invalid publication guard; pass its server function.");
    if (structural && (!deliveryOnly(host) || !HASH.test(expectedGeneration ?? '') || verified !== undefined || jobIdentity !== undefined))
      throw failure('JXL_UNSUPPORTED', "Delivery unsupported here; use a Free Worker or server verification.");
    if (structural && replace)
      throw failure('JXL_UNSUPPORTED', "Delivery would replace copy history; clear it before selecting a new delivery.");
    if (!IMAGE.test(key) || (!variant && !hasSidecar(key))) return refused('not_image_key');
    if (!structural && !HASH.test(source ?? '')) return refused('source_required');
    if (expectedGeneration !== undefined && !HASH.test(expectedGeneration))
      throw failure('JXL_OPTIONS', "Invalid generation; pass the source version digest.");
    if (!COPY_ID.test(expectedDeliveryRevision ?? ''))
      throw failure('JXL_OPTIONS', "Invalid revision; pass the revision captured before conversion.");
    if (jobIdentity !== undefined && (typeof jobIdentity !== 'string' || !COPY_ID.test(jobIdentity) || expectedGeneration === undefined))
      throw failure('JXL_OPTIONS', "Invalid rendition; pass its server ID and source generation.");
    if (typeof replace !== 'boolean') throw failure('JXL_OPTIONS', "Invalid replace; pass true or false.");
    if (result?.meetsTarget !== true) return refused(result?.reason?.code ?? 'JXL_TARGET');
    if (result.format !== 'jxl' || !['jpeg-bytes', 'pixels', 'lossy'].includes(result.kept)) return refused('JXL_INPUT');
    const value = result.bytes;
    if (!(value instanceof Uint8Array) || value.byteLength < 2 || value.byteLength > maxCopyBytes) return refused('not_jxl');
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
        !Number.isSafeInteger(width * height) || maxPixels !== undefined && width * height > maxPixels)
      return refused('dimensions_differ');
    const bytes = value.slice(), {bytes: ignored, verification: ignoredReceipt, assurance: ignoredAssurance, ...metadata} = result;
    const savedResult = structuredClone(metadata);
    // Only a private server caller supplies this argument. An HTTP result's `verification` is never authority.
    // The driver already checked its immutable output parts and verified the saved source in bounded advances.
    if (verified !== undefined) {
      if (!jobIdentity || !expectedGeneration || verified?.verified !== true || !(sourcePixels ? verified.source?.kind === 'pixels' && savedResult.source?.kind === 'pixels' &&
              verified.source.digest === savedResult.source.digest && /^sha256:[a-f0-9]{64}$/.test(verified.source.digest)
            : verified.source?.kind === 'bytes' && verified.source.digest === 'sha256:' + source) || !/^sha256:[a-f0-9]{64}$/.test(verified.outputDigest ?? '') ||
          verified.width !== width || verified.height !== height || verified.format !== savedResult.format ||
          verified.kept !== savedResult.kept || JSON.stringify(verified.fidelity) !== JSON.stringify(savedResult.fidelity))
        throw failure('JXL_INPUT', "Receipt mismatch; verify its original and candidate.");
    } else if (!structural) {
      let info;
      try { info = await inspect(bytes, {details: ['layout'], maxInputBytes: maxCopyBytes, maxPixels, maxBoxes: 4096}); }
      catch { signal?.throwIfAborted(); return refused('not_jxl'); }
      const rotated = info.orientation >= 5;
      if ((rotated ? info.height : info.width) !== width || (rotated ? info.width : info.height) !== height)
        return refused('dimensions_differ');
    }
    signal?.throwIfAborted();
    const before = structural ? await physicalHead(key, {signal, call}) : verified ? await sourceHead(key, {signal, call}) : await snapshot(key, {signal, call});
    if (!before || !structural && !verified && original(before) !== source || expectedGeneration !== undefined && before.generation !== expectedGeneration)
      return refused('key_changed');
    if (!variant && bytes.length >= before.size) return refused('not_smaller');
    if (!create || !before.generation) return refused('conditional_write_required');
    // A durable command captured its delivery revision when it was prepared. Reuse that admission value so an
    // orphan retry still leaves room for the runner's read/finish/save calls; final publication and readers fence it.
    const selected = jobIdentity === undefined ? await delivery(key, before.generation, signal, call) :
      {mode: 'copies', revision: expectedDeliveryRevision};
    if (selected.mode !== 'copies' || selected.revision !== expectedDeliveryRevision) return refused('delivery_changed');
    // The ordinary route verifies against the stored original, on first attach as on replace. The
    // explicitly authorized Free route checks structure/geometry only; both enforce the captured fidelity setting.
    if (floor !== undefined && !meetsFloor(savedResult.fidelity, floor)) return refused('JXL_TARGET');
    const snapshotStart = bytes => {
      const first = bytes.subarray(0, COLOR_HEADER_BYTES);
      return bytes.length > COLOR_HEADER_BYTES && headerIncomplete(first, sourceMimeType(key))
        ? bytes.subarray(0, EXTENDED_SOURCE_HEADER_BYTES) : first;
    };
    let receipt = verified, sourceStart = !checkable(key) || structural ? null : verified ? undefined : snapshotStart(before.bytes);
    if (structural) {
      const {geometry, bytes: head} = await originalHeader(key, before, {signal, call});
      sourceStart = head;
      savedResult.assurance = await structuralDelivery({...savedResult, bytes}, geometry, structural.selected,
        {width: structural.width, maxPixels});
    } else if (!receipt) {
      try { receipt = await (await import('jpegxl/verify')).verify(before.bytes.slice(), {...savedResult, bytes}, {maxPixels, signal}); }
      catch (error) { signal?.throwIfAborted(); if (replace || !error?.verification) throw error; receipt = error.verification; }
    }
    if (!structural && receipt?.verified !== true) {
      if (replace) throw failure('JXL_INPUT', "Unverified replacement; verify it against its original.");
      return refused('not_verified');
    }
    // Ruling 91: the copy's color and its source's, both read from headers, ride in its ownership record.
    if (sourceStart === undefined) sourceStart = await sourceHeader(key, before, {signal, call});
    const sourceColor = sourceStart ? await colorOf(sourceStart) : null, color = sourceColor ? await colorOf(bytes) : null;
    const slot = variant ? `w${width}` : 'main', previous = replace ? await records(key, before.generation, signal, slot, false, call) : [];
    // A persisted job reuses its identity; ordinary admissions are independent.
    const identity = jobIdentity ?? crypto.randomUUID().replaceAll('-', '');
    if (!COPY_ID.test(identity)) throw failure('JXL_INTERNAL', "Invalid image result; report the input and options.");
    const sha256 = verified ? verified.outputDigest.slice(7) : await digest(bytes), prefix = await base(key), stem =
      `${prefix}${before.generation}.${slot}.${identity}.${sha256}`;
    const copyKey = stem + '.jxl', recordKey = stem + '.json';
    const valueRecord = {owner: OWNER, source: key, generation: before.generation, identity, sha256, bytes: bytes.length,
      result: savedResult, kind: variant ? 'variant' : 'sidecar', deliveryRevision: selected.revision,
      ...(preservedFor && {preservedFor}), ...(color && {color, sourceColor}), state: 'active'};
    const recordBytes = utf8(JSON.stringify(valueRecord));
    // The terminal state "retired" adds one byte to the serialized active record.
    if (recordBytes.length + 1 > MAX_RECORD_BYTES) throw failure('JXL_LIMIT', "Ownership record too large; reduce its contents.");
    const owned = {...valueRecord, width, height, key: copyKey, recordKey, recordBytes, recordSize: recordBytes.length, size: bytes.length};
    const changed = fence && await fence();
    if (changed) return refused(changed);
    // Saved jobs replay uncertain writes under this identity. A confirmed refusal retires it. A saved job retires its
    // ownership record here and names the payload in its refusal (`collect`): its next call removes it (collect()), so
    // each call stays within the host's storage calls.
    let kept = false, retire = jobIdentity === undefined, fenced = false, answer;
    try {
      const state = await deliver(owned, bytes, signal, call);
      if (state !== 'active') { retire = true; answer = refused(state === 'retired' ? 'copy_retired' : 'copy_exists'); }
      else if ((structural ? (await physicalHead(key, {signal, call}))?.generation : await generation(key, {signal, call})) !== before.generation) {
        retire = true; answer = refused('key_changed');
      }
      else {
        const latest = await delivery(key, before.generation, signal, call);
        let changed;
        if (latest.mode !== 'copies' || latest.revision !== selected.revision) {
          retire = true; fenced = true; answer = refused('delivery_changed');
        } else if (fence && (changed = await fence())) {
          retire = true; answer = refused(changed);
        } else {
          kept = true;
          // Freeze the predecessor set once. A distinct late admission has another
          // identity, even for the same bytes, and cannot be deleted by this cleanup.
          for (const prior of previous) if (prior.key !== copyKey) await remove(prior, signal, call);
          answer = {key, ...(variant ? {width} : {}), stored: variant ? 'variant' : 'sidecar', reason: null,
            jxlBytes: bytes.length, result: savedResult, ...(replace && receipt ? {receipt} : {})};
        }
      }
    } finally {
      if (!kept && retire) {
        try {
          if (jobIdentity === undefined) await remove(owned, undefined, call);
          else if ((fenced || await retireRecord(owned, undefined, call)) && answer) answer.collect = collectable(owned);
        } catch (error) { signal?.throwIfAborted(); throw error; }
      }
    }
    return answer;
  }
  // Ruling 91 (rulings 258 and 277): a copy's color against its source's. A copy made with both colors carries them in
  // its ownership record; an older copy, once checked, has a create-only record beside it whose name holds the answer,
  // so a listing alone tells it: 'same', 'differs' (stale: never delivered, the item is a candidate again) or
  // 'unchecked' (delivered as before, checked by the optimizer's next run).
  const colorKey = (owned, verdict) => owned.recordKey.slice(0, -5) + `.color.${verdict}.json`;
  function colorState(owned, names) {
    if (owned.color) return sameColor(owned.color, owned.sourceColor) ? 'same' : 'differs';
    if (!checkable(owned.source)) return 'unknown';
    return names.has(colorKey(owned, 'differs')) ? 'differs' : names.has(colorKey(owned, 'same')) ? 'same' : 'unchecked';
  }
  // Check the current main copies a listing shows unchecked: the source's header and each copy's header, no decode;
  // then the create-only record. A run stopped before the record leaves the copy unchecked; no key is overwritten.
  async function checkColor(key, {signal, call = direct} = {}) {
    publicKey(key);
    if (typeof call !== 'function') throw failure('JXL_OPTIONS', "Invalid storage dispatcher; pass a function.");
    if (!create) return {checked: 0, differs: 0, reason: 'conditional_write_required'};
    if (!checkable(key)) return {checked: 0, differs: 0, reason: 'color_unread'};
    const head = await sourceHead(key, {signal, call});
    if (!head?.generation) return {checked: 0, differs: 0, reason: 'key_changed'};
    const selected = await delivery(key, head.generation, signal, call);
    if (selected.mode !== 'copies') return {checked: 0, differs: 0};
    const listed = await files(await base(key) + head.generation + '.main.', signal, call), names = new Set(listed.map(file => file.key));
    const copies = (await records(key, head.generation, signal, 'main', false, call, listed))
      .filter(owned => owned.kind === 'sidecar' && owned.deliveryRevision === selected.revision && colorState(owned, names) === 'unchecked');
    if (!copies.length) return {checked: 0, differs: 0};
    const start = await sourceHeader(key, head, {signal, call}), sourceColor = start && await colorOf(start);
    // No verdict without both headers read whole: the copy stays unchecked.
    if (!sourceColor) return {checked: 0, differs: 0, reason: 'color_unread'};
    let checked = 0, differs = 0;
    for (const owned of copies) {
      const copyStart = await copyHeader(owned, signal, call), color = copyStart && await colorOf(copyStart);
      if (!color) continue;
      const verdict = sameColor(color, sourceColor) ? 'same' : 'differs';
      const body = utf8(JSON.stringify({owner: OWNER, kind: 'color', source: key, generation: owned.generation,
        identity: owned.identity, sha256: owned.sha256, color, sourceColor}));
      // A false answer is a concurrent check's record: it was read from the same immutable copy and generation.
      await io(() => call(() => create(colorKey(owned, verdict), body, {contentType: 'application/json', signal})), signal);
      checked++; if (verdict === 'differs') differs++;
    }
    return {checked, differs};
  }
  // A refused copy's identity as JSON, for collect(). Delivery revision changes already fence its readers.
  const collectable = ({source, generation, identity, sha256, bytes, result, kind, deliveryRevision, color, sourceColor, key, recordKey}) =>
    ({source, generation, identity, sha256, bytes, result, kind, deliveryRevision, ...(color && {color, sourceColor}), key, recordKey});
  // Retire a refused copy and remove its payload (attach's `collect`); only its own bytes are deleted.
  async function collect(copy, {signal, call = direct} = {}) {
    if (typeof call !== 'function') throw failure('JXL_OPTIONS', "Invalid storage dispatcher; pass a function.");
    const prefix = typeof copy?.source === 'string' && IMAGE.test(copy.source) ? await base(copy.source) : null;
    if (!prefix || !HASH.test(copy.generation ?? '') || !COPY_ID.test(copy.identity ?? '') || !HASH.test(copy.sha256 ?? '') ||
        !COPY_ID.test(copy.deliveryRevision ?? '') ||
        !['sidecar', 'variant'].includes(copy.kind) || !Number.isSafeInteger(copy.bytes) || typeof copy.key !== 'string' ||
        !copy.key.startsWith(prefix + copy.generation + '.') || !copy.key.endsWith(`.${copy.identity}.${copy.sha256}.jxl`) ||
        copy.recordKey !== copy.key.slice(0, -4) + '.json' ||
        ((copy.color !== undefined || copy.sourceColor !== undefined) && !(isColor(copy.color) && isColor(copy.sourceColor))))
      throw failure('JXL_INPUT', "Invalid retired copy; pass one returned by attach.");
    return remove({...copy, owner: OWNER}, signal, call);
  }

  // The originals controller invokes this in a dedicated advance before restoring physical JPEG bytes.
  // Its archive receipt is server-owned. Reuse that authority for the identical bounded delivery payload;
  // neither browser metadata nor another encoder/verifier can authorize this transition.
  async function preserveArchiveDelivery(key, result, options = {}) {
    const {signal, call = direct, source, expectedGeneration, expectedDeliveryRevision, receipt, jobIdentity, preservationId} = options;
    if (!COPY_ID.test(preservationId ?? ''))
      throw failure('JXL_INPUT', "Missing restore record; reload it.");
    const eligible = async () => {
      const current = await deliveryState(key, {signal, call});
      return current?.generation === expectedGeneration && current.mode === 'copies' && current.revision === expectedDeliveryRevision;
    };
    if (!await eligible()) return {preserved: true, reason: 'no_longer_selected'};
    if (!(result?.bytes instanceof Uint8Array) || result.bytes.length < 2 || result.bytes.length > maxCopyBytes)
      throw failure('JXL_LIMIT', "Archive copy too large; keep its current delivery.");
    if (result.kept !== 'jpeg-bytes' || result.fidelity !== 'exact' || receipt?.verified !== true ||
        receipt.kind !== 'jpeg-restore' || receipt.format !== 'jxl' || receipt.kept !== 'jpeg-bytes' || receipt.fidelity !== 'exact' ||
        receipt.source?.kind !== 'bytes' || receipt.source.digest !== 'sha256:' + source ||
        receipt.referenceDigest !== 'sha256:' + source || receipt.restoredDigest !== 'sha256:' + source ||
        receipt.outputDigest !== 'sha256:' + await digest(result.bytes))
      throw failure('JXL_INPUT', "Archive receipt mismatch; verify its original and candidate.");
    const published = await attach(key, result, {source, expectedGeneration, expectedDeliveryRevision, receipt,
      jobIdentity, signal, call}, false, undefined, preservationId);
    if (published?.stored === 'sidecar') return {preserved: true, publication: published};
    // A concurrent source/delivery choice makes this old archive ineligible. Confirm that fence again;
    // an uncertain write, a retired same identity, or any other refusal leaves restoration blocked.
    if (['key_changed', 'delivery_changed'].includes(published?.reason) && !await eligible()) {
      if (published.collect) await collect(published.collect, {signal, call});
      return {preserved: true, reason: 'no_longer_selected'};
    }
    throw failure('JXL_IO', "Archive delivery unconfirmed; reconcile its publication before retrying.");
  }

  const extra = {
    maxPixels,
    maxInputBytes,
    host,
    originals,
    sourceHead,
    physicalSourceHead: physicalHead,
    readSource,
    deliveryState,
    restoreOriginal: (key, options) => selectDelivery(key, 'original', options),
    resumeCopies: (key, options) => selectDelivery(key, 'copies', options),
    fingerprint: async (key, {signal} = {}) => original(await snapshot(key, {signal})),
    async sourceSnapshot(key, options) {
      const file = await snapshot(key, options);
      if (!file) return null;
      if (!file.generation) throw failure('JXL_INPUT', "Missing generation; pass the source generation.");
      const selected = await delivery(key, file.generation, options?.signal, options?.call);
      // Bind verification admission to the actual original, never a browser's smaller output or a plugin default.
      // The public reader supplies geometry without decoding pixels. An unreadable header supplies no bound.
      let geometry;
      if (maxPixels === undefined) {
        try {
          const info = await inspect(file.bytes, {maxInputBytes});
          geometry = {width: info.width, height: info.height};
        } catch { options?.signal?.throwIfAborted(); }
      }
      return {bytes: file.bytes, contentType: file.contentType,
        delivery: {mode: selected.mode, revision: selected.revision},
        source: {generation: file.generation, sha256: file.sha256, byteLength: file.bytes.length,
          deliveryRevision: selected.revision, ...geometry}};
    },
    currentCopies: current,
    async upload(options) {
      publicKey(options.key);
      const before = IMAGE.test(options.key) ? await generation(options.key, {signal: options.signal}) : null;
      const result = await inner.upload(options);
      // A store whose version follows the content answers the same generation for the same bytes: its copies stay.
      if (before && await generation(options.key, {signal: options.signal}) !== before) await dropGeneration(options.key, before, options.signal);
      return result;
    },
    async delete(key, options) {
      publicKey(key);
      const before = IMAGE.test(key) ? await generation(key, options) : null;
      const result = await inner.delete(key, options);
      await dropGeneration(key, before, options?.signal);
      return result;
    },
    download(key, options) { return inner.download(publicKey(key), options); },
    getPublicUrl(key) { return inner.getPublicUrl(publicKey(key)); },
    stored(key, {signal} = {}) { return read(publicKey(key), maxInputBytes, signal); },
    exists(key, options) { return typeof key === 'string' && key.startsWith(ROOT) ? Promise.resolve(false) : inner.exists(publicKey(key), options); },
    async list(options) {
      const page = await inner.list(options);
      return {...page, files: page.files.filter(file => !file.key.startsWith(ROOT))};
    },
    async family(key, {signal, _inspect} = {}) {
      publicKey(key);
      const head = IMAGE.test(key) ? await sourceHead(key, {signal}) : null;
      const originalFiles = (await files(key, signal)).filter(file => file.key === key), prefix = await base(key);
      const prefixFiles = await files(prefix, signal), listing = new Map(prefixFiles.map(file => [file.key, file]));
      const owned = await records(key, null, signal, '', true, direct, prefixFiles);
      const all = [...originalFiles];
      const revisionKey = prefix + 'revision.json';
      if (listing.has(revisionKey)) {
        let revision;
        try {
          const stored = await read(revisionKey, MAX_RECORD_BYTES, signal);
          const value = stored && JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(stored.bytes));
          if (value?.owner === OWNER && value.kind === 'revision' && value.source === key &&
              /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.version) &&
              (value.stat === null || Array.isArray(value.stat) && value.stat.length === 6 && value.stat.every(v => typeof v === 'string' && /^-?\d+$/.test(v))))
            revision = {key: revisionKey, size: stored.size};
        } catch (error) {
          signal?.throwIfAborted();
          if (error?.code === 'JXL_INTERNAL') throw error;
        }
        if (revision) all.push(revision);
      }
      for (const item of owned) {
        all.push({key: item.recordKey, size: item.recordSize});
        if (listing.has(item.key)) all.push(listing.get(item.key));
      }
      const deliveries = new Map();
      for (const file of listing.values()) {
        const match = /^([a-f0-9]{64})\.delivery\.json$/.exec(file.key.slice(prefix.length));
        if (match) {
          const selected = await delivery(key, match[1], signal);
          deliveries.set(match[1], selected);
          if (selected.revision) all.push({key: file.key, size: selected.size});
        }
      }
      if (originals) all.push(...await originals.family(key, {signal}));
      if (_inspect) { _inspect.head = head; _inspect.owned = owned; _inspect.deliveries = deliveries; _inspect.names = new Set(listing.keys()); }
      return all;
    },
    async librarySnapshot(key, {signal} = {}) {
      const inspectState = {};
      const all = await extra.family(key, {signal, _inspect: inspectState});
      const main = all.find(file => file.key === key);
      if (!main) return {family: all, main: null};
      const head = IMAGE.test(key) ? inspectState.head : await sourceHead(key, {signal});
      if (!head?.generation) return {family: all, main, policy: null};
      const selected = inspectState.deliveries.get(head.generation) ?? await delivery(key, head.generation, signal);
      const policy = {generation: head.generation, mode: selected.mode, revision: selected.revision};
      const copies = selected.mode === 'copies'
        ? inspectState.owned.filter(item => item.state === 'active' && item.generation === head.generation && item.deliveryRevision === selected.revision)
        : [];
      let side = null, color;
      if (hasSidecar(key)) {
        const archived = originals && isJpegKey(key) ? await originals.rendition(key, {signal}) : null;
        for (const file of copies.filter(item => item.kind === 'sidecar').sort((a, b) => a.size - b.size)) {
          if (archived && file.size >= archived.bytes.length) break;
          const state = colorState(file, inspectState.names);
          if (state === 'differs') continue;
          const bytes = await extra.readVariant(file, {signal, _verified: {record: file, source: head}});
          if (bytes) { side = {...file.result, bytes, etag: file.sha256.slice(0, 32)}; color = state; break; }
        }
        side ??= archived;
      }
      return {family: all, main, policy, copies, side, ...(color && {color})};
    },
    // EmDash has no media delete hook, so a copy of a picture deleted behind this adapter stays. One bounded step of the
    // scheduled sweep: it reads up to `limit` ownership records of one listing page from `cursor` and retires and
    // removes the copy of each whose source is gone (remove() above). A source that is there, a record that is not
    // ours and every other object are left as they are. Returns the cursor for the next step, null after the last page.
    async sweepCopies({cursor, limit = 25, signal, call = direct} = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw failure('JXL_OPTIONS', "Invalid limit; use 1 to 100.");
      // One listing per first hex digit of a record's name: EmDash's local storage lists only the names that start with
      // the prefix's last segment, so the whole folder cannot be listed at once. The cursor is "<digit>:<listing cursor>".
      const at = /^([0-9a-f]):(.*)$/.exec(cursor ?? '0:');
      if (!at) throw failure('JXL_OPTIONS', "Invalid cursor; pass the preceding step's cursor.");
      const page = await io(() => call(() => inner.list({prefix: ROOT + at[1], limit, signal, ...(at[2] ? {cursor: at[2]} : {})})), signal);
      const next = page.nextCursor ? at[1] + ':' + page.nextCursor : at[1] === 'f' ? null : (parseInt(at[1], 16) + 1).toString(16) + ':';
      const result = {examined: 0, removed: 0, cursor: next};
      for (const file of page.files.filter(item => item.key.startsWith(ROOT))) {
        const match = /^[a-f0-9]{64}\.[a-f0-9]{64}\.(?:main|w[1-9][0-9]*)\.[a-f0-9]{32}\.[a-f0-9]{64}\.json$/.exec(file.key.slice(ROOT.length));
        if (!match) continue;
        result.examined++;
        const stored = await read(file.key, MAX_RECORD_BYTES, signal, call).catch(error => { signal?.throwIfAborted(); return null; });
        let source;
        try { source = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(stored.bytes)); } catch { continue; }
        if (source?.owner !== OWNER || typeof source.source !== 'string') continue;
        try { publicKey(source.source); } catch { continue; }
        // The record names its source, and the source's key names the record's family.
        const prefix = await base(source.source);
        if (!file.key.startsWith(prefix)) continue;
        if (await sourceHead(source.source, {signal, call})) continue;
        const owned = await record(file, source.source, prefix, signal, call);
        if (!owned) continue;
        // A retired record whose copy a stopped remove() left behind: the copy is collected; once gone, it is skipped.
        if (owned.state === 'retired' && !await read(owned.key, maxCopyBytes, signal, call).catch(error => { signal?.throwIfAborted(); return null; })) continue;
        if (await remove(owned, signal, call)) result.removed++;
      }
      return result;
    },
    attach: (key, result, options) => attach(key, result, options, false),
    // This private native operation cannot archive/replace the source. Browser receipts stay result metadata;
    // only this configured host and the server's geometry check select the structural admission branch.
    attachDelivery(key, result, {settings: selected, width, ...options} = {}) {
      return attach(key, result, options, width !== undefined, {selected: structuredClone(selected), width});
    },
    collect,
    checkColor,
    attachVariant(key, width, result, options) {
      if (!Number.isSafeInteger(width) || width < 16)
        return Promise.resolve({key, width, stored: null, reason: 'width'});
      if (result?.width !== width)
        return Promise.resolve({key, width, stored: null, reason: 'dimensions_differ'});
      return attach(key, result, options, true);
    },
    async sidecar(key, {signal} = {}) {
      if (!hasSidecar(key)) return null;
      const archived = originals && isJpegKey(key) ? await originals.rendition(key, {signal}) : null;
      let head;
      try { head = await sourceHead(key, {signal}); }
      catch (error) { if (error?.code === 'JXL_LIMIT' && !signal?.aborted) return archived; throw error; }
      if (!head?.generation) return archived;
      const selected = await delivery(key, head.generation, signal);
      if (selected.mode !== 'copies') return archived;
      const listed = await files(await base(key) + head.generation + '.main.', signal), names = new Set(listed.map(file => file.key));
      const active = (await records(key, head.generation, signal, 'main', false, direct, listed))
        .filter(file => file.deliveryRevision === selected.revision && file.kind === 'sidecar' && colorState(file, names) !== 'differs')
        .sort((a, b) => a.size - b.size);
      for (const file of active) {
        if (archived && file.size >= archived.bytes.length) break;
        const bytes = await extra.readVariant(file, {signal, _verified: {record: file, source: head}});
        if (bytes) return {...file.result, bytes, etag: file.sha256.slice(0, 32)};
      }
      return archived;
    },
    async variants(key, options) {
      const chosen = new Map();
      for (const file of await current(key, options)) if (file.kind === 'variant' && (!chosen.has(file.width) || chosen.get(file.width).size > file.size)) chosen.set(file.width, file);
      return [...chosen.values()].sort((a, b) => a.width - b.width);
    },
    async readVariant(file, {signal, _verified} = {}) {
      if (!file || typeof file.source !== 'string') return null;
      const prefix = await base(file.source);
      const latest = _verified?.record ?? await record({key: file.recordKey ?? ''}, file.source, prefix, signal);
      if (!latest || latest.state !== 'active' || latest.key !== file.key) return null;
      const source = _verified?.source ?? await sourceHead(file.source, {signal});
      if (latest.generation !== source?.generation || latest.kind === 'sidecar' &&
          (!Number.isSafeInteger(source.size) || latest.bytes >= source.size)) return null;
      const bytes = await payload(latest, signal, direct, false);
      if (await generation(file.source, {signal}) !== latest.generation) return null;
      const selected = await delivery(file.source, latest.generation, signal);
      if (selected.mode !== 'copies' || selected.revision !== latest.deliveryRevision) return null;
      return bytes;
    }
  };
  return new Proxy(inner, {get(target, key) {
    if (Object.hasOwn(extra, key)) return extra[key];
    const value = target[key];
    return typeof value === 'function' ? value.bind(target) : value;
  }});
}
