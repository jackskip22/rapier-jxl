// SPDX-License-Identifier: MIT
import {fault, guard} from './admit.mjs';
import {SIGNATURE, CODESTREAM, PARTIAL, boxes, fileHeader, boxHeader} from './container.mjs';

const invalid = message => fault('JXL_INPUT', message);
const aborted = signal => { if (signal?.aborted) throw signal.reason ?? fault('JXL_INPUT', 'JPEG XL container streaming was canceled.'); };

function settings(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw invalid('Container options are an object.');
  const {chunkSize = 65536, maxBytes = Number.MAX_SAFE_INTEGER, signal} = options;
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1)
    throw invalid('A container chunk size is a positive safe integer.');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw invalid('maxBytes is a positive safe integer.');
  if (signal !== undefined && (!signal || typeof signal !== 'object' || typeof signal.aborted !== 'boolean')) throw invalid('signal is an AbortSignal.');
  let total = 0;
  return {chunkSize, signal, count(length) {
    if (!Number.isSafeInteger(total + length) || total + length > maxBytes) throw fault('JXL_SIZE', 'The streamed JPEG XL container exceeds maxBytes.');
    total += length;
  }};
}

function fragment(data, index, final) {
  if (index >= 0x80000000) throw fault('JXL_SIZE', 'A JPEG XL stream has at most 2^31 fragments.');
  return guard(() => {
    const header = boxHeader(PARTIAL, data.length + 4), out = new Uint8Array(header.length + 4 + data.length);
    out.set(header); new DataView(out.buffer).setUint32(header.length, index + (final ? 0x80000000 : 0));
    out.set(data, header.length + 4); return out;
  });
}

export function* containerChunks(bytes, options = {}) {
  const state = settings(options);
  if (!(bytes instanceof Uint8Array) || bytes.length < 2) throw invalid('JPEG XL input is a Uint8Array.');
  aborted(state.signal);
  const bare = bytes[0] === 255 && bytes[1] === 10;
  let entries;
  if (bare) entries = [{type: CODESTREAM, body: 0, end: bytes.length}];
  else {
    if (!SIGNATURE.every((value, i) => bytes[i] === value)) throw invalid('Invalid JPEG XL signature.');
    entries = Array.from(boxes(bytes));
  }
  const payloads = entries.filter(entry => (entry.type === CODESTREAM || entry.type === PARTIAL) &&
    entry.end > entry.body + (entry.type === PARTIAL ? 4 : 0));
  const lastPayload = payloads.at(-1);
  let size = bare ? 32 : SIGNATURE.length;
  for (const entry of entries) {
    if (entry.type === CODESTREAM || entry.type === PARTIAL) {
      const length = entry.end - entry.body - (entry.type === PARTIAL ? 4 : 0);
      size += length + 12 * Math.ceil(length / state.chunkSize);
    } else size += entry.end - entry.at;
  }
  state.count(size);
  yield bare ? fileHeader() : SIGNATURE.slice();
  let index = 0;
  for (const entry of entries) {
    aborted(state.signal);
    if (entry.type !== CODESTREAM && entry.type !== PARTIAL) { yield new Uint8Array(bytes.subarray(entry.at, entry.end)); continue; }
    const begin = entry.body + (entry.type === PARTIAL ? 4 : 0);
    const final = entry === lastPayload;
    for (let at = begin; at < entry.end; at += state.chunkSize) {
      aborted(state.signal);
      const end = Math.min(entry.end, at + state.chunkSize);
      yield fragment(bytes.subarray(at, end), index++, final && end === entry.end);
    }
  }
}

export function withContainer(bytes, options = {}) {
  return guard(() => {
    const chunks = Array.from(containerChunks(bytes, options)), size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Uint8Array(size); let at = 0;
    for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
    return out;
  });
}

export async function* streamContainer(source, options = {}) {
  const state = settings(options), prefix = fileHeader(options.level ?? 5);
  if (!source || typeof source[Symbol.asyncIterator] !== 'function' && typeof source[Symbol.iterator] !== 'function')
    throw invalid('The codestream source is an iterable of Uint8Array chunks.');
  aborted(state.signal); state.count(prefix.length); yield prefix;
  let index = 0, signature = 0, tail = null;
  for await (const chunk of source) {
    aborted(state.signal);
    if (!(chunk instanceof Uint8Array)) throw invalid('Every codestream chunk is a Uint8Array.');
    for (let i = 0; i < chunk.length && signature < 2; i++) {
      if (chunk[i] !== (signature++ ? 10 : 255)) throw invalid('Invalid raw JPEG XL codestream signature.');
    }
    if (!chunk.length) continue;
    if (tail !== null) { state.count(13); yield fragment(Uint8Array.of(tail), index++, false); }
    for (let at = 0; at < chunk.length - 1; at += state.chunkSize) {
      aborted(state.signal);
      const part = chunk.subarray(at, Math.min(chunk.length - 1, at + state.chunkSize));
      state.count(part.length + 12); yield fragment(part, index++, false);
    }
    tail = chunk[chunk.length - 1];
  }
  aborted(state.signal);
  if (signature !== 2) throw invalid('The raw JPEG XL codestream is incomplete.');
  state.count(13); yield fragment(Uint8Array.of(tail), index, true);
}
