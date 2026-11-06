// SPDX-License-Identifier: MIT
import {createStepper, MAX_PART_BYTES} from './resumable-encode.mjs';
import {encodeValue, decodeValue, lazySource, SAVED, PASSED, journalNext} from './step-journal.mjs';
import {prefetchParts, READ_BATCH_BYTES} from './resumable-prefetch.mjs';
const READS = 64;
import {fault} from './fault.mjs';

function checksum(buffer) {
  const words = new Int32Array(buffer, 0, buffer.byteLength >> 2), tail = new Uint8Array(buffer, words.length * 4);
  let a = 0x9e3779b9 ^ buffer.byteLength, b = 0x85ebca6b;
  for (let i = 0; i < words.length; i++) { a = Math.imul(a ^ words[i], 0x01000193); b = (b + a) | 0; }
  for (let i = 0; i < tail.length; i++) a = Math.imul(a ^ tail[i], 0x01000193);
  return (a ^ Math.imul(b, 0x27d4eb2f)) >>> 0;
}
const invalid = message => { throw fault('JXL_INPUT', message); };
const STOP = Object.freeze(new Error('A resumable call ended its attempt.'));
const unitRequest = value => value?.unit !== undefined || value?.unitDone !== undefined || value?.unitFailed !== undefined;
async function driveSteps(steps, request) {
  let reply, step, ended = false;
  try {
    while (!(step = journalNext(steps, reply)).done) {
      const value = step.value;
      reply = unitRequest(value) ? await request(value) : undefined;
      if (!unitRequest(value) && value?.gpu === undefined && typeof value !== 'number') invalid('A resumable step made a request it cannot answer here.');
    }
    ended = true;
    return step.value;
  } finally { if (!ended) try { steps.return?.(); } catch {} }
}
const now = () => performance.now();

async function through(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}
const deflate = bytes => through(bytes, new CompressionStream('deflate-raw'));

async function savePages(io, pending) {
  let page = [], size = 0;
  const flush = async () => {
    if (!size) return;
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const piece of page) { bytes.set(piece.bytes, at); at += piece.bytes.length; }
    const ref = await io.write(bytes);
    at = 0;
    for (const piece of page) { piece.slices.push([ref, at, piece.bytes.length]); at += piece.bytes.length; }
    page = []; size = 0;
  };
  for (const {entry, bytes: plain} of pending) {
    const slices = [], bytes = plain.length ? await deflate(plain) : plain;
    for (let at = 0; at < bytes.length;) {
      const take = Math.min(bytes.length - at, MAX_PART_BYTES - size);
      page.push({bytes: bytes.subarray(at, at + take), slices}); size += take; at += take;
      if (size === MAX_PART_BYTES) await flush();
    }
    entry.bytes = slices;
  }
  await flush();
}
const slicesOf = entry => {
  if (!Array.isArray(entry.bytes) || entry.bytes.some(s => !Array.isArray(s) || s.length !== 3 || !Number.isSafeInteger(s[1]) ||
      !Number.isSafeInteger(s[2]) || s[1] < 0 || s[2] < 0 || s[1] + s[2] > MAX_PART_BYTES)) invalid('Invalid journal value pages.');
  return entry.bytes;
};
async function loadBytes(io, entry) {
  const spans = [];
  for (const [ref, from, length] of slicesOf(entry)) {
    const page = await io.borrow(ref);
    if (from + length > page.length) invalid('A journal value lies outside its page.');
    spans.push(page.subarray(from, from + length));
  }
  if (!entry.length) { if (spans.length) invalid('A journal value has the wrong length.'); return new Uint8Array(0); }
  const packed = new Uint8Array(spans.reduce((n, span) => n + span.length, 0));
  let at = 0;
  for (const span of spans) { packed.set(span, at); at += span.length; }
  if (!Number.isSafeInteger(entry.length) || entry.length < 0 || entry.length > packed.length * 1032 + 64) invalid('A journal value has the wrong length.');
  return inflateTo(packed, entry.length);
}
async function inflateTo(packed, length) {
  const reader = new Blob([packed]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader(), chunks = [];
  let at = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      if (at + value.length > length) invalid('A journal value has the wrong length.');
      chunks.push(value); at += value.length;
    }
  } catch (error) {
    reader.cancel().catch(() => {});
    if (error?.code === 'JXL_INPUT') throw error;
    invalid('A journal value is not deflated data.');
  }
  if (at !== length) invalid('A journal value has the wrong length.');
  if (chunks.length === 1) return chunks[0];
  const bytes = new Uint8Array(length);
  at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
  return bytes;
}

export function createJournalStepper({id, build, normalize, open, run, eager = false}) {
  return createStepper({id, build, normalize,
    start: (plan, source) => ({journal: {}, plan, source, hot: []}),
    async step(state, io) {
      const {journal, plan, source: description, hot = []} = state;
      if (!journal || typeof journal !== 'object' || Array.isArray(journal) || !plan || !description) invalid('Invalid journal state.');
      const started = now(), budget = io.budgetMs ?? plan.budgetMs ?? 20;
      const loaded = new Map(), round = x => +x.toFixed(1);
      const pending = [], used = new Set();
      let longest = ['', 0], replay = null, attempted = 0, decodeMs = 0;
      let fresh = 0, saveMs = 0, loadMs = 0, sourceMs = 0, readBytes = 0, attempts = 0, answered = 0, final = null, source = null;
      const read = async wanted => {
        if (wanted.includes('source') && !source) {
          const t0 = now();
          source = await io.readSource(0, description.byteLength);
          sourceMs += now() - t0; readBytes += source.length;
        }
        const paths = wanted.filter(p => p !== 'source' && journal[p] && !journal[p].passed && !loaded.has(p));
        if (!paths.length) return;
        const l0 = now(), entries = paths.map(p => journal[p]);
        await prefetchParts(io, [...new Map(entries.flatMap(e => slicesOf(e).map(([ref]) => [ref.hash, ref]))).values()]);
        for (const [i, p] of paths.entries()) { loaded.set(p, await loadBytes(io, entries[i])); readBytes += entries[i].length; }
        loadMs += now() - l0;
      };
      const warm = [...(run || eager ? ['source'] : []), ...hot.filter(p => journal[p])];
      if (warm.length) await read(warm);
      while (true) {
        attempts++; replay = null; attempted = now();
        const missing = new Set(), miss = p => missing.add(p), input = source ?? lazySource(description.byteLength, miss);
        const owned = new Map(), refs = new Map(), sums = new Map();
        const known = {get: buffer => {
          const ref = refs.get(buffer);
          return ref && (ref[0] === 'source' || sums.get(buffer) === checksum(buffer)) ? ref : undefined;
        }};
        const resolve = (p, i) => {
          if (p === 'source') return i !== 0 ? undefined : source ? source.buffer : null;
          if (!owned.has(p)) { if (!journal[p]) invalid('A journal value refers to a missing value.'); return null; }
          return owned.get(p)?.[i] ?? null;
        };
        const register = (p, buffers) => {
          owned.set(p, buffers);
          buffers?.forEach((buffer, i) => { refs.set(buffer, [p, i]); sums.set(buffer, checksum(buffer)); });
        };
        if (source) refs.set(source.buffer, ['source', 0]);
        const stack = [{path: '', children: 0}];
        let stopped = false;
        const request = async value => {
          if (missing.size || stopped) throw STOP;
          if (value.unit !== undefined) {
            const top = stack.at(-1), path = (top.path ? top.path + '.' : '') + top.children++, entry = journal[path];
            if (entry) {
              if (entry.name !== value.unit || !!entry.carry !== !!value.carry) invalid('The journal does not match this operation\'s steps.');
              if (entry.passed) { answered++; return {[SAVED]: PASSED}; }
              const d0 = now(), bytes = loaded.get(path) ?? null, decoded = decodeValue(entry.meta, bytes, resolve, path, miss);
              used.add(path);
              register(path, bytes ? decoded.buffers : null);
              decodeMs += now() - d0;
              answered++;
              return {[SAVED]: decoded.value};
            }
            if (fresh && now() - started >= budget) { stopped = true; throw STOP; }
            if (replay === null) replay = now() - attempted;
            stack.push({path, children: 0, name: value.unit, carry: !!value.carry, started: now()});
            return undefined;
          }
          const frame = stack.pop(), ran = now() - frame.started;
          if (ran > longest[1]) longest = [stack.map(f => f.name).filter(Boolean).concat(frame.name).join('/'), +ran.toFixed(1)];
          if (!frame?.name || frame.name !== (value.unitDone ?? value.unitFailed)) invalid('Unbalanced unit steps.');
          const inside = frame.path + '.';
          for (const p of Object.keys(journal)) if (p.startsWith(inside)) { delete journal[p]; owned.delete(p); loaded.delete(p); }
          for (const [buffer, ref] of refs) if (typeof ref[0] === 'string' && ref[0].startsWith(inside)) refs.delete(buffer);
          if (value.unitFailed !== undefined) return undefined;
          const w0 = now(), {meta, bytes, buffers} = encodeValue(value.save ? value.save(value.value) : value.value, known);
          if (frame.carry) {
            const parent = frame.path.slice(0, frame.path.lastIndexOf('.') + 1), at = +frame.path.slice(parent.length);
            for (let i = 0; i < at; i++) {
              const p = parent + i, before = journal[p];
              if (before?.carry && !before.passed && before.name === frame.name) { journal[p] = {name: before.name, carry: true, passed: true}; owned.delete(p); loaded.delete(p); }
            }
          }
          journal[frame.path] = {name: frame.name, ...(frame.carry && {carry: true}), meta, length: bytes.length, bytes: []};
          pending.push({entry: journal[frame.path], bytes});
          loaded.set(frame.path, bytes);
          if (frame.carry) owned.set(frame.path, buffers); else register(frame.path, buffers);
          saveMs += now() - w0; fresh++;
          return undefined;
        };
        let result, abandoned = false;
        try { result = await (run ? run(plan, input, description, request) : driveSteps(open(plan, input, description), request)); }
        catch (error) { if (!missing.size && !stopped) throw error; }
        if (missing.size) abandoned = true;
        const stop = !abandoned && stopped;
        if (abandoned) { await read([...missing]); continue; }
        final = stop ? null : result;
        break;
      }
      if (final === null) await savePages(io, pending.filter(({entry}) => Object.values(journal).includes(entry)));
      const work = {phase: 'journal', stepMs: +(now() - started).toFixed(1), decodeMs: +decodeMs.toFixed(1), longest, replayMs: +(replay ?? now() - attempted).toFixed(1), attempts, answered, fresh, entries: Object.keys(journal).length, readBytes,
        sourceMs: round(sourceMs), loadMs: round(loadMs), saveMs: round(saveMs)};
      for (const {entry} of pending) for (const [p, e] of Object.entries(journal)) if (e === entry) used.add(p);
      const next = {journal, plan, source: description, hot: [...used].filter(p => journal[p] && !journal[p].passed)};
      const reads = [];
      let batch = 0;
      for (const ref of new Map(next.hot.flatMap(p => slicesOf(journal[p]).map(([ref]) => [ref.hash, ref]))).values()) {
        if (reads.length === READS || batch + ref.length > READ_BATCH_BYTES) break;
        reads.push(ref); batch += ref.length;
      }
      if (final === null) return {state: next, work, reads};
      const bytes = final instanceof Uint8Array ? final : final?.bytes, facts = final instanceof Uint8Array ? null : final?.facts ?? null;
      if (!(bytes instanceof Uint8Array)) invalid('The steps returned no file.');
      return {state: next, work, output: bytes.length ? bytes : null, result: {schema: 1, length: bytes.length, facts}};
    }});
}
