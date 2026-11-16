// SPDX-License-Identifier: MIT
// EmDash's bounded read of a stored body: bytes, a Blob or a byte stream into owned bytes, at most maxBytes (256 MiB by
// default and at most), cancelling a stream on overflow, refusal or abort.
const MAX_BYTES = 256 * 1024 * 1024;
const fail = (code, message) => Object.assign(new Error(message), {code});
const bufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get;
const typedName = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag).get;
const typedBuffer = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'buffer').get;
const typedLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength').get;
const consume = promise => { Promise.resolve(promise).catch(() => {}); };

// An ordinary ArrayBuffer's length; a view, a SharedArrayBuffer or anything else is null.
function bufferBytes(value) {
  if (ArrayBuffer.isView(value)) return null;
  try { return bufferLength.call(value); } catch { return null; }
}
// A Uint8Array on an ordinary, attached ArrayBuffer: its length.
function viewLength(value) {
  if (typedName.call(value) !== 'Uint8Array' || bufferBytes(typedBuffer.call(value)) === null)
    throw fail('JXL_INPUT', "Invalid body; use bytes, a Blob, or a byte stream.");
  return typedLength.call(value);
}
function copy(value) {
  viewLength(value);
  try { return new Uint8Array(value); }
  catch { throw fail('JXL_INPUT', "Detached body; use an attached buffer."); }
}
// An aborted signal throws its own reason.
function check(signal) {
  if (signal?.aborted) throw signal.reason ?? fail('JXL_IO', "Read aborted; use a new signal.");
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
function settings(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('JXL_OPTIONS', "Invalid options; use an object.");
  if (Object.values(Object.getOwnPropertyDescriptors(value)).some(field => !('value' in field)))
    throw fail('JXL_OPTIONS', "Options have accessors; use plain values.");
  for (const key of Object.keys(value)) if (key !== 'maxBytes' && key !== 'signal') throw fail('JXL_OPTIONS', `Unknown option ${key}; remove it.`);
  const {maxBytes = MAX_BYTES, signal} = value;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES)
    throw fail('JXL_OPTIONS', "Invalid maxBytes; use whole bytes from 1 to 256 MiB.");
  if (signal !== undefined && (!signal || typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function'))
    throw fail('JXL_OPTIONS', "Invalid signal; use an AbortSignal.");
  return {maxBytes, signal};
}

/** Owned bytes from a stored body, at most maxBytes. */
export async function readAll(body, options) {
  const {maxBytes, signal} = settings(options);
  check(signal);
  const over = () => fail('JXL_LIMIT', `Body exceeds maxBytes (${maxBytes}); raise it or send less.`);
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    if (body.size > maxBytes) throw over();
    let buffer;
    try { buffer = await wait(body.arrayBuffer(), signal); }
    catch (cause) { if (signal?.aborted) throw cause; throw Object.assign(fail('JXL_IO', "Read failed; check storage and retry."), {cause}); }
    if (buffer.byteLength !== body.size) throw fail('JXL_INPUT', "File changed; reread it.");
    return new Uint8Array(buffer);
  }
  const length = bufferBytes(body);
  if (length !== null) {
    if (length > maxBytes) throw over();
    try { return new Uint8Array(new Uint8Array(body)); }
    catch { throw fail('JXL_INPUT', "Detached body; use an attached buffer."); }
  }
  if (ArrayBuffer.isView(body)) { if (viewLength(body) > maxBytes) throw over(); return copy(body); }
  if (!body || typeof body.getReader !== 'function') throw fail('JXL_INPUT', "Invalid body; use bytes, a Blob, or a byte stream.");
  const reader = body.getReader(), chunks = [];
  let total = 0, ended = false;
  try {
    for (;;) {
      check(signal);
      let done, value;
      try { ({done, value} = await wait(reader.read(), signal)); }
      catch (cause) {
        // The stream's own failure (a dropped connection, a source that throws) is JXL_IO; an abort is the caller's.
        if (signal?.aborted || typeof cause?.code === 'string' && cause.code.startsWith('JXL_')) throw cause;
        throw Object.assign(fail('JXL_IO', "Read failed; check storage and retry."), {cause});
      }
      check(signal);
      if (done) {
        ended = true;
        if (chunks.length === 1) return chunks[0];
        const bytes = new Uint8Array(total);
        let at = 0;
        for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
        return bytes;
      }
      const size = viewLength(value);
      if (size > maxBytes - total) throw over();
      chunks.push(copy(value)); total += size;
    }
  } finally {
    if (!ended) { try { consume(reader.cancel(signal?.aborted ? signal.reason : undefined)); } catch {} }
    try { reader.releaseLock(); } catch {}
  }
}
