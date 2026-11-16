// SPDX-License-Identifier: MIT
// A Worker in front of a site: browsers that send Accept: image/jxl get a JPEG's or PNG's JPEG XL file where one exists,
// and everyone else, and every request whose file is missing, gets the site's response untouched. It works on Workers
// Free, where a request has almost no CPU: the files are made before (`npx jpegxl <folder>` writes photo.jxl beside
// photo.jpg, which this serves for photo.jpg), or stored in R2 (binding JXL) or else the Cache API.
// JXL_CONVERT=on (Workers Paid, limits.cpu_ms 30,000) also makes the missing ones here: JPEGs recompressed without loss
// (rapier-jxl/jpeg restores the JPEG exactly), PNGs exact, each once, after the first such request has been answered
// with the original. A JPEG XL request answered with the original says why in its x-jxl header and in the Worker's log:
// `converting`, or `skipped: <reason>`; a served file says `stored` or `beside`.
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
// workerd at each size below (Workers Paid itself not yet). Larger pictures step down; past the last row, no conversion.
const FITS = {
  'image/jpeg': [[7, 4_200_000], [3, 12_600_000]],
  'image/png': [[1, 2_700_000]],
};
// The CPU of one conversion: [effort, ms, ms per million pixels], the next measured effort up, at least the most of three
// runs of the whole workerd process (local, warm and fresh isolates). A picture converts only when twice this fits
// JXL_CPU_MS, the Worker's limits.cpu_ms: Paid's 30,000 converts every size above; Free's 10 passes every picture through.
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
let busy = 0; // when this isolate's conversion started; a cut-off one frees it after PENDING_MS

const settings = env => ({
  convert: env.JXL_CONVERT === 'on',
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
const varied = vary => !vary ? 'Accept' : /(?:^|,)\s*(?:\*|accept)\s*(?:,|$)/i.test(vary) ? vary : `${vary}, Accept`;

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

// The author's own photo.jxl for photo.jpg or photo.png, served to a client that accepts it: the site answers 200 with
// a JPEG XL file, and where the picture's size is known the .jxl is smaller. Never reads a file bigger than the picture
// or than MAX_SIBLING_BYTES, whichever is less, into the isolate, and a read that fails falls back to the original.
const MAX_SIBLING_BYTES = 20_000_000;
async function sibling(request, url, origin, response) {
  const at = new URL(url); at.pathname = url.pathname.replace(/\.[^./]+$/, '.jxl');
  let answer;
  try { answer = await origin(new Request(at, {method: 'GET', headers: {accept: 'image/jxl'}})); } catch { return null; }
  if (answer.status !== 200 || !answer.body || privateAnswer(request, answer) || !keptVary(answer)) { answer.body?.cancel(); return null; }
  const size = Number(response.headers.get('content-length')) || 0;        // the picture's bytes, 0 if unknown
  const cap = size > 0 ? Math.min(size, MAX_SIBLING_BYTES) : MAX_SIBLING_BYTES;
  const declared = Number(answer.headers.get('content-length')) || 0;       // the .jxl's bytes, 0 if unknown
  // Not smaller than the picture, or past the read cap: fall back without pulling the body into the isolate.
  if (declared >= cap) { answer.body.cancel(); return null; }
  let bytes;
  try { bytes = await readBounded(answer.body, cap); } catch { return null; } // a read failure (or over cap) -> the original
  if (!bytes) return null;
  const jxl = bytes[0] === 0xff && bytes[1] === 0x0a || bytes.length > 12 && bytes[4] === 0x4a && bytes[5] === 0x58 && bytes[6] === 0x4c && bytes[7] === 0x20;
  if (!jxl || size > 0 && bytes.byteLength >= size) return null;           // only claims "smaller" when the picture's size is known
  const headers = new Headers({'content-type': 'image/jxl', vary: varied(response.headers.get('vary')),
    'cache-control': response.headers.get('cache-control') ?? 'public, max-age=3600'});
  const etag = answer.headers.get('etag');
  if (etag) headers.set('etag', etag);
  if (matchesIfNoneMatch(request.headers.get('if-none-match'), etag)) return new Response(null, {status: 304, headers});
  headers.set('content-length', String(bytes.byteLength));
  return new Response(request.method === 'HEAD' ? null : bytes, {headers});
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
      if (total > cap) { reader.cancel().catch(() => {}); return null; } // not awaited: a tee's cancel waits for its other branch
      parts.push(value);
    }
  } finally { reader.releaseLock?.(); }
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.byteLength; }
  return out;
}

// The response's bytes without consuming it, or null past MAX_SIBLING_BYTES (the stream is cancelled, not read on).
const within = response => Number(response.headers.get('content-length')) > MAX_SIBLING_BYTES ? null : readBounded(response.clone().body, MAX_SIBLING_BYTES);

function served(file, request, response, key) {
  const etag = `"${key.slice(0, 32)}-jxl"`, headers = new Headers({'content-type': 'image/jxl', vary: varied(response.headers.get('vary')), etag,
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

export function jxl(handler = {}) {
  return {
    ...handler,
    async fetch(request, env, ctx) {
      const origin = (asked = request) => handler.fetch ? handler.fetch(asked, env, ctx) : env.ASSETS ? env.ASSETS.fetch(asked) : fetch(asked);
      const url = new URL(request.url), type = TYPES[url.pathname.split('.').pop().toLowerCase()];
      if (!type || !['GET', 'HEAD'].includes(request.method) || request.headers.has('range') ||
          !acceptsJxl(request.headers.get('accept'), type)) return origin();

      const response = await origin(), path = url.pathname + url.search, logged = url.pathname; // the log keeps no query and nothing else the client sent
      const said = (r, state) => { r.headers.set('vary', varied(r.headers.get('vary'))); r.headers.set('x-jxl', state); console.log(`rapier-jxl ${logged}: ${state}`); return r; };
      const original = (reason, body = response.body) => said(new Response(body, response), `skipped: ${reason}`);
      if (response.status !== 200) return original(`the site answered ${response.status}`);
      if ((mediaType(response.headers.get('content-type')) ?? type) !== type) return original('unexpected content type');
      if (privateAnswer(request, response)) return original('the answer is private');
      const options = settings(env), converts = options.convert && allowed(options, type);
      // The file made before, beside the picture (photo.jpg -> photo.jxl): one request to the site, no CPU.
      if (!keptVary(response)) return original('the answer varies on more than Accept');
      const beside = await sibling(request, url, origin, response);
      if (beside) { response.body?.cancel(); return said(beside, 'beside'); }
      // Nothing else can hold a file for it: no R2, and nothing converted into this location's cache.
      if (!options.convert && !env.JXL) return original('no JPEG XL file for it');
      const kept = store(env, url), validator = response.headers.get('etag') ?? response.headers.get('last-modified');
      if (validator === null && !converts) return original(options.convert ? overCpu : 'no JPEG XL file for it');
      const bytes = validator === null ? await within(response) : null; // the key needs them
      if (bytes === null && validator === null) return original(`over ${MAX_SIBLING_BYTES / 1e6} MB`);
      const key = await sha256(JSON.stringify([url.origin + path, validator ?? await sha256(bytes), options.effort, options.quality]));

      let file, record = null;
      try {
        file = await kept.get(key);
        if (file && !file.record) { response.body?.cancel(); return served(file, request, response, key); }
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
          if (output) { await kept.put(key, output); outcome = `stored ${output.byteLength} B of ${source.byteLength}`; }
          else { outcome ??= 's no smaller'; await kept.note(key, outcome); }
        } catch (error) {
          outcome = 's the conversion failed'; // never the exception's own text: it can carry the picture's path or the store's address
          await kept.note(key, outcome).catch(() => {});
        } finally { busy = 0; }
        console.log(`rapier-jxl ${logged}: ${outcome.startsWith('s ') ? 'not stored: ' + outcome.slice(2) : outcome}, effort ${sized.effort}, try ${tries + 1}, ${Date.now() - t0} ms`);
      })());
      return said(answer, 'converting');
    },
  };
}

export default jxl();
