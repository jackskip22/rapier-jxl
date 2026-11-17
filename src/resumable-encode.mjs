// SPDX-License-Identifier: MIT
import {DECODER_SNAPSHOT} from './shown-picture.mjs';
import {fault, abortReason} from './fault.mjs';
import {encodeData, decodeData, digest} from './resumable-data.mjs';
import {sha256Start, sha256Update, sha256Finish} from './sha256.mjs';
import {prefetchParts, READ_BATCH_BYTES} from './resumable-prefetch.mjs';

export const MAX_PART_BYTES = 1048576;
const MAX_OUTPUT_BYTES = 0xffffffff;
const VERIFY_BYTES = MAX_PART_BYTES, WHOLE_BYTES = 2 * MAX_PART_BYTES, MIN_CHUNK = 262144, MAX_CHUNKS = 64, OUTPUT_REFS = 16, MAX_MANIFEST_BYTES = 16384, HASH = /^[a-f0-9]{64}$/;
const READS = 64;
const SOURCE_CACHE_BYTES = 4 * MAX_PART_BYTES;
function byteCache(limit) {
  const values = new Map();
  let bytes = 0;
  const remove = key => { const value = values.get(key); if (value) { bytes -= value.length; values.delete(key); } };
  return {
    get size() { return values.size; },
    has: key => values.has(key),
    get(key) { const value = values.get(key); if (value) { values.delete(key); values.set(key, value); } return value; },
    delete: remove,
    set(key, value) {
      remove(key);
      if (value.length > limit) return;
      while (bytes + value.length > limit) remove(values.keys().next().value);
      values.set(key, value); bytes += value.length;
    }
  };
}
const readsOf = refs => {
  if (!Array.isArray(refs) || refs.length > READS || refs.reduce((n, ref) => n + refOf(ref).length, 0) > READ_BATCH_BYTES)
    invalid('checkpoint reads: <=64, <=8 MiB');
  return refs;
};
const invalid = message => { throw fault('JXL_INPUT', message); };
const stale = message => { throw fault('JXL_INPUT', message); };
const own = value => decodeData(encodeData(value));
const same = (a, b) => {
  const x = encodeData(a), y = encodeData(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
};
export const chunkBytes = byteLength => { let size = MIN_CHUNK; while (Math.ceil(byteLength / size) > MAX_CHUNKS) size *= 2; return size; };
const verifyBytes = byteLength => Math.max(VERIFY_BYTES, chunkBytes(byteLength));
const stopped = signal => { if (signal?.aborted) throw abortReason(signal); };
const refOf = ref => {
  if (!ref || !HASH.test(ref.hash) || !Number.isSafeInteger(ref.length) || ref.length < 0 || ref.length > MAX_PART_BYTES ||
      Object.keys(ref).length !== 2) invalid('part reference: hash, length');
  return ref;
};
export {refOf};
const sourceOf = source => {
  const s = own(source);
  if (!s || typeof s !== 'object' || Array.isArray(s) || !HASH.test(s.sha256) ||
      typeof s.generation !== 'string' || !s.generation.length || s.generation.length > 256 ||
      !Number.isSafeInteger(s.byteLength) || s.byteLength < 1 || s.byteLength > 0xffffffff)
    throw fault('JXL_INPUT', 'source: generation, sha256(64 lowercase hex), byteLength(1-4294967295)');
  return s;
};
const budgetOf = budget => {
  if (!budget || typeof budget !== 'object' || Array.isArray(budget) || Object.keys(budget).some(k => k !== 'units') ||
      !Number.isSafeInteger(budget.units) || budget.units < 1 || budget.units > 64)
    throw fault('JXL_INPUT', 'budget: {units: 1-64}');
  return {units: budget.units};
};

export function partsIO(read, signal, retain = true, readMany) {
  const pending = new Map(), cache = byteCache(READ_BATCH_BYTES);
  let readBytes = 0, readCalls = 0;
  const write = async bytes => {
    stopped(signal);
    if (!(bytes instanceof Uint8Array) || bytes.length > MAX_PART_BYTES) invalid('part: Uint8Array <=1 MiB');
    const owned = new Uint8Array(bytes), hash = await digest(owned), ref = {hash, length: owned.length};
    stopped(signal);
    if (!pending.has(hash)) pending.set(hash, {ref, bytes: owned});
    cache.delete(hash);
    return ref;
  };
  const load = async ref => {
    refOf(ref); stopped(signal);
    let bytes = pending.get(ref.hash)?.bytes ?? cache.get(ref.hash);
    if (!bytes) {
      if (typeof read !== 'function') invalid('read: function');
      readCalls++;
      const found = await read(ref);
      stopped(signal);
      if (!(found instanceof Uint8Array) || found.length !== ref.length) invalid('immutable part: missing/truncated');
      bytes = new Uint8Array(found);
      if (await digest(bytes) !== ref.hash) invalid('immutable part: digest mismatch');
      stopped(signal); readBytes += bytes.length; if (retain) cache.set(ref.hash, bytes);
    }
    if (bytes.length !== ref.length) invalid('part length: digest mismatch');
    if (!retain) cache.delete(ref.hash);
    return bytes;
  };
  const prefetch = async refs => {
    stopped(signal);
    if (!Array.isArray(refs) || refs.length > 128) invalid('part batch: <=128 references');
    let bytes = 0;
    const wanted = new Map();
    for (const ref of refs) {
      refOf(ref); bytes += ref.length;
      if (bytes > READ_BATCH_BYTES) invalid('part batch: <=8 MiB');
      const known = pending.get(ref.hash)?.bytes ?? cache.get(ref.hash);
      if (wanted.has(ref.hash) && wanted.get(ref.hash).length !== ref.length ||
          known && known.length !== ref.length)
        invalid('part length: digest mismatch');
      if (!known) wanted.set(ref.hash, {hash: ref.hash, length: ref.length});
    }
    if (!wanted.size) return;
    if (typeof readMany !== 'function') invalid('readMany: function');
    const expected = [...wanted.values()];
    readCalls++;
    const found = await readMany(expected.map(ref => ({...ref})));
    stopped(signal);
    if (!Array.isArray(found) || found.length !== expected.length) invalid('part batch: result count mismatch');
    const owned = found.map((value, i) => {
      if (!(value instanceof Uint8Array) || value.length !== expected[i].length) invalid('immutable part: missing/truncated');
      return new Uint8Array(value);
    });
    const hashes = await Promise.all(owned.map(digest));
    stopped(signal);
    for (let i = 0; i < hashes.length; i++) if (hashes[i] !== expected[i].hash) invalid('immutable part: digest mismatch');
    for (let i = 0; i < owned.length; i++) { cache.set(expected[i].hash, owned[i]); readBytes += owned[i].length; }
  };
  const fetch = async refs => {
    stopped(signal);
    if (!Array.isArray(refs) || refs.length > 128 || refs.reduce((n, ref) => n + refOf(ref).length, 0) > READ_BATCH_BYTES) invalid('part batch: <=128, <=8 MiB');
    if (typeof readMany !== 'function') invalid('readMany: function');
    readCalls++;
    const found = await readMany(refs.map(ref => ({hash: ref.hash, length: ref.length})));
    stopped(signal);
    if (!Array.isArray(found) || found.length !== refs.length) invalid('part batch: result count mismatch');
    found.forEach((value, i) => { if (!(value instanceof Uint8Array) || value.length !== refs[i].length) invalid('immutable part: missing/truncated'); readBytes += value.length; });
    return found;
  };
  return {read: async ref => new Uint8Array(await load(ref)), write, durable: true, fetch,
    borrow: load, prefetch, bytesRead: () => readBytes, callsRead: () => readCalls,
    readJSON: async ref => decodeData(await load(ref)), writeJSON: value => write(encodeData(value)),
    parts: () => [...pending.values()]};
}

async function seal(manifest) {
  const bytes = encodeData(manifest);
  if (bytes.length > MAX_MANIFEST_BYTES) invalid('checkpoint manifest: <=16 KiB');
  return {...manifest, hash: await digest(bytes)};
}

async function verify(checkpoint, codec, build) {
  const c = own(checkpoint);
  if (!c || c.format !== 'rapier-jxl/checkpoint') invalid("checkpoint: expected format 'rapier-jxl/checkpoint'");
  if (c.codec !== codec) invalid('checkpoint: codec mismatch');
  if (c.build !== build) invalid('checkpoint: build mismatch; restart');
  if (!HASH.test(c.hash) || !HASH.test(c.job) || !Number.isSafeInteger(c.revision) || c.revision < 0 ||
      !['active', 'done'].includes(c.status) || c.previous !== null && !HASH.test(c.previous)) invalid('checkpoint: manifest fields');
  const {hash, ...body} = c, bytes = encodeData(body);
  if (bytes.length > MAX_MANIFEST_BYTES || await digest(bytes) !== hash) invalid('checkpoint: digest mismatch');
  sourceOf(c.source);
  if (c.status !== 'done' || c.state !== null) refOf(c.state);
  readsOf(c.reads);
  if (await digest(encodeData({codec, build, source: c.source, plan: c.plan})) !== c.job)
    invalid('checkpoint: job mismatch');
  if (c.status === 'done') {
    if (!c.output || !Number.isSafeInteger(c.output.byteLength) || c.output.byteLength < 0 || c.output.byteLength > MAX_OUTPUT_BYTES)
      invalid('output: byteLength, refs, result');
    const {refs, index} = c.output;
    if (!c.output.byteLength ? refs !== null || index !== null : refs === null ? (refOf(index), false) : !Array.isArray(refs) || !refs.length ||
        refs.length > OUTPUT_REFS || index !== null || (refs.forEach(refOf), refs.reduce((n, r) => n + r.length, 0) !== c.output.byteLength))
      invalid('output: byteLength, refs, result');
    if (c.output.result === undefined) invalid('output: byteLength, refs, result');
  } else if (c.output !== null) invalid('checkpoint: output only when done');
  return c;
}

function smallData(value) {
  const bytes = encodeData(value);
  if (bytes.length > MAX_MANIFEST_BYTES) invalid('completion metadata: <=16 KiB');
  return decodeData(bytes);
}

function sourceRange(host, source) {
  return async (offset, length) => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > source.byteLength)
      invalid('source read: bounded range');
    if (!length) return new Uint8Array();
    if (typeof host.readSource !== 'function') invalid('readSource: function');
    const found = await host.readSource(offset, length);
    stopped(host.signal);
    if (!(found instanceof Uint8Array) || found.length !== length) invalid('source range: missing/truncated');
    return new Uint8Array(found);
  };
}
function checkedSource(range, source, signal, chunks) {
  const size = chunkBytes(source.byteLength), count = Math.ceil(source.byteLength / size), held = byteCache(SOURCE_CACHE_BYTES);
  if (!Array.isArray(chunks) || chunks.length !== count || !chunks.every(sum => HASH.test(sum))) invalid('source chunks: sha256 list');
  const check = async (first, bytes) => {
    const sums = await Promise.all(Array.from({length: Math.ceil(bytes.length / size)}, (_, i) =>
      digest(bytes.subarray(i * size, Math.min(bytes.length, (i + 1) * size)))));
    stopped(signal);
    for (let i = 0; i < sums.length; i++) if (sums[i] !== chunks[first + i]) throw fault('JXL_INPUT', 'source bytes: digest mismatch');
  };
  return async (offset, length) => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > source.byteLength)
      invalid('source read: bounded range');
    if (!length) return new Uint8Array();
    const first = Math.floor(offset / size), last = Math.ceil((offset + length) / size);
    if (!offset && length === source.byteLength && !held.size) { const bytes = await range(0, length); await check(0, bytes); return bytes; }
    const out = new Uint8Array(length), copy = (i, chunk) => {
      const at = i * size, lo = Math.max(offset, at), hi = Math.min(offset + length, at + chunk.length);
      out.set(chunk.subarray(lo - at, hi - at), lo - offset);
    };
    let from = last, to = first;
    for (let i = first; i < last; i++) {
      const chunk = held.get(i);
      if (chunk) copy(i, chunk); else { from = Math.min(from, i); to = i + 1; }
    }
    if (from < to) {
      const bytes = await range(from * size, Math.min(source.byteLength, to * size) - from * size);
      await check(from, bytes);
      for (let i = from; i < to; i++) {
        const chunk = bytes.subarray((i - from) * size, Math.min(bytes.length, (i - from + 1) * size));
        copy(i, chunk);
        if (chunk.length <= SOURCE_CACHE_BYTES && !held.has(i)) held.set(i, chunk.slice());
      }
    }
    return out;
  };
}

export function createStepper(adapter) {
  if (!adapter || typeof adapter.id !== 'string' || !adapter.id.length || adapter.id.length > 128 || !HASH.test(adapter.build) ||
      !['normalize', 'start', 'step'].every(k => typeof adapter[k] === 'function'))
    throw fault('JXL_INPUT', 'stepper: id, build, normalize/start/step');
  const {normalize, start: begin, step} = adapter, codec = adapter.id, build = adapter.build;

  const planOf = (options, source, verifyOutput = false) => {
    if (typeof verifyOutput !== 'boolean') throw fault('JXL_OPTIONS', 'verify: boolean');
    const plan = own(normalize(own(options), source));
    return verifyOutput ? {...plan, verify: true} : plan;
  };

  async function start({source, options = {}, verify: verifyOutput = false, admit}) {
    source = sourceOf(source);
    const plan = planOf(options, source, verifyOutput);
    await admit?.(plan, source);
    const io = partsIO();
    const job = await digest(encodeData({codec, build, source, plan}));
    const state = await io.writeJSON({phase: 'verify', offset: 0, hash: sha256Start(), chunks: []});
    const checkpoint = await seal({format: 'rapier-jxl/checkpoint', codec, build, job,
      source, plan, revision: 0, previous: null, state, reads: [], status: 'active', output: null});
    return {checkpoint, parts: io.parts()};
  }

  async function advance(checkpoint, host, budget = {units: 1}) {
    stopped(host?.signal);
    budget = budgetOf(budget);
    const c = await verify(checkpoint, codec, build);
    if (!host || !same(sourceOf(host.source), c.source)) throw fault('JXL_INPUT', 'source: generation/digest mismatch');
    if (!Number.isSafeInteger(host.expectedRevision) || host.expectedRevision !== c.revision)
      stale('expectedRevision: checkpoint mismatch');
    if (c.status === 'done') stale('checkpoint: completed');
    if (c.revision === Number.MAX_SAFE_INTEGER) invalid('checkpoint revision: at maximum');
    if (!same(planOf(c.plan.options ?? c.plan, c.source, c.plan.verify ?? false), c.plan)) invalid('codec plan: mismatch');
    await host.admit?.(c.plan, c.source);
    const transition = await digest(encodeData({checkpoint: c.hash, budget}));
    const io = partsIO(host.read, host.signal, true, host.readMany), readSource = sourceRange(host, c.source);
    let checked = null, prepared = false, sourceBytes = 0, sourceCalls = 0;
    await prefetchParts(io, [c.state, ...c.reads]);
    let state = await io.readJSON(c.state), output, outputRefs = [], reads = [];
    const reach = (checkpoint, codecState, named = []) => {
      const refs = [checkpoint.state, ...(checkpoint.reads ?? []), ...(checkpoint.output?.refs ?? []), checkpoint.output?.index, ...named,
        ...(codecState && adapter.refs ? adapter.refs(codecState) : [])].filter(Boolean);
      return new Map(refs.map(ref => [ref.hash, ref]));
    };
    const before = reach(c, state?.phase === 'encode' ? state.codec : null);
    const work = [];
    const deadline = Number.isFinite(host.deadline) ? host.deadline : Infinity;
    for (let unit = 0; unit < budget.units && output === undefined && (unit === 0 || performance.now() < deadline); unit++) {
      stopped(host.signal);
      if (state.phase === 'verify') {
        const h = state.hash;
        if (!Number.isSafeInteger(state.offset) || state.offset < 0 || state.offset >= c.source.byteLength || !h || h.length !== state.offset ||
            !Array.isArray(h.h) || h.h.length !== 8 || !h.h.every(Number.isSafeInteger) || !Array.isArray(h.tail) ||
            h.tail.length !== state.offset % 64 || !h.tail.every(v => Number.isInteger(v) && v >= 0 && v < 256) ||
            !Array.isArray(state.chunks) || state.offset % verifyBytes(c.source.byteLength) || state.chunks.length !== state.offset / chunkBytes(c.source.byteLength) ||
            !state.chunks.every(sum => HASH.test(sum))) invalid('source checkpoint: phase/chunks');
        const count = Math.min(verifyBytes(c.source.byteLength), c.source.byteLength - state.offset), at = state.offset, size = chunkBytes(c.source.byteLength);
        const whole = !at && c.source.byteLength <= WHOLE_BYTES, length = whole ? c.source.byteLength : count;
        const bytes = await readSource(at, length);
        const sums = await Promise.all(Array.from({length: Math.ceil(length / size)}, (_, i) => digest(bytes.subarray(i * size, Math.min(length, (i + 1) * size)))));
        const sum = whole ? await digest(bytes) : null;
        state = {...state, hash: whole ? h : sha256Update(h, bytes), offset: at + length, chunks: [...state.chunks, ...sums]};
        work.push({phase: 'source', offset: at, bytes: length});
        if (state.offset === c.source.byteLength) {
          if ((sum ?? sha256Finish(state.hash)) !== c.source.sha256) throw fault('JXL_INPUT', 'source bytes: digest mismatch');
          state = {phase: 'encode', codec: begin(c.plan, c.source), chunks: state.chunks};
        }
      } else if (state.phase === 'encode') {
        checked ??= checkedSource(async (at, length) => {
          sourceCalls++; const bytes = await readSource(at, length); sourceBytes += bytes.length; return bytes;
        }, c.source, host.signal, state.chunks);
        if (!prepared) { await host.prepare?.(c.plan, c.source, checked); prepared = true; }
        const left = deadline - performance.now(), budgetMs = Number.isFinite(left) ? Math.max(1, left) : host.budgetMs;
        const result = await step(state.codec, {...io, readSource: checked, bytesRead: () => sourceBytes + io.bytesRead(),
          callsRead: () => sourceCalls + io.callsRead(), signal: host.signal,
          ...(Number.isFinite(budgetMs) && budgetMs > 0 && {budgetMs}), ...(host.reads && {reads: host.reads}), ...(host.memoryBytes !== undefined && {memoryBytes: host.memoryBytes}), ...(host.straight && {straight: host.straight}),
          ...(host.verify && {verify: host.verify}), ...(DECODER_SNAPSHOT in host && {[DECODER_SNAPSHOT]: host[DECODER_SNAPSHOT]})});
        stopped(host.signal);
        if (!result || !Object.hasOwn(result, 'state')) invalid('step: state required');
        state = {phase: 'encode', codec: result.state, chunks: state.chunks};
        reads = result.reads ?? [];
        work.push(result.work ?? {phase: 'encode'});
        if (result.output !== undefined) {
          const bytes = result.output;
          if (bytes !== null && !(bytes instanceof Uint8Array)) invalid('output: Uint8Array');
          const refs = [];
          if (result.outputRefs) {
            if (!Array.isArray(result.outputRefs) || result.outputRefs.reduce((n, ref) => n + refOf(ref).length, 0) !== (bytes?.length ?? 0)) invalid('outputRefs: byteLength mismatch');
            refs.push(...result.outputRefs);
          } else if (bytes) for (let at = 0; at < bytes.length; at += MAX_PART_BYTES) refs.push(await io.write(bytes.subarray(at, Math.min(bytes.length, at + MAX_PART_BYTES))));
          outputRefs = refs;
          output = {refs: refs.length && refs.length <= OUTPUT_REFS ? refs : null, index: refs.length > OUTPUT_REFS ? await io.writeJSON(refs) : null,
            byteLength: bytes?.length ?? 0, result: result.result === undefined ? null : smallData(result.result)};
          state = null;
        }
        if (result.yield) break;
      } else invalid('codec phase: unknown');
    }
    stopped(host.signal);
    const done = output !== undefined, nextState = done ? null : await io.writeJSON(state), {hash: previousHash, ...body} = c;
    const next = await seal({...body, previous: previousHash, state: nextState, reads: done ? [] : readsOf(reads), revision: c.revision + 1,
      status: done ? 'done' : 'active', output: done ? output : null});
    stopped(host.signal);
    const after = reach(next, state?.phase === 'encode' ? state.codec : null, outputRefs);
    const released = [...before].filter(([hash]) => !after.has(hash)).map(([, ref]) => ({hash: ref.hash, length: ref.length}));
    return {checkpoint: next, parts: io.parts(), released, work, units: work.length, transition, done, output: done ? output : null};
  }

  async function completed(checkpoint, host) {
    stopped(host?.signal);
    const c = await verify(checkpoint, codec, build);
    if (c.status !== 'done') invalid('checkpoint: not done');
    if (!host || !same(sourceOf(host.source), c.source)) invalid('source: generation/digest mismatch');
    if (host.expectedRevision !== c.revision) stale('expectedRevision: checkpoint mismatch');
    if (!same(planOf(c.plan.options ?? c.plan, c.source, c.plan.verify ?? false), c.plan)) invalid('codec plan: mismatch');
    await host.admit?.(c.plan, c.source);
    return c;
  }
  async function completion(checkpoint, host) {
    const c = await completed(checkpoint, host);
    return {result: c.output.result, byteLength: c.output.byteLength};
  }
  async function output(checkpoint, host, file) {
    const c = await completed(checkpoint, host);
    if (!c.output.byteLength) return file(0);
    const io = partsIO(host.read, host.signal, false, host.readMany), refs = c.output.refs ?? await io.readJSON(c.output.index);
    if (!Array.isArray(refs) || !refs.length) invalid('output index: nonempty array');
    let total = 0;
    for (const ref of refs) { refOf(ref); total += ref.length; }
    if (total !== c.output.byteLength) invalid('output index: length mismatch');
    let bytes = null, at = 0;
    for (let i = 0; i < refs.length;) {
      let end = i + 1, size = refs[i].length;
      while (end < refs.length && end - i < 128 && size + refs[end].length <= READ_BATCH_BYTES) size += refs[end++].length;
      const batch = refs.slice(i, end), found = await io.fetch(batch); i = end;
      bytes ??= file(total);
      for (let k = 0; k < batch.length; k++) {
        const ref = batch[k];
        bytes.set(found[k], at); found[k] = null;
        if (await digest(bytes.subarray(at, at + ref.length)) !== ref.hash) invalid('immutable part: digest mismatch');
        stopped(host.signal); at += ref.length;
      }
    }
    return bytes;
  }
  return Object.freeze({start, advance, completion, output});
}
