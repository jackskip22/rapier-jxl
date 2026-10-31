// SPDX-License-Identifier: MIT
import {fault, guard} from './admit.mjs';
import {SIGNATURE, CODESTREAM, PARTIAL, boxes, fileHeader, boxHeader} from './container.mjs';

const invalid = message => fault('JXL_INPUT', message);
const aborted = signal => { if (signal?.aborted) throw signal.reason ?? fault('JXL_INPUT', 'JPEG XL container streaming was canceled.'); };

function settings(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw invalid('Container options are an object.');
  const {chunkSize = 65536, maxBytes = Number.MAX_SAFE_INTEGER, maxBoxes = 65536, signal} = options;
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1)
    throw invalid('A container chunk size is a positive safe integer.');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw invalid('maxBytes is a positive safe integer.');
  if (!Number.isSafeInteger(maxBoxes) || maxBoxes < 1) throw invalid('maxBoxes is a positive safe integer.');
  if (signal !== undefined && (!signal || typeof signal !== 'object' || typeof signal.aborted !== 'boolean')) throw invalid('signal is an AbortSignal.');
  let total = 0, boxCount = 0;
  return {chunkSize, signal, maxBoxes,
    boxes(n) {
      if (!Number.isSafeInteger(n) || n < 0 || n > maxBoxes - boxCount)
        throw invalid('JPEG XL box count exceeds the limit.');
      boxCount += n;
    },
    count(length) {
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

function prepareContainer(bytes, options = {}) {
  const state = settings(options);
  if (!(bytes instanceof Uint8Array) || bytes.length < 2) throw invalid('JPEG XL input is a Uint8Array.');
  aborted(state.signal);
  const bare = bytes[0] === 255 && bytes[1] === 10;
  let entries;
  if (bare) entries = [{type: CODESTREAM, body: 0, end: bytes.length}];
  else {
    if (!SIGNATURE.every((value, i) => bytes[i] === value)) throw invalid('Invalid JPEG XL signature.');
    entries = Array.from(boxes(bytes, state.maxBoxes));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(entries[0].body + 4) === 1) {
      const fragments = entries.filter(entry => entry.type === PARTIAL);
      if (fragments.length > 1) {
        const logical = new Array(fragments.length);
        for (const entry of fragments) logical[view.getUint32(entry.body) & 0x7fffffff] = entry;
        let at = 0;
        entries = entries.map(entry => entry.type === PARTIAL ? logical[at++] : entry);
      }
    }
  }
  const payloads = entries.filter(entry => (entry.type === CODESTREAM || entry.type === PARTIAL) &&
    entry.end > entry.body + (entry.type === PARTIAL ? 4 : 0));
  const lastPayload = payloads.at(-1);
  let size = bare ? 32 : SIGNATURE.length, outputBoxes = bare ? 1 : 0;
  for (const entry of entries) {
    if (entry.type === CODESTREAM || entry.type === PARTIAL) {
      const length = entry.end - entry.body - (entry.type === PARTIAL ? 4 : 0);
      outputBoxes += Math.ceil(length / state.chunkSize);
      size += length + 12 * Math.ceil(length / state.chunkSize);
    } else { size += entry.end - entry.at; outputBoxes++; }
  }
  state.count(size);
  state.boxes(outputBoxes);
  return {state, bare, entries, lastPayload, size};
}

function writeContainer(plan, bytes, emit) {
  const {state, bare, entries, lastPayload} = plan;
  emit(bare ? fileHeader() : SIGNATURE.slice());
  let index = 0;
  for (const entry of entries) {
    aborted(state.signal);
    if (entry.type !== CODESTREAM && entry.type !== PARTIAL) { emit(new Uint8Array(bytes.subarray(entry.at, entry.end))); continue; }
    const begin = entry.body + (entry.type === PARTIAL ? 4 : 0);
    const final = entry === lastPayload;
    for (let at = begin; at < entry.end; at += state.chunkSize) {
      aborted(state.signal);
      const end = Math.min(entry.end, at + state.chunkSize);
      emit(fragment(bytes.subarray(at, end), index++, final && end === entry.end));
    }
  }
}

export function* containerChunks(bytes, options = {}) {
  const plan = prepareContainer(bytes, options);
  yield plan.bare ? fileHeader() : SIGNATURE.slice();
  let index = 0;
  const {state, entries, lastPayload} = plan;
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
    const plan = prepareContainer(bytes, options);
    const out = new Uint8Array(plan.size);
    let at = 0;
    writeContainer(plan, bytes, chunk => { out.set(chunk, at); at += chunk.length; });
    return out;
  });
}

export async function* streamContainer(source, options = {}) {
  const state = settings(options), prefix = fileHeader(options.level ?? 5);
  if (!source || typeof source[Symbol.asyncIterator] !== 'function' && typeof source[Symbol.iterator] !== 'function')
    throw invalid('The codestream source is an iterable of Uint8Array chunks.');
  aborted(state.signal); state.boxes(options.level === 10 ? 2 : 1); state.count(prefix.length); yield prefix;
  let index = 0, signature = 0, tail = null;
  for await (const chunk of source) {
    aborted(state.signal);
    if (!(chunk instanceof Uint8Array)) throw invalid('Every codestream chunk is a Uint8Array.');
    for (let i = 0; i < chunk.length && signature < 2; i++) {
      if (chunk[i] !== (signature++ ? 10 : 255)) throw invalid('Invalid raw JPEG XL codestream signature.');
    }
    if (!chunk.length) continue;
    if (tail !== null) { state.boxes(1); state.count(13); yield fragment(Uint8Array.of(tail), index++, false); }
    for (let at = 0; at < chunk.length - 1; at += state.chunkSize) {
      aborted(state.signal);
      const part = chunk.subarray(at, Math.min(chunk.length - 1, at + state.chunkSize));
      state.boxes(1); state.count(part.length + 12); yield fragment(part, index++, false);
    }
    tail = chunk[chunk.length - 1];
  }
  aborted(state.signal);
  if (signature !== 2) throw invalid('The raw JPEG XL codestream is incomplete.');
  state.boxes(1); state.count(13); yield fragment(Uint8Array.of(tail), index, true);
}
