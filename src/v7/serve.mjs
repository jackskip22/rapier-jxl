// SPDX-License-Identifier: MIT
import './engines.mjs';
import {restoreJPEG} from '../jpeg-reconstruction.mjs';
import {brotliDictionary} from '../brotli-dictionary.mjs';
import {arrayBufferBytes, copyBytes, encodedByteLength} from './bytes.mjs';
import {bytes, check, fail, declared, object, snapshotOptions, callers, abortable, dimensions, admitSignal, pixelLimit, blobBytes, isBlob, rejectOptionSymbols} from './primitives.mjs';
const NO_SERVE = 'No JPEG reconstruction data: serve it as image/jxl, or make it with recompress().';
import {isPlainRecord} from './records.mjs';
import {boundedHeader} from './inspect.mjs';
import {sha256Start, sha256Update, sha256Finish} from '../sha256.mjs';
import {slice} from '../progressive-slice.mjs';
import {acceptWeights, normalizeType} from './examples/files/accept.mjs';
export {acceptsJxl} from './examples/files/accept.mjs';

const DEFAULT_CACHE_CONTROL = 'private, no-cache';
const SERVE_KEYS = new Set(['cacheControl', 'etag', 'maxPixels', 'width', 'maxBytes', 'responsive', 'fallback', 'signal']);
const MAX_HINT_WIDTH = 1073741824;
const pixelBound = pixelLimit;

async function owned(input, signal) {
  if (isBlob(input)) {
    return bytes(await blobBytes(input, signal));
  }
  encodedByteLength(input);
  return copyBytes(input);
}

const field = (source, key) => { try { return source[key]; } catch (error) { throw callers(error); } };
function headerText(value) {
  if (typeof value === 'string' || typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) {
    const parts = [];
    for (let i = 0; i < value.length; i++) {
      const part = field(value, i);
      if (typeof part !== 'string') throw fail('JXL_OPTIONS', 'A request header is invalid; use a string or an array of strings.');
      parts.push(part);
    }
    return parts.join(', ');
  }
  throw fail('JXL_OPTIONS', 'A request header is invalid; use a string or an array of strings.');
}
function readHeaderField(source, lowerName) {
  if (!source || typeof source !== 'object') return undefined;
  const headers = field(source, 'headers'), bag = headers && typeof headers === 'object' ? headers : source;
  const get = field(bag, 'get');
  if (typeof get === 'function') {
    let value;
    try { value = get.call(bag, lowerName); } catch (error) { throw callers(error); }
    return value === null || value === undefined ? undefined : headerText(value);
  }
  for (const [key, value] of Object.entries(snapshotOptions(bag, 'Request headers'))) {
    if (key.toLowerCase() === lowerName && value !== undefined && value !== null) {
      return headerText(value);
    }
  }
  return undefined;
}

function isRequestLike(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const headers = field(value, 'headers');
  return !!headers && typeof headers === 'object';
}

function isResponseLike(value) {
  return !!value && typeof value === 'object' && typeof field(value, 'writeHead') === 'function' && typeof field(value, 'end') === 'function';
}

function refuseAccessors(record) {
  if (!isPlainRecord(record)) throw fail('JXL_OPTIONS', "Invalid options; pass a plain object.");
  if (Object.values(Object.getOwnPropertyDescriptors(record)).some(field => !('value' in field)))
    throw fail('JXL_OPTIONS', "Options contain accessors; pass plain data values.");
}

const TAGS = new WeakMap();
async function computeEntityHash(data) {
  if (!globalThis.crypto?.subtle) return sha256Finish(sha256Update(sha256Start(), data)).slice(0, 32);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', data));
  return Array.from(digest.subarray(0, 16), b => b.toString(16).padStart(2, '0')).join('');
}

function formatRepresentationEtag(baseEtag, suffix) {
  if (baseEtag === undefined) return null;
  const trimmed = baseEtag.trim();
  const weak = trimmed.startsWith('W/');
  const raw = weak ? trimmed.slice(2) : trimmed;
  const unquoted = raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2 ? raw.slice(1, -1) : raw;
  return `${weak ? 'W/' : ''}"${unquoted}-${suffix}"`;
}

function matchesIfNoneMatch(ifNoneMatch, etag) {
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

function parseHintNumber(raw, integerOnly = false) {
  if (typeof raw !== 'string') return NaN;
  const trimmed = raw.trim();
  if (!(integerOnly ? /^\d{1,12}$/ : /^\d{1,12}(?:\.\d{1,6})?$/).test(trimmed)) return NaN;
  const n = Number(trimmed);
  return Number.isFinite(n) && n > 0 ? n : NaN;
}

function parseCall(request, second, third) {
  if (!isRequestLike(request)) throw fail('JXL_OPTIONS', "Invalid request; pass a Request or a node:http request.");
  const serverResponse = isResponseLike(second) ? second : null, rawOptions = serverResponse ? third : second;
  if (serverResponse === null && third !== undefined) throw fail('JXL_OPTIONS', "Invalid response; pass a node:http response as the third argument.");
  const options = rawOptions === undefined ? {} : (object(rawOptions), refuseAccessors(rawOptions), {...rawOptions});
  rejectOptionSymbols(options, 'serve option');
  for (const key of Object.keys(options)) if (!SERVE_KEYS.has(key)) throw fail('JXL_OPTIONS', `Unknown serve option ${key}; remove it.`);
  const method = field(request, 'method');
  if (method !== undefined && typeof method !== 'string') throw fail('JXL_OPTIONS', "Request method is unsupported; use GET or HEAD.");
  const rawMethod = method !== undefined ? method.toUpperCase() : 'GET';
  if (rawMethod !== 'GET' && rawMethod !== 'HEAD') throw fail('JXL_OPTIONS', "Request method is unsupported; use GET or HEAD.");
  const {cacheControl = DEFAULT_CACHE_CONTROL} = options;
  if (typeof cacheControl !== 'string' || !cacheControl.trim() || /[^\t\x20-\x7e\x80-\xff]/.test(cacheControl))
    throw fail('JXL_OPTIONS', "Invalid cacheControl; pass a nonempty header string.");
  if (options.etag !== undefined) {
    if (typeof options.etag !== 'string' || !options.etag.trim() || /[\r\n]/.test(options.etag))
      throw fail('JXL_OPTIONS', "Invalid etag; pass a nonempty string.");
    const supplied = options.etag.trim(), weak = supplied.startsWith('W/'), raw = weak ? supplied.slice(2) : supplied;
    const quoted = raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"');
    const opaque = quoted ? raw.slice(1, -1) : raw;
    if ((weak && !quoted) || (!quoted && !opaque) || !/^[\x21\x23-\x7e\x80-\xff]*$/.test(opaque))
      throw fail('JXL_OPTIONS', "Invalid etag; pass a quoted HTTP entity tag.");
  }
  if (options.width !== undefined && (!Number.isSafeInteger(options.width) || options.width < 1))
    throw fail('JXL_OPTIONS', 'Invalid width; pass a positive safe integer.');
  if (options.maxBytes !== undefined && (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1))
    throw fail('JXL_OPTIONS', 'Invalid maxBytes; pass a positive safe integer.');
  if (options.responsive !== undefined && typeof options.responsive !== 'boolean')
    throw fail('JXL_OPTIONS', 'Invalid responsive; pass true or false.');
  let fallback;
  if (options.fallback !== undefined) {
    const {type, bytes, ...rest} = snapshotOptions(options.fallback, 'fallback', [], true);
    if (Object.keys(rest).length || typeof type !== 'string' || !/^[a-z]+\/[a-z0-9.+-]+$/i.test(type) || type.toLowerCase() === 'image/jxl')
      throw fail('JXL_OPTIONS', 'Invalid fallback; pass {type: "image/webp", bytes} with a media type other than image/jxl.');
    if (typeof bytes !== 'function' && !isBlob(bytes)) {
      if (!ArrayBuffer.isView(bytes) && arrayBufferBytes(bytes) === null)
        throw fail('JXL_OPTIONS', 'Invalid fallback bytes; pass a Uint8Array, a Blob or a function returning one.');
      encodedByteLength(bytes);
    }
    fallback = {type: normalizeType(type), bytes, of: options.fallback};
  }
  admitSignal(options.signal);
  const maxPixels = pixelBound(options.maxPixels);
  const useHints = !!options.responsive && options.width === undefined;
  let hintWidth;
  if (useHints) {
    const secVw = parseHintNumber(readHeaderField(request, 'sec-ch-viewport-width'), true);
    const vw = Number.isFinite(secVw) ? secVw : parseHintNumber(readHeaderField(request, 'viewport-width'), false);
    if (Number.isFinite(vw)) {
      const secDpr = parseHintNumber(readHeaderField(request, 'sec-ch-dpr'), false);
      const rawDpr = Number.isFinite(secDpr) ? secDpr : parseHintNumber(readHeaderField(request, 'dpr'), false);
      const dpr = Number.isFinite(rawDpr) ? Math.min(rawDpr, 4) : 1;
      hintWidth = Math.min(MAX_HINT_WIDTH, Math.max(1, Math.ceil(vw * dpr)));
    }
  }
  return {maxPixels, accept: readHeaderField(request, 'accept') ?? '', ifNoneMatch: readHeaderField(request, 'if-none-match') ?? '', method: rawMethod,
    cacheControl, etag: options.etag, width: options.width ?? hintWidth, maxBytes: options.maxBytes, responsive: useHints, fallback, signal: options.signal, serverResponse};
}

const cut = (bytes, maxWidth, maxBytes) => {
  try { return slice(bytes, {...(maxWidth !== undefined && {maxWidth}), ...(maxBytes !== undefined && {maxBytes})}); }
  catch (error) { if (error?.code === 'JXL_UNSUPPORTED') return null; throw error; }
};
const WRITTEN = new WeakSet();
function answerFault(response, signal) {
  if (!response || WRITTEN.has(response) || signal?.aborted) return;
  try {
    if (response.destroyed === true || response.writableEnded === true || response.headersSent === true) return;
    const writeHead = response.writeHead, end = response.end;
    if (typeof writeHead !== 'function' || typeof end !== 'function') return;
    WRITTEN.add(response);
    Promise.resolve(writeHead.call(response, 500, {'content-type': 'text/plain', 'cache-control': 'no-store'}))
      .then(() => end.call(response)).catch(() => {});
  } catch {  }
}
const settle = (promise, response, signal) => promise.catch(error => { answerFault(response, signal); throw declared(error); });
async function respond(response, status, headers, body, signal) {
  const writeHead = field(response, 'writeHead'), end = field(response, 'end');
  if (typeof writeHead !== 'function' || typeof end !== 'function')
    throw fail('JXL_OPTIONS', "Invalid response; pass a node:http response with writeHead and end.");
  WRITTEN.add(response);
  try {
    await abortable(writeHead.call(response, status, headers), signal); check(signal);
    await abortable(end.call(response, body), signal); check(signal);
  }
  catch (error) { throw callers(error); }
}

export function serve(input, request, second, third) {
  let parsed;
  try {
    parsed = parseCall(request, second, third);
    check(parsed.signal);
  } catch (error) {
    let response = null;
    try { response = isResponseLike(second) ? second : null; } catch {  }
    let sig = parsed?.signal;
    if (!sig && response && third && typeof third === 'object') {
      try { const d = Object.getOwnPropertyDescriptor(third, 'signal'); if (d && 'value' in d && typeof d.value?.aborted === 'boolean') sig = d.value; } catch {}
    }
    answerFault(response, sig);
    return Promise.reject(declared(error));
  }
  const {accept, ifNoneMatch, method, cacheControl, etag: customEtag, width, maxBytes, responsive, fallback, signal, serverResponse, maxPixels} = parsed;
  let pending, heldFallback;
  try {
    if (isBlob(input) && fallback && typeof fallback.bytes !== 'function' && !isBlob(fallback.bytes))
      heldFallback = copyBytes(fallback.bytes);
    pending = owned(input, signal);
  } catch (error) {
    answerFault(serverResponse, signal);
    return Promise.reject(declared(error));
  }
  return settle((async () => {
    const jxlBytes = await pending;
    check(signal);
    const disconnected = () => serverResponse !== null && (field(serverResponse, 'destroyed') === true || field(serverResponse, 'writableEnded') === true);
    if (disconnected()) return undefined;
    const size = boundedHeader(jxlBytes);
    dimensions(size.width, size.height, maxPixels);

    const [weightJxl, weightJpeg, weightFallback] = typeof accept === 'string'
      ? acceptWeights(accept, fallback ? ['image/jpeg', fallback.type] : ['image/jpeg']) : [0, 0, 0];
    let wantsJxl = weightJxl > 0 && weightJxl >= weightJpeg && weightJxl >= (fallback ? weightFallback : 0);
    let restoredJpeg;
    if (!wantsJxl && (!fallback || weightJpeg >= weightFallback)) {
      if (disconnected()) return undefined;
      try { restoredJpeg = restoreJPEG(jxlBytes, brotliDictionary, {maxPixels}); }
      catch (error) { const named = declared(error); if (named?.code === 'JXL_MEMORY' || named?.code === 'JXL_DIMENSIONS' || (!fallback && !(weightJxl > 0))) throw named; }
    }
    if (!wantsJxl && !restoredJpeg) {
      wantsJxl = weightJxl > 0 && (!fallback || weightJxl >= weightFallback);
      if (!wantsJxl && !fallback) throw fail('JXL_RECONSTRUCTION', NO_SERVE);
    }
    const noJpeg = !wantsJxl && !restoredJpeg;
    const contentType = wantsJxl ? 'image/jxl' : noJpeg ? fallback.type : 'image/jpeg';
    const sliced = wantsJxl && (width !== undefined || maxBytes !== undefined) ? cut(jxlBytes, width, maxBytes) : null;
    if (wantsJxl && !sliced && maxBytes !== undefined && jxlBytes.byteLength > maxBytes)
      throw fail('JXL_LIMIT', `Stored JPEG XL file (${jxlBytes.byteLength} B) exceeds maxBytes (${maxBytes}).`);
    const suffix = wantsJxl ? (sliced && sliced.scale > 1 ? 'jxl-s' + sliced.scale : 'jxl') : noJpeg ? 'fallback' : 'jpeg';
    const varyHeader = responsive ? 'Accept, Sec-CH-Viewport-Width, Viewport-Width, Sec-CH-DPR, DPR' : 'Accept';
    let fallbackBytes;
    if (noJpeg) {
      if (heldFallback) fallbackBytes = heldFallback;
      else {
        const supplied = typeof fallback.bytes === 'function' ? await abortable(Promise.resolve().then(() => fallback.bytes.call(fallback.of)).catch(error => { throw callers(error); }), signal) : fallback.bytes;
        check(signal);
        fallbackBytes = await owned(supplied, signal);
      }
    }
    const baseTag = noJpeg ? `"${await computeEntityHash(new TextEncoder().encode(fallback.type + '\0' + await computeEntityHash(fallbackBytes)))}"`
      : customEtag ?? `"${TAGS.get(input) ?? (TAGS.set(input, await computeEntityHash(jxlBytes)), TAGS.get(input))}"`;
    const etag = formatRepresentationEtag(baseTag, suffix);

    if (matchesIfNoneMatch(ifNoneMatch, etag)) {
      check(signal);
      const headers304 = {
        'content-type': contentType,
        'vary': varyHeader,
        'cache-control': cacheControl,
        'etag': etag,
      };
      if (disconnected()) return undefined;
      if (serverResponse) await respond(serverResponse, 304, headers304, undefined, signal);
      return serverResponse ? undefined : new Response(null, {status: 304, headers: headers304});
    }

    let bodyBytes;
    if (wantsJxl) {
      bodyBytes = sliced ? sliced.bytes : jxlBytes;
    } else if (noJpeg) {
      bodyBytes = fallbackBytes;
    } else {
      bodyBytes = restoredJpeg;
    }
    check(signal);
    const headers200 = {
      'content-type': contentType,
      'content-length': String(bodyBytes.byteLength),
      'vary': varyHeader,
      'cache-control': cacheControl,
      'etag': etag,
    };
    const wireBody = method === 'HEAD' ? null : bodyBytes;
    if (serverResponse) {
      if (disconnected()) return undefined;
      await respond(serverResponse, 200, headers200, wireBody ?? undefined, signal);
      return undefined;
    }
    return new Response(wireBody, {status: 200, headers: headers200});
  })(), serverResponse, signal);
}
