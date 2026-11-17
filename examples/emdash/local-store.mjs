import {dirname, join, resolve, sep} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {link, lstat, mkdir, readFile, realpath, rename, unlink, utimes, writeFile} from 'node:fs/promises';
import {readAll} from './read-all.mjs';

// One server process per directory. Persistent revisions also bind copies after a restart.
const STATE = Symbol.for('rapier-jxl.emdash.local-store');
const {locks} = globalThis[STATE] ??= {locks: new Map()};
const PRIVATE = '__rapier_jxl__/', OWNER = 'rapier-jxl/emdash', MAX_REVISION_BYTES = 2048;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const publicSource = key => !key.startsWith(PRIVATE) && /\.(?:jpe?g|jpe|jfif|png|webp|avif)$/i.test(key);
const sameStat = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const invalid = message => Object.assign(new Error(message), {code: 'JXL_INPUT'});
const cancel = body => { try { Promise.resolve(body?.cancel?.()).catch(() => {}); } catch {} };
const contentType = key => /\.(?:jpe?g|jpe|jfif)$/i.test(key) ? 'image/jpeg' : /\.png$/i.test(key) ? 'image/png' :
  /\.jxl$/i.test(key) ? 'image/jxl' : /\.webp$/i.test(key) ? 'image/webp' : /\.avif$/i.test(key) ? 'image/avif' :
    /\.json$/i.test(key) ? 'application/json' : 'application/octet-stream';
export function localStore(inner, directory, maxBytes = 256 * 1024 * 1024) {
  const root = resolve(directory), privateDirectory = join(root, PRIVATE);
  function filePath(key) {
    if (typeof key !== 'string' || !key || key.includes('\0')) throw invalid("key: within storage directory");
    const path = resolve(root, key.replace(/^\//, ''));
    if (!path.startsWith(root + sep)) throw invalid("key: within storage directory");
    return path;
  }
  async function confinedPath(key) {
    const target = filePath(key);
    try { if ((await lstat(target)).isSymbolicLink()) throw invalid("media path: no symlinks"); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    let baseReal;
    try { baseReal = await realpath(root); } catch (error) { if (error.code === 'ENOENT') baseReal = root; else throw error; }
    for (let current = dirname(target); current.startsWith(root + sep); current = dirname(current)) {
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink()) throw invalid("media path: no symlinks");
        const actual = await realpath(current);
        if (actual !== baseReal && !actual.startsWith(baseReal + sep))
          throw invalid("key: within storage directory");
        break;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    try {
      const leaf = await lstat(target);
      if (leaf.isSymbolicLink()) throw invalid("media file: regular file");
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return target;
  }
  const revisionPath = key => join(privateDirectory, createHash('sha256').update(key).digest('hex') + '.revision.json');
  async function ensurePrivate(create = false) {
    try {
      if (!(await lstat(privateDirectory)).isDirectory()) throw invalid("revision directory: regular directory");
      return true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!create) return false;
      await mkdir(privateDirectory, {recursive: true});
      return ensurePrivate();
    }
  }
  async function identity(key) {
    const target = await confinedPath(key);
    try {
      const value = await lstat(target, {bigint: true});
      if (!value.isFile()) throw invalid("media file: regular file");
      return [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs, value.birthtimeNs].map(String);
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  const privateEtag = async key => {
    const value = await identity(key);
    return value ? createHash('sha256').update(JSON.stringify(value)).digest('hex') : null;
  };
  async function locked(key, action) {
    const name = filePath(key), previous = locks.get(name) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(action);
    locks.set(name, task);
    try { return await task; } finally { if (locks.get(name) === task) locks.delete(name); }
  }
  async function readRevision(key) {
    if (!await ensurePrivate()) return null;
    const path = revisionPath(key);
    let info;
    try { info = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!info.isFile() || info.size > MAX_REVISION_BYTES) throw invalid("revision: restore saved record");
    const bytes = await readFile(path);
    let value;
    try { value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)); }
    catch { throw invalid("revision: restore saved record"); }
    if (bytes.length > MAX_REVISION_BYTES || value?.owner !== OWNER || value.kind !== 'revision' ||
        value.source !== key || !UUID.test(value.version ?? '') ||
        !(value.stat === null || Array.isArray(value.stat) && value.stat.length === 6 &&
          value.stat.every(item => typeof item === 'string' && /^-?[0-9]+$/.test(item))))
      throw invalid("revision: restore saved record");
    return {value, bytes};
  }
  async function writeRevision(key, value, bytes = Buffer.from(JSON.stringify(value))) {
    if (bytes.length > MAX_REVISION_BYTES) throw invalid("revision: too large");
    await ensurePrivate(true);
    const path = revisionPath(key), temporary = path + '.' + randomUUID() + '.tmp';
    try { await writeFile(temporary, bytes, {flag: 'wx', mode: 0o600}); await rename(temporary, path); }
    finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    return {value, bytes};
  }
  async function removeRevision(key) {
    try { await unlink(revisionPath(key)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const revision = (key, value) => ({owner: OWNER, kind: 'revision', source: key, version: randomUUID(), stat: value});
  async function currentRevision(key, value) {
    const saved = await readRevision(key);
    if (saved && sameStat(saved.value.stat, value)) return saved;
    // A JPEG restore that stopped after its rename: the file it names, exactly, is that restore's commit.
    const {pending, ...intent} = saved?.value ?? {};
    if (value && pending && String(pending.size) === value[2] &&
        createHash('sha256').update(await readFile(await confinedPath(key))).digest('hex') === pending.sha256)
      return writeRevision(key, {...intent, stat: value, originalId: pending.originalId, representation: 'jpeg', contentType: pending.contentType});
    return value ? writeRevision(key, revision(key, value)) : saved;
  }
  async function mutate(key, action, signal) {
    signal?.throwIfAborted();
    if (!publicSource(key)) return action();
    const before = await identity(key), prior = await currentRevision(key, before);
    signal?.throwIfAborted();
    // Publish a fresh intent before native I/O, so interruption cannot resurrect the old generation. While the file is
    // still the one before (an exit before the action touched it), the intent keeps what that file is (a restored JPEG
    // has no marker of its own); the file the action writes is named afresh.
    const fresh = revision(key, before), {originalId, representation, contentType} = prior?.value ?? {};
    const intent = originalId ? {...fresh, originalId, representation, ...(contentType && {contentType})} : fresh;
    await writeRevision(key, intent);
    let committed = false;
    try {
      signal?.throwIfAborted();
      const result = await action(); committed = true;
      const after = await identity(key);
      if (after) await writeRevision(key, {...fresh, stat: after}); else await removeRevision(key);
      return result;
    } catch (error) {
      try {
        const after = await identity(key);
        if (!committed && sameStat(before, after)) {
          if (prior) await writeRevision(key, prior.value, prior.bytes); else await removeRevision(key);
        } else if (after) await writeRevision(key, {...fresh, stat: after}); else await removeRevision(key);
      } catch { /* The fresh intent remains safe if cleanup I/O also fails. */ }
      throw error;
    }
  }
  async function privateWrite(options, exclusive) {
    await ensurePrivate(true);
    const temporary = PRIVATE + randomUUID() + '.tmp';
    try {
      const result = await inner.upload({...options, key: temporary});
      options.signal?.throwIfAborted();
      if (exclusive) {
        try { await link(filePath(temporary), filePath(options.key)); }
        catch (error) { if (error.code === 'EEXIST') return false; throw error; }
        return true;
      }
      // Publish a complete terminal record. Active create-only admission cannot
      // replace its occupied name, including after an interrupted process.
      await rename(filePath(temporary), filePath(options.key));
      return {...result, key: options.key, ...(typeof inner.getPublicUrl === 'function' ? {url: inner.getPublicUrl(options.key)} : {})};
    } finally {
      await unlink(filePath(temporary)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  const store = new Proxy(inner, {get(target, property) {
    if (property === 'upload') return options => locked(options.key,
      () => options.key.startsWith(PRIVATE) ? privateWrite(options, false) :
        (async () => { await confinedPath(options.key); return mutate(options.key, () => target.upload(options), options.signal); })());
    if (property === 'delete') return (key, options) => locked(key,
      async () => { await confinedPath(key); return mutate(key, () => target.delete(key, options), options?.signal); });
    if (property === 'download') return (key, options) => locked(key, async () => {
      options?.signal?.throwIfAborted();
      await confinedPath(key);
      const result = await target.download(key, options);
      try {
        options?.signal?.throwIfAborted();
        if (!publicSource(key)) return key.startsWith(PRIVATE) ? {...result, ...(key.endsWith('.json') && {etag: await privateEtag(key)}), version: await privateEtag(key)} : result;
        const saved = await currentRevision(key, await identity(key));
        if (!saved) throw invalid("media file: restore missing");
        const version = saved.value.version;
        const metadata = saved.value.originalId ? {originalId: saved.value.originalId, representation: saved.value.representation,
          contentType: saved.value.contentType ?? result.contentType} : {};
        if (result.size > maxBytes) return {...result, ...metadata, etag: version, version};
        const bytes = await readAll(result.body, {maxBytes, signal: options?.signal});
        const body = new ReadableStream({start(controller) { controller.enqueue(bytes); controller.close(); }});
        return {...result, ...metadata, body, etag: version, version};
      } catch (error) { cancel(result?.body); throw error; }
    });
    const value = target[property];
    return typeof value === 'function' ? value.bind(target) : value;
  }});
  const create = (key, body, {contentType, signal} = {}) => locked(key, async () => {
    signal?.throwIfAborted();
    await confinedPath(key);
    if (await inner.exists(key, {signal})) return false;
    signal?.throwIfAborted();
    if (key.startsWith(PRIVATE)) {
      const written = await privateWrite({key, body, contentType, signal}, true);
      return written === true ? {created: true, version: await privateEtag(key)} : written;
    }
    await mutate(key, () => inner.upload({key, body, contentType, signal}), signal);
    return true;
  });
  const compareAndSet = (key, body, {etag, contentType, signal} = {}) => locked(key, async () => {
    if (!key.startsWith(PRIVATE) || !key.endsWith('.json') || etag !== null && (typeof etag !== 'string' || !etag))
      throw invalid("revision: stored revision");
    signal?.throwIfAborted();
    if (await privateEtag(key) !== etag) return false;
    const result = await privateWrite({key, body, contentType, signal}, etag === null);
    return etag === null ? result === true : true;
  });
  const head = (key, options = {}) => locked(key, async () => {
    options.signal?.throwIfAborted();
    const value = await identity(key);
    if (!value) return null;
    const info = await lstat(await confinedPath(key));
    if (!publicSource(key)) return {size: info.size, contentType: contentType(key), lastModified: info.mtime,
      etag: await privateEtag(key), version: await privateEtag(key)};
    const saved = await currentRevision(key, value), revision = saved.value;
    return {size: info.size, contentType: revision.contentType ?? contentType(key), lastModified: info.mtime,
      etag: revision.version, version: revision.version,
      ...(revision.originalId ? {originalId: revision.originalId, representation: revision.representation} : {})};
  });
  const replace = (key, body, options = {}) => locked(key, async () => {
    if (!publicSource(key) || !/\.(?:jpe?g|jpe|jfif)$/i.test(key) ||
        !UUID.test(options.expectedVersion ?? '') || options.etag !== options.expectedVersion ||
        !/^[a-f0-9]{32}$/.test(options.originalId ?? '') || !['jxl', 'jpeg'].includes(options.representation))
      throw invalid("replacement: source and archive identities");
    options.signal?.throwIfAborted();
    const before = await identity(key), prior = await currentRevision(key, before);
    if (!before || prior?.value.version !== options.expectedVersion) return null;
    await ensurePrivate(true);
    const intent = revision(key, before), temporary = PRIVATE + randomUUID() + '.tmp';
    // The fresh intent has no representation marker. A crash before rename cannot claim that
    // old JPEG bytes are already an archive; a crash after rename is found by the UUID box, and
    // a restored JPEG, which has none, by the size and SHA-256 its intent names (currentRevision).
    const pending = options.representation === 'jpeg' && {originalId: options.originalId, contentType: options.contentType,
      size: body.byteLength, sha256: createHash('sha256').update(body).digest('hex')};
    await writeRevision(key, pending ? {...intent, pending} : intent);
    try {
      await inner.upload({key: temporary, body, contentType: options.contentType, signal: options.signal});
      options.signal?.throwIfAborted();
      if (options.lastModified) {
        const time = new Date(options.lastModified);
        if (!Number.isFinite(time.getTime())) throw invalid("mtime: valid file timestamp");
        await utimes(filePath(temporary), time, time);
      }
      await rename(filePath(temporary), filePath(key));
      const after = await identity(key);
      const saved = await writeRevision(key, {...intent, stat: after, originalId: options.originalId,
        representation: options.representation, contentType: options.contentType});
      return {etag: saved.value.version, version: saved.value.version, size: body.byteLength};
    } catch (error) {
      // Restore only a definitively untouched source. Once rename occurred, the new intent
      // stays in place and the archive control token remains unresolved until positive proof.
      try { if (sameStat(before, await identity(key))) await writeRevision(key, prior.value, prior.bytes); } catch {}
      throw error;
    } finally { await unlink(filePath(temporary)).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  });
  return {store, create, compareAndSet, head, replace};
}
