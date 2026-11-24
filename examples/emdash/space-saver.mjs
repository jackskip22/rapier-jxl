// SPDX-License-Identifier: MIT
// Shared JPEG space-saver logic for EmDash, Cloudflare R2 and Cloudflare Workers.
// Only JPEGs may drop their originals, and only on a host with the CPU to rebuild them.
// Before an original is removed, its JPEG XL is restored and its SHA-256 is checked against
// the stored JPEG: any mismatch keeps the original. Other formats keep their originals.
import {restore as restoreJpeg} from 'jpegxl/jpeg';
import {acceptsJxl} from 'jpegxl/serve';
import {digest} from './digest.mjs';
import {originalWorkerCache} from './original-cache-workers.mjs';

export {digest, originalWorkerCache};

const fail = (code, message) => Object.assign(new Error(message), {code});

// A retained JPEG never depends on a cold restore request. Unknown Worker allowances are not proof of Paid.
export const canRetireJpeg = host => host?.platform === 'node' && host.cpuLimitMs === null ||
  ['node', 'cloudflare'].includes(host?.platform) && host.cpuLimitMs >= 30000;

export const isRetirableJpegKey = key => typeof key === 'string' && /\.(?:jpe?g|jpe|jfif)$/i.test(key) &&
  !/[\\\x00-\x1f\x7f]/.test(key) && !key.split('/').some(part => !part || part === '.' || part === '..');

const PREVIEW_AGENT = /\b(?:Slackbot|Discordbot|Twitterbot|facebookexternalhit|Facebot|WhatsApp|TelegramBot|LinkedInBot|Applebot|Pinterest|Embedly|Iframely|SkypeUriPreview|vkShare|redditbot|Mastodon|Bluesky|Snapchat|Quora Link Preview|Rogerbot|Outbrain|LinkPreview|PreviewBot)\b/i;

// Share previews and link unfurlers need the rebuilt JPEG even when an HTTP client advertises image/jxl.
export function isSharePreviewRequest(request) {
  const headers = request?.headers;
  if (!headers || typeof headers.get !== 'function') return false;
  const purpose = `${headers.get('sec-purpose') ?? ''},${headers.get('purpose') ?? ''},${headers.get('x-purpose') ?? ''}`;
  if (/\bpreview\b/i.test(purpose)) return true;
  return PREVIEW_AGENT.test(headers.get('user-agent') ?? '');
}

export async function cachedOriginalBytes(cache, key, {sha256, byteLength, signal} = {}) {
  const bytes = await cache?.get(key, {signal});
  if (!(bytes instanceof Uint8Array)) return null;
  if (byteLength !== undefined && bytes.byteLength !== byteLength) return null;
  if (sha256 && await digest(bytes) !== sha256) return null;
  return bytes;
}

// Restore a JPEG XL candidate and compare its SHA-256 with the stored JPEG before removing an original.
export async function verifyRestoredJpeg(jxlBytes, original, {restore = restoreJpeg, signal} = {}) {
  signal?.throwIfAborted();
  const isBytes = original instanceof Uint8Array;
  const byteLength = isBytes ? original.byteLength : original?.byteLength;
  const sha256 = isBytes ? await digest(original) : original?.sha256;
  if (!(jxlBytes instanceof Uint8Array) || !Number.isSafeInteger(byteLength) || byteLength < 1 ||
      typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) {
    return {verified: false, sha256: sha256 ?? null, restoredSha256: null, byteLength: byteLength ?? 0, bytes: null};
  }
  let restored;
  try {
    restored = await restore(jxlBytes, signal ? {signal} : undefined);
  } catch (error) {
    signal?.throwIfAborted();
    return {verified: false, sha256, restoredSha256: null, byteLength, bytes: null, error};
  }
  const bytes = restored?.bytes;
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== byteLength) {
    return {verified: false, sha256, restoredSha256: null, byteLength, bytes: null};
  }
  const restoredSha256 = await digest(bytes);
  const verified = restoredSha256 === sha256;
  return {verified, sha256, restoredSha256, byteLength, bytes: verified ? bytes : null};
}

export async function rebuildOriginalJpeg(jxlBytes, {cache, cacheKey, sha256, byteLength, restore = restoreJpeg, signal} = {}) {
  signal?.throwIfAborted();
  if (!(jxlBytes instanceof Uint8Array)) throw fail('JXL_INPUT', 'JPEG XL recovery requires an input byte array.');
  // A path, size or caller label is not the archive's identity, and callers can reuse their input arrays.
  const candidate = new Uint8Array(jxlBytes);
  const identity = cache && cacheKey ? `${cacheKey}:${await digest(candidate)}` : null;
  if (identity) {
    const hit = await cachedOriginalBytes(cache, identity, {sha256, byteLength, signal});
    if (hit) return {bytes: hit, cached: true};
  }
  const restored = await restore(candidate, signal ? {signal} : undefined);
  const bytes = restored?.bytes;
  if (!(bytes instanceof Uint8Array)) throw fail('JXL_RECONSTRUCTION', 'Could not restore the original JPEG.');
  if (byteLength !== undefined && bytes.byteLength !== byteLength)
    throw fail('JXL_INPUT', 'Restored JPEG length does not match the stored original.');
  if (sha256 && await digest(bytes) !== sha256)
    throw fail('JXL_INPUT', 'Restored JPEG digest does not match the stored original.');
  if (identity) await cache.put(identity, bytes, {signal});
  return {bytes, cached: false};
}

function representationEtag(baseEtag, suffix) {
  const trimmed = String(baseEtag ?? '').trim();
  if (!trimmed) return null;
  const weak = trimmed.startsWith('W/'), raw = weak ? trimmed.slice(2) : trimmed;
  const unquoted = raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2 ? raw.slice(1, -1) : raw;
  return `${weak ? 'W/' : ''}"${unquoted}-${suffix}"`;
}

function matchesWeakEtag(ifNoneMatch, etag) {
  if (typeof ifNoneMatch !== 'string' || !ifNoneMatch.trim() || !etag) return false;
  if (ifNoneMatch.trim() === '*') return true;
  const target = etag.startsWith('W/') ? etag.slice(2) : etag;
  let i = 0;
  while (i < ifNoneMatch.length) {
    while (i < ifNoneMatch.length && (ifNoneMatch[i] === ' ' || ifNoneMatch[i] === '\t' || ifNoneMatch[i] === ',')) i++;
    if (i >= ifNoneMatch.length) break;
    if (ifNoneMatch.startsWith('W/"', i)) i += 2;
    if (ifNoneMatch[i] !== '"') return false;
    const end = ifNoneMatch.indexOf('"', i + 1);
    if (end < 0) return false;
    const opaque = ifNoneMatch.slice(i, end + 1);
    i = end + 1;
    while (i < ifNoneMatch.length && (ifNoneMatch[i] === ' ' || ifNoneMatch[i] === '\t')) i++;
    if (i < ifNoneMatch.length && ifNoneMatch[i] !== ',') return false;
    if (opaque === target) return true;
  }
  return false;
}

function ensureVaryAccept(vary) {
  const parts = String(vary ?? '').split(',').map(part => part.trim()).filter(Boolean);
  if (parts.includes('*')) return '*';
  for (const name of ['Accept', 'User-Agent', 'Purpose', 'Sec-Purpose', 'X-Purpose', 'Range'])
    if (!parts.some(part => part.toLowerCase() === name.toLowerCase())) parts.push(name);
  return parts.join(', ');
}

function parseSingleRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/i.exec(String(header ?? '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start, end;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return {unsatisfiable: true};
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Number(m[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return {unsatisfiable: true};
    end = Math.min(end, size - 1);
  }
  return {start, end};
}

// Serve a space-saver JPEG XL object: image/jxl for browsers that accept it, and the rebuilt original JPEG
// for browsers without JPEG XL, share previews, HEAD, 304 and Range requests, with Cache-Control and Vary: Accept.
export async function serveStoredJxl(jxlBytes, request, {
  cache, cacheKey, sha256, byteLength, cacheControl = 'public, max-age=3600',
  etag, vary = 'Accept', lastModified, restore = restoreJpeg, signal,
} = {}) {
  const method = (request.method || 'GET').toUpperCase();
  const ranged = method === 'GET' && request.headers.has('range');
  const wantsJxl = !ranged && !isSharePreviewRequest(request) && acceptsJxl(request.headers.get('accept'), 'image/jpeg');
  const baseTag = etag ?? `"${(await digest(jxlBytes)).slice(0, 32)}"`;
  const varyHeader = ensureVaryAccept(vary);

  if (wantsJxl) {
    const repTag = representationEtag(baseTag, 'jxl');
    const headers = new Headers({'content-type': 'image/jxl', vary: varyHeader, 'cache-control': cacheControl});
    if (repTag) headers.set('etag', repTag);
    if (lastModified) headers.set('last-modified', lastModified);
    if (matchesWeakEtag(request.headers.get('if-none-match'), repTag)) return new Response(null, {status: 304, headers});
    headers.set('content-length', String(jxlBytes.byteLength));
    return new Response(method === 'HEAD' ? null : jxlBytes, {status: 200, headers});
  }

  const {bytes: jpegBytes} = await rebuildOriginalJpeg(jxlBytes, {cache, cacheKey, sha256, byteLength, restore, signal});
  const repTag = representationEtag(baseTag, 'jpeg');
  const headers = new Headers({'content-type': 'image/jpeg', vary: varyHeader, 'cache-control': cacheControl, 'accept-ranges': 'bytes'});
  if (repTag) headers.set('etag', repTag);
  if (lastModified) headers.set('last-modified', lastModified);

  // A conditional GET is evaluated before its range, as it is for an ordinary stored object.
  if (matchesWeakEtag(request.headers.get('if-none-match'), repTag)) return new Response(null, {status: 304, headers});

  if (ranged && method === 'GET') {
    const ifRange = request.headers.get('if-range');
    const rangeAllowed = !ifRange || (repTag && !repTag.startsWith('W/') && ifRange.trim() === repTag);
    if (rangeAllowed) {
      const parsed = parseSingleRange(request.headers.get('range'), jpegBytes.byteLength);
      if (parsed?.unsatisfiable) {
        headers.set('content-range', `bytes */${jpegBytes.byteLength}`);
        return new Response(null, {status: 416, headers});
      }
      if (parsed) {
        const slice = jpegBytes.subarray(parsed.start, parsed.end + 1);
        headers.set('content-range', `bytes ${parsed.start}-${parsed.end}/${jpegBytes.byteLength}`);
        headers.set('content-length', String(slice.byteLength));
        return new Response(slice, {status: 206, headers});
      }
    }
  }

  headers.set('content-length', String(jpegBytes.byteLength));
  return new Response(method === 'HEAD' ? null : jpegBytes, {status: 200, headers});
}

// R2 has no conditional delete. Keep recovery at the original key and replace only the ETag we verified.
// The marker is interpreted by both serving adapters, so the URL still negotiates JPEG and JPEG XL.
const r2RecoveryFields = ['jxl', 'from', 'etag', 'type', 'sha256', 'bytes', 'jxlSha256', 'cacheControl', 'lastModified'];
export function isRetiredR2Jpeg(object, key = object?.key) {
  const meta = object?.customMetadata;
  return isRetirableJpegKey(key) && meta?.jxl === 'retired' && meta.from === key && meta.type === 'image/jpeg' &&
    /^[a-f0-9]{64}$/.test(meta.sha256 ?? '') && /^[a-f0-9]{64}$/.test(meta.jxlSha256 ?? '') &&
    Number.isSafeInteger(Number(meta.bytes)) && Number(meta.bytes) > 0;
}

// Previous storage protocol, retained for context:
// Verify that jxlBytes restores the stored JPEG's SHA-256, store the beside .jxl, and remove the original JPEG from R2.
// Current retirement verifies the stored JPEG's SHA-256 and replaces its bytes conditionally at the original key.
export async function retireR2Jpeg(bucket, {
  key, etag, cacheControl, lastModified, jxlBytes, restore = restoreJpeg, signal,
} = {}) {
  if (!isRetirableJpegKey(key)) return {removed: false, stored: false, reason: 'not_jpeg'};
  if (!(jxlBytes instanceof Uint8Array) || typeof etag !== 'string' || !etag)
    return {removed: false, stored: false, reason: 'sha256_mismatch'};
  // A caller may reuse its array while storage I/O is pending. This call owns the bytes it checks and writes.
  const candidate = new Uint8Array(jxlBytes);
  signal?.throwIfAborted();
  const current = await bucket.get(key, {onlyIf: {etagMatches: etag}});
  if (!current?.body || current.etag !== etag) return {removed: false, stored: false, reason: 'changed'};
  if (isRetiredR2Jpeg(current, key)) {
    await current.body.cancel?.();
    return {removed: true, stored: true, reason: 'already_retired'};
  }
  // User metadata with these names cannot be replaced by recovery metadata and then removed on restore.
  if (r2RecoveryFields.some(name => Object.hasOwn(current.customMetadata ?? {}, name))) {
    await current.body.cancel?.();
    return {removed: false, stored: false, reason: 'metadata_conflict', code: 'JXL_INPUT'};
  }
  // Verify the actual bucket object. A same-named origin response or caller-supplied proof is not its identity.
  const source = new Uint8Array(await current.arrayBuffer());
  const check = await verifyRestoredJpeg(candidate, source, {restore, signal});
  if (!check.verified) return {removed: false, stored: false, reason: 'sha256_mismatch'};
  const jxlSha256 = await digest(candidate);
  const originalHttp = current.httpMetadata ?? {};
  cacheControl ??= originalHttp.cacheControl;
  const customMetadata = {
    ...current.customMetadata, jxl: 'retired', from: key, etag, type: 'image/jpeg',
    sha256: check.sha256, bytes: String(check.byteLength), jxlSha256,
    ...(cacheControl && {cacheControl}), ...(lastModified && {lastModified}),
  };
  signal?.throwIfAborted();
  const put = await bucket.put(key, candidate, {
    httpMetadata: {...originalHttp, contentType: 'image/jxl', ...(cacheControl && {cacheControl})},
    customMetadata, onlyIf: {etagMatches: etag}, sha256: jxlSha256,
  });
  if (!put) return {removed: false, stored: false, reason: 'changed'};
  return {removed: true, stored: true, sha256: check.sha256, byteLength: check.byteLength};
}

// Way back for R2: rebuild every removed original JPEG from its exact .jxl in the bucket.
export async function restoreR2Originals(bucket, {prefix = '', restore = restoreJpeg, signal} = {}) {
  let cursor, restored = 0, kept = 0, failed = 0;
  const keys = [];
  do {
    signal?.throwIfAborted();
    const listed = await bucket.list({prefix, include: ['customMetadata', 'httpMetadata'], ...(cursor && {cursor})});
    for (const item of listed.objects ?? []) {
      signal?.throwIfAborted();
      if (typeof item?.key !== 'string' || item.key.startsWith('.jxl-parts/') || item.key.startsWith('__rapier_jxl__/')) continue;
      const head = item.customMetadata ? item : await bucket.head(item.key);
      const inline = isRetiredR2Jpeg(head, item.key), from = head?.customMetadata?.from;
      if (!inline && (!item.key.endsWith('.jxl') || !isRetirableJpegKey(from) || head?.customMetadata?.jxl !== 'exact')) continue;
      if (!inline && await bucket.head(from)) { kept++; continue; }
      const stored = await bucket.get(item.key, {onlyIf: {etagMatches: head.etag}});
      if (!stored?.body || stored.etag !== head.etag) { failed++; continue; }
      try {
        const jxlBytes = new Uint8Array(await stored.arrayBuffer());
        if (inline && await digest(jxlBytes) !== head.customMetadata.jxlSha256) throw fail('JXL_INPUT', 'Stored JPEG XL digest changed.');
        const expectedBytes = Number(head.customMetadata.bytes);
        if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || !/^[a-f0-9]{64}$/.test(head.customMetadata.sha256 ?? ''))
          throw fail('JXL_INPUT', 'The stored original has no verified identity.');
        const {bytes} = await rebuildOriginalJpeg(jxlBytes, {sha256: head.customMetadata.sha256, byteLength: expectedBytes, restore, signal});
        const cacheControl = head.customMetadata.cacheControl || head.httpMetadata?.cacheControl;
        signal?.throwIfAborted();
        const customMetadata = {...head.customMetadata};
        for (const name of r2RecoveryFields) delete customMetadata[name];
        const put = await bucket.put(from, bytes, {
          httpMetadata: {...head.httpMetadata, contentType: 'image/jpeg', ...(cacheControl && {cacheControl})}, customMetadata,
          onlyIf: inline ? {etagMatches: head.etag} : new Headers({'if-none-match': '*'}), sha256: head.customMetadata.sha256,
        });
        if (put) { restored++; keys.push(from); } else kept++;
      } catch (error) {
        signal?.throwIfAborted();
        failed++;
      }
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return {restored, kept, failed, keys};
}

function nodeBuiltins() {
  const get = globalThis.process?.getBuiltinModule;
  if (typeof get !== 'function') throw fail('JXL_PLATFORM', 'Folder operations need Node 22.3 or later.');
  return {fs: get('node:fs/promises'), path: get('node:path'), url: get('node:url'), constants: get('node:fs').constants};
}

const RECOVERY_PREFIX = '.rapier-jxl-recovery-';
const LOCK_PREFIX = '.rapier-jxl-lock-';
const folderError = error => error?.code?.startsWith('JXL_') ? error : fail('JXL_IO', error?.message || 'Folder operation failed. Recovery files were kept.');

// Admit every parent and never follow a file link. The lock coordinates folder commands, not privileged writers
// that change private recovery files, open file handles or directory ownership outside this protocol.
async function folderPath({fs, path, root}, rel) {
  if (typeof rel !== 'string' || !rel || /[\\\x00-\x1f\x7f]/.test(rel) || path.isAbsolute(rel)
    || rel.split('/').some(part => !part || part === '.' || part === '..')) throw fail('JXL_INPUT', 'Invalid folder recovery path.');
  if (process.platform === 'win32' && rel.split('/').some(part => /[:. ]$|:|^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))
    throw fail('JXL_INPUT', 'Invalid Windows folder recovery path.');
  let full = root;
  const parts = rel.split('/');
  for (const [index, part] of parts.entries()) {
    full = path.join(full, part);
    const info = await fs.lstat(full).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!info) continue;
    if (info.isSymbolicLink()) throw fail('JXL_INPUT', `${rel}: symbolic link refused.`);
    if (index < parts.length - 1 && !info.isDirectory()) throw fail('JXL_INPUT', `${rel}: parent is not a folder.`);
  }
  return full;
}

async function readFolderFile(context, rel) {
  const {fs, constants} = context, full = await folderPath(context, rel);
  const before = await fs.lstat(full).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!before) return null;
  if (!before.isFile()) throw fail('JXL_INPUT', `${rel}: a plain file is required.`);
  let file;
  try {
    file = await fs.open(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = await file.stat();
    if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino) throw fail('JXL_IO', `${rel}: changed while opening it.`);
    return {bytes: new Uint8Array(await file.readFile()), mode: info.mode & 0o777};
  } catch (error) {
    if (error.code === 'ELOOP') throw fail('JXL_INPUT', `${rel}: symbolic link refused.`);
    throw error;
  } finally { await file?.close(); }
}

async function inFolder(folder, dryRun, run) {
  const context = nodeBuiltins(), {fs, path} = context;
  let lock;
  try {
    context.root = await fs.realpath(path.resolve(folder));
    if (!dryRun) {
      // A PID in each atomic mkdir also identifies a dead command without a partly written lock file.
      lock = await fs.mkdtemp(path.join(context.root, `${LOCK_PREFIX}${process.pid}-`));
      for (const entry of await fs.readdir(context.root, {withFileTypes: true})) {
        if (!entry.name.startsWith(LOCK_PREFIX) || path.join(context.root, entry.name) === lock) continue;
        const owner = /^\.rapier-jxl-lock-([1-9]\d*)-[A-Za-z0-9]+$/.exec(entry.name);
        if (!owner || !entry.isDirectory()) throw fail('JXL_INPUT', 'The folder has an invalid space-saver lock.');
        let alive = true;
        try { process.kill(Number(owner[1]), 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
        if (alive) throw fail('JXL_IO', 'Another folder space-saver command is running.');
        await fs.rmdir(await folderPath(context, entry.name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
    }
    return await run(context);
  } catch (error) { throw folderError(error); }
  finally { if (lock) await fs.rmdir(lock).catch(() => {}); }
}

async function walkFolder(context, currentRel = '', out = []) {
  const {fs, path, root} = context, currentDir = currentRel ? await folderPath(context, currentRel) : root;
  const entries = (await fs.readdir(currentDir, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(currentDir, entry.name), rel = currentRel ? currentRel + '/' + entry.name : entry.name;
    if (entry.isDirectory()) await walkFolder(context, rel, out);
    else if (entry.isFile()) out.push({full, rel});
  }
  return out;
}

async function writeAtomicNoClobber(fs, path, target, bytes, mode = 0o644) {
  const dir = path.dirname(target);
  const tmp = await fs.mkdtemp(path.join(dir, '.rapier-jxl-')), file = path.join(tmp, 'file');
  try {
    await writeRecoveryFile(fs, file, bytes, mode);
    await fs.link(file, target);
    return true;
  }
  catch (error) { if (error?.code === 'EEXIST') return false; throw error; }
  finally { await fs.rm(tmp, {recursive: true, force: true}); }
}

async function writeRecoveryFile(fs, file, bytes, mode) {
  const handle = await fs.open(file, 'wx', mode);
  try { await handle.writeFile(bytes); await handle.chmod(mode); await handle.sync(); }
  finally { await handle.close(); }
}

async function readRecoveryRecords(context) {
  const {fs, root} = context, records = [], seen = new Set();
  for (const entry of await fs.readdir(root, {withFileTypes: true})) {
    if (!entry.name.startsWith(RECOVERY_PREFIX)) continue;
    if (!entry.isDirectory() || !/^\.rapier-jxl-recovery-[A-Za-z0-9]+$/.test(entry.name))
      throw fail('JXL_INPUT', 'Invalid folder recovery directory.');
    const recordFile = await readFolderFile(context, entry.name + '/record.json');
    let record;
    try { record = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(recordFile?.bytes)); } catch {}
    if (!record || record.version !== 1 || !isRetirableJpegKey(record.file) || seen.has(record.file)
      || !/^[a-f0-9]{64}$/.test(record.sha256 ?? '') || !/^[a-f0-9]{64}$/.test(record.jxlSha256 ?? '')
      || !Number.isSafeInteger(record.byteLength) || record.byteLength < 0
      || !Number.isInteger(record.mode) || record.mode < 0 || record.mode > 0o777)
      throw fail('JXL_INPUT', `${entry.name}: invalid recovery record. Keep its files for recovery.`);
    await folderPath(context, record.file);
    seen.add(record.file); records.push({stage: entry.name, record});
  }
  return records;
}

async function removeRecovery(context, stage) {
  for (const name of ['original', 'archive.jxl', 'record.next', 'record.json']) {
    const full = await folderPath(context, stage + '/' + name);
    await context.fs.unlink(full).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  await context.fs.rmdir(await folderPath(context, stage));
}

async function updateRecoveryRecord(context, stage, record) {
  const next = await folderPath(context, stage + '/record.next');
  await context.fs.unlink(next).catch(error => { if (error.code !== 'ENOENT') throw error; });
  await writeRecoveryFile(context.fs, next, JSON.stringify(record) + '\n', 0o600);
  await context.fs.rename(next, await folderPath(context, stage + '/record.json'));
}

async function restoreCaptured(context, {stage, record}, {restore, dryRun}) {
  const captured = await readFolderFile(context, stage + '/original');
  let bytes = captured?.bytes, mode = captured?.mode ?? record.mode;
  const target = await folderPath(context, record.file), present = await readFolderFile(context, record.file);
  // A retry may find the original published and the archive already unlinked during cleanup.
  if (!captured && present && present.bytes.byteLength === record.byteLength && await digest(present.bytes) === record.sha256) {
    if (!dryRun) await removeRecovery(context, stage);
    return false;
  }
  if (captured) {
    const capturedSha = await digest(bytes);
    if (capturedSha !== record.sha256 || bytes.byteLength !== record.byteLength || mode !== record.mode) {
      record = {...record, sha256: capturedSha, byteLength: bytes.byteLength, mode};
      if (!dryRun) await updateRecoveryRecord(context, stage, record);
    }
  }
  if (!bytes) {
    const pinned = await readFolderFile(context, stage + '/archive.jxl');
    if (!pinned || await digest(pinned.bytes) !== record.jxlSha256) throw fail('JXL_INPUT', `${record.file}: recovery archive changed.`);
    bytes = (await rebuildOriginalJpeg(pinned.bytes, {restore, sha256: record.sha256, byteLength: record.byteLength})).bytes;
  }
  if (present && (present.bytes.byteLength !== bytes.byteLength || await digest(present.bytes) !== await digest(bytes)))
    throw fail('JXL_IO', `${record.file}: another file occupies the restore path. Recovery remains in ${stage}.`);
  if (!present && !dryRun) {
    const written = await writeAtomicNoClobber(context.fs, context.path, target, bytes, mode);
    if (!written) throw fail('JXL_IO', `${record.file}: appeared during restore. Recovery remains in ${stage}.`);
  }
  if (!dryRun) await removeRecovery(context, stage);
  return !present;
}

// Space-saver folder pass for static assets behind Workers Paid: JPEGs become exact .jpg.jxl and drop the JPEG
// only after restore + SHA-256 matches; PNGs and other formats keep their originals.
export async function retireFolderJpegs(folder, {effort = 7, dryRun = false, recompress, restore = restoreJpeg} = {}) {
  const recompressFn = recompress ?? (await import('jpegxl/jpeg')).recompress;
  return inFolder(folder, dryRun, async context => {
    const {fs, path, root} = context, pending = await readRecoveryRecords(context), files = await walkFolder(context);
    let removed = 0, kept = 0;
    const changes = [];
    for (const {full, rel} of files) {
      if (rel.endsWith('.jxl')) continue;
      if (!isRetirableJpegKey(rel)) { kept++; changes.push({file: rel, action: 'kept', reason: 'not_jpeg'}); continue; }
      if (pending.some(item => item.record.file === rel)) throw fail('JXL_IO', `${rel}: run --restore to finish its earlier recovery first.`);
      const original = await readFolderFile(context, rel), raw = original?.bytes;
      if (!raw || raw.byteLength < 3 || raw[0] !== 0xff || raw[1] !== 0xd8 || raw[2] !== 0xff) {
        kept++; changes.push({file: rel, action: 'kept', reason: 'not_jpeg'}); continue;
      }
      const jxlRel = rel + '.jxl', existing = await readFolderFile(context, jxlRel);
      let jxlBytes = existing?.bytes;
      if (!jxlBytes) {
        let encoded;
        try { encoded = await recompressFn(raw, {effort: Math.min(effort, 9)}); }
        catch { kept++; changes.push({file: rel, action: 'kept', reason: 'unreadable'}); continue; }
        if (!(encoded?.bytes instanceof Uint8Array) || encoded.bytes.byteLength >= raw.byteLength) {
          kept++; changes.push({file: rel, action: 'kept', reason: 'no_smaller'}); continue;
        }
        jxlBytes = new Uint8Array(encoded.bytes);
      }
      const check = await verifyRestoredJpeg(jxlBytes, raw, {restore});
      if (!check.verified) {
        kept++; changes.push({file: rel, action: 'kept', reason: 'sha256_mismatch'}); continue;
      }
      let stage, sharedArchive = false;
      if (!dryRun) {
        const stagePath = await fs.mkdtemp(path.join(root, RECOVERY_PREFIX));
        stage = path.basename(stagePath);
        const record = {version: 1, file: rel, sha256: check.sha256, byteLength: raw.byteLength,
          jxlSha256: await digest(jxlBytes), mode: original.mode};
        await writeRecoveryFile(fs, path.join(stagePath, 'record.json'), JSON.stringify(record) + '\n', 0o600);
        // A fresh public archive shares the read-only pin's inode. An existing archive gets an independent snapshot.
        const pinnedPath = path.join(stagePath, 'archive.jxl');
        await writeRecoveryFile(fs, pinnedPath, jxlBytes, existing ? 0o400 : 0o444);
        if (!existing) {
          const jxlPath = await folderPath(context, jxlRel);
          try { await fs.link(pinnedPath, jxlPath); sharedArchive = true; }
          catch (error) {
            if (error.code !== 'EEXIST') throw error;
            const now = await readFolderFile(context, jxlRel);
            if (!now || !(await verifyRestoredJpeg(now.bytes, raw, {restore})).verified) {
              await removeRecovery(context, stage);
              kept++; changes.push({file: rel, action: 'kept', reason: 'sha256_mismatch'}); continue;
            }
          }
        }
        // Capture the file that is actually removed from the public name, then verify that captured file.
        await folderPath(context, rel);
        await fs.rename(full, path.join(stagePath, 'original'));
        const moved = await readFolderFile(context, stage + '/original'), pinned = await readFolderFile(context, stage + '/archive.jxl');
        if (!moved || !pinned || await digest(pinned.bytes) !== record.jxlSha256
          || !(await verifyRestoredJpeg(pinned.bytes, moved.bytes, {restore})).verified) {
          await restoreCaptured(context, {stage, record}, {restore, dryRun: false});
          kept++; changes.push({file: rel, action: 'kept', reason: 'changed'}); continue;
        }
        if (record.mode !== moved.mode) {
          record.mode = moved.mode;
          await updateRecoveryRecord(context, stage, record);
        }
        await fs.unlink(await folderPath(context, stage + '/original'));
        if (sharedArchive) {
          const pinInfo = await fs.lstat(pinnedPath), publicInfo = await fs.lstat(full + '.jxl').catch(error => {
            if (error.code === 'ENOENT') return null;
            throw error;
          });
          sharedArchive = publicInfo?.isFile() && publicInfo.dev === pinInfo.dev && publicInfo.ino === pinInfo.ino;
        }
      }
      removed++;
      changes.push({file: rel, jxl: rel + '.jxl', action: 'removed', ...(stage && {recovery: stage,
        recoveryBytes: sharedArchive ? 0 : jxlBytes.byteLength})});
    }
    return {removed, kept, dryRun, changes};
  });
}

// Way back for static asset folders: rebuild every removed original JPEG from its .jpg.jxl or .jpeg.jxl file.
export async function restoreFolderOriginals(folder, {dryRun = false, restore = restoreJpeg} = {}) {
  return inFolder(folder, dryRun, async context => {
    const {fs, path} = context, records = await readRecoveryRecords(context), handled = new Set();
    let restored = 0, kept = 0, failed = 0;
    const changes = [];
    for (const item of records) {
      const file = item.record.file;
      handled.add(file);
      try {
        const wrote = await restoreCaptured(context, item, {restore, dryRun});
        if (wrote) restored++; else kept++;
        changes.push({file, action: wrote ? 'restored' : 'kept'});
      } catch (error) {
        failed++; changes.push({file, action: 'failed', code: folderError(error).code, recovery: item.stage});
      }
    }
    const files = await walkFolder(context);
    for (const {rel} of files) {
      if (!rel.endsWith('.jxl')) continue;
      const origRel = rel.slice(0, -4);
      if (!isRetirableJpegKey(origRel) || handled.has(origRel)) continue;
      try {
        const origPath = await folderPath(context, origRel), existing = await readFolderFile(context, origRel);
        if (existing) { kept++; changes.push({file: origRel, action: 'kept'}); continue; }
        const jxl = await readFolderFile(context, rel);
        if (!jxl) throw fail('JXL_IO', `${rel}: disappeared during restore.`);
        const {bytes} = await rebuildOriginalJpeg(jxl.bytes, {restore});
        if (!dryRun) {
          await folderPath(context, origRel);
          const written = await writeAtomicNoClobber(fs, path, origPath, bytes);
          if (!written) { kept++; changes.push({file: origRel, action: 'kept'}); continue; }
        }
        restored++;
        changes.push({file: origRel, action: 'restored'});
      } catch (error) {
        failed++; changes.push({file: origRel, action: 'failed', code: folderError(error).code});
      }
    }
    return {restored, kept, failed, dryRun, changes};
  });
}

async function runSpaceSaverCli() {
  const {fs, path, url} = nodeBuiltins();
  if (!process.argv[1]) return;
  let same = false;
  try { same = await fs.realpath(process.argv[1]) === await fs.realpath(url.fileURLToPath(import.meta.url)); } catch { return; }
  if (!same) return;
  const args = process.argv.slice(2);
  let wayBack = false, dryRun = false, asJson = false, effort = 7, folder;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--restore') wayBack = true;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--json') asJson = true;
    else if ((arg === '--effort' || arg === '-e') && args[i + 1]) effort = Number(args[++i]);
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write('Usage: node jxl-space-saver.mjs [--restore] [--effort <1-9>] [--dry-run] [--json] <folder>\n');
      return;
    } else if (!arg.startsWith('-') && !folder) folder = arg;
    else { process.stderr.write(`jxl-space-saver: unknown argument: ${arg}\n`); process.exitCode = 1; return; }
  }
  if (!folder) { process.stderr.write('Usage: node jxl-space-saver.mjs [--restore] [--dry-run] <folder>\n'); process.exitCode = 1; return; }
  const result = wayBack ? await restoreFolderOriginals(folder, {dryRun}) : await retireFolderJpegs(folder, {effort, dryRun});
  if (asJson) { process.stdout.write(JSON.stringify(result) + '\n'); return; }
  for (const item of result.changes) {
    if (item.action === 'removed') process.stdout.write(`${dryRun ? 'would remove' : 'removed'}: ${item.file} -> ${item.jxl}\n`);
    else if (item.action === 'restored') process.stdout.write(`${dryRun ? 'would restore' : 'restored'}: ${item.file}\n`);
    else if (item.action === 'failed') process.stderr.write(`failed: ${item.file}\n`);
  }
  if (result.failed) process.exitCode = 1;
}
if (globalThis.process?.argv?.[1]) await runSpaceSaverCli();
