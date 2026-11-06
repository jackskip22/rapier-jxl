// SPDX-License-Identifier: MIT
import {copyBytes, encodedByteLength, arrayBufferBytes} from './bytes.mjs';
import {admitSignal, check, fail, object} from './primitives.mjs';

const MAX_BYTES = 256 * 1024 * 1024;
const consume = promise => { Promise.resolve(promise).catch(() => {}); };

function options(value, keys) {
  const raw = object(value);
  if (Object.values(Object.getOwnPropertyDescriptors(raw)).some(field => !('value' in field)))
    throw fail('JXL_OPTIONS', 'Options cannot contain accessors.');
  const result = {...raw};
  for (const key of Object.keys(result)) if (!keys.includes(key)) throw fail('JXL_OPTIONS', `Unknown storage option: ${key}.`);
  if ('signal' in result) admitSignal(result.signal);
  return result;
}
function byteBound(value, name, fallback = MAX_BYTES) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_BYTES)
    throw fail('JXL_OPTIONS', `${name} is a positive whole number, at most 256 MiB.`);
  return value;
}
function sizeOf(body) {
  if (typeof Blob !== 'undefined' && body instanceof Blob) return body.size;
  const length = arrayBufferBytes(body);
  if (length !== null) return length;
  if (ArrayBuffer.isView(body)) return encodedByteLength(body, true);
  return null;
}
function collect(chunks, length) {
  if (chunks.length === 1) return chunks[0];
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
  return bytes;
}
function wait(promise, signal) {
  if (!signal) return promise;
  check(signal);
  return new Promise((resolve, reject) => {
    const abort = () => { release(); try { check(signal); } catch (error) { reject(error); } };
    const release = () => signal.removeEventListener?.('abort', abort);
    signal.addEventListener('abort', abort, {once: true});
    Promise.resolve(promise).then(value => { release(); resolve(value); }, error => { release(); reject(error); });
    if (signal.aborted) { release(); abort(); }
  });
}

export async function readAll(body, rawOptions) {
  const settings = options(rawOptions, ['maxBytes', 'signal']), {signal} = settings;
  const maxBytes = byteBound(settings.maxBytes, 'maxBytes');
  check(signal);
  const known = sizeOf(body);
  if (known !== null && known > maxBytes) throw fail('JXL_LIMIT', `Object body exceeds maxBytes (${maxBytes}).`);
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    const bytes = new Uint8Array(await wait(body.arrayBuffer(), signal));
    check(signal); return bytes;
  }
  if (arrayBufferBytes(body) !== null) {
    try { return new Uint8Array(new Uint8Array(body)); }
    catch { throw fail('JXL_INPUT', 'Object body uses an attached ArrayBuffer.'); }
  }
  if (ArrayBuffer.isView(body)) return copyBytes(body, true);
  if (!body || typeof body.getReader !== 'function') throw fail('JXL_INPUT', 'Object body is bytes, a Blob or a byte stream.');
  const reader = body.getReader(), chunks = [];
  let length = 0, ended = false;
  try {
    for (;;) {
      check(signal);
      const {done, value} = await wait(reader.read(), signal);
      check(signal);
      if (done) { ended = true; return collect(chunks, length); }
      const size = encodedByteLength(value, true);
      if (size > maxBytes - length) throw fail('JXL_LIMIT', `Object body exceeds maxBytes (${maxBytes}).`);
      chunks.push(copyBytes(value, true)); length += size;
    }
  } finally {
    if (!ended) { try { consume(reader.cancel(signal?.aborted ? signal.reason : undefined)); } catch {} }
    try { reader.releaseLock(); } catch {}
  }
}

