// SPDX-License-Identifier: MIT
import {restoreJPEG} from '../jpeg-reconstruction.mjs';
import {jpegReconstruction} from '../container.mjs';
import {brotliDictionary} from '../brotli-dictionary.mjs';
import {copyBytes, encodedByteLength} from './bytes.mjs';
import {bytes, check, fail, declared, object, dimensions, admitSignal} from './primitives.mjs';
import {isPlainRecord} from './records.mjs';
import {header} from './inspect.mjs';

const MAX_INPUT_BYTES = 256 * 1024 * 1024;
const DEFAULT_CACHE_CONTROL = 'private, no-cache';
const SERVE_KEYS = new Set(['cacheControl', 'etag', 'maxPixels', 'signal']);
function pixelBound(value) {
  if (value === undefined) return 40000000;
  if (!Number.isSafeInteger(value) || value < 1 || value > 40000000) throw fail('JXL_OPTIONS', 'maxPixels is a positive whole number, at most 40,000,000.');
  return value;
}

async function owned(input, signal) {
  if (typeof Blob !== 'undefined' && input instanceof Blob) {
    if (input.size > MAX_INPUT_BYTES) throw fail('JXL_LIMIT', 'Encoded input exceeds 256 MiB.');
    const read = new Uint8Array(await input.arrayBuffer());
    check(signal);
    return bytes(read);
  }
  if (encodedByteLength(input) > MAX_INPUT_BYTES) throw fail('JXL_LIMIT', 'Encoded input exceeds 256 MiB.');
  return copyBytes(input);
}

function readHeaderField(source, lowerName) {
  if (!source || typeof source !== 'object') return undefined;
  const bag = source.headers && typeof source.headers === 'object' ? source.headers : source;
  if (typeof bag.get === 'function') {
    const value = bag.get(lowerName);
    return value === null ? undefined : String(value);
  }
  for (const [key, value] of Object.entries(bag)) {
    if (key.toLowerCase() === lowerName && value !== undefined && value !== null) {
      return Array.isArray(value) ? value.join(', ') : String(value);
    }
  }
  return undefined;
}

function isRequestLike(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) && !!value.headers && typeof value.headers === 'object';
}

function isResponseLike(value) {
  return !!value && typeof value === 'object' && typeof value.writeHead === 'function' && typeof value.end === 'function';
}

function refuseAccessors(record) {
  if (!isPlainRecord(record)) throw fail('JXL_OPTIONS', 'Options must be a plain object.');
  if (Object.values(Object.getOwnPropertyDescriptors(record)).some(field => !('value' in field)))
    throw fail('JXL_OPTIONS', 'Options cannot contain accessors.');
}

function acceptsJxl(acceptHeader) {
  if (typeof acceptHeader !== 'string') return false;
  const q = {};
  for (const part of acceptHeader.split(',')) {
    const [type, ...params] = part.split(';').map(text => text.trim());
    const range = type.toLowerCase();
    if (!['image/jxl', 'image/jpeg', 'image/*', '*/*'].includes(range)) continue;
    let weight = 1;
    for (const param of params) {
      const [key, value = ''] = param.split('=').map(text => text.trim());
      if (key.toLowerCase() !== 'q') continue;
      weight = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(value) ? Number(value) : NaN;
    }
    if (!Number.isNaN(weight)) q[range] = Math.max(q[range] ?? 0, weight);
  }
  const jpeg = q['image/jpeg'] ?? q['image/*'] ?? q['*/*'] ?? 0;
  return (q['image/jxl'] ?? 0) > 0 && q['image/jxl'] >= jpeg;
}

const TAGS = new WeakMap();
async function computeEntityHash(data) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return Array.from(digest.subarray(0, 16), b => b.toString(16).padStart(2, '0')).join('');
}

function formatRepresentationEtag(baseEtag, suffix) {
  if (baseEtag === undefined) return null;
  const trimmed = baseEtag.trim();
  const weak = trimmed.startsWith('W/');
  const raw = weak ? trimmed.slice(2).trim() : trimmed;
  const unquoted = raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2 ? raw.slice(1, -1) : raw;
  return `${weak ? 'W/' : ''}"${unquoted}-${suffix}"`;
}

function matchesIfNoneMatch(ifNoneMatch, etag) {
  if (typeof ifNoneMatch !== 'string' || !ifNoneMatch.trim() || !etag) return false;
  const stripWeak = tag => {
    const t = tag.trim();
    return t.startsWith('W/') ? t.slice(2).trim() : t;
  };
  const target = stripWeak(etag);
  for (const candidate of ifNoneMatch.match(/(?:[^",]|"[^"]*")+/g) ?? []) {
    const token = candidate.trim();
    if (token === '*') return true;
    if (stripWeak(token) === target) return true;
  }
  return false;
}

function parseCall(request, second, third) {
  if (!isRequestLike(request)) throw fail('JXL_OPTIONS', 'Pass the request: serve(stored, request) or serve(stored, req, res).');
  const serverResponse = isResponseLike(second) ? second : null, rawOptions = serverResponse ? third : second;
  if (serverResponse === null && third !== undefined) throw fail('JXL_OPTIONS', 'The third argument is a node:http response.');
  const options = rawOptions === undefined ? {} : (object(rawOptions), refuseAccessors(rawOptions), {...rawOptions});
  for (const key of Object.keys(options)) if (!SERVE_KEYS.has(key)) throw fail('JXL_OPTIONS', `Unknown serve option: ${key}.`);
  const rawMethod = typeof request.method === 'string' ? request.method.toUpperCase() : 'GET';
  if (rawMethod !== 'GET' && rawMethod !== 'HEAD') throw fail('JXL_OPTIONS', 'serve answers GET and HEAD.');
  const cacheControl = options.cacheControl ?? DEFAULT_CACHE_CONTROL;
  if (typeof cacheControl !== 'string' || !cacheControl.trim() || /[\r\n]/.test(cacheControl))
    throw fail('JXL_OPTIONS', 'cacheControl must be a non-empty header string.');
  if (options.etag !== undefined && (typeof options.etag !== 'string' || !options.etag.trim() || /[\r\n]/.test(options.etag)))
    throw fail('JXL_OPTIONS', 'etag must be a non-empty string.');
  admitSignal(options.signal);
  const maxPixels = pixelBound(options.maxPixels);
  return {maxPixels, accept: readHeaderField(request, 'accept') ?? '', ifNoneMatch: readHeaderField(request, 'if-none-match') ?? '', method: rawMethod,
    cacheControl, etag: options.etag, signal: options.signal, serverResponse};
}

const settle = (promise, signal) => promise.catch(error => { throw error === signal?.reason ? error : declared(error); });

export function serve(input, request, second, third) {
  let parsed;
  try {
    parsed = parseCall(request, second, third);
    check(parsed.signal);
  } catch (error) {
    return Promise.reject(error === parsed?.signal?.reason ? error : declared(error));
  }
  const {accept, ifNoneMatch, method, cacheControl, etag: customEtag, signal, serverResponse, maxPixels} = parsed;
  let pending;
  try {
    pending = owned(input, signal);
  } catch (error) {
    return Promise.reject(declared(error));
  }
  return settle((async () => {
    const jxlBytes = await pending;
    check(signal);
    const size = header(jxlBytes);
    dimensions(size.width, size.height, maxPixels);

    const wantsJxl = acceptsJxl(accept);
    const contentType = wantsJxl ? 'image/jxl' : 'image/jpeg';
    const suffix = wantsJxl ? 'jxl' : 'jpeg';
    const baseTag = customEtag ?? `"${TAGS.get(input) ?? (TAGS.set(input, await computeEntityHash(jxlBytes)), TAGS.get(input))}"`;
    const etag = formatRepresentationEtag(baseTag, suffix);

    if (!wantsJxl && (jxlBytes[0] === 255 && jxlBytes[1] === 10 || !jpegReconstruction(jxlBytes))) {
      throw fail('JXL_RECONSTRUCTION', 'The file contains no JPEG reconstruction data.');
    }

    if (matchesIfNoneMatch(ifNoneMatch, etag)) {
      check(signal);
      const headers304 = {
        'content-type': contentType,
        'vary': 'Accept',
        'cache-control': cacheControl,
        'etag': etag,
      };
      if (serverResponse) {
        serverResponse.writeHead(304, headers304);
        serverResponse.end();
      }
      return serverResponse ? undefined : new Response(null, {status: 304, headers: headers304});
    }

    let bodyBytes;
    if (wantsJxl) {
      bodyBytes = jxlBytes;
    } else {
      const restored = restoreJPEG(jxlBytes, brotliDictionary, {maxPixels});
      if (!restored) throw fail('JXL_RECONSTRUCTION', 'The file contains no JPEG reconstruction data.');
      bodyBytes = restored;
    }
    check(signal);
    const headers200 = {
      'content-type': contentType,
      'content-length': String(bodyBytes.byteLength),
      'vary': 'Accept',
      'cache-control': cacheControl,
      'etag': etag,
    };
    const wireBody = method === 'HEAD' ? null : bodyBytes;
    if (serverResponse) {
      serverResponse.writeHead(200, headers200);
      serverResponse.end(wireBody ?? undefined);
      return undefined;
    }
    return new Response(wireBody, {status: 200, headers: headers200});
  })(), signal);
}
