// SPDX-License-Identifier: MIT
// A JPEG XL file beside every JPEG and PNG put into an R2 bucket (binding JXL_BUCKET), and reads answered by Accept.
//   queue    R2 event notifications (object-create) arrive through a Queue. photo.jpg gets photo.jxl: a JPEG's is exact
//            (rapier-jxl/jpeg restores the same JPEG exactly), a PNG's pixel exact, or at JXL_QUALITY (1-99) a look.
//   Workflow a picture too large to convert inside one queue call runs as a Workflow (JxlWorkflow): each step is one
//            advance of rapier-jxl/resumable's job; its parts are kept in the bucket under .jxl-parts/, its checkpoint is the step's state.
//   fetch    GET /photo.jpg answers photo.jxl to a client that accepts image/jxl, the original to everyone else (Vary: Accept).
// A picture the Worker's memory cannot hold is left as it is: the log says `skipped: <reason>`.
import {WorkflowEntrypoint} from 'cloudflare:workers';
import {recompress} from 'jpegxl/jpeg';
import {encode} from 'jpegxl/upload';
import {serve, acceptsJxl} from 'jpegxl/serve';
import * as resumable from 'jpegxl/resumable';

const TYPES = Object.freeze({__proto__: null, jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png'});
// A picture is held whole in the isolate's 128 MB only to convert it inside one queue call (JXL_DIRECT_MP and MAX_READ); MAX_ORIGINAL bounds a Workflow's source.
const PARTS = '.jxl-parts/', MAX_READ = 20_000_000, MAX_ORIGINAL = 100_000_000, MAX_STEPS = 1024;
const PERMANENT_CODES = new Set(['JXL_INPUT', 'JXL_JPEG', 'JXL_DIMENSIONS', 'JXL_UNSUPPORTED', 'JXL_OPTIONS']);

function validKey(key) {
  if (typeof key !== 'string' || !key || key.length > 1024 || /[\x00-\x1f\x7f\\]/.test(key)) return false;
  if (key.startsWith('/') || key.endsWith('/') || key.includes('//')) return false;
  const segments = key.split('/');
  return !segments.some(seg => !seg || seg === '.' || seg === '..' || seg === '.jxl-parts');
}
function typeOf(key) {
  if (!validKey(key)) return undefined;
  const slash = key.lastIndexOf('/'), dot = key.lastIndexOf('.');
  return dot > slash + 1 ? TYPES[key.slice(dot + 1).toLowerCase()] : undefined;
}
const besideKey = key => key.replace(/\.[^./]+$/, '') + '.jxl';
// A step's state comes back from the Workflow engine as an RPC value; the job wants plain data.
const plain = value => JSON.parse(JSON.stringify(value));
const hex = buffer => [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join('');
const nonRetryable = message => Object.assign(new Error(message), {name: 'NonRetryableError'});
const validPartHash = hash => typeof hash === 'string' && /^[0-9a-f]{16,128}$/i.test(hash);

function settings(env) {
  const rawEffort = Number(env?.JXL_EFFORT ?? 3);
  const effort = Number.isInteger(rawEffort) && rawEffort >= 1 && rawEffort <= 7 ? rawEffort : 3;
  const hasQuality = env?.JXL_QUALITY !== undefined && env?.JXL_QUALITY !== '';
  const rawQuality = hasQuality ? Number(env.JXL_QUALITY) : null;
  const quality = rawQuality !== null && Number.isFinite(rawQuality) && rawQuality >= 1 && rawQuality <= 99 ? rawQuality : (hasQuality ? NaN : null);
  const rawDirect = Number(env?.JXL_DIRECT_MP ?? 2);
  const directMp = Number.isFinite(rawDirect) && rawDirect >= 0 ? rawDirect : 2;
  return {effort, quality, directMp};
}
const operationOf = (type, options) => type === 'image/jpeg'
  ? {operation: recompress, options: {effort: options.effort}}
  : {operation: encode, options: {effort: Math.min(3, options.effort), fidelity: options.quality === null ? 'exact' : {quality: options.quality}}};

// A PNG's IHDR or a JPEG's frame header: its width and height, or null.
function size(b) {
  const u16 = i => b[i] << 8 | b[i + 1];
  if (b[0] === 0x89 && b[1] === 0x50) return b.length >= 24 ? {width: (u16(16) * 65536 + u16(18)), height: (u16(20) * 65536 + u16(22))} : null;
  for (let at = 2; b[0] === 0xff && b[1] === 0xd8 && at + 9 <= b.length;) {
    if (b[at] !== 0xff) return null;
    const marker = b[at + 1];
    if (marker === 0xff) { at++; continue; }
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return {width: u16(at + 7), height: u16(at + 5)};
    const segLen = u16(at + 2);
    if (segLen < 2) return null;
    at += 2 + segLen;
  }
  return null;
}

// Whether this picture converts, and where: 'direct' inside the call, 'workflow' in steps, or {skip: reason}.
function plan(head, type, options, byteLength) {
  if (Number.isNaN(options.quality)) return {skip: 'its options are refused'};
  const dims = size(head);
  if (!dims || !dims.width || !dims.height) return {skip: 'not a picture this reads'};
  const {operation, options: job} = operationOf(type, options);
  let admitted;
  try { admitted = resumable.workerAdmission({operation, options: job, width: dims.width, height: dims.height, kind: 'file'}); } catch { return {skip: 'its options are refused'}; }
  if (!admitted.admitted) return {skip: `${(dims.width * dims.height / 1e6).toFixed(1)} MP is more than a Worker's memory holds`};
  const direct = byteLength <= MAX_READ && dims.width * dims.height <= options.directMp * 1e6;
  return {dims, how: direct ? 'direct' : 'workflow'};
}

// Inspect photo.jxl beside key: 'current' when already up to date, 'taken' when owned by another file or user upload, 'free' when writable.
async function besideState(env, key, etag) {
  const beside = await env.JXL_BUCKET.head(besideKey(key));
  if (!beside) return 'free';
  if (beside.customMetadata?.from !== key) return 'taken';
  return beside.customMetadata?.etag === etag ? 'current' : 'free';
}
async function keep(env, key, source, bytes, how) {
  const target = besideKey(key), existing = await env.JXL_BUCKET.head(target);
  if (existing && existing.customMetadata?.from !== key) return false;
  const onlyIf = existing ? {etagMatches: existing.etag} : new Headers({'if-none-match': '*'});
  const put = await env.JXL_BUCKET.put(target, bytes, {
    httpMetadata: {contentType: 'image/jxl'},
    customMetadata: {jxl: how, from: key, etag: source.etag, type: source.type},
    onlyIf,
  });
  return !!put;
}
const how = (type, options) => type === 'image/jpeg' ? 'exact' : options.quality === null ? 'pixels' : 'look';

async function cleanupPrefix(bucket, prefix) {
  let cursor;
  do {
    const listed = await bucket.list({prefix, ...(cursor && {cursor})});
    if (listed.objects.length) await bucket.delete(listed.objects.map(part => part.key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

// One event: nothing for what is not a new JPEG or PNG; the file made here, or a Workflow started for it.
async function handle(env, event) {
  const key = event?.object?.key, type = typeof key === 'string' ? typeOf(key) : undefined;
  if (!['PutObject', 'CopyObject', 'CompleteMultipartUpload'].includes(event?.action) || !type) return 'not for this Worker';
  const options = settings(env), object = await env.JXL_BUCKET.head(key);
  if (!object) return 'gone';
  const state = await besideState(env, key, object.etag);
  if (state === 'current') return 'already made';
  if (state === 'taken') return 'skipped: beside key taken';
  if (object.size > MAX_ORIGINAL) return `skipped: over ${MAX_ORIGINAL / 1e6} MB`;
  // The headers sit in the first bytes: a picture that will not convert is not read whole.
  const first = await env.JXL_BUCKET.get(key, {range: {offset: 0, length: 1 << 20}, onlyIf: {etagMatches: object.etag}});
  if (!first?.body) return 'changed';
  const {skip, how: where} = plan(new Uint8Array(await first.arrayBuffer()), type, options, object.size);
  if (skip) return `skipped: ${skip}`;
  if (where === 'workflow') {
    try {
      // One instance for this very object: the same event twice finds it.
      await env.JXL_WORKFLOW.create({id: hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key + '\0' + object.etag))).slice(0, 40), params: {key, etag: object.etag, type}});
      return 'workflow started';
    } catch (error) { if (/already|exist/i.test(String(error?.message))) return 'workflow already running'; throw error; }
  }
  const whole = await env.JXL_BUCKET.get(key, {onlyIf: {etagMatches: object.etag}});
  if (!whole?.body) return 'changed';
  const head = new Uint8Array(await whole.arrayBuffer()), {operation, options: job} = operationOf(type, options), result = await operation(head, job);
  if (!result.bytes || result.bytes.byteLength >= head.byteLength) return 'skipped: no smaller';
  const currentNow = await env.JXL_BUCKET.head(key);
  if (!currentNow || currentNow.etag !== object.etag) return 'changed';
  if (!(await keep(env, key, {etag: object.etag, type}, result.bytes, how(type, options)))) return 'skipped: beside key taken';
  return `made ${result.bytes.byteLength} B of ${head.byteLength}`;
}

export class JxlWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const payload = event?.payload ?? {};
    const {key, etag, type} = payload, instanceId = String(event?.instanceId ?? '');
    if (!validKey(key) || typeof etag !== 'string' || !etag || etag.length > 512 || (type !== 'image/jpeg' && type !== 'image/png') || typeOf(key) !== type || !/^[\w-]+$/.test(instanceId))
      throw nonRetryable('invalid workflow payload');
    const env = this.env, options = settings(env), {operation, options: job} = operationOf(type, options);
    const prefix = `${PARTS}${instanceId}/`;
    const source = async () => {
      const head = await env.JXL_BUCKET.head(key);
      if (!head || head.etag !== etag || head.size > MAX_ORIGINAL) throw nonRetryable('the picture changed');
      return head;
    };
    const store = {
      readSource: async (offset, length) => {
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > MAX_READ)
          throw nonRetryable('invalid source range');
        if (length === 0) return new Uint8Array(0);
        const obj = await env.JXL_BUCKET.get(key, {range: {offset, length}, onlyIf: {etagMatches: etag}});
        if (!obj?.body) throw nonRetryable('the picture changed');
        return new Uint8Array(await obj.arrayBuffer());
      },
      read: async ref => {
        if (!validPartHash(ref?.hash)) throw nonRetryable('invalid part reference');
        const obj = await env.JXL_BUCKET.get(prefix + ref.hash);
        if (!obj?.body) throw nonRetryable('missing workflow part');
        return new Uint8Array(await obj.arrayBuffer());
      },
      write: (ref, bytes) => {
        if (!validPartHash(ref?.hash)) throw nonRetryable('invalid part reference');
        return env.JXL_BUCKET.put(prefix + ref.hash, bytes);
      },
    };
    try {
      const input = plain(await step.do('read', async () => {
        const head = await source(), state = await besideState(env, key, etag);
        if (state === 'taken') throw nonRetryable('beside key taken');
        const digest = new crypto.DigestStream('SHA-256');
        const obj = await env.JXL_BUCKET.get(key, {onlyIf: {etagMatches: etag}});
        if (!obj?.body) throw nonRetryable('the picture changed');
        await obj.body.pipeTo(digest);
        return {generation: etag.slice(0, 200), sha256: hex(await digest.digest), byteLength: head.size, kind: 'file'};
      }));
      let checkpoint = plain(await step.do('start', () => resumable.start({operation, input, options: job, store})));
      const retries = {retries: {limit: 3, delay: '5 seconds', backoff: 'exponential'}, timeout: '5 minutes'};
      let finished = false;
      for (let n = 0; n < MAX_STEPS; n++) {
        const advanced = await step.do(`advance ${n}`, retries, async () => {
          const {checkpoint: next, done} = await resumable.advance(checkpoint, {operation, input, store, budget: {ms: 20000}});
          return {checkpoint: next, done};
        });
        checkpoint = plain(advanced.checkpoint);
        if (advanced.done) { finished = true; break; }
      }
      if (!finished) throw nonRetryable('workflow exceeded step limit');
      return await step.do('finish', retries, async () => {
        await source();
        const result = await resumable.finish(checkpoint, {operation, input, store}), made = result.bytes?.byteLength ?? 0;
        let outcome = 'skipped: no smaller';
        if (made && made < input.byteLength) {
          const kept = await keep(env, key, {etag, type}, result.bytes, how(type, options));
          outcome = kept ? `made ${made} B of ${input.byteLength}` : 'skipped: beside key taken';
        }
        await cleanupPrefix(env.JXL_BUCKET, prefix);
        console.log(`rapier-jxl ${key}: ${outcome}`);
        return outcome;
      });
    } catch (error) {
      if (error?.name === 'NonRetryableError' || PERMANENT_CODES.has(error?.code)) {
        try { await cleanupPrefix(env.JXL_BUCKET, prefix); } catch {}
        if (PERMANENT_CODES.has(error?.code)) throw nonRetryable(error.message);
      }
      throw error;
    }
  }
}

function formatJxlEtag(baseEtag) {
  const trimmed = String(baseEtag ?? '').trim();
  if (!trimmed) return null;
  const weak = trimmed.startsWith('W/'), raw = weak ? trimmed.slice(2) : trimmed;
  const unquoted = raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2 ? raw.slice(1, -1) : raw;
  return `${weak ? 'W/' : ''}"${unquoted}-jxl"`;
}
function matchesWeakIfNoneMatch(ifNoneMatch, etag) {
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

// A read: photo.jpg or photo.png, and the file made from this very original where the client accepts JPEG XL.
async function read(request, env) {
  if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method Not Allowed', {status: 405, headers: {allow: 'GET, HEAD'}});
  let url, key;
  try {
    url = new URL(request.url);
    key = decodeURIComponent(url.pathname.slice(1));
  } catch {
    return new Response('Bad Request', {status: 400});
  }
  if (!validKey(key)) return new Response('Not found', {status: 404});
  const type = typeOf(key), ranged = request.headers.has('range');
  const wantsJxl = !!type && !ranged && acceptsJxl(request.headers.get('accept'), type);

  if (wantsJxl) {
    const [origHead, beside] = await Promise.all([env.JXL_BUCKET.head(key), env.JXL_BUCKET.get(besideKey(key))]);
    if (!origHead) { beside?.body?.cancel(); return new Response('Not found', {status: 404}); }
    if (beside?.body && beside.customMetadata?.from === key && beside.customMetadata?.etag === origHead.etag && beside.size <= MAX_READ) {
      const origHeaders = new Headers();
      origHead.writeHttpMetadata(origHeaders);
      const cacheControl = origHeaders.get('cache-control') ?? 'public, max-age=3600';
      const bytes = new Uint8Array(await beside.arrayBuffer());
      if (type === 'image/jpeg') {
        try { return await serve(bytes, request, {cacheControl, etag: beside.httpEtag}); }
        catch { /* fall back to original if sidecar is corrupt */ }
      } else {
        const etag = formatJxlEtag(beside.httpEtag);
        const served = new Headers({'content-type': 'image/jxl', vary: 'Accept', 'cache-control': cacheControl, ...(etag && {etag})});
        if (matchesWeakIfNoneMatch(request.headers.get('if-none-match'), etag)) return new Response(null, {status: 304, headers: served});
        served.set('content-length', String(bytes.byteLength));
        return new Response(request.method === 'HEAD' ? null : bytes, {headers: served});
      }
    } else {
      beside?.body?.cancel();
    }
  }

  const original = await env.JXL_BUCKET.get(key, {onlyIf: request.headers, range: ranged ? request.headers : undefined});
  if (!original) return new Response('Not found', {status: 404});
  const headers = new Headers();
  original.writeHttpMetadata(headers);
  headers.set('etag', original.httpEtag);
  if (type) headers.set('vary', 'Accept');
  if (original.body === undefined) return new Response(null, {status: 304, headers});
  return new Response(request.method === 'HEAD' ? null : original.body, {headers, status: ranged ? 206 : 200});
}

export default {
  fetch: (request, env) => read(request, env),
  async queue(batch, env) {
    for (const message of batch.messages) {
      const key = typeof message.body?.object?.key === 'string' ? message.body.object.key.slice(0, 200) : '<invalid>';
      try {
        console.log(`rapier-jxl ${key}: ${await handle(env, message.body)}`);
        message.ack();
      } catch (error) {
        const code = error?.code ?? error?.name;
        console.log(`rapier-jxl ${key}: failed (${code})`);
        if (PERMANENT_CODES.has(error?.code) || error?.name === 'NonRetryableError') message.ack();
        else message.retry({delaySeconds: 30});
      }
    }
  },
};
