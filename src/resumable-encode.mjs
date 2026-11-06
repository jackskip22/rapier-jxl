// SPDX-License-Identifier: MIT
import {fault} from './fault.mjs';
import {encodeData, decodeData, digest} from './resumable-data.mjs';
import {sha256Start, sha256Update, sha256Finish} from './sha256.mjs';
import {prefetchParts, READ_BATCH_BYTES} from './resumable-prefetch.mjs';

export const CHECKPOINT_VERSION = 2;
export const MAX_PART_BYTES = 1048576;
const MAX_OUTPUT_BYTES = 0xffffffff;
const VERIFY_BYTES = 2 * MAX_PART_BYTES, OUTPUT_REFS = 16, MAX_MANIFEST_BYTES = 16384, HASH = /^[a-f0-9]{64}$/;
const READS = 64;
const readsOf = refs => {
  if (!Array.isArray(refs) || refs.length > READS || refs.reduce((n, ref) => n + refOf(ref).length, 0) > READ_BATCH_BYTES)
    invalid('Invalid checkpoint reads.');
  return refs;
};
const invalid = message => { throw fault('JXL_INPUT', message); };
const stale = message => { throw fault('JXL_INPUT', message); };
const own = value => decodeData(encodeData(value));
const same = (a, b) => {
  const x = encodeData(a), y = encodeData(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
};
const stopped = signal => { if (signal?.aborted) throw fault('JXL_ABORTED', 'The job was aborted.'); };
const refOf = ref => {
  if (!ref || !HASH.test(ref.hash) || !Number.isSafeInteger(ref.length) || ref.length < 0 || ref.length > MAX_PART_BYTES ||
      Object.keys(ref).length !== 2) invalid('Invalid immutable part reference.');
  return ref;
};
const sourceOf = source => {
  const s = own(source);
  if (!s || typeof s !== 'object' || Array.isArray(s) || !HASH.test(s.sha256) ||
      typeof s.generation !== 'string' || !s.generation.length || s.generation.length > 256 ||
      !Number.isSafeInteger(s.byteLength) || s.byteLength < 1 || s.byteLength > 0xffffffff)
    throw fault('JXL_INPUT', 'A source has an immutable generation, SHA-256 and byteLength from 1 to 2^32-1.');
  return s;
};
const budgetOf = budget => {
  if (!budget || typeof budget !== 'object' || Array.isArray(budget) || Object.keys(budget).some(k => k !== 'units') ||
      !Number.isSafeInteger(budget.units) || budget.units < 1 || budget.units > 64)
    throw fault('JXL_INPUT', 'A work budget is {units: 1..64}.');
  return {units: budget.units};
};

export function partsIO(read, signal, retain = true, readMany) {
  const pending = new Map(), cache = new Map();
  const write = async bytes => {
    stopped(signal);
    if (!(bytes instanceof Uint8Array) || bytes.length > MAX_PART_BYTES) invalid('An immutable part is at most 1 MiB.');
    const owned = new Uint8Array(bytes), hash = await digest(owned), ref = {hash, length: owned.length};
    stopped(signal);
    if (!pending.has(hash)) pending.set(hash, {ref, bytes: owned});
    cache.set(hash, owned);
    return ref;
  };
  const load = async ref => {
    refOf(ref); stopped(signal);
    let bytes = cache.get(ref.hash);
    if (!bytes) {
      if (typeof read !== 'function') invalid('The host must read immutable parts.');
      const found = await read(ref);
      stopped(signal);
      if (!(found instanceof Uint8Array) || found.length !== ref.length) invalid('Missing or truncated immutable part.');
      bytes = new Uint8Array(found);
      if (await digest(bytes) !== ref.hash) invalid('Corrupted immutable part.');
      stopped(signal); if (retain) cache.set(ref.hash, bytes);
    }
    if (bytes.length !== ref.length) invalid('Part length does not match its digest.');
    if (!retain) cache.delete(ref.hash);
    return bytes;
  };
  const prefetch = async refs => {
    stopped(signal);
    if (!Array.isArray(refs) || refs.length > 128) invalid('A part read batch has at most 128 references.');
    let bytes = 0;
    const wanted = new Map();
    for (const ref of refs) {
      refOf(ref); bytes += ref.length;
      if (bytes > READ_BATCH_BYTES) invalid('A part read batch is at most 8 MiB.');
      if (wanted.has(ref.hash) && wanted.get(ref.hash).length !== ref.length ||
          cache.has(ref.hash) && cache.get(ref.hash).length !== ref.length)
        invalid('Part length does not match its digest.');
      if (!cache.has(ref.hash)) wanted.set(ref.hash, {hash: ref.hash, length: ref.length});
    }
    if (!wanted.size) return;
    if (typeof readMany !== 'function') invalid('The host must provide bounded batched part reads.');
    const expected = [...wanted.values()];
    const found = await readMany(expected.map(ref => ({...ref})));
    stopped(signal);
    if (!Array.isArray(found) || found.length !== expected.length) invalid('A part read batch has the wrong number of results.');
    const owned = found.map((value, i) => {
      if (!(value instanceof Uint8Array) || value.length !== expected[i].length) invalid('Missing or truncated immutable part.');
      return new Uint8Array(value);
    });
    const hashes = await Promise.all(owned.map(digest));
    stopped(signal);
    for (let i = 0; i < hashes.length; i++) if (hashes[i] !== expected[i].hash) invalid('Corrupted immutable part.');
    for (let i = 0; i < owned.length; i++) cache.set(expected[i].hash, owned[i]);
  };
  return {read: async ref => new Uint8Array(await load(ref)), write, durable: true,
    borrow: load, prefetch,
    readJSON: async ref => decodeData(await load(ref)), writeJSON: value => write(encodeData(value)),
    parts: () => [...pending.values()]};
}

async function seal(manifest) {
  const bytes = encodeData(manifest);
  if (bytes.length > MAX_MANIFEST_BYTES) invalid('The checkpoint manifest exceeds 16 KiB.');
  return {...manifest, hash: await digest(bytes)};
}

async function verify(checkpoint, codec, build) {
  const c = own(checkpoint);
  if (!c || c.format !== 'rapier-jxl/checkpoint') invalid('This is not a rapier-jxl checkpoint.');
  if (c.schema !== CHECKPOINT_VERSION || c.build !== build) invalid('This checkpoint was written by another rapier-jxl version; start the job again.');
  if (c.codec !== codec) invalid('This checkpoint is of another operation.');
  if (!HASH.test(c.hash) || !HASH.test(c.job) || !Number.isSafeInteger(c.revision) || c.revision < 0 ||
      !['active', 'done'].includes(c.status) || c.previous !== null && !HASH.test(c.previous)) invalid('Invalid checkpoint manifest.');
  const {hash, ...body} = c, bytes = encodeData(body);
  if (bytes.length > MAX_MANIFEST_BYTES || await digest(bytes) !== hash) invalid('Corrupted checkpoint manifest.');
  sourceOf(c.source);
  if (c.status !== 'done' || c.state !== null) refOf(c.state);
  readsOf(c.reads);
  if (await digest(encodeData({codec, build, source: c.source, plan: c.plan, schema: CHECKPOINT_VERSION})) !== c.job)
    invalid('The checkpoint job identity changed.');
  if (c.status === 'done') {
    if (!c.output || !Number.isSafeInteger(c.output.byteLength) || c.output.byteLength < 0 || c.output.byteLength > MAX_OUTPUT_BYTES)
      invalid('Invalid completed output.');
    const {refs, index} = c.output;
    if (!c.output.byteLength ? refs !== null || index !== null : refs === null ? (refOf(index), false) : !Array.isArray(refs) || !refs.length ||
        refs.length > OUTPUT_REFS || index !== null || (refs.forEach(refOf), refs.reduce((n, r) => n + r.length, 0) !== c.output.byteLength))
      invalid('Invalid completed output.');
    if (c.output.result === undefined) invalid('Invalid completed output.');
  } else if (c.output !== null) invalid('An unfinished checkpoint cannot expose output.');
  return c;
}

function smallData(value) {
  const bytes = encodeData(value);
  if (bytes.length > MAX_MANIFEST_BYTES) invalid('Completion metadata exceeds 16 KiB.');
  return decodeData(bytes);
}

function sourceRange(host, source) {
  return async (offset, length) => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > source.byteLength)
      invalid('A source read is a bounded byte range.');
    if (!length) return new Uint8Array();
    if (typeof host.readSource !== 'function') invalid('The host must read the original (readSource).');
    const found = await host.readSource(offset, length);
    stopped(host.signal);
    if (!(found instanceof Uint8Array) || found.length !== length) invalid('Missing or truncated source range.');
    return new Uint8Array(found);
  };
}
function checkedSource(range, source) {
  let whole = null;
  return async (offset, length) => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > source.byteLength)
      invalid('A source read is a bounded byte range.');
    if (!whole) {
      const bytes = await range(0, source.byteLength);
      if (await digest(bytes) !== source.sha256) throw fault('JXL_INPUT', 'The source bytes do not match their pinned digest.');
      whole = bytes;
    }
    if (offset === 0 && length === whole.length) { const bytes = whole; whole = null; return bytes; }
    return whole.slice(offset, offset + length);
  };
}

export function createStepper(adapter) {
  if (!adapter || typeof adapter.id !== 'string' || !adapter.id.length || adapter.id.length > 128 || !HASH.test(adapter.build) ||
      !['normalize', 'start', 'step'].every(k => typeof adapter[k] === 'function'))
    throw fault('JXL_INPUT', 'A stepper needs a named codec, exact build digest and data-state operations.');
  const {normalize, start: begin, step} = adapter, codec = adapter.id, build = adapter.build;

  async function start({source, options = {}}) {
    source = sourceOf(source);
    const plan = own(normalize(own(options), source)), io = partsIO();
    const job = await digest(encodeData({codec, build, source, plan, schema: CHECKPOINT_VERSION}));
    const state = await io.writeJSON({phase: 'verify', offset: 0, hash: sha256Start()});
    const checkpoint = await seal({format: 'rapier-jxl/checkpoint', schema: CHECKPOINT_VERSION, codec, build, job,
      source, plan, revision: 0, previous: null, state, reads: [], status: 'active', output: null});
    return {checkpoint, parts: io.parts()};
  }

  async function advance(checkpoint, host, budget = {units: 1}) {
    stopped(host?.signal);
    budget = budgetOf(budget);
    const c = await verify(checkpoint, codec, build);
    if (!host || !same(sourceOf(host.source), c.source)) throw fault('JXL_INPUT', 'The source generation or digest changed.');
    if (!Number.isSafeInteger(host.expectedRevision) || host.expectedRevision !== c.revision)
      stale('The host revision does not match this checkpoint.');
    if (c.status === 'done') stale('This checkpoint already completed.');
    if (!same(normalize(c.plan.options ?? c.plan, c.source), c.plan)) invalid('The normalized codec plan changed.');
    const transition = await digest(encodeData({checkpoint: c.hash, budget}));
    const io = partsIO(host.read, host.signal, true, host.readMany), readSource = sourceRange(host, c.source), checked = checkedSource(readSource, c.source);
    await prefetchParts(io, [c.state, ...c.reads]);
    let state = await io.readJSON(c.state), output, reads = [];
    const work = [];
    const deadline = Number.isFinite(host.deadline) ? host.deadline : Infinity;
    for (let unit = 0; unit < budget.units && output === undefined && (unit === 0 || performance.now() < deadline); unit++) {
      stopped(host.signal);
      if (state.phase === 'verify') {
        const h = state.hash;
        if (!Number.isSafeInteger(state.offset) || state.offset < 0 || state.offset >= c.source.byteLength || !h || h.length !== state.offset ||
            !Array.isArray(h.h) || h.h.length !== 8 || !h.h.every(Number.isSafeInteger) || !Array.isArray(h.tail) ||
            h.tail.length !== state.offset % 64 || !h.tail.every(v => Number.isInteger(v) && v >= 0 && v < 256)) invalid('Invalid source checkpoint.');
        const count = Math.min(VERIFY_BYTES, c.source.byteLength - state.offset), at = state.offset;
        state = {...state, hash: sha256Update(h, await readSource(at, count)), offset: at + count};
        work.push({phase: 'source', offset: at, bytes: count});
        if (state.offset === c.source.byteLength) {
          if (sha256Finish(state.hash) !== c.source.sha256) throw fault('JXL_INPUT', 'The source bytes do not match their pinned digest.');
          state = {phase: 'encode', codec: begin(c.plan, c.source)};
        }
      } else if (state.phase === 'encode') {
        const left = deadline - performance.now(), budgetMs = Number.isFinite(left) ? Math.max(1, left) : host.budgetMs;
        const result = await step(state.codec, {...io, readSource: checked, signal: host.signal,
          ...(Number.isFinite(budgetMs) && budgetMs > 0 && {budgetMs})});
        stopped(host.signal);
        if (!result || !Object.hasOwn(result, 'state')) invalid('The codec returned no next state.');
        state = {phase: 'encode', codec: result.state};
        reads = result.reads ?? [];
        work.push(result.work ?? {phase: 'encode'});
        if (result.output !== undefined) {
          const bytes = result.output;
          if (bytes !== null && !(bytes instanceof Uint8Array)) invalid('A codec output is its bytes.');
          const refs = [];
          if (bytes) for (let at = 0; at < bytes.length; at += MAX_PART_BYTES) refs.push(await io.write(bytes.subarray(at, Math.min(bytes.length, at + MAX_PART_BYTES))));
          output = {refs: refs.length && refs.length <= OUTPUT_REFS ? refs : null, index: refs.length > OUTPUT_REFS ? await io.writeJSON(refs) : null,
            byteLength: bytes?.length ?? 0, result: result.result === undefined ? null : smallData(result.result)};
          state = null;
        }
      } else invalid('Invalid codec phase.');
    }
    stopped(host.signal);
    const done = output !== undefined, nextState = done ? null : await io.writeJSON(state), {hash: previousHash, ...body} = c;
    const next = await seal({...body, previous: previousHash, state: nextState, reads: done ? [] : readsOf(reads), revision: c.revision + 1,
      status: done ? 'done' : 'active', output: done ? output : null});
    stopped(host.signal);
    return {checkpoint: next, parts: io.parts(), work, units: work.length, transition, done, output: done ? output : null};
  }

  async function completed(checkpoint, host) {
    stopped(host?.signal);
    const c = await verify(checkpoint, codec, build);
    if (c.status !== 'done') invalid('The encode is not complete.');
    if (!host || !same(sourceOf(host.source), c.source)) invalid('The source generation or digest changed.');
    if (host.expectedRevision !== c.revision) stale('The host revision does not match this checkpoint.');
    if (!same(normalize(c.plan.options ?? c.plan, c.source), c.plan)) invalid('The normalized codec plan changed.');
    return c;
  }
  async function completion(checkpoint, host) {
    const c = await completed(checkpoint, host);
    return {result: c.output.result, byteLength: c.output.byteLength};
  }
  async function* outputParts(checkpoint, host) {
    const c = await completed(checkpoint, host);
    if (!c.output.byteLength) return;
    const io = partsIO(host.read, host.signal, true, host.readMany), refs = c.output.refs ?? await io.readJSON(c.output.index);
    if (!Array.isArray(refs) || !refs.length) invalid('Invalid output index.');
    let total = 0;
    for (const ref of refs) { refOf(ref); total += ref.length; }
    if (total !== c.output.byteLength) invalid('The output index does not cover the finished file.');
    for (let i = 0; i < refs.length; i += 8) {
      const batch = refs.slice(i, i + 8);
      await prefetchParts(io, batch);
      for (const ref of batch) { stopped(host.signal); yield await io.read(ref); }
    }
  }
  return Object.freeze({start, advance, completion, outputParts});
}
