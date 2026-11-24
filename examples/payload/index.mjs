// SPDX-License-Identifier: MIT
// JPEG XL plug-in for Payload CMS. Writes a .jxl beside every uploaded image and each imageSizes rendition,
// through Payload's storage adapter or on local disk, serves with Vary: Accept, and restores Space-saver JPEGs.
import {createHash, randomBytes} from 'node:crypto';
import {mkdir, readFile, realpath, link, rm, stat, lstat, open, unlink, writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {basename, dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {encode} from 'jpegxl';
import {recompress, restore} from 'jpegxl/jpeg';
import {acceptsJxl} from '../files/accept.mjs';

const STATE = Symbol.for('rapier.jxl.payload.state');
const REQUESTED_JXL = Symbol.for('rapier.jxl.payload.requestedJxl');
const SPACE_SAVER_TASK = 'jxl-space-saver';
const TEMP_PREFIX = '__jxl_';
const JPEG_MIME = /^image\/jpe?g$/i;
const RASTER_MIME = /^image\/(jpe?g|png|webp|gif|avif|tiff|bmp|heic|heif)$/i;
const ALLOWED_OPTIONS = new Set(['effort', 'fidelity', 'spaceSaver', 'collections', 'sharp']);
const ALLOWED_COLLECTION_OPTIONS = new Set(['effort', 'fidelity', 'spaceSaver']);

const fail = (code, message) => Object.assign(new Error(message), {code});
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const sha256Hex = bytes => createHash('sha256').update(bytes).digest('hex');

export function varyAccept(headers) {
  const out = headers instanceof Headers ? headers : new Headers(headers);
  const current = out.get('Vary') ?? out.get('vary');
  const parts = (current ?? '').split(',').map(part => part.trim()).filter(Boolean);
  if (parts.includes('*')) return out;
  for (const name of ['Accept', 'Range', 'User-Agent', 'Purpose', 'Sec-Purpose', 'X-Purpose']) {
    if (!parts.some(part => part.toLowerCase() === name.toLowerCase())) parts.push(name);
  }
  out.set('Vary', parts.join(', '));
  return out;
}

export function jxlFilename(filename) {
  if (typeof filename !== 'string' || !filename || /[\x00-\x1f\x7f]/.test(filename) || filename.includes('/') || filename.includes('\\') || filename === '.' || filename === '..' || filename.includes('..')) {
    return null;
  }
  if (/\.jxl$/i.test(filename)) return null;
  return `${filename}.jxl`;
}

function baseFilenameFromJxl(filename) {
  if (typeof filename !== 'string' || !/\.jxl$/i.test(filename)) return null;
  const base = filename.slice(0, -4);
  return jxlFilename(base) ? base : null;
}

function isJpeg(bytes, mimeType) {
  if (bytes && bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true;
  return typeof mimeType === 'string' && JPEG_MIME.test(mimeType.trim());
}

function isPng(bytes, mimeType) {
  if (bytes && bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return true;
  return typeof mimeType === 'string' && /^image\/png$/i.test(mimeType.trim());
}

function isSupportedImage(bytes, mimeType) {
  if (!bytes || bytes.length < 4) return false;
  if (typeof mimeType === 'string') {
    const clean = mimeType.split(';')[0].trim().toLowerCase();
    if (clean === 'image/svg+xml' || clean === 'image/jxl' || clean.includes('xml')) return false;
    if (RASTER_MIME.test(clean)) return true;
    if (clean && !clean.startsWith('image/') && clean !== 'application/octet-stream') return false;
  }
  return isJpeg(bytes, mimeType) || isPng(bytes, mimeType) ||
    (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) ||
    (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38);
}

let cachedSharp;
async function resolveSharp(explicit, req) {
  if (typeof explicit === 'function') return explicit;
  if (typeof req?.payload?.config?.sharp === 'function') return req.payload.config.sharp;
  if (cachedSharp !== undefined) return cachedSharp;
  try {
    const mod = await import('sharp');
    cachedSharp = mod.default ?? mod;
  } catch {
    cachedSharp = null;
  }
  return cachedSharp;
}

async function decodeWithSharp(sharpFn, bytes) {
  const image = sharpFn(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), {failOn: 'none'});
  const meta = await image.metadata();
  image.rotate();
  const wide = meta.depth === 'ushort';
  if (wide) image.toColorspace('rgb16');
  const {data, info} = await image.ensureAlpha().raw({depth: wide ? 'ushort' : 'uchar'}).toBuffer({resolveWithObject: true});
  const icc = meta.icc && !['b-w', 'grey16', 'cmyk'].includes(meta.space) && !(meta.channels < 3) ? new Uint8Array(meta.icc) : undefined;
  const samples = wide
    ? new Uint16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return {data: samples, width: info.width, height: info.height, ...(icc ? {icc} : {})};
}

async function encodeImageBytes(bytes, mimeType, settings, req) {
  const u8 = bytes instanceof Uint8Array
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : new Uint8Array(Buffer.from(bytes));
  if (isJpeg(u8, mimeType)) {
    const opts = settings.effort !== undefined ? {effort: settings.effort} : {};
    return recompress(u8, opts);
  }
  const opts = {
    ...(settings.effort !== undefined ? {effort: settings.effort} : {}),
    ...(settings.fidelity !== undefined ? {fidelity: settings.fidelity} : {}),
  };
  const blobType = isPng(u8, mimeType) ? 'image/png' : (typeof mimeType === 'string' && mimeType ? mimeType : undefined);
  try {
    return await encode(new Blob([u8], blobType ? {type: blobType} : undefined), opts);
  } catch (error) {
    if (error?.code !== 'JXL_PLATFORM') throw error;
    const sharpFn = await resolveSharp(settings.sharp, req);
    if (!sharpFn) throw error;
    const pixels = await decodeWithSharp(sharpFn, u8);
    return encode(pixels, opts);
  }
}

function validateSettings(options, allowedKeys) {
  if (!plain(options)) throw fail('JXL_OPTIONS', 'jxl options must be an object');
  for (const key of Object.keys(options)) {
    if (!allowedKeys.has(key)) throw fail('JXL_OPTIONS', `Unknown jxl option: ${key}`);
  }
  if (options.effort !== undefined && (!Number.isInteger(options.effort) || options.effort < 1 || options.effort > 9)) {
    throw fail('JXL_OPTIONS', 'effort must be an integer from 1 to 9');
  }
  if (options.spaceSaver !== undefined && typeof options.spaceSaver !== 'boolean') {
    throw fail('JXL_OPTIONS', 'spaceSaver must be a boolean');
  }
}

function resolveCollectionSettings(collection, rootOptions) {
  if (!collection?.upload) return null;
  const uploadObj = typeof collection.upload === 'object' ? collection.upload : {};
  const map = rootOptions.collections;
  let override = undefined;
  if (Array.isArray(map)) {
    if (!map.includes(collection.slug)) return null;
  } else if (plain(map)) {
    if (!Object.hasOwn(map, collection.slug) || map[collection.slug] === false) return null;
    if (plain(map[collection.slug])) {
      validateSettings(map[collection.slug], ALLOWED_COLLECTION_OPTIONS);
      override = map[collection.slug];
    } else if (map[collection.slug] !== true) {
      throw fail('JXL_OPTIONS', `Invalid collection config for ${collection.slug}`);
    }
  } else if (map !== undefined) {
    throw fail('JXL_OPTIONS', 'collections must be an array of slugs or an object');
  } else if (Array.isArray(uploadObj.mimeTypes) && uploadObj.mimeTypes.length > 0) {
    const acceptsImages = uploadObj.mimeTypes.some(type => typeof type === 'string' && (type.startsWith('image/') || type === '*/*'));
    if (!acceptsImages) return null;
  }
  return {
    effort: override?.effort ?? rootOptions.effort,
    fidelity: override?.fidelity ?? rootOptions.fidelity,
    spaceSaver: override?.spaceSaver ?? Boolean(rootOptions.spaceSaver),
    sharp: rootOptions.sharp,
  };
}

function safeStaticFile(staticDir, filename) {
  if (typeof filename !== 'string' || !filename || /[\x00-\x1f\x7f]/.test(filename) || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    throw fail('JXL_INPUT', 'Invalid upload filename');
  }
  const root = resolve(staticDir);
  const full = resolve(root, filename);
  const rel = relative(root, full);
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
    throw fail('JXL_INPUT', 'Upload filename escapes staticDir');
  }
  return {root, full};
}

async function assertRealParentInsideRoot(root, full) {
  const [realRoot, realParent] = await Promise.all([realpath(root), realpath(dirname(full))]);
  const rel = relative(realRoot, realParent);
  if (rel && (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel))) {
    throw fail('JXL_INPUT', 'Upload directory escapes staticDir');
  }
  return {realRoot, realParent};
}

async function writeLocalAtomic(staticDir, filename, bytes) {
  const {root, full} = safeStaticFile(staticDir, filename);
  await mkdir(root, {recursive: true});
  const {realParent} = await assertRealParentInsideRoot(root, full);
  const tmp = join(realParent, `.${basename(full)}.${randomBytes(6).toString('hex')}.tmp`);
  let placed = false;
  try {
    await writeFile(tmp, bytes, {flag: 'wx'});
    try { await link(tmp, full); placed = true; }
    catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const present = await readLocalBytes(root, filename);
      if (!present || sha256Hex(present) !== sha256Hex(bytes))
        throw fail('JXL_INPUT', 'An existing upload recovery file has different contents');
    }
  } catch (error) {
    throw error;
  } finally { await rm(tmp, {force: true}); }
  return placed;
}

async function readLocalFileVerified(staticDir, filename) {
  const {root, full} = safeStaticFile(staticDir, filename);
  let file;
  try {
    const info = await lstat(full);
    if (!info.isFile()) throw fail('JXL_INPUT', 'Upload files must be regular files, not links');
    await assertRealParentInsideRoot(root, full);
    file = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
    const fdInfo = await file.stat();
    if (!fdInfo.isFile()) throw fail('JXL_INPUT', 'Upload files must be regular files');
    const bytes = new Uint8Array(await file.readFile());
    return {
      bytes,
      localStat: {
        dev: fdInfo.dev,
        ino: fdInfo.ino,
        size: fdInfo.size,
        mtimeMs: fdInfo.mtimeMs,
      },
    };
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    if (error?.code === 'ELOOP') throw fail('JXL_INPUT', 'Upload files must not be links');
    throw error;
  } finally { await file?.close(); }
}

async function readLocalBytes(staticDir, filename) {
  const found = await readLocalFileVerified(staticDir, filename);
  return found ? found.bytes : null;
}

async function deleteLocalFile(staticDir, filename) {
  let target;
  try { target = safeStaticFile(staticDir, filename); } catch { return; }
  try {
    const info = await stat(target.full);
    if (!info.isFile()) return;
    await assertRealParentInsideRoot(target.root, target.full);
    await rm(target.full, {force: true});
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
  }
}

async function deleteLocalVerified(staticDir, filename, expectedStat) {
  if (!expectedStat) throw fail('JXL_INPUT', 'Missing local file identity before removal');
  const {root, full} = safeStaticFile(staticDir, filename);
  await assertRealParentInsideRoot(root, full);
  let current;
  try {
    current = await lstat(full);
  } catch (error) {
    if (error?.code === 'ENOENT') throw fail('JXL_IO', 'Stored original JPEG disappeared before removal');
    throw error;
  }
  if (!current.isFile() ||
      current.dev !== expectedStat.dev ||
      current.ino !== expectedStat.ino ||
      current.size !== expectedStat.size ||
      current.mtimeMs !== expectedStat.mtimeMs) {
    throw fail('JXL_RECONSTRUCTION', 'Stored original JPEG changed on disk before removal. The file was kept.');
  }
  await unlink(full);
}

function buildFileUrl({config, req, slug, filename, prefix}) {
  const serverURL = req?.payload?.config?.serverURL ?? config?.serverURL ?? '';
  const apiRoute = req?.payload?.config?.routes?.api ?? config?.routes?.api ?? '/api';
  const base = `${String(serverURL).replace(/\/$/, '')}${apiRoute.startsWith('/') ? apiRoute : '/' + apiRoute}/${slug}/file/${encodeURIComponent(filename)}`;
  return typeof prefix === 'string' && prefix ? `${base}?prefix=${encodeURIComponent(prefix)}` : base;
}

function refreshJxlUrls(jxlData, {config, req, slug, prefix}) {
  if (!plain(jxlData) || typeof jxlData.filename !== 'string') return jxlData;
  const next = {
    ...jxlData,
    url: jxlData.externalUrl || buildFileUrl({config, req, slug, filename: jxlData.filename, prefix}),
  };
  if (plain(jxlData.sizes)) {
    const sizes = {};
    for (const [name, entry] of Object.entries(jxlData.sizes)) {
      if (!plain(entry) || typeof entry.filename !== 'string') continue;
      sizes[name] = {
        ...entry,
        url: entry.externalUrl || buildFileUrl({config, req, slug, filename: entry.filename, prefix}),
      };
    }
    next.sizes = sizes;
  }
  return next;
}

function parseByteRange(rangeHeader, totalSize) {
  if (!rangeHeader) return {type: 'full'};
  if (!/^bytes=/i.test(rangeHeader)) return {type: 'full'};
  if (totalSize <= 0) return {type: 'invalid'};
  const spec = rangeHeader.slice(6).trim();
  if (spec.includes(',')) return {type: 'invalid'};
  const match = /^(\d*)-(\d*)$/.exec(spec);
  if (!match || (match[1] === '' && match[2] === '')) return {type: 'invalid'};
  let start, end;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return {type: 'invalid'};
    start = Math.max(0, totalSize - suffix);
    end = totalSize - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? totalSize - 1 : Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= totalSize || end < start) {
      return {type: 'invalid'};
    }
    end = Math.min(end, totalSize - 1);
  }
  return {type: 'partial', start, end};
}

function bytesResponse(bytes, mimeType, req, modifyResponseHeaders, initialHeaders) {
  let headers = new Headers(initialHeaders);
  if (typeof modifyResponseHeaders === 'function') headers = new Headers(modifyResponseHeaders({headers}) || headers);
  mergeServingPolicies(headers, initialHeaders);
  for (const name of ['Content-Range', 'Content-Encoding', 'Content-MD5', 'Content-Digest', 'Repr-Digest', 'Digest', 'Last-Modified', 'Content-Disposition']) headers.delete(name);
  const etag = `"${mimeType.replace(/[^a-z0-9]+/gi, '-')}-${sha256Hex(bytes)}"`;
  headers.set('ETag', etag);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Content-Type', mimeType);
  headers.set('Content-Length', String(bytes.byteLength));
  varyAccept(headers);
  const method = (req?.method || 'GET').toUpperCase();
  const ifMatch = req?.headers?.get?.('if-match');
  if (ifMatch != null && !ifMatch.split(',').some(value => value.trim() === '*' || value.trim() === etag)) {
    headers.set('Content-Length', '0');
    return new Response(null, {status: 412, headers});
  }
  const ifNoneMatch = req?.headers?.get?.('if-none-match');
  if ((method === 'GET' || method === 'HEAD') && ifNoneMatch?.split(',').some(value => {
    const tag = value.trim();
    return tag === '*' || tag.replace(/^W\//, '') === etag;
  })) {
    headers.delete('Content-Length');
    return new Response(null, {status: 304, headers});
  }
  const rangeHeader = req?.headers?.get?.('range') ?? req?.headers?.get?.('Range') ?? null;
  const ifRange = req?.headers?.get?.('if-range');
  const range = parseByteRange(method !== 'GET' || (ifRange != null && ifRange !== etag) ? null : rangeHeader, bytes.byteLength);
  if (range.type === 'invalid') {
    headers.set('Content-Range', `bytes */${bytes.byteLength}`);
    headers.set('Content-Length', '0');
    return new Response(null, {status: 416, headers});
  }
  let body = bytes;
  let status = 200;
  if (range.type === 'partial') {
    body = bytes.subarray(range.start, range.end + 1);
    headers.set('Content-Range', `bytes ${range.start}-${range.end}/${bytes.byteLength}`);
    headers.set('Content-Length', String(body.byteLength));
    status = 206;
  } else {
    headers.set('Content-Length', String(bytes.byteLength));
  }
  return new Response(method === 'HEAD' ? null : body, {status, headers});
}

function mergeServingPolicies(headers, inherited) {
  const prior = new Headers(inherited);
  const vary = [];
  for (const part of `${headers.get('Vary') ?? ''},${prior.get('Vary') ?? ''}`.split(',').map(value => value.trim()).filter(Boolean)) {
    if (!vary.some(value => value.toLowerCase() === part.toLowerCase())) vary.push(part);
  }
  if (vary.length) headers.set('Vary', vary.includes('*') ? '*' : vary.join(', '));
  const previousPolicy = prior.get('Cache-Control');
  const nextPolicy = headers.get('Cache-Control');
  if (previousPolicy && nextPolicy && previousPolicy !== nextPolicy) headers.set('Cache-Control', 'private, no-store');
  else if (previousPolicy && !nextPolicy) headers.set('Cache-Control', previousPolicy);
  const previousCookies = prior.getSetCookie?.() ?? (prior.has('Set-Cookie') ? [prior.get('Set-Cookie')] : []);
  const nextCookies = headers.getSetCookie?.() ?? (headers.has('Set-Cookie') ? [headers.get('Set-Cookie')] : []);
  for (const cookie of previousCookies) if (!nextCookies.includes(cookie)) headers.append('Set-Cookie', cookie);
  if (headers.has('Set-Cookie')) headers.set('Cache-Control', 'private, no-store');
  return headers;
}

function isPreviewRequest(req) {
  const headers = req?.headers;
  if (!headers || typeof headers.get !== 'function') return false;
  const purpose = `${headers.get('purpose') ?? ''},${headers.get('sec-purpose') ?? ''},${headers.get('x-purpose') ?? ''}`;
  return /\bpreview\b/i.test(purpose) || /\b(?:Slackbot|Discordbot|Twitterbot|facebookexternalhit|Facebot|WhatsApp|TelegramBot|LinkedInBot|Applebot|Pinterest|Embedly|Iframely|SkypeUriPreview|vkShare|redditbot|Mastodon|Bluesky|Snapchat|Quora Link Preview|Rogerbot|Outbrain|LinkPreview|PreviewBot)\b/i.test(headers.get('user-agent') ?? '');
}

function checkStoredIdentity(bytes, digest, length, label) {
  if (length !== undefined && (!Number.isSafeInteger(length) || length < 0 || bytes.byteLength !== length)) {
    throw fail('JXL_RECONSTRUCTION', `${label} length did not match its recorded size`);
  }
  if (digest !== undefined && (typeof digest !== 'string' || !/^[a-f0-9]{64}$/i.test(digest) || sha256Hex(bytes) !== digest.toLowerCase())) {
    throw fail('JXL_RECONSTRUCTION', `${label} digest did not match its recorded SHA-256`);
  }
}

async function readStoredBody(response, expectedLength) {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const {value, done} = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw fail('JXL_IO', 'Storage adapter returned a non-byte body');
      length += value.byteLength;
      if (!Number.isSafeInteger(length) || (expectedLength !== undefined && length > expectedLength)) {
        throw fail('JXL_RECONSTRUCTION', 'Stored file exceeded its recorded size');
      }
      chunks.push(value.slice());
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (expectedLength !== undefined && length !== expectedLength) throw fail('JXL_RECONSTRUCTION', 'Stored file was shorter than its recorded size');
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function ownedUploadEntry(doc, filename) {
  if (!plain(doc)) return null;
  const matches = [];
  if (doc.filename === filename) matches.push({source: doc, metadata: doc.jxl});
  for (const [name, entry] of Object.entries(plain(doc.sizes) ? doc.sizes : {})) {
    if (plain(entry) && entry.filename === filename) matches.push({source: entry, metadata: doc.jxl?.sizes?.[name]});
  }
  if (matches.length !== 1) return null;
  return matches[0];
}

function fullFileRequest(req, filename, prefix) {
  const url = new URL(req?.url || `http://localhost/file/${encodeURIComponent(filename)}`);
  url.pathname = url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1) + encodeURIComponent(filename);
  url.searchParams.delete('prefix');
  if (typeof prefix === 'string' && prefix) url.searchParams.set('prefix', prefix);
  const headers = new Headers(req?.headers);
  for (const name of ['Range', 'If-Range', 'If-None-Match', 'If-Match', 'If-Modified-Since', 'If-Unmodified-Since']) headers.delete(name);
  headers.set('Accept', filename.endsWith('.jxl') ? 'image/jxl' : '*/*');
  return Object.assign(new Request(url, {method: 'GET', headers, signal: req?.signal}), {
    payload: req?.payload, context: req?.context ?? {}, user: req?.user, locale: req?.locale, t: req?.t,
    routeParams: {...req?.routeParams, filename}, searchParams: url.searchParams,
  });
}

function guessMimeFromFilename(filename) {
  const lower = String(filename || '').toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.avif')) return 'image/avif';
  if (lower.endsWith('.tif') || lower.endsWith('.tiff')) return 'image/tiff';
  if (lower.endsWith('.bmp')) return 'image/bmp';
  if (lower.endsWith('.jxl')) return 'image/jxl';
  return 'application/octet-stream';
}

function createStorageBridge(collectionConfig, hooksMeta) {
  const uploadConfig = typeof collectionConfig.upload === 'object' ? collectionConfig.upload : {};
  const isCloud = Boolean(uploadConfig.disableLocalStorage);
  const staticDir = uploadConfig.staticDir || collectionConfig.slug;
  const directAdapter = plain(uploadConfig.adapter) && typeof uploadConfig.adapter.handleUpload === 'function'
    ? uploadConfig.adapter
    : null;

  const adapterHandlers = () => (collectionConfig.upload?.handlers ?? []).filter(h => !hooksMeta.ownHandlers.has(h));
  const adapterAfterDeleteHooks = () => {
    const all = collectionConfig.hooks?.afterDelete ?? [];
    const addedAfterJxl = all.filter(h => !hooksMeta.ownAfterDelete.has(h) && !hooksMeta.initialAfterDelete.has(h));
    if (addedAfterJxl.length > 0) return addedAfterDeleteFallback(addedAfterJxl);
    return hooksMeta.alreadyCloud ? all.filter(h => !hooksMeta.ownAfterDelete.has(h)) : [];
  };
  function addedAfterDeleteFallback(list) { return list; }

  function cleanGetRequest(req, filename, prefix) {
    const baseUrl = req?.url || `http://localhost/api/${collectionConfig.slug}/file/${encodeURIComponent(filename)}`;
    const url = new URL(baseUrl, 'http://localhost');
    if (typeof prefix === 'string' && prefix && !url.searchParams.has('prefix')) url.searchParams.set('prefix', prefix);
    const headers = new Headers(req?.headers);
    for (const name of ['accept', 'range', 'if-range', 'if-none-match', 'if-modified-since', 'if-match', 'if-unmodified-since']) headers.delete(name);
    return Object.assign(new Request(url.href, {method: 'GET', headers}), {
      payload: req?.payload,
      context: req?.context ?? {},
      user: req?.user,
      locale: req?.locale,
      t: req?.t,
    });
  }

  return {
    isCloud,
    staticDir,
    canDelete() {
      if (!isCloud) return true;
      if (directAdapter && typeof directAdapter.handleDelete === 'function') return true;
      return adapterAfterDeleteHooks().length > 0;
    },
    async fetchViaAdapter(req, {doc, filename, prefix, headers = new Headers()}) {
      if (directAdapter && typeof directAdapter.staticHandler === 'function') {
        const res = await directAdapter.staticHandler(req, {
          doc,
          headers,
          params: {collection: collectionConfig.slug, filename, prefix},
        });
        if (res instanceof Response) return res;
      }
      for (const handler of adapterHandlers()) {
        const res = await handler(req, {
          doc,
          headers,
          params: {collection: collectionConfig.slug, filename, prefix},
        });
        if (res instanceof Response) return res;
      }
      return null;
    },
    async readBytes(filename, {doc, req, prefix} = {}) {
      if (!jxlFilename(filename) && !baseFilenameFromJxl(filename)) throw fail('JXL_INPUT', 'Invalid upload filename');
      const effectivePrefix = prefix ?? doc?.prefix;
      if (!isCloud) return readLocalBytes(staticDir, filename);
      const getReq = cleanGetRequest(req, filename, effectivePrefix);
      const res = await this.fetchViaAdapter(getReq, {doc, filename, prefix: effectivePrefix});
      if (!res || !res.ok) return null;
      return new Uint8Array(await res.arrayBuffer());
    },
    async readVerifiedFile(filename, {doc, req, prefix, expectedLength} = {}) {
      if (!jxlFilename(filename) && !baseFilenameFromJxl(filename)) throw fail('JXL_INPUT', 'Invalid upload filename');
      const effectivePrefix = prefix ?? doc?.prefix;
      if (!isCloud) {
        const local = await readLocalFileVerified(staticDir, filename);
        if (!local) return null;
        if (expectedLength !== undefined && local.bytes.byteLength !== expectedLength) {
          throw fail('JXL_RECONSTRUCTION', 'Stored file length did not match its recorded size');
        }
        return local;
      }
      const getReq = cleanGetRequest(req, filename, effectivePrefix);
      const res = await this.fetchViaAdapter(getReq, {doc, filename, prefix: effectivePrefix});
      if (!res) return null;
      if (res.status === 404) {
        await res.body?.cancel();
        return null;
      }
      if (res.status !== 200 || res.headers.has('Content-Range') ||
          (res.headers.has('Content-Encoding') && res.headers.get('Content-Encoding').toLowerCase() !== 'identity')) {
        await res.body?.cancel();
        throw fail('JXL_IO', 'Storage adapter did not return a complete file');
      }
      const bytes = await readStoredBody(res, expectedLength);
      return {bytes, localStat: null};
    },
    async writeSingleFile({buffer, filename, mimeType, doc, req}) {
      const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
      if (!isCloud) {
        return writeLocalAtomic(staticDir, filename, bytes);
      }
      // Generic upload hooks may replace a competing upload. A host must explicitly provide atomic create-if-absent.
      if (typeof directAdapter?.handleUploadIfAbsent !== 'function')
        throw fail('JXL_PLATFORM', 'Cloud restoration requires an atomic handleUploadIfAbsent storage adapter. The recovery archive was kept.');
      const placed = await directAdapter.handleUploadIfAbsent({
        collection: collectionConfig, data: {...doc, filename},
        file: {buffer: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), filename, filesize: bytes.byteLength, mimeType}, req,
      });
      if (placed !== true && placed !== false) throw fail('JXL_IO', 'Atomic upload did not confirm whether it created the restored file');
      return placed;
    },
    async deleteFiles(filenames, {doc, req} = {}) {
      const owned = new Set([doc?.filename, ...Object.values(doc?.sizes ?? {}).map(size => size?.filename)].filter(name => jxlFilename(name)));
      for (const name of [...owned]) owned.add(jxlFilename(name));
      const list = [...new Set(filenames.filter(f => owned.has(f)))];
      if (!list.length) return;
      if (!isCloud) {
        for (const name of list) await deleteLocalFile(staticDir, name);
        return;
      }
      if (directAdapter && typeof directAdapter.handleDelete === 'function') {
        for (const filename of list) {
          await directAdapter.handleDelete({collection: collectionConfig, doc, filename, req});
        }
        return;
      }
      const hooks = adapterAfterDeleteHooks();
      if (!hooks.length) return;
      const [first, ...rest] = list;
      const syntheticDoc = {
        ...doc,
        filename: first,
        sizes: Object.fromEntries(rest.map((name, index) => [`${TEMP_PREFIX}del_${index}`, {filename: name}])),
      };
      for (const hook of hooks) {
        await hook({
          collection: collectionConfig,
          context: req?.context ?? {},
          doc: syntheticDoc,
          id: doc?.id,
          req,
        });
      }
    },
    async deleteVerifiedMainOriginal(filename, {doc, req, localStat} = {}) {
      if (!jxlFilename(filename) || doc?.filename !== filename) {
        throw fail('JXL_INPUT', 'Target filename does not match the upload document');
      }
      if (Object.values(plain(doc?.sizes) ? doc.sizes : {}).some(size => size?.filename === filename)) {
        throw fail('JXL_INPUT', 'Main filename collides with an imageSizes rendition that must keep its original');
      }
      if (!isCloud) {
        await deleteLocalVerified(staticDir, filename, localStat);
        return;
      }
      if (!this.canDelete()) {
        throw fail('JXL_PLATFORM', 'This storage adapter cannot remove retired originals. The original was kept.');
      }
      await this.deleteFiles([filename], {doc, req});
    },
  };
}

function collectJxlFilenames(jxlDoc, doc) {
  if (!plain(jxlDoc) || !plain(doc)) return [];
  const names = [];
  if (jxlDoc.filename === jxlFilename(doc.filename)) names.push(jxlDoc.filename);
  if (plain(jxlDoc.sizes) && plain(doc.sizes)) {
    for (const [name, size] of Object.entries(jxlDoc.sizes)) {
      if (plain(size) && size.filename === jxlFilename(doc.sizes[name]?.filename)) names.push(size.filename);
    }
  }
  return names;
}

function hasJobsQueue(req) {
  return typeof req?.payload?.jobs?.queue === 'function';
}

async function verifyWrittenJxlForQueue({storage, doc, jxlMeta, originalSha256, originalBytesLength, req}) {
  if (!storage.canDelete()) {
    return {
      ok: false,
      error: {
        code: 'JXL_PLATFORM',
        message: 'This storage adapter cannot remove retired originals. The original was kept.',
      },
    };
  }
  let storedJxl;
  try {
    storedJxl = await storage.readVerifiedFile(jxlMeta.filename, {
      doc,
      req,
      prefix: doc?.prefix,
      expectedLength: jxlMeta.filesize,
    });
  } catch (error) {
    return {
      ok: false,
      error: {
        code: error?.code === 'JXL_RECONSTRUCTION' ? 'JXL_RECONSTRUCTION' : 'JXL_IO',
        message: 'Written JPEG XL companion could not be verified. The original was kept.',
      },
    };
  }
  if (!storedJxl?.bytes || storedJxl.bytes.byteLength === 0) {
    return {
      ok: false,
      error: {
        code: 'JXL_IO',
        message: 'Written JPEG XL companion was missing. The original was kept.',
      },
    };
  }
  if ((Number.isSafeInteger(jxlMeta.filesize) && storedJxl.bytes.byteLength !== jxlMeta.filesize) ||
      (typeof jxlMeta.sha256 === 'string' && sha256Hex(storedJxl.bytes) !== jxlMeta.sha256.toLowerCase())) {
    return {
      ok: false,
      error: {
        code: 'JXL_RECONSTRUCTION',
        message: 'Written JPEG XL companion did not match its recorded SHA-256. The original was kept.',
      },
    };
  }
  let restored;
  try {
    restored = await restore(storedJxl.bytes);
  } catch {
    return {
      ok: false,
      error: {
        code: 'JXL_RECONSTRUCTION',
        message: 'Written JPEG XL companion could not restore the uploaded JPEG. The original was kept.',
      },
    };
  }
  if (!(restored?.bytes instanceof Uint8Array) ||
      restored.bytes.byteLength !== originalBytesLength ||
      sha256Hex(restored.bytes) !== originalSha256) {
    return {
      ok: false,
      error: {
        code: 'JXL_RECONSTRUCTION',
        message: 'Written JPEG XL companion restored a different SHA-256. The original was kept.',
      },
    };
  }
  return {ok: true};
}

function buildSpaceSaverWhere(col, doc, {expectSpaceSaved = false} = {}) {
  const identity = {
    id: doc.id,
    filename: doc.filename,
    'jxl.filename': doc.jxl.filename,
    'jxl.spaceSaved': expectSpaceSaved,
    'jxl.originalSha256': doc.jxl.originalSha256,
    'jxl.originalFilesize': doc.jxl.originalFilesize,
  };
  for (const name of ['sha256', 'filesize']) {
    if (doc.jxl[name] !== undefined) identity[`jxl.${name}`] = doc.jxl[name];
  }
  if (Number.isSafeInteger(doc.filesize)) identity.filesize = doc.filesize;
  if (doc.prefix !== undefined) identity.prefix = doc.prefix;
  const conditions = Object.entries(identity).map(([name, value]) => ({[name]: {equals: value}}));
  if (doc.prefix === undefined && (col.flattenedFields ?? col.fields ?? []).some(field => field.name === 'prefix')) {
    conditions.push({prefix: {exists: false}});
  }
  return {and: conditions};
}

function defaultHooksMeta(col) {
  return {
    alreadyCloud: Boolean(col.upload?.disableLocalStorage),
    initialBeforeChange: new Set(),
    initialAfterDelete: new Set(),
    ownBeforeChange: new Set(),
    ownAfterDelete: new Set(),
    ownHandlers: new Set(),
  };
}

function documentReferencesFilename(row, filename, prefix) {
  if (!plain(row)) return false;
  if ((row.prefix ?? '') !== (prefix ?? '')) return false;
  if (row.filename === filename) return true;
  for (const size of Object.values(plain(row.sizes) ? row.sizes : {})) {
    if (plain(size) && size.filename === filename) return true;
  }
  return false;
}

async function runSpaceSaverJob({input, req, getRootConfig}) {
  if (req?.transactionID != null) {
    return {
      output: {
        spaceSaved: false,
        code: 'JXL_PLATFORM',
        reason: 'Space saver job must run after commit outside an active transaction',
      },
    };
  }
  const payload = req?.payload;
  if (!payload || typeof payload.find !== 'function') {
    return {
      output: {
        spaceSaved: false,
        code: 'JXL_PLATFORM',
        reason: 'Payload instance is unavailable in Space saver job',
      },
    };
  }
  if (!plain(input) || typeof input.collection !== 'string' || !input.collection ||
      (typeof input.id !== 'string' && typeof input.id !== 'number')) {
    return {
      output: {
        spaceSaved: false,
        code: 'JXL_INPUT',
        reason: 'Invalid Space saver job input',
      },
    };
  }

  const rootConfig = payload.config ?? getRootConfig?.();
  const col = payload.collections?.[input.collection]?.config ??
    (rootConfig?.collections ?? []).find(entry => entry?.slug === input.collection);
  if (!col?.upload) {
    return {
      output: {
        spaceSaved: false,
        code: 'JXL_INPUT',
        reason: `Unknown upload collection ${input.collection}`,
      },
    };
  }

  const registry = rootConfig?.custom?.[STATE] ?? getRootConfig?.()?.custom?.[STATE];
  const meta = registry?.get(col.slug)?.hooksMeta ?? defaultHooksMeta(col);
  const storage = createStorageBridge(col, meta);
  const jobReq = {payload, context: {}};

  const recordDocFailure = async (doc, code, message) => {
    if (plain(doc) && plain(doc.jxl) && typeof payload.db?.updateOne === 'function') {
      const {spaceSaverError: _prev, ...restJxl} = doc.jxl;
      const nextJxl = {...restJxl, spaceSaved: false, spaceSaverError: {code, message}};
      await payload.db.updateOne({
        collection: col.slug,
        where: buildSpaceSaverWhere(col, doc, {expectSpaceSaved: false}),
        data: {jxl: nextJxl},
        options: {atomic: true},
      }).catch(() => {});
    }
    return {output: {spaceSaved: false, code, reason: message}};
  };

  const readCommittedTarget = async (expectedFilename, expectedSha256) => {
    const foundById = await payload.find({
      collection: col.slug,
      where: {id: {equals: input.id}},
      depth: 0,
      limit: 2,
      pagination: false,
      overrideAccess: true,
    });
    const byIdDocs = (foundById?.docs ?? []).filter(row => row?.id === input.id);
    if (byIdDocs.length !== 1) {
      return {ok: false, doc: null, code: 'JXL_INPUT', message: 'Upload document no longer exists'};
    }
    const doc = byIdDocs[0];
    if (doc.jxl?.spaceSaved === true) {
      return {ok: false, alreadySaved: true, doc};
    }
    if (typeof doc.filename !== 'string' || !jxlFilename(doc.filename)) {
      return {ok: false, doc: null, code: 'JXL_INPUT', message: 'Upload document has an invalid filename'};
    }
    if (expectedFilename !== undefined && doc.filename !== expectedFilename) {
      return {ok: false, doc: null, code: 'JXL_INPUT', message: 'Upload filename changed before retirement'};
    }
    if (!JPEG_MIME.test(doc.mimeType || guessMimeFromFilename(doc.filename))) {
      return {ok: false, doc: null, code: 'JXL_INPUT', message: 'Upload document is not a JPEG'};
    }
    const companionName = jxlFilename(doc.filename);
    if (!plain(doc.jxl) ||
        doc.jxl.filename !== companionName ||
        typeof doc.jxl.originalSha256 !== 'string' ||
        !/^[a-f0-9]{64}$/i.test(doc.jxl.originalSha256) ||
        !Number.isSafeInteger(doc.jxl.originalFilesize) ||
        doc.jxl.originalFilesize < 1) {
      return {ok: false, doc: null, code: 'JXL_INPUT', message: 'Upload metadata does not identify a restorable JPEG'};
    }
    if (expectedSha256 !== undefined && doc.jxl.originalSha256.toLowerCase() !== expectedSha256.toLowerCase()) {
      return {ok: false, doc: null, code: 'JXL_INPUT', message: 'Upload image changed before retirement'};
    }
    if (doc.filesize !== undefined && doc.filesize !== doc.jxl.originalFilesize) {
      return {
        ok: false,
        doc,
        code: 'JXL_RECONSTRUCTION',
        message: 'Document filesize no longer matches its recorded upload size. The original was kept.',
      };
    }
    if (!ownedUploadEntry(doc, doc.filename)) {
      return {
        ok: false,
        doc,
        code: 'JXL_INPUT',
        message: 'Main filename collides with an imageSizes rendition. The original was kept.',
      };
    }

    const nameClauses = [{filename: {equals: doc.filename}}];
    for (const size of col.upload?.imageSizes ?? []) {
      if (typeof size?.name === 'string') nameClauses.push({[`sizes.${size.name}.filename`]: {equals: doc.filename}});
    }
    const ownerWhere = typeof doc.prefix === 'string'
      ? {and: [{or: nameClauses}, {prefix: {equals: doc.prefix}}]}
      : {or: nameClauses};
    const ownerQuery = {
      collection: col.slug,
      where: ownerWhere,
      depth: 0,
      limit: 10,
      pagination: false,
      overrideAccess: true,
    };
    const ownerResult = await payload.find(ownerQuery);
    const matchingRows = [...(ownerResult?.docs ?? [])];
    if (col.versions?.drafts) {
      const draftResult = await payload.find({...ownerQuery, draft: true});
      matchingRows.push(...(draftResult?.docs ?? []));
    }
    const owners = matchingRows.filter(row => documentReferencesFilename(row, doc.filename, doc.prefix));
    if (!owners.some(row => row.id === doc.id) || owners.some(row => row.id !== doc.id) || ownerResult?.hasNextPage) {
      return {
        ok: false,
        doc: null,
        code: 'JXL_INPUT',
        message: 'Filename ownership changed before retirement. The file was kept.',
      };
    }
    return {ok: true, doc};
  };

  const initial = await readCommittedTarget();
  if (initial.alreadySaved) return {output: {spaceSaved: true}};
  if (!initial.ok) {
    return initial.doc
      ? recordDocFailure(initial.doc, initial.code, initial.message)
      : {output: {spaceSaved: false, code: initial.code, reason: initial.message}};
  }
  const doc = initial.doc;

  if (typeof payload.db?.updateOne !== 'function') {
    return recordDocFailure(doc, 'JXL_PLATFORM', 'Space saver requires a conditional database writer. The original was kept.');
  }
  if (!storage.canDelete()) {
    return recordDocFailure(doc, 'JXL_PLATFORM', 'This storage adapter cannot remove retired originals. The original was kept.');
  }

  let storedOriginal;
  try {
    storedOriginal = await storage.readVerifiedFile(doc.filename, {
      doc,
      req: jobReq,
      prefix: doc.prefix,
      expectedLength: doc.jxl.originalFilesize,
    });
  } catch (error) {
    const code = error?.code === 'JXL_RECONSTRUCTION' ? 'JXL_RECONSTRUCTION' : 'JXL_IO';
    const message = error?.code === 'JXL_RECONSTRUCTION'
      ? 'Stored original JPEG length did not match its recorded upload size. The original was kept.'
      : 'Could not read stored original JPEG for verification. The original was kept.';
    return recordDocFailure(doc, code, message);
  }
  if (!storedOriginal?.bytes) {
    return recordDocFailure(doc, 'JXL_IO', 'Stored original JPEG was missing before verification.');
  }

  const expectedOrigHash = doc.jxl.originalSha256.toLowerCase();
  if (!isJpeg(storedOriginal.bytes) ||
      storedOriginal.bytes.byteLength !== doc.jxl.originalFilesize ||
      sha256Hex(storedOriginal.bytes) !== expectedOrigHash) {
    return recordDocFailure(
      doc,
      'JXL_RECONSTRUCTION',
      'Stored original JPEG did not match its recorded upload SHA-256. The original was kept.',
    );
  }

  let storedJxl;
  try {
    storedJxl = await storage.readVerifiedFile(doc.jxl.filename, {
      doc,
      req: jobReq,
      prefix: doc.prefix,
      expectedLength: Number.isSafeInteger(doc.jxl.filesize) ? doc.jxl.filesize : undefined,
    });
  } catch (error) {
    const code = error?.code === 'JXL_RECONSTRUCTION' ? 'JXL_RECONSTRUCTION' : 'JXL_IO';
    return recordDocFailure(doc, code, 'Stored JPEG XL companion could not be verified. The original was kept.');
  }
  if (!storedJxl?.bytes || storedJxl.bytes.byteLength === 0) {
    return recordDocFailure(doc, 'JXL_IO', 'Stored JPEG XL companion was missing. The original was kept.');
  }
  if ((Number.isSafeInteger(doc.jxl.filesize) && storedJxl.bytes.byteLength !== doc.jxl.filesize) ||
      (typeof doc.jxl.sha256 === 'string' && sha256Hex(storedJxl.bytes) !== doc.jxl.sha256.toLowerCase())) {
    return recordDocFailure(
      doc,
      'JXL_RECONSTRUCTION',
      'Stored JPEG XL companion did not match its recorded SHA-256. The original was kept.',
    );
  }

  let rebuilt;
  try {
    rebuilt = await restore(storedJxl.bytes);
  } catch {
    return recordDocFailure(
      doc,
      'JXL_RECONSTRUCTION',
      'Stored JPEG XL companion could not restore the original JPEG. The original was kept.',
    );
  }
  if (!(rebuilt?.bytes instanceof Uint8Array) ||
      rebuilt.bytes.byteLength !== doc.jxl.originalFilesize ||
      sha256Hex(rebuilt.bytes) !== expectedOrigHash ||
      Buffer.compare(rebuilt.bytes, storedOriginal.bytes) !== 0) {
    return recordDocFailure(
      doc,
      'JXL_RECONSTRUCTION',
      'Stored JPEG XL companion did not restore the original JPEG exactly. The original was kept.',
    );
  }

  // Re-read the committed document and filename ownership right before removing the original.
  const preDelete = await readCommittedTarget(doc.filename, expectedOrigHash);
  if (preDelete.alreadySaved) return {output: {spaceSaved: true}};
  if (!preDelete.ok) {
    return preDelete.doc
      ? recordDocFailure(preDelete.doc, preDelete.code, preDelete.message)
      : {output: {spaceSaved: false, code: preDelete.code, reason: preDelete.message}};
  }
  const freshDoc = preDelete.doc;
  if ((freshDoc.prefix ?? '') !== (doc.prefix ?? '') ||
      freshDoc.jxl.filename !== doc.jxl.filename ||
      freshDoc.jxl.originalFilesize !== doc.jxl.originalFilesize) {
    return {
      output: {
        spaceSaved: false,
        code: 'JXL_INPUT',
        reason: 'Upload metadata changed before retirement. The file was kept.',
      },
    };
  }

  try {
    await storage.deleteVerifiedMainOriginal(freshDoc.filename, {
      doc: freshDoc,
      req: jobReq,
      localStat: storedOriginal.localStat,
    });
  } catch (error) {
    await storage.writeSingleFile({
      buffer: storedOriginal.bytes,
      filename: freshDoc.filename,
      mimeType: 'image/jpeg',
      doc: freshDoc,
      req: jobReq,
    }).catch(() => {});
    const code = typeof error?.code === 'string' && error.code.startsWith('JXL_') ? error.code : 'JXL_IO';
    const message = typeof error?.code === 'string' && error.code.startsWith('JXL_')
      ? error.message
      : 'Could not remove the verified original JPEG. The original was kept.';
    return recordDocFailure(freshDoc, code, message);
  }

  const {spaceSaverError: _cleared, ...cleanJxl} = freshDoc.jxl;
  const nextJxl = {...cleanJxl, spaceSaved: true};
  let updated = null;
  try {
    updated = await payload.db.updateOne({
      collection: col.slug,
      where: buildSpaceSaverWhere(col, freshDoc, {expectSpaceSaved: false}),
      data: {jxl: nextJxl},
      options: {atomic: true},
    });
  } catch {
    updated = null;
  }

  if (!updated) {
    const checkAfter = await payload.find({
      collection: col.slug,
      where: {id: {equals: freshDoc.id}},
      depth: 0,
      limit: 1,
      pagination: false,
      overrideAccess: true,
    }).catch(() => null);
    const stillDoc = (checkAfter?.docs ?? []).find(row => row?.id === freshDoc.id);
    if (stillDoc && stillDoc.filename === freshDoc.filename) {
      await storage.writeSingleFile({
        buffer: storedOriginal.bytes,
        filename: freshDoc.filename,
        mimeType: 'image/jpeg',
        doc: freshDoc,
        req: jobReq,
      }).catch(() => {});
      return recordDocFailure(
        stillDoc,
        'JXL_IO',
        'Conditional metadata update did not match the committed upload. The original was restored.',
      );
    }
    return {
      output: {
        spaceSaved: false,
        code: 'JXL_IO',
        reason: 'Conditional metadata update did not match the committed upload',
      },
    };
  }

  return {output: {spaceSaved: true}};
}

function createSpaceSaverTask(getRootConfig) {
  return {
    slug: SPACE_SAVER_TASK,
    interfaceName: 'TaskJxlSpaceSaver',
    retries: 0,
    inputSchema: [
      {name: 'collection', type: 'text', required: true},
      {name: 'id', type: 'json', required: true},
    ],
    outputSchema: [
      {name: 'spaceSaved', type: 'checkbox', required: true},
      {name: 'code', type: 'text'},
      {name: 'reason', type: 'text'},
    ],
    handler: ({input, req}) => runSpaceSaverJob({input, req, getRootConfig}),
  };
}

async function uploadedFileBytes(file) {
  if (!file) return null;
  if (file.data && file.data.byteLength > 0) {
    return new Uint8Array(file.data.buffer, file.data.byteOffset, file.data.byteLength);
  }
  if (typeof file.tempFilePath === 'string' && file.tempFilePath) {
    return new Uint8Array(await readFile(file.tempFilePath));
  }
  return null;
}

function attachCollection(collection, settings, getRootConfig) {
  const uploadObj = typeof collection.upload === 'object' ? {...collection.upload} : {};
  const alreadyCloud = Boolean(uploadObj.disableLocalStorage);
  const hooksMeta = {
    alreadyCloud,
    initialBeforeChange: new Set(collection.hooks?.beforeChange ?? []),
    initialAfterDelete: new Set(collection.hooks?.afterDelete ?? []),
    ownBeforeChange: new Set(),
    ownAfterDelete: new Set(),
    ownHandlers: new Set(),
  };

  const pendingMap = new WeakMap();
  const getPending = req => (req && typeof req === 'object' ? pendingMap.get(req) : undefined);

  const jxlBeforeChange = async ({collection: runtimeCollection, data, operation, originalDoc, req}) => {
    const col = runtimeCollection ?? collection;
    const storage = createStorageBridge(col, hooksMeta);
    const fileBytes = await uploadedFileBytes(req?.file);
    if (!fileBytes || typeof data?.filename !== 'string' || !data.filename) {
      if (plain(data)) data.jxl = originalDoc?.jxl ?? null;
      return data;
    }

    // A historical Space saver row can have its only recoverable image at the fixed sidecar name.
    // The storage adapter may replace that name before a database transaction commits, so restore it first.
    if (operation === 'update' && originalDoc?.jxl?.spaceSaved === true)
      throw fail('JXL_INPUT', 'Restore this upload\'s originals before replacing a Space saver image');

    const oldJxlNames = operation === 'update' ? collectJxlFilenames(originalDoc?.jxl, originalDoc) : [];
    const mimeType = data.mimeType || req?.file?.mimetype || guessMimeFromFilename(data.filename);

    if (!isSupportedImage(fileBytes, mimeType)) {
      data.jxl = null;
      pendingMap.set(req, {finalizedCloud: true, jxlMeta: null, staleOldNames: oldJxlNames, originalDoc});
      return data;
    }

    const mainJxlName = jxlFilename(data.filename);
    if (!mainJxlName) return data;

    const mainIsJpeg = isJpeg(fileBytes, mimeType);
    const originalSha256 = mainIsJpeg ? sha256Hex(fileBytes) : undefined;
    const mainResult = await encodeImageBytes(fileBytes, mimeType, settings, req);

    const encodedSizes = {};
    const sizeBuffers = req?.payloadUploadSizes;
    if (plain(data.sizes) && plain(sizeBuffers)) {
      for (const [sizeName, sizeMeta] of Object.entries(data.sizes)) {
        if (sizeName.startsWith(TEMP_PREFIX)) continue;
        const sizeBuf = sizeBuffers[sizeName];
        if (!plain(sizeMeta) || typeof sizeMeta.filename !== 'string' || !sizeMeta.filename || !sizeBuf?.byteLength) continue;
        const sizeMime = sizeMeta.mimeType || guessMimeFromFilename(sizeMeta.filename);
        if (!isSupportedImage(sizeBuf, sizeMime)) continue;
        const targetName = jxlFilename(sizeMeta.filename);
        if (!targetName) continue;
        const encoded = await encodeImageBytes(sizeBuf, sizeMime, settings, req);
        encodedSizes[sizeName] = {
          bytes: encoded.bytes,
          meta: {
            filename: targetName,
            filesize: encoded.bytes.byteLength,
            width: encoded.width ?? sizeMeta.width,
            height: encoded.height ?? sizeMeta.height,
            mimeType: 'image/jxl',
            sha256: sha256Hex(encoded.bytes),
            ...(isJpeg(sizeBuf, sizeMime) ? {originalSha256: sha256Hex(sizeBuf), originalFilesize: sizeBuf.byteLength} : {}),
            url: buildFileUrl({config: getRootConfig(), req, slug: col.slug, filename: targetName, prefix: data.prefix}),
          },
        };
      }
    }

    const wantsSpaceSaver = Boolean(settings.spaceSaver && mainIsJpeg);
    const queueAvailable = hasJobsQueue(req);
    const jxlMeta = {
      filename: mainJxlName,
      filesize: mainResult.bytes.byteLength,
      width: mainResult.width ?? data.width,
      height: mainResult.height ?? data.height,
      mimeType: 'image/jxl',
      sha256: sha256Hex(mainResult.bytes),
      fidelity: mainResult.fidelity ?? (mainIsJpeg ? 'exact' : 'default'),
      spaceSaved: false,
      originalFilesize: fileBytes.byteLength,
      ...(originalSha256 ? {originalSha256} : {}),
      ...(wantsSpaceSaver && !queueAvailable ? {spaceSaverError: {
        code: 'JXL_PLATFORM',
        message: 'Space saver requires Payload jobs queue support. The original was kept.',
      }} : {}),
      url: buildFileUrl({config: getRootConfig(), req, slug: col.slug, filename: mainJxlName, prefix: data.prefix}),
      sizes: Object.fromEntries(Object.entries(encodedSizes).map(([name, item]) => [name, item.meta])),
    };

    const newJxlNames = new Set(collectJxlFilenames(jxlMeta, data));
    const staleOldNames = oldJxlNames.filter(name => !newJxlNames.has(name));

    if (!storage.isCloud) {
      await writeLocalAtomic(storage.staticDir, mainJxlName, mainResult.bytes);
      for (const item of Object.values(encodedSizes)) {
        await writeLocalAtomic(storage.staticDir, item.meta.filename, item.bytes);
      }
      data.jxl = jxlMeta;
      if (req && typeof req === 'object') {
        pendingMap.set(req, {
          finalizedCloud: true,
          wantsSpaceSaver,
          queuedSpaceSaver: false,
          originalSha256,
          originalBytesLength: fileBytes.byteLength,
          jxlMeta,
          staleOldNames,
          originalDoc,
        });
      }
      return data;
    }

    // Cloud storage mode: stage JXL buffers so the storage adapter's beforeChange hook uploads every file through the adapter.
    for (const item of [{bytes: mainResult.bytes, meta: jxlMeta}, ...Object.values(encodedSizes)]) {
      const present = await storage.readBytes(item.meta.filename, {doc: data, req, prefix: data.prefix});
      if (present && sha256Hex(present) !== item.meta.sha256)
        throw fail('JXL_INPUT', 'An existing upload recovery file has different contents');
    }
    data.sizes = {...(plain(data.sizes) ? data.sizes : {})};
    req.payloadUploadSizes = {...(plain(req.payloadUploadSizes) ? req.payloadUploadSizes : {})};
    const stagedKeys = [];
    const mainKey = `${TEMP_PREFIX}original`;
    data.sizes[mainKey] = {
      filename: mainJxlName,
      filesize: mainResult.bytes.byteLength,
      width: jxlMeta.width,
      height: jxlMeta.height,
      mimeType: 'image/jxl',
    };
    req.payloadUploadSizes[mainKey] = Buffer.from(mainResult.bytes.buffer, mainResult.bytes.byteOffset, mainResult.bytes.byteLength);
    stagedKeys.push([mainKey, null]);

    for (const [sizeName, item] of Object.entries(encodedSizes)) {
      const tempKey = `${TEMP_PREFIX}size_${sizeName}`;
      data.sizes[tempKey] = {
        filename: item.meta.filename,
        filesize: item.meta.filesize,
        width: item.meta.width,
        height: item.meta.height,
        mimeType: 'image/jxl',
      };
      req.payloadUploadSizes[tempKey] = Buffer.from(item.bytes.buffer, item.bytes.byteOffset, item.bytes.byteLength);
      stagedKeys.push([tempKey, sizeName]);
    }

    data.jxl = jxlMeta;
    pendingMap.set(req, {
      finalizedCloud: false,
      stagedKeys,
      staleOldNames,
      originalDoc,
      wantsSpaceSaver,
      queuedSpaceSaver: false,
      originalSha256,
      originalBytesLength: fileBytes.byteLength,
      jxlMeta,
    });
    return data;
  };
  hooksMeta.ownBeforeChange.add(jxlBeforeChange);

  const finalizeCloudBeforeDb = async ({data, req}) => {
    const state = getPending(req);
    if (!state || state.finalizedCloud) return data?.jxl;
    state.finalizedCloud = true;
    let jxlMeta = {...state.jxlMeta, sizes: {...state.jxlMeta.sizes}};

    for (const [tempKey, sizeName] of state.stagedKeys) {
      const stagedMeta = data?.sizes?.[tempKey];
      if (stagedMeta?.url && typeof stagedMeta.url === 'string') {
        if (sizeName === null) {
          jxlMeta.url = stagedMeta.url;
          if (/^https?:\/\//i.test(stagedMeta.url)) jxlMeta.externalUrl = stagedMeta.url;
        } else if (jxlMeta.sizes[sizeName]) {
          jxlMeta.sizes[sizeName] = {
            ...jxlMeta.sizes[sizeName],
            url: stagedMeta.url,
            ...(/^https?:\/\//i.test(stagedMeta.url) ? {externalUrl: stagedMeta.url} : {}),
          };
        }
      }
      if (plain(data?.sizes)) delete data.sizes[tempKey];
      if (plain(req?.payloadUploadSizes)) delete req.payloadUploadSizes[tempKey];
    }

    if (state.wantsSpaceSaver && !hasJobsQueue(req) && !jxlMeta.spaceSaverError) {
      jxlMeta = {
        ...jxlMeta,
        spaceSaved: false,
        spaceSaverError: {
          code: 'JXL_PLATFORM',
          message: 'Space saver requires Payload jobs queue support. The original was kept.',
        },
      };
    }

    state.jxlMeta = jxlMeta;
    if (plain(data)) data.jxl = jxlMeta;
    return jxlMeta;
  };

  const persistRequestJxlMetadata = async (req, col, doc, jxlMeta) => {
    if (doc?.id == null || !plain(jxlMeta) || typeof req?.payload?.db?.updateOne !== 'function') return;
    await req.payload.db.updateOne({
      where: {
        and: [
          {id: {equals: doc.id}},
          ...(typeof doc.filename === 'string' ? [{filename: {equals: doc.filename}}] : []),
        ],
      },
      collection: col.slug,
      data: {jxl: jxlMeta},
      req,
      returning: false,
    });
  };

  const jxlAfterChange = async ({collection: runtimeCollection, doc, req}) => {
    const state = getPending(req);
    if (!state) return doc;
    const col = runtimeCollection ?? collection;
    const storage = createStorageBridge(col, hooksMeta);
    let needsMetadataPersist = false;

    if (!state.finalizedCloud) {
      const finalized = await finalizeCloudBeforeDb({data: doc, req});
      doc.jxl = refreshJxlUrls(finalized, {config: getRootConfig(), req, slug: col.slug, prefix: doc?.prefix});
      needsMetadataPersist = true;
    }

    if (state.wantsSpaceSaver && plain(doc?.jxl) && !state.queuedSpaceSaver) {
      state.queuedSpaceSaver = true;
      if (!hasJobsQueue(req)) {
        if (!doc.jxl.spaceSaverError) {
          doc.jxl = refreshJxlUrls({
            ...doc.jxl,
            spaceSaved: false,
            spaceSaverError: {
              code: 'JXL_PLATFORM',
              message: 'Space saver requires Payload jobs queue support. The original was kept.',
            },
          }, {config: getRootConfig(), req, slug: col.slug, prefix: doc?.prefix});
          needsMetadataPersist = true;
        }
      } else if (doc?.id == null) {
        doc.jxl = refreshJxlUrls({
          ...doc.jxl,
          spaceSaved: false,
          spaceSaverError: {
            code: 'JXL_INPUT',
            message: 'Upload document has no ID for Space saver retirement. The original was kept.',
          },
        }, {config: getRootConfig(), req, slug: col.slug, prefix: doc?.prefix});
        needsMetadataPersist = true;
      } else {
        const verified = await verifyWrittenJxlForQueue({
          storage,
          doc,
          jxlMeta: doc.jxl,
          originalSha256: state.originalSha256,
          originalBytesLength: state.originalBytesLength,
          req,
        });
        if (!verified.ok) {
          doc.jxl = refreshJxlUrls({
            ...doc.jxl,
            spaceSaved: false,
            spaceSaverError: verified.error,
          }, {config: getRootConfig(), req, slug: col.slug, prefix: doc?.prefix});
          needsMetadataPersist = true;
        } else {
          try {
            await req.payload.jobs.queue({
              task: SPACE_SAVER_TASK,
              input: {collection: col.slug, id: doc.id},
              req,
            });
          } catch (error) {
            const code = typeof error?.code === 'string' && error.code.startsWith('JXL_') ? error.code : 'JXL_IO';
            doc.jxl = refreshJxlUrls({
              ...doc.jxl,
              spaceSaved: false,
              spaceSaverError: {
                code,
                message: 'Could not queue the Space saver job. The original was kept.',
              },
            }, {config: getRootConfig(), req, slug: col.slug, prefix: doc?.prefix});
            needsMetadataPersist = true;
          }
        }
      }
    }

    if (needsMetadataPersist) {
      await persistRequestJxlMetadata(req, col, doc, doc.jxl).catch(() => {});
    }

    // Without a transaction, the new row is already durable here. In a transaction the old recovery files stay available.
    if (!req?.transactionID && state.originalDoc?.jxl?.spaceSaved !== true && state.staleOldNames?.length)
      await storage.deleteFiles(state.staleOldNames, {doc: state.originalDoc, req});
    pendingMap.delete(req);
    return doc;
  };

  const jxlAfterDelete = async ({collection: runtimeCollection, doc, req}) => {
    // afterDelete may still roll back. A retired original's .jxl is its only copy, so inside a transaction it stays.
    // Every other .jxl is made from an original that is kept, and Payload removes its own files in the same transaction.
    if (req?.transactionID && doc?.jxl?.spaceSaved === true) return;
    const names = collectJxlFilenames(doc?.jxl, doc);
    if (!names.length) return;
    const col = runtimeCollection ?? collection;
    const storage = createStorageBridge(col, hooksMeta);
    await storage.deleteFiles(names, {doc, req});
  };
  hooksMeta.ownAfterDelete.add(jxlAfterDelete);

  const prevModifyHeaders = uploadObj.modifyResponseHeaders;
  uploadObj.modifyResponseHeaders = args => {
    const base = typeof prevModifyHeaders === 'function' ? prevModifyHeaders(args) || args.headers : args.headers;
    return varyAccept(base);
  };

  const jxlUploadHandler = async (req, {doc, headers, params}) => {
    const runtimeCol = req?.payload?.collections?.[params?.collection]?.config ?? collection;
    const storage = createStorageBridge(runtimeCol, hooksMeta);
    const requestedJxl = req?.context?.[REQUESTED_JXL];
    const rawFilename = typeof requestedJxl === 'string' ? requestedJxl : params?.filename;
    if (!['GET', 'HEAD'].includes((req?.method || 'GET').toUpperCase())) return undefined;
    if (typeof rawFilename !== 'string' || !rawFilename) return undefined;
    const directJxl = /\.jxl$/i.test(rawFilename);
    const sourceFilename = directJxl ? baseFilenameFromJxl(rawFilename) : rawFilename;
    const companionJxl = jxlFilename(sourceFilename);
    if (!companionJxl) throw fail('JXL_INPUT', 'Invalid upload filename');
    if (params?.prefix != null && typeof params.prefix !== 'string') throw fail('JXL_INPUT', 'Invalid upload prefix');
    if (doc == null) {
      if (typeof req?.payload?.find !== 'function') throw fail('JXL_INPUT', 'Upload ownership is unavailable');
      const names = [{filename: {equals: sourceFilename}}];
      for (const size of runtimeCol.upload?.imageSizes ?? []) {
        if (typeof size?.name === 'string') names.push({[`sizes.${size.name}.filename`]: {equals: sourceFilename}});
      }
      const constraints = [{or: names}];
      if (typeof params?.prefix === 'string') constraints.push({prefix: {equals: params.prefix}});
      const lookup = {
        collection: runtimeCol.slug, where: {and: constraints}, depth: 0, limit: 2, pagination: false,
        overrideAccess: false, user: req.user, req,
      };
      let found = await req.payload.find(lookup);
      if (!found?.docs?.length && runtimeCol.versions?.drafts) found = await req.payload.find({...lookup, draft: true});
      const matches = (found?.docs ?? []).filter(row => ownedUploadEntry(row, sourceFilename) &&
        (params?.prefix == null || (row.prefix ?? '') === params.prefix));
      if (matches.length !== 1 || found?.hasNextPage) throw fail('JXL_INPUT', 'Upload filename has no unambiguous owner');
      doc = matches[0];
    }
    const entry = ownedUploadEntry(doc, sourceFilename);
    if (!entry) throw fail('JXL_INPUT', 'Requested filename does not belong to this upload');
    if ((doc.prefix != null && typeof doc.prefix !== 'string') ||
      (params?.prefix != null && params.prefix !== (doc.prefix ?? ''))) throw fail('JXL_INPUT', 'Requested prefix does not belong to this upload');
    const prefix = doc.prefix ?? undefined;
    const metadata = entry.metadata;
    const notFound = () => {
      const body = JSON.stringify({errors: [{message: 'File not found.'}]});
      return new Response(req?.method?.toUpperCase() === 'HEAD' ? null : body, {
        status: 404, headers: varyAccept(new Headers({'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body))})),
      });
    };
    if (metadata == null) return directJxl ? notFound() : undefined;
    if (!plain(metadata) || metadata.filename !== companionJxl) throw fail('JXL_INPUT', 'Archive filename does not belong to this upload');
    const sourceMime = entry.source.mimeType || guessMimeFromFilename(sourceFilename);
    const isJpegSource = JPEG_MIME.test(sourceMime);

    const retainHeaders = original => {
      const out = new Headers(original);
      for (const [name, value] of new Headers(headers)) if (!out.has(name)) out.set(name, value);
      return mergeServingPolicies(out, headers);
    };
    const adapterAnswer = async response => {
      let out = retainHeaders(response.headers);
      out = uploadObj.modifyResponseHeaders({headers: out}) || out;
      mergeServingPolicies(out, response.headers);
      varyAccept(out);
      const head = req?.method?.toUpperCase() === 'HEAD';
      if (head) await response.body?.cancel();
      return new Response(head ? null : response.body, {status: response.status, statusText: response.statusText, headers: out});
    };
    const readComplete = async (filename, expectedLength) => {
      if (expectedLength !== undefined && (!Number.isSafeInteger(expectedLength) || expectedLength < 0)) {
        throw fail('JXL_RECONSTRUCTION', 'Stored file has an invalid recorded size');
      }
      if (!storage.isCloud) {
        const bytes = await storage.readBytes(filename, {doc, req, prefix});
        return bytes ? {bytes, headers: retainHeaders()} : null;
      }
      const response = await storage.fetchViaAdapter(fullFileRequest(req, filename, prefix), {doc, filename, prefix, headers});
      if (!response) return null;
      if (response.status >= 400) return {response, missing: response.status === 404};
      if (response.status !== 200 || response.headers.has('Content-Range') ||
        (response.headers.has('Content-Encoding') && response.headers.get('Content-Encoding').toLowerCase() !== 'identity')) {
        await response.body?.cancel();
        throw fail('JXL_IO', 'Storage adapter did not return a complete file');
      }
      let bytes;
      try { bytes = await readStoredBody(response, expectedLength); }
      catch (error) {
        if (error?.code === 'JXL_RECONSTRUCTION' || error?.code === 'JXL_IO') throw error;
        throw fail('JXL_IO', 'Could not read the complete stored file');
      }
      return {bytes, headers: retainHeaders(response.headers)};
    };
    const checkOriginal = bytes => {
      if (!isJpeg(bytes)) throw fail('JXL_RECONSTRUCTION', 'Stored original is not a JPEG');
      checkStoredIdentity(bytes, metadata.originalSha256, metadata.originalFilesize, 'Original JPEG');
      checkStoredIdentity(bytes, undefined, entry.source.filesize, 'Original JPEG');
    };
    let requestedOriginal;
    const serveArchive = async asJxl => {
      const stored = await readComplete(companionJxl, metadata.filesize);
      if (!stored || stored.missing) {
        await stored?.response?.body?.cancel();
        return null;
      }
      if (stored.response) return adapterAnswer(stored.response);
      checkStoredIdentity(stored.bytes, metadata.sha256, metadata.filesize, 'JPEG XL archive');
      let original;
      if (isJpegSource) {
        try { original = (await restore(stored.bytes))?.bytes; }
        catch { throw fail('JXL_RECONSTRUCTION', 'Stored JPEG XL could not reconstruct its JPEG'); }
        if (!(original instanceof Uint8Array)) throw fail('JXL_RECONSTRUCTION', 'Stored JPEG XL did not reconstruct a JPEG');
        checkOriginal(original);
      }
      if (!asJxl && !original) return null;
      mergeServingPolicies(stored.headers, requestedOriginal?.headers ?? requestedOriginal?.response?.headers);
      return bytesResponse(asJxl ? stored.bytes : original, asJxl ? 'image/jxl' : 'image/jpeg', req, uploadObj.modifyResponseHeaders, stored.headers);
    };

    if (storage.isCloud) {
      requestedOriginal = await readComplete(sourceFilename, entry.source.filesize ?? metadata.originalFilesize);
      if (requestedOriginal?.bytes) {
        if (isJpegSource) checkOriginal(requestedOriginal.bytes);
        else checkStoredIdentity(requestedOriginal.bytes, undefined, entry.source.filesize, 'Original image');
      }
      if (requestedOriginal?.response && (!requestedOriginal.missing || requestedOriginal.response.headers.has('Set-Cookie') ||
        /(?:^|,)\s*(?:private|no-store|no-cache)\b/i.test(requestedOriginal.response.headers.get('Cache-Control') ?? ''))) {
        return adapterAnswer(requestedOriginal.response);
      }
    }

    // 1. Direct .jxl file request (from <picture><source type="image/jxl" srcSet="...jxl">).
    if (directJxl) {
      const answer = (await serveArchive(true)) || notFound();
      await requestedOriginal?.response?.body?.cancel();
      return answer;
    }
    const acceptHeader = req?.headers?.get?.('accept') ?? req?.headers?.get?.('Accept') ?? '';

    // 2. Content negotiation when a client requests the original or size path with Accept: image/jxl.
    const byteRange = (req?.method || 'GET').toUpperCase() === 'GET' && /^bytes=/i.test(req?.headers?.get?.('range') ?? '');
    if (!byteRange && !isPreviewRequest(req) && RASTER_MIME.test(sourceMime) && acceptsJxl(acceptHeader, sourceMime)) {
      const negotiated = await serveArchive(true);
      if (negotiated) {
        await requestedOriginal?.response?.body?.cancel();
        return negotiated;
      }
    }

    // 3. Non-JXL client: serve existing original, or restore Space-saver JPEG on the server.
    if (isJpegSource) {
      const original = storage.isCloud ? requestedOriginal : await readComplete(sourceFilename, entry.source.filesize ?? metadata.originalFilesize);
      if (original?.bytes) {
        checkOriginal(original.bytes);
        return bytesResponse(original.bytes, 'image/jpeg', req, uploadObj.modifyResponseHeaders, original.headers);
      }
      if (original?.response && (!original.missing || original.response.headers.has('Set-Cookie') ||
        /(?:^|,)\s*(?:private|no-store|no-cache)\b/i.test(original.response.headers.get('Cache-Control') ?? ''))) {
        return adapterAnswer(original.response);
      }
      const restored = await serveArchive(false);
      if (restored) {
        await original?.response?.body?.cancel();
        return restored;
      }
      return original?.response ? adapterAnswer(original.response) : undefined;
    }

    // Local disk: if original image is present, let Payload's native stream handler serve it (with Vary: Accept from modifyResponseHeaders).
    // Uploads without archive metadata return above. Recorded JPEGs use the verified response path before this fallback.
    if (storage.isCloud) {
      if (requestedOriginal?.bytes) return bytesResponse(requestedOriginal.bytes, sourceMime, req, uploadObj.modifyResponseHeaders, requestedOriginal.headers);
      return requestedOriginal?.response ? adapterAnswer(requestedOriginal.response) : undefined;
    }
    return undefined;
  };
  hooksMeta.ownHandlers.add(jxlUploadHandler);
  uploadObj.handlers = [jxlUploadHandler, ...(uploadObj.handlers ?? [])];

  const jxlFileEndpoint = {
    method: 'get',
    path: '/file/:filename',
    handler: async req => {
      const collectionEntity = req?.payload?.collections?.[collection.slug];
      const endpoints = collectionEntity?.config?.endpoints ?? [];
      const builtin = [...endpoints].reverse().find(ep => ep.method === 'get' && ep.path === '/file/:filename' && ep.handler !== jxlFileEndpoint.handler);
      if (!builtin) {
        return new Response(JSON.stringify({errors: [{message: 'Upload endpoint unavailable.'}]}), {status: 500});
      }
      const requested = req?.routeParams?.filename;
      const base = baseFilenameFromJxl(requested);
      if (base) {
        req.context = req.context ?? {};
        req.context[REQUESTED_JXL] = requested;
        req.routeParams = {...req.routeParams, filename: base};
      }
      const response = await builtin.handler(req);
      const outHeaders = new Headers(response.headers);
      varyAccept(outHeaders);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: outHeaders,
      });
    },
  };

  const fields = [...(collection.fields ?? [])];
  if (!fields.some(field => field && typeof field === 'object' && 'name' in field && field.name === 'jxl')) {
    fields.push({
      name: 'jxl',
      type: 'json',
      admin: {readOnly: true},
      hooks: {
        beforeChange: [
          async ({data, req, originalDoc}) => {
            // Admin readOnly does not reject REST or Local API input. Only this upload's private state owns recovery metadata.
            if (!getPending(req)) return originalDoc?.jxl ?? null;
            const finalized = await finalizeCloudBeforeDb({data, req});
            return finalized !== undefined ? finalized : getPending(req)?.jxlMeta ?? null;
          },
        ],
        afterRead: [
          ({collection: runtimeCol, data, originalDoc, req, value}) => {
            const raw = value ?? data?.jxl ?? originalDoc?.jxl;
            const prefix = data?.prefix ?? originalDoc?.prefix;
            return refreshJxlUrls(raw, {
              config: getRootConfig(),
              req,
              slug: runtimeCol?.slug ?? collection.slug,
              prefix,
            });
          },
        ],
      },
    });
  }

  const hooks = {...(collection.hooks ?? {})};
  hooks.beforeChange = alreadyCloud
    ? [jxlBeforeChange, ...(hooks.beforeChange ?? [])]
    : [...(hooks.beforeChange ?? []), jxlBeforeChange];
  hooks.afterChange = [...(hooks.afterChange ?? []), jxlAfterChange];
  hooks.afterDelete = [...(hooks.afterDelete ?? []), jxlAfterDelete];

  const nextEndpoints = collection.endpoints === false
    ? false
    : [...(collection.endpoints ?? []), jxlFileEndpoint];

  return {
    collection: {
      ...collection,
      upload: uploadObj,
      fields,
      hooks,
      endpoints: nextEndpoints,
    },
    hooksMeta,
  };
}

export function jxl(options = {}) {
  validateSettings(options, ALLOWED_OPTIONS);
  const plugin = config => {
    if (!plain(config)) throw fail('JXL_OPTIONS', 'Payload config must be an object');
    let finalConfig = config;
    const priorRegistry = config.custom?.[STATE] instanceof Map ? config.custom[STATE] : null;
    const registry = new Map(priorRegistry ?? []);
    const collections = (config.collections ?? []).map(collection => {
      const settings = resolveCollectionSettings(collection, options);
      if (!settings) return collection;
      const attached = attachCollection(collection, settings, () => finalConfig);
      registry.set(collection.slug, {settings, hooksMeta: attached.hooksMeta});
      return attached.collection;
    });

    const anySpaceSaver = Boolean(options.spaceSaver) || [...registry.values()].some(entry => entry?.settings?.spaceSaver);
    let nextJobs = config.jobs;
    if (anySpaceSaver) {
      const baseJobs = plain(config.jobs) ? {...config.jobs} : {};
      const tasks = Array.isArray(baseJobs.tasks) ? [...baseJobs.tasks] : [];
      if (!tasks.some(task => task?.slug === SPACE_SAVER_TASK)) {
        tasks.push(createSpaceSaverTask(() => finalConfig));
      }
      nextJobs = {
        ...baseJobs,
        enabled: true,
        tasks,
      };
    }

    finalConfig = {
      ...config,
      collections,
      ...(anySpaceSaver ? {jobs: nextJobs} : {}),
      custom: {
        ...(config.custom ?? {}),
        [STATE]: registry,
      },
    };
    return finalConfig;
  };
  // Run before cloud storage plug-ins in buildConfig() so jxl() observes user hooks separately from adapter hooks.
  plugin.order = -1000;
  return plugin;
}

export default jxl;

export async function restoreOriginals(payload, options = {}) {
  if (!payload || typeof payload.find !== 'function') {
    throw fail('JXL_OPTIONS', 'restoreOriginals requires an initialized Payload instance');
  }
  if (!plain(options)) throw fail('JXL_OPTIONS', 'restoreOriginals options must be an object');
  const filterSlugs = options.collections
    ? new Set(Array.isArray(options.collections) ? options.collections : [options.collections])
    : null;
  const registry = payload.config?.custom?.[STATE];
  const collections = (payload.config?.collections ?? []).filter(col => {
    if (!col?.upload) return false;
    if (filterSlugs && !filterSlugs.has(col.slug)) return false;
    return true;
  });

  let restored = 0;
  let skipped = 0;
  const perCollection = {};

  for (const col of collections) {
    const meta = registry?.get(col.slug)?.hooksMeta ?? defaultHooksMeta(col);
    const storage = createStorageBridge(col, meta);
    let colRestored = 0;
    let page = 1;
    for (;;) {
      const found = await payload.find({
        collection: col.slug,
        depth: 0,
        limit: 100,
        overrideAccess: true,
        page,
      });
      const docs = found?.docs ?? [];
      for (const doc of docs) {
        if (!doc?.filename || !JPEG_MIME.test(doc.mimeType || guessMimeFromFilename(doc.filename))) {
          skipped++;
          continue;
        }
        const jxlName = doc.jxl?.filename ?? jxlFilename(doc.filename);
        const existingOriginal = await storage.readBytes(doc.filename, {doc, req: {payload, context: {}}});
        if (existingOriginal && doc.jxl?.spaceSaved !== true) {
          skipped++;
          continue;
        }
        if (!jxlName || jxlName !== jxlFilename(doc.filename) || !/^[a-f0-9]{64}$/.test(doc.jxl?.originalSha256 ?? '') ||
          !Number.isSafeInteger(doc.jxl?.originalFilesize) || doc.jxl.originalFilesize < 1)
          throw fail('JXL_INPUT', `Recovery metadata does not identify the original JPEG ${doc.filename}`);
        if (existingOriginal && (sha256Hex(existingOriginal) !== doc.jxl.originalSha256 || existingOriginal.byteLength !== doc.jxl.originalFilesize))
          throw fail('JXL_INPUT', `A different file already occupies the original name ${doc.filename}`);
        if (!existingOriginal) {
          if (!jxlName) throw fail('JXL_INPUT', `Missing JPEG XL source for ${col.slug}/${doc.filename}`);
          const jxlBytes = await storage.readBytes(jxlName, {doc, req: {payload, context: {}}});
          if (!jxlBytes) throw fail('JXL_IO', `JPEG XL file ${jxlName} is missing in ${col.slug}`);
          if ((doc.jxl.sha256 && sha256Hex(jxlBytes) !== doc.jxl.sha256) ||
            (Number.isSafeInteger(doc.jxl.filesize) && jxlBytes.byteLength !== doc.jxl.filesize))
            throw fail('JXL_RECONSTRUCTION', `Stored JPEG XL identity changed for ${doc.filename}`);
          const rebuilt = await restore(jxlBytes);
          if (!(rebuilt?.bytes instanceof Uint8Array)) {
            throw fail('JXL_RECONSTRUCTION', `Could not restore original JPEG from ${jxlName}`);
          }
          if (rebuilt.bytes.byteLength !== doc.jxl.originalFilesize || sha256Hex(rebuilt.bytes) !== doc.jxl.originalSha256) {
            throw fail('JXL_RECONSTRUCTION', `Restored JPEG SHA-256 mismatch for ${doc.filename}`);
          }
          const placed = await storage.writeSingleFile({
            buffer: rebuilt.bytes,
            filename: doc.filename,
            mimeType: 'image/jpeg',
            doc,
            req: {payload, context: {}},
          });
          const verified = await storage.readBytes(doc.filename, {doc, req: {payload, context: {}}});
          if (!verified || verified.byteLength !== doc.jxl.originalFilesize || sha256Hex(verified) !== doc.jxl.originalSha256) {
            throw fail('JXL_IO', `Failed to verify restored original JPEG ${doc.filename}`);
          }
          if (placed) { colRestored++; restored++; } else skipped++;
        } else {
          skipped++;
        }

        if (plain(doc.jxl) && doc.jxl.spaceSaved === true) {
          const {spaceSaverError: _cleared, ...restJxl} = doc.jxl;
          const nextJxl = {...restJxl, spaceSaved: false};
          if (typeof payload.db?.updateOne !== 'function')
            throw fail('JXL_PLATFORM', 'Completing restoration requires a conditional database writer. The original and recovery archive were kept.');
          const identity = {id: doc.id, filename: doc.filename, 'jxl.filename': doc.jxl.filename,
            'jxl.spaceSaved': true, 'jxl.originalSha256': doc.jxl.originalSha256, 'jxl.originalFilesize': doc.jxl.originalFilesize};
          for (const name of ['sha256', 'filesize']) if (doc.jxl[name] !== undefined) identity[`jxl.${name}`] = doc.jxl[name];
          if (doc.prefix !== undefined) identity.prefix = doc.prefix;
          if (doc.updatedAt !== undefined) identity.updatedAt = doc.updatedAt;
          const conditions = Object.entries(identity).map(([name, value]) => ({[name]: {equals: value}}));
          if (doc.prefix === undefined && (col.flattenedFields ?? col.fields ?? []).some(field => field.name === 'prefix'))
            conditions.push({prefix: {exists: false}});
          // A delayed restore cannot replace the recovery record of a newer upload or another completed restore.
          try {
            await payload.db.updateOne({
              where: {and: conditions},
              collection: col.slug,
              data: {jxl: nextJxl},
              options: {atomic: true},
              returning: false,
            });
          } catch {
            throw fail('JXL_IO', 'Could not complete the conditional recovery metadata update. The original and recovery archive were kept.');
          }
        }
      }
      if (!found?.hasNextPage || docs.length === 0) break;
      page++;
    }
    perCollection[col.slug] = colRestored;
  }

  return {restored, skipped, collections: perCollection};
}

export async function restoreLocalOriginals(staticDir) {
  if (typeof staticDir !== 'string' || !staticDir) {
    throw fail('JXL_OPTIONS', 'restoreLocalOriginals requires a directory path');
  }
  const {readdir} = await import('node:fs/promises');
  const root = resolve(staticDir);
  const entries = await readdir(root, {withFileTypes: true}).catch(error => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  let restored = 0;
  let skipped = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !/\.jpe?g\.jxl$/i.test(entry.name)) continue;
    const origName = entry.name.slice(0, -4);
    const existing = await readLocalBytes(root, origName);
    if (existing) {
      skipped++;
      continue;
    }
    const jxlBytes = await readLocalBytes(root, entry.name);
    if (!jxlBytes) continue;
    const rebuilt = await restore(jxlBytes);
    await writeLocalAtomic(root, origName, rebuilt.bytes);
    restored++;
  }
  return {restored, skipped};
}
