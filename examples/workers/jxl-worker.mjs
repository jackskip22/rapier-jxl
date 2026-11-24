// SPDX-License-Identifier: MIT
// A Worker in front of a site: browsers that send Accept: image/jxl get a JPEG's or PNG's JPEG XL file where one exists,
// and everyone else, and every request whose file is missing, gets the site's response untouched. It works on Workers
// Free, where a request has almost no CPU: the files are made before (`npx jpegxl <folder> --keep-extension` writes photo.jpg.jxl beside
// photo.jpg, which this serves for photo.jpg), or stored in R2 (binding JXL) or else the Cache API.
// JXL_CONVERT=on (Workers Paid, limits.cpu_ms 30,000) also makes the missing ones here: JPEGs recompressed without loss
// (rapier-jxl/jpeg restores the original JPEG), PNGs exact, each once, after the first such request has been answered
// with the original. JXL_SPACE_SAVER=on on Workers Paid stores JPEGs only as exact JPEG XL and rebuilds the original JPEG
// for browsers without JPEG XL and for share previews, with Cache-Control and Vary: Accept.
//
//   export default jxl();                // in front of the origin, or of the ASSETS binding
//   export default jxl(existingHandler); // around a Worker's own fetch handler
import {recompress} from 'jpegxl/jpeg';
import {encode} from 'jpegxl/upload';
import {acceptsJxl} from 'jpegxl/serve';

const TYPES = Object.freeze({__proto__: null, jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png'});
const mediaType = value => value?.split(';', 1)[0].trim().toLowerCase();
function matchesIfNoneMatch(header, etag) {
  if (!header || !etag) return false;
  const strip = tag => { const t = tag.trim(); return t.startsWith('W/"') ? t.slice(2) : t; };
  const target = strip(etag);
  return (header.match(/(?:[^",]|"[^"]*")+/g) ?? []).some(part => { const t = part.trim(); return t === '*' || strip(t) === target; });
}
// The highest effort, and the most pixels it converts, inside a 128 MB isolate: three runs of three stored in local
// workerd at each size below (Workers Paid itself not yet). Larger pictures step down, and past the last row they do not convert.
const FITS = {
  'image/jpeg': [[7, 4_200_000], [3, 12_600_000]],
  'image/png': [[1, 2_700_000]],
};
// The CPU of one conversion: [effort, ms, ms per million pixels], the next measured effort up, at least the most of three
// runs of the whole workerd process (local, warm and fresh isolates). A picture converts only when twice this fits
// JXL_CPU_MS, the Worker's limits.cpu_ms: Paid's 30,000 converts every size above, while Free's 10 passes every picture through.
const CPU = {
  'image/jpeg': [[1, 350, 120], [3, 560, 260], [7, 900, 420]],
  'image/png': [[1, 150, 200]],
  'image/png at a quality': [[1, 650, 360]],
};
// Records, stored beside the files and marked as records: `p<tries> <ms>` a conversion under way, `s <reason>` a picture
// that is never tried again. A record still under way after PENDING_MS was stopped by the host (waitUntil ends 30 s
// after the response): the next request tries once more, then records `cut short`.
const PENDING_MS = 60_000, TRIES = 2;
// One conversion at a time in an isolate: two at once would share its 128 MB, and an isolate over it loses both.
let busy = 0;

let spaceSaverMod;
const getSpaceSaver = () => spaceSaverMod ??= import('./jxl-space-saver.mjs');
const workerCaches = new Map();
async function cacheForOrigin(originUrl) {
  let cache = workerCaches.get(originUrl);
  if (!cache) { cache = (await getSpaceSaver()).originalWorkerCache(originUrl); workerCaches.set(originUrl, cache); }
  return cache;
}

const settings = env => ({
  convert: env.JXL_CONVERT === 'on',
  spaceSaver: env.JXL_SPACE_SAVER === 'on',
  effort: Number(env.JXL_EFFORT ?? 3),
  quality: env.JXL_QUALITY === undefined || env.JXL_QUALITY === '' ? null : Number(env.JXL_QUALITY), // PNGs only
  cpuMs: Number(env.JXL_CPU_MS ?? 30000),
});

const hex = buffer => [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha256 = async data => hex(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? new TextEncoder().encode(data) : data));

// An answer meant for one person is neither stored nor served from the store: the request carried Authorization or a
// cookie, or the site's answer says Set-Cookie or Cache-Control private, no-store or no-cache. It goes out as the site sent it.
const privateAnswer = (request, response) => request.headers.has('authorization') || request.headers.has('cookie') || response.headers.has('set-cookie') ||
  /(?:^|[\s,])(?:private|no-store|no-cache)(?=$|[\s,=])/i.test(response.headers.get('cache-control') ?? '');

// Whether an answer's Vary names only what this Worker already keeps apart: Accept (it asked for JPEG XL) and Accept-Encoding
// (the body is the same picture once decoded). Anything else, or `*`, varies on what the store's key does not hold.
const keptVary = response => (response.headers.get('vary') ?? '').split(',').map(name => name.trim().toLowerCase()).filter(Boolean)
  .every(name => name === 'accept' || name === 'accept-encoding');

// What the origin's Vary said, with Accept added once.
// Every additional header that selects this representation is also named once.
function varied(vary, variesByPreview = false) {
  const names = (vary ?? '').split(',').map(name => name.trim()).filter(Boolean);
  if (names.includes('*')) return vary;
  for (const name of ['Accept', ...(variesByPreview ? ['User-Agent', 'Purpose', 'Sec-Purpose', 'X-Purpose', 'Range'] : [])])
    if (!names.some(existing => existing.toLowerCase() === name.toLowerCase())) names.push(name);
  return names.join(', ');
}

// A PNG's IHDR or a JPEG's frame header: its pixel count, or 0.
function pixels(b) {
  const u16 = i => b[i] << 8 | b[i + 1];
  if (b[0] === 0x89 && b[1] === 0x50) return b.length >= 24 ? (u16(16) * 65536 + u16(18)) * (u16(20) * 65536 + u16(22)) : 0;
  for (let at = 2; b[0] === 0xff && b[1] === 0xd8 && at + 9 <= b.length;) {
    if (b[at] !== 0xff) return 0;
    const marker = b[at + 1];
    if (marker === 0xff) { at++; continue; }
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return u16(at + 5) * u16(at + 7);
    at += 2 + u16(at + 2);
  }
  return 0;
}

// {get(key) -> {record, size, body, text(), etag} | null, put(key, bytes), note(key, text, over?) -> claimed}: R2 when
// bound, else this location's Cache API. R2 notes are conditional: of two requests that both find no record (or the
// same stale one), one claims the conversion.
function store(env, url) {
  if (env.JXL) return {
    get: async key => {
      const object = await env.JXL.get(key);
      return object && {record: object.customMetadata?.jxl === 'record', size: object.size, body: object.body, text: () => object.text(), etag: object.etag};
    },
    put: (key, bytes) => env.JXL.put(key, bytes),
    note: async (key, text, over) => !!await env.JXL.put(key, text, {customMetadata: {jxl: 'record'},
      ...(over !== undefined && {onlyIf: over ? {etagMatches: over.etag} : new Headers({'if-none-match': '*'})})}),
  };
  const cache = caches.default, at = key => new Request(`${url.origin}/.jxl/${key}`), year = 'public, max-age=31536000';
  return {
    get: async key => {
      const hit = await cache.match(at(key));
      return hit && {record: hit.headers.has('x-jxl-record'), size: Number(hit.headers.get('content-length')), body: hit.body, text: () => hit.text()};
    },
    put: (key, bytes) => cache.put(at(key), new Response(bytes, {headers: {'cache-control': year}})),
    note: async (key, text) => (await cache.put(at(key), new Response(text, {headers: {'cache-control': year, 'x-jxl-record': '1'}})), true),
  };
}

// The CPU a conversion of this many pixels takes at this effort, in ms, and whether twice it fits.
function cpu(type, count, effort, quality) {
  const rows = CPU[type === 'image/png' && quality !== null ? 'image/png at a quality' : type];
  const [, start, perMP] = rows.find(([most]) => effort <= most) ?? rows.at(-1);
  return start + count / 1e6 * perMP;
}
const allowed = (options, type, count = 0, effort = 1) => 2 * cpu(type, count, effort, options.quality) <= options.cpuMs;
const overCpu = 'over the CPU this Worker allows';

// The effort this picture converts at, or why it does not: `keep` marks a reason that holds for any setting.
function fit(bytes, type, options) {
  const count = pixels(bytes), row = FITS[type].find(([, most]) => count <= most);
  if (!count) return {skip: 'not a picture this reads', keep: true};
  if (!row) return {skip: `over ${FITS[type].at(-1)[1] / 1e6} MP`, keep: true};
  const effort = Math.min(options.effort, row[0]);
  return allowed(options, type, count, effort) ? {effort} : {skip: overCpu};
}

async function convert(bytes, type, options, effort) {
  const result = type === 'image/jpeg'
    ? await recompress(bytes, {effort})
    : await encode(new Blob([bytes], {type}), {effort, fidelity: options.quality === null ? 'exact' : {quality: options.quality}});
  return result.bytes && result.bytes.byteLength < bytes.byteLength ? result.bytes : null;
}

const isJxlMagic = bytes => bytes[0] === 0xff && bytes[1] === 0x0a ||
  bytes.length > 12 && bytes[4] === 0x4a && bytes[5] === 0x58 && bytes[6] === 0x4c && bytes[7] === 0x20;

// The author's own photo.jpg.jxl for photo.jpg (photo.png.jxl for photo.png), served to a client that accepts it: the site answers 200 with
// a JPEG XL file, and where the picture's size is known the .jxl is smaller. Never reads a file bigger than the picture
// or than MAX_SIBLING_BYTES, whichever is less, into the isolate, and a read that fails falls back to the original.
const MAX_SIBLING_BYTES = 20_000_000;
async function sibling(request, url, origin, response) {
  // A common photo.jxl has no source identity: it can belong to a different extension or an older file.
  // --keep-extension writes this exact name even without a collision. No common-name fallback or origin probes.
  const at = new URL(url); at.pathname += '.jxl';
  return siblingAt(request, at, origin, response);
}
async function siblingAt(request, at, origin, response) {
  let answer;
  try { answer = await origin(new Request(at, {method: 'GET', headers: {accept: 'image/jxl'}})); } catch { return null; }
  if (answer.status !== 200 || !answer.body || privateAnswer(request, answer) || !keptVary(answer)) { answer.body?.cancel(); return null; }
  const size = Number(response.headers.get('content-length')) || 0;
  const cap = size > 0 ? Math.min(size, MAX_SIBLING_BYTES) : MAX_SIBLING_BYTES;
  const declared = Number(answer.headers.get('content-length')) || 0;
  // Not smaller than the picture, or past the read cap: fall back without pulling the body into the isolate.
  if (declared >= cap) { answer.body.cancel(); return null; }
  let bytes;
  try { bytes = await readBounded(answer.body, cap); } catch { return null; }
  if (!bytes) return null;
  if (!isJxlMagic(bytes) || size > 0 && bytes.byteLength >= size) return null;
  const headers = new Headers({'content-type': 'image/jxl', vary: varied(response.headers.get('vary')),
    'cache-control': response.headers.get('cache-control') ?? 'public, max-age=3600'});
  const etag = answer.headers.get('etag');
  if (etag) headers.set('etag', etag);
  if (matchesIfNoneMatch(request.headers.get('if-none-match'), etag)) return new Response(null, {status: 304, headers});
  headers.set('content-length', String(bytes.byteLength));
  return new Response(request.method === 'HEAD' ? null : bytes, {headers});
}

// Read a space-saver sibling (.jpg.jxl) or R2 archive when the original JPEG was removed (origin answered 404).
async function storedJpegSource(bucket, candidateKey, expectedFrom, expectedOrigin, {inline = false, hashed = false, canRestore = true} = {}) {
  const saver = await getSpaceSaver();
  const head = await bucket.head(candidateKey);
  if (!head || head.customMetadata?.jxl !== (inline ? 'retired' : 'exact')) return null;
  const owned = object => {
    const meta = object?.customMetadata;
    return object?.key === candidateKey && typeof object.etag === 'string' && object.etag &&
      Number.isSafeInteger(object.size) && object.size > 0 && object.size <= MAX_SIBLING_BYTES &&
      meta?.from === expectedFrom && (!meta.origin || meta.origin === expectedOrigin) &&
      (!hashed || meta.origin === expectedOrigin) &&
      (inline ? saver.isRetiredR2Jpeg(object, expectedFrom) : meta.jxl === 'exact' &&
        (!meta.type || meta.type === 'image/jpeg') && /^[a-f0-9]{64}$/.test(meta.sha256 ?? '') &&
        Number.isSafeInteger(Number(meta.bytes)) && Number(meta.bytes) > 0);
  };
  if (!owned(head)) return {invalid: true};
  if (!canRestore) return {unavailable: true};
  const object = await bucket.get(candidateKey, {onlyIf: {etagMatches: head.etag}});
  if (!object?.body || object.etag !== head.etag || !owned(object)) {
    await object?.body?.cancel?.(); return {invalid: true};
  }
  const bytes = await readBounded(object.body, MAX_SIBLING_BYTES).catch(() => null);
  const meta = object.customMetadata;
  if (!bytes || bytes.length !== object.size || !isJxlMagic(bytes) ||
      meta.jxlSha256 && await sha256(bytes) !== meta.jxlSha256) return {invalid: true};
  return {
    kind: 'stored', bytes, cacheKey: `${candidateKey}:${object.etag}`,
    sha256: meta.sha256, byteLength: Number(meta.bytes),
    cacheControl: meta.cacheControl || object.httpMetadata?.cacheControl || 'public, max-age=3600',
    etag: object.httpEtag, lastModified: meta.lastModified,
  };
}

async function retiredJpegSource(url, path, env, canRestore) {
  const saver = await getSpaceSaver();
  let key;
  try { key = decodeURIComponent(url.pathname.slice(1)); } catch { return null; }
  if (!saver.isRetirableJpegKey(key)) return null;
  for (const bucket of new Set([env.JXL_ORIGINALS, env.JXL])) {
    if (typeof bucket?.head !== 'function' || typeof bucket?.get !== 'function') continue;
    const source = await storedJpegSource(bucket, key, key, url.origin + path, {inline: true, canRestore});
    if (source) return source;
  }
  return null;
}

async function removedJpegSource(request, url, path, origin, env) {
  const at = new URL(url); at.pathname += '.jxl';
  let answer;
  try { answer = await origin(new Request(at, {method: 'GET', headers: {accept: 'image/jxl'}})); } catch { answer = null; }
  if (answer) {
    if (answer.status === 200 && answer.body && !privateAnswer(request, answer) && keptVary(answer)) {
      const declared = Number(answer.headers.get('content-length')) || 0;
      if (declared <= MAX_SIBLING_BYTES) {
        const bytes = await readBounded(answer.body, MAX_SIBLING_BYTES).catch(() => null);
        if (bytes && isJxlMagic(bytes)) {
          return {
            kind: 'beside', bytes,
            cacheKey: `${url.pathname}:${answer.headers.get('etag') ?? bytes.byteLength}`,
            cacheControl: answer.headers.get('cache-control') ?? 'public, max-age=3600',
            etag: answer.headers.get('etag') ?? undefined,
            vary: answer.headers.get('vary'),
            lastModified: answer.headers.get('last-modified') ?? undefined,
          };
        }
      } else answer.body.cancel();
    } else answer.body?.cancel();
  }
  let relKey = null;
  try { relKey = decodeURIComponent(url.pathname.slice(1)); } catch { relKey = null; }
  const saver = await getSpaceSaver();
  if (!saver.isRetirableJpegKey(relKey)) return null;
  const candidates = [];
  if (relKey) {
    candidates.push([relKey + '.jxl', false], [relKey.replace(/\.[^./]+$/, '') + '.jxl', false]);
  }
  candidates.push([`archive/${await sha256(url.origin + path)}.jxl`, true]);
  for (const bucket of new Set([env.JXL_ORIGINALS, env.JXL])) {
    if (typeof bucket?.head !== 'function' || typeof bucket?.get !== 'function') continue;
    for (const [candidateKey, hashed] of candidates) {
      const source = await storedJpegSource(bucket, candidateKey, relKey, url.origin + path, {hashed});
      if (source) return source;
    }
  }
  return null;
}

// The stream's bytes, or null past `cap`. The reader is released either way.
async function readBounded(body, cap) {
  const reader = body.getReader(), parts = [];
  let total = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) { reader.cancel().catch(() => {}); return null; }
      parts.push(value);
    }
  } finally { reader.releaseLock?.(); }
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.byteLength; }
  return out;
}

// The response's bytes without consuming it, or null past MAX_SIBLING_BYTES (the stream is canceled, not read on).
const within = response => Number(response.headers.get('content-length')) > MAX_SIBLING_BYTES ? null : readBounded(response.clone().body, MAX_SIBLING_BYTES);

function served(file, request, response, key, variesByPreview) {
  const etag = `"${key.slice(0, 32)}-jxl"`, headers = new Headers({'content-type': 'image/jxl', vary: varied(response.headers.get('vary'), variesByPreview), etag,
    'cache-control': response.headers.get('cache-control') ?? 'public, max-age=3600', 'x-jxl': 'stored'});
  const lastModified = response.headers.get('last-modified');
  if (lastModified) headers.set('last-modified', lastModified);
  if (matchesIfNoneMatch(request.headers.get('if-none-match'), etag)) {
    file.body?.cancel(); return new Response(null, {status: 304, headers});
  }
  headers.set('content-length', String(file.size));
  if (request.method === 'HEAD') { file.body?.cancel(); return new Response(null, {headers}); }
  return new Response(file.body, {headers});
}

// Way back: rebuild every removed original JPEG in a static folder or R2 bucket.
export async function restoreOriginals(target, options) {
  const saver = await getSpaceSaver();
  if (typeof target === 'string') return saver.restoreFolderOriginals(target, options);
  return saver.restoreR2Originals(target?.JXL_ORIGINALS ?? target?.JXL ?? target, options);
}

export function jxl(handler = {}) {
  return {
    ...handler,
    async fetch(request, env, ctx) {
      const origin = (asked = request) => handler.fetch ? handler.fetch(asked, env, ctx) : env.ASSETS ? env.ASSETS.fetch(asked) : fetch(asked);
      const url = new URL(request.url), type = TYPES[url.pathname.split('.').pop().toLowerCase()];
      if (!type || !['GET', 'HEAD'].includes(request.method)) return origin();
      const options = settings(env);
      const ranged = request.method === 'GET' && request.headers.has('range');

      if (!options.spaceSaver && type !== 'image/jpeg') {
        if (ranged || !acceptsJxl(request.headers.get('accept'), type)) return origin();
      }

      const saver = options.spaceSaver || type === 'image/jpeg' ? await getSpaceSaver() : null;
      const canRestore = saver ? saver.canRetireJpeg({platform: 'cloudflare', cpuLimitMs: options.cpuMs}) : false;
      const canRetire = options.spaceSaver && canRestore;
      const preview = saver ? saver.isSharePreviewRequest(request) : false;
      const wantsJxl = !ranged && !preview && acceptsJxl(request.headers.get('accept'), type);

      // Non-JPEGs always keep their originals, and hosts below the Paid CPU budget never retire or cold-restore JPEGs.
      // The retirement setting gates new writes. A capable host can still read an existing archive when it is off.
      if (type !== 'image/jpeg' && !wantsJxl) return origin();
      if (request.headers.has('authorization') || request.headers.has('cookie')) return origin();

      const response = await origin(), path = url.pathname + url.search, logged = url.pathname;
      const said = (r, state) => { r.headers.set('vary', varied(r.headers.get('vary'), type === 'image/jpeg')); r.headers.set('x-jxl', state); console.log(`rapier-jxl ${logged}: ${state}`); return r; };
      const original = (reason, body = response.body) => said(new Response(body, response), `skipped: ${reason}`);

      if (type === 'image/jpeg' && [200, 206, 304, 404].includes(response.status) && !privateAnswer(request, response) && keptVary(response)) {
        // A known small CPU allowance cannot cold-restore or verify an archive, even when retirement was enabled before.
        if (!canRestore && response.status === 404) return response;
        const archived = await retiredJpegSource(url, path, env, canRestore) ??
          (response.status === 404 ? await removedJpegSource(request, url, path, origin, env) : null);
        if (archived) {
          await response.body?.cancel();
          if (archived.invalid) return new Response('Not found', {status: 404});
          if (archived.unavailable) return new Response(request.method === 'HEAD' ? null : JSON.stringify({
            code: 'JXL_PLATFORM', error: 'This Worker cannot restore a retired JPEG within its CPU allowance.',
          }), {status: 503, headers: {'content-type': 'application/json', 'cache-control': 'no-store', vary: varied(undefined, true)}});
          try {
            const identity = {
              cache: await cacheForOrigin(url.origin), cacheKey: archived.cacheKey,
              sha256: archived.sha256, byteLength: archived.byteLength,
            };
            // The JPEG branch checks reconstruction itself. A direct JXL answer must verify the same original identity.
            if (wantsJxl) await saver.rebuildOriginalJpeg(archived.bytes, identity);
            const rebuilt = await saver.serveStoredJxl(archived.bytes, request, {...identity,
              cacheControl: archived.cacheControl, etag: archived.etag,
              vary: varied(archived.vary), lastModified: archived.lastModified,
            });
            const state = rebuilt.headers.get('content-type') === 'image/jxl' ? archived.kind : 'restored';
            return said(rebuilt, state);
          } catch {
            return new Response('Not found', {status: 404});
          }
        }
        if (response.status === 404) return response;
      }

      if (!wantsJxl) {
        if (response.status === 200 && !privateAnswer(request, response) && keptVary(response)) {
          const headers = new Headers(response.headers);
          headers.set('vary', varied(headers.get('vary'), type === 'image/jpeg'));
          return new Response(response.body, {status: response.status, statusText: response.statusText, headers});
        }
        return response;
      }

      if (response.status !== 200) return original(`the site answered ${response.status}`);
      if ((mediaType(response.headers.get('content-type')) ?? type) !== type) return original('unexpected content type');
      if (privateAnswer(request, response)) return original('the answer is private');
      const converts = options.convert && allowed(options, type);
      // The file made before, beside the picture: no encoding work in this request.
      if (!keptVary(response)) return original('the answer varies on more than Accept');
      const beside = await sibling(request, url, origin, response);
      if (beside) { response.body?.cancel(); return said(beside, 'beside'); }
      // Nothing else can hold a file for it: no R2, and nothing converted into this location's cache.
      if (!options.convert && !env.JXL) return original('no JPEG XL file for it');
      const kept = store(env, url), validator = response.headers.get('etag') ?? response.headers.get('last-modified');
      if (validator === null && !converts) return original(options.convert ? overCpu : 'no JPEG XL file for it');
      const bytes = validator === null ? await within(response) : null;
      if (bytes === null && validator === null) return original(`over ${MAX_SIBLING_BYTES / 1e6} MB`);
      const key = await sha256(JSON.stringify([url.origin + path, validator ?? await sha256(bytes), options.effort, options.quality]));

      let file, record = null;
      try {
        file = await kept.get(key);
        if (file && !file.record) { response.body?.cancel(); return served(file, request, response, key, type === 'image/jpeg'); }
        if (file) record = await file.text();
      } catch (error) { return original('the store failed'); }
      if (record?.startsWith('s ')) return original(record.slice(2));
      const tries = record ? Number(record.slice(1, record.indexOf(' '))) : 0;
      const stale = record && Date.now() - Number(record.slice(record.indexOf(' ') + 1)) >= PENDING_MS;
      if (record && !stale) return original('converting');
      if (!converts) return original(options.convert ? overCpu : 'no JPEG XL file for it');
      if (request.method !== 'GET') return original('HEAD (a GET converts)');
      if (stale && tries >= TRIES) {
        await kept.note(key, 's cut short', file).catch(() => {});
        return original('cut short');
      }
      const source = bytes ?? await within(response);
      if (!source) return original(`over ${MAX_SIBLING_BYTES / 1e6} MB`);
      response.body?.cancel();
      const sized = fit(source, type, options);
      if (sized.skip) { if (sized.keep) await kept.note(key, `s ${sized.skip}`).catch(() => {}); return original(sized.skip, source); }
      if (Date.now() - busy < PENDING_MS) return original('this isolate is converting another picture', source);
      busy = Date.now();
      // The claim is written before the original goes out, so a request right after it finds the conversion under way.
      let claimed = false, failure;
      try { claimed = await kept.note(key, `p${tries + 1} ${Date.now()}`, file ?? null); } catch (error) { failure = error; }
      if (!claimed) { busy = 0; return original(failure ? 'the store failed' : 'converting', source); }

      const origCacheControl = response.headers.get('cache-control') ?? undefined;
      const origLastModified = response.headers.get('last-modified') ?? undefined;
      // The conversion holds the isolate's thread, which also writes this response: it starts once the body is read out.
      let at = 0, sent;
      const read = new Promise(resolve => sent = resolve);
      const answer = new Response(new ReadableStream({type: 'bytes', pull(stream) {
        if (at < source.byteLength) stream.enqueue(source.slice(at, at += 65536));
        if (at >= source.byteLength) stream.close(), sent();
      }, cancel: () => sent()}), response);
      answer.headers.set('content-length', String(source.byteLength));
      ctx.waitUntil((async () => {
        const t0 = Date.now();
        let outcome;
        try {
          await Promise.race([read, scheduler.wait(10_000)]);
          let output = null;
          try { output = await convert(source, type, options, sized.effort); } catch (error) {
            if (!String(error?.code).startsWith('JXL_')) throw error;
            outcome = `s ${error.code}`;
          }
          if (output && canRetire && type === 'image/jpeg') {
            const check = await saver.verifyRestoredJpeg(output, source);
            if (!check.verified) {
              output = null;
              outcome = 's restore mismatch';
            } else {
              await kept.put(key, output);
              let relKey = null;
              try { relKey = decodeURIComponent(url.pathname.slice(1)); } catch { relKey = null; }
              if (env.JXL?.put) {
                const archKey = `archive/${await sha256(url.origin + path)}.jxl`;
                await env.JXL.put(archKey, output, {
                  httpMetadata: {contentType: 'image/jxl', ...(origCacheControl && {cacheControl: origCacheControl})},
                  customMetadata: {
                    jxl: 'exact', ...(relKey && {from: relKey}), origin: url.origin + path,
                    sha256: check.sha256, bytes: String(source.byteLength),
                    jxlSha256: await sha256(output),
                    ...(origCacheControl && {cacheControl: origCacheControl}),
                    ...(origLastModified && {lastModified: origLastModified}),
                  },
                });
              }
              if (env.JXL_ORIGINALS && relKey && saver.isRetirableJpegKey(relKey)) {
                const origObj = await env.JXL_ORIGINALS.head(relKey);
                if (origObj) {
                  await saver.retireR2Jpeg(env.JXL_ORIGINALS, {
                    key: relKey, etag: origObj.etag, cacheControl: origCacheControl,
                    lastModified: origLastModified, jxlBytes: output,
                  });
                }
              }
              outcome = `stored ${output.byteLength} B of ${source.byteLength}`;
            }
          } else if (output) {
            await kept.put(key, output);
            outcome = `stored ${output.byteLength} B of ${source.byteLength}`;
          }
          if (!output) { outcome ??= 's no smaller'; await kept.note(key, outcome); }
        } catch (error) {
          outcome = 's the conversion failed';
          await kept.note(key, outcome).catch(() => {});
        } finally { busy = 0; }
        console.log(`rapier-jxl ${logged}: ${outcome.startsWith('s ') ? 'not stored: ' + outcome.slice(2) : outcome}, effort ${sized.effort}, try ${tries + 1}, ${Date.now() - t0} ms`);
      })());
      return said(answer, 'converting');
    },
  };
}

export default jxl();
