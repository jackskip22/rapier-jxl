// SPDX-License-Identifier: MIT
import {createStepper, MAX_PART_BYTES, refOf} from './resumable-encode.mjs';
import {encodeValue, decodeValue, lazySource, lazyValue, unreadPath, joinedBytes, journalFact, JOIN, SAVED, PASSED, journalNext, journalProtocol, plainJournal} from './step-journal.mjs';
import {writeData, parseData} from './resumable-data.mjs';
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
    while (!(step = journalNext(steps, reply, request)).done) {
      const value = step.value;
      reply = unitRequest(value) ? await request(value) : undefined;
      if (!unitRequest(value) && value?.gpu === undefined && typeof value !== 'number') invalid('A resumable step made a request it cannot answer here.');
    }
    ended = true;
    return step.value;
  } finally { if (!ended) try { steps.return?.(); } catch {} }
}
async function drainPlain(steps, signal) {
  let step, ended = false;
  const plain = plainJournal(signal);
  try {
    while (!(step = journalNext(steps, undefined, plain)).done) {
      if (signal.aborted) throw signal.reason;
      const value = step.value;
      if (value?.gpu === undefined && typeof value !== 'number' && value !== undefined) invalid('A resumable step made a request it cannot answer here.');
    }
    ended = true;
    return step.value;
  } finally { if (!ended) try { steps.return?.(); } catch {} }
}
const now = () => performance.now();
async function writeParts(file, request, io) {
  const refs = [];
  for (let at = 0; at < file.length; at += MAX_PART_BYTES) {
    const end = Math.min(file.length, at + MAX_PART_BYTES), saved = await request({unit: 'file-part'});
    if (saved) { refs.push(saved[SAVED]); continue; }
    let ref;
    try { ref = await io.write(file.subarray(at, end)); } catch (error) { await request({unitFailed: 'file-part'}); throw error; }
    file.ahead(end, end + MAX_PART_BYTES);
    await request({unitDone: 'file-part', value: ref});
    refs.push(ref);
  }
  return refs;
}
const HOLD_BYTES = 67108864;
const OBSERVE = Symbol.for('rapier-jxl.journal.observe');
const STRAIGHT_HEAD = 65536, SOURCE_AHEAD = 1048576, SOURCE_PIECE = 524288, PROBATION = 256, SOURCE_REFERENCE = 65536, NEARBY_BYTES = 4194304, SPARE_BYTES = 1048576, SIBLING_BYTES = 4194304, META_BYTES = 1024, WRITE_BYTES = 16777216;
const kindOf = v => !v || typeof v !== 'object' || v.t !== undefined ? undefined
  : Array.isArray(v.a) ? 'a' : Array.isArray(v.o) ? 'o' : Array.isArray(v.m) ? 'm' : Array.isArray(v.s) ? 's' : undefined;
const parsed = new WeakMap();
function valueOf(entry, raw) {
  if (entry.metaLength === undefined) return {meta: entry.meta, bytes: raw};
  const known = parsed.get(raw);
  if (known && known.entry === entry) return known.value;
  if (!Number.isSafeInteger(entry.metaLength) || entry.metaLength < 2 || entry.metaLength > raw.length || !['a', 'o', 'm', 's'].includes(entry.kind))
    invalid('Invalid journal value.');
  const head = raw.subarray(0, entry.metaLength), meta = parseData(head instanceof Pieces ? head.slice(0) : head);
  if (kindOf(meta?.v) !== entry.kind) invalid('Invalid journal value.');
  const value = {meta, bytes: raw.subarray(entry.metaLength)};
  parsed.set(raw, {entry, value});
  return value;
}

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
  for (const {entry, bytes: plain, alone} of pending) {
    const slices = [], bytes = plain;
    if (alone) await flush();
    for (let at = 0; at < bytes.length;) {
      const take = Math.min(bytes.length - at, MAX_PART_BYTES - size);
      page.push({bytes: bytes.subarray(at, at + take), slices}); size += take; at += take;
      if (size === MAX_PART_BYTES) await flush();
    }
    if (alone) await flush();
    entry.bytes = slices;
  }
  await flush();
}
const slicesOf = entry => {
  if (!Array.isArray(entry.bytes) || entry.bytes.some(s => !Array.isArray(s) || s.length !== 3 || !Number.isSafeInteger(s[1]) ||
      !Number.isSafeInteger(s[2]) || s[1] < 0 || s[2] < 0 || s[1] + s[2] > MAX_PART_BYTES)) invalid('Invalid journal value pages.');
  return entry.bytes;
};
async function loadBytes(io, entries) {
  const pages = new Map(), values = entries.map(entry => {
    if (!Number.isSafeInteger(entry.length) || entry.length < 0) invalid('A journal value has the wrong length.');
    const value = {length: entry.length, spans: []};
    let at = 0;
    for (const [ref, from, length] of slicesOf(entry)) {
      refOf(ref);
      if (from + length > ref.length) invalid('A journal value lies outside its page.');
      const page = pages.get(ref.hash) ?? {ref, spans: []};
      if (page.ref.length !== ref.length) invalid('Part length does not match its digest.');
      page.spans.push({value, from, length, at}); pages.set(ref.hash, page); at += length;
    }
    if (at !== entry.length || !entry.length && slicesOf(entry).length) invalid('A journal value has the wrong length.');
    return value;
  });
  await prefetchParts(io, [...pages.values()].map(page => page.ref), async batch => {
    for (const ref of batch) {
      const bytes = await io.borrow(ref);
      for (const {value, from, length, at} of pages.get(ref.hash).spans) value.spans.push({at, bytes: bytes.subarray(from, from + length)});
    }
  });
  return values.map(({spans}) => {
    spans.sort((a, b) => a.at - b.at);
    return !spans.length ? new Uint8Array(0) : spans.length === 1 ? spans[0].bytes : new Pieces(spans.map(span => span.bytes));
  });
}
class Pieces {
  constructor(spans, length = spans.reduce((n, span) => n + span.length, 0)) { this.spans = spans; this.length = length; }
  #cut(from, to) {
    const out = [];
    let at = 0;
    for (const span of this.spans) {
      const end = at + span.length;
      if (end > from && at < to) out.push(span.subarray(Math.max(from - at, 0), Math.min(to, end) - at));
      at = end;
      if (at >= to) break;
    }
    return out;
  }
  subarray(from, to = this.length) {
    const out = this.#cut(from, to);
    return out.length === 1 ? out[0] : out.length ? new Pieces(out, to - from) : new Uint8Array(0);
  }
  slice(from, to = this.length) {
    const bytes = new Uint8Array(to - from);
    let at = 0;
    for (const span of this.#cut(from, to)) { bytes.set(span, at); at += span.length; }
    return bytes;
  }
}

export function createJournalStepper({id, build, normalize, open, run, verify, eager = false, tools = {}, straight: ordinary}) {
  ordinary ??= open && ((plan, data, description, signal) => drainPlain(open(plan, data, description, true), signal));
  const toolOf = name => { if (!Object.hasOwn(tools, name)) invalid('A step names a journal tool this build has not.'); return tools[name]; };
  return createStepper({id, build, normalize,
    start: (plan, source) => ({journal: {}, plan, source, hot: []}),
    refs: state => Object.values(state?.journal ?? {}).flatMap(entry => entry.passed || !Array.isArray(entry.bytes) ? [] : entry.bytes.map(slice => slice[0])),
    async step(state, host) {
      const {journal, plan, source: description, hot = [], tried = false, costs: lastCosts = {}} = state;
      const io = host, callReads = host.reads ?? Infinity, initialReads = io.callsRead(), hostReads = () => io.callsRead() - initialReads;
      let capped = false;
      if (!journal || typeof journal !== 'object' || Array.isArray(journal) || !plan || !description || !Array.isArray(hot) ||
          !hot.every(p => typeof p === 'string') || typeof tried !== 'boolean' || !lastCosts || typeof lastCosts !== 'object' || Array.isArray(lastCosts) ||
          !Object.values(lastCosts).every(ms => Number.isFinite(ms) && ms >= 0))
        invalid('Invalid journal state.');
      const started = now(), budget = io.budgetMs ?? plan.budgetMs ?? 20;
      const holdLimit = 2 * description.byteLength + HOLD_BYTES;
      let peak = 0, lastHeld = 0;
      const holding = (adding = 0) => {
        const seen = new Set();
        let held = adding;
        const add = view => { const buffer = view?.buffer; if (buffer && !seen.has(buffer)) { seen.add(buffer); held += buffer.byteLength; } };
        const addRaw = raw => { if (raw instanceof Pieces) raw.spans.forEach(add); else add(raw); };
        if (source) add(source); else for (const r of ranges) add(r.bytes);
        for (const raw of loaded.values()) addRaw(raw);
        for (const {buffers} of kept.values()) for (const buffer of buffers) if (buffer && !seen.has(buffer)) { seen.add(buffer); held += buffer.byteLength; }
        for (const {bytes} of pending) if (bytes) addRaw(bytes);
        lastHeld = held - adding;
        if (held > peak) peak = held;
        if (held > holdLimit) throw fault('JXL_MEMORY', `A resumable call held ${held} bytes, over its bound of ${holdLimit}.`);
      };
      const straight = !tried && !Object.keys(journal).length && typeof io.straight === 'function' &&
        await io.straight(await io.readSource(0, Math.min(description.byteLength, STRAIGHT_HEAD)), budget);
      const loaded = new Map(), round = x => +x.toFixed(1);
      const finished = new Set();
      const kept = new Map();
      const hold = (p, buffers) => {
        if (!buffers?.length || kept.has(p)) return;
        kept.set(p, {buffers, sums: buffers.map(checksum)});
        lastHeld += buffers.reduce((n, buffer) => n + (buffer?.byteLength ?? 0), 0);
        if (lastHeld > holdLimit) holding();
      };
      const unchanged = p => {
        const k = kept.get(p);
        if (k && k.buffers.every((buffer, i) => checksum(buffer) === k.sums[i])) return k.buffers;
        kept.delete(p);
        return null;
      };
      const pending = [], used = new Set(), missed = new Set(), misses = new Map();
      const pendingOf = new Map(), unpend = entry => {
        const item = pendingOf.get(entry);
        if (!item) return;
        pendingBytes -= item.bytes.length; if (entry.carry) carriedBytes -= item.bytes.length; item.bytes = null; pendingOf.delete(entry);
      };
      const touched = new Set(), paths = new WeakMap();
      let pendingBytes = 0, carriedBytes = 0, readFull = false, wholeBytes = 0;
      const missedRanges = [];
      let longest = ['', 0], replay = null, attempted = 0, decodeMs = 0;
      let frontier = null, sourceMissed = false, replayMissed = false, warming = false;
      const costs = new Map(Object.entries(lastCosts));
      let fresh = 0, saveMs = 0, loadMs = 0, sourceMs = 0, readBytes = 0, sourceBytes = 0, attempts = 0, answered = 0, final = null, fileParts = null, source = null;
      const ranges = [];
      const readRanges = async spans => {
        const t0 = now();
        for (const [from, to] of spans) {
          if (ranges.some(r => r.at <= from && to <= r.at + r.bytes.length)) continue;
          const touching = ranges.filter(r => r.at <= to && from <= r.at + r.bytes.length);
          const at = Math.min(from, ...touching.map(r => r.at)), end = Math.max(to, ...touching.map(r => r.at + r.bytes.length));
          const bytes = new Uint8Array(end - at);
          let cursor = at;
          const fill = async (from, to) => {
            for (let at0 = from; at0 < to; at0 += SOURCE_PIECE) {
              const got = await io.readSource(at0, Math.min(SOURCE_PIECE, to - at0)); bytes.set(got, at0 - at); sourceBytes += got.length;
            }
          };
          for (const r of touching.sort((x, y) => x.at - y.at)) {
            if (r.at > cursor) await fill(cursor, r.at);
            bytes.set(r.bytes, r.at - at); cursor = Math.max(cursor, r.at + r.bytes.length);
          }
          if (cursor < end) await fill(cursor, end);
          for (const r of touching) ranges.splice(ranges.indexOf(r), 1);
          ranges.push({at, bytes});
        }
        sourceMs += now() - t0;
      };
      const read = async wanted => {
        if (wanted.includes('source') && !source) {
          if (!warming) { sourceMissed = true; if (replay === null) replayMissed = true; }
          holding(description.byteLength);
          const t0 = now();
          source = await io.readSource(0, description.byteLength);
          sourceMs += now() - t0; sourceBytes += source.length; if (!warming) wholeBytes = source.length; ranges.length = 0;
        }
        const spans = source ? [] : wanted.filter(p => p.startsWith('source:')).map(p => p.split(':').slice(1).map(Number));
        if (spans.length) await readRanges(spans);
        const paths = wanted.filter(p => !p.startsWith('source') && journal[p] && !journal[p].passed && !loaded.has(p));
        if (!paths.length) return;
        const l0 = now(), entries = paths.map(p => journal[p]);
        holding(entries.reduce((n, entry) => n + (Number.isSafeInteger(entry.length) ? entry.length : 0), 0));
        const values = await loadBytes(io, entries);
        for (const [i, p] of paths.entries()) { loaded.set(p, values[i]); readBytes += entries[i].length; }
        holding();
        loadMs += now() - l0;
      };
      const whole = typeof eager === 'function' ? eager(description) : eager;
      const sourceStage = hot.find(p => p.startsWith('source@'))?.slice(7), prefixSource = sourceStage === '*';
      const sticky = hot.filter(p => p[0] === '!').map(p => p.slice(1)), probation = new Set(hot.filter(p => p[0] === '~').map(p => p.slice(1)));
      const warm = [...(whole && description.byteLength <= NEARBY_BYTES || sourceStage !== undefined ? ['source'] : []),
        ...hot.filter(p => journal[p] || p.startsWith('source:')), ...sticky.filter(p => journal[p])];
      warming = true;
      if (straight) await read(['source']);
      if (straight && ordinary && !plan.verify) {
        const controller = new AbortController(), signal = controller.signal, deadline = started + budget;
        let passed = false;
        Object.defineProperty(signal, 'aborted', {get: () => {
          if (!passed && (now() >= deadline || io.signal?.aborted)) { passed = true; controller.abort(io.signal?.aborted ? io.signal.reason : STOP); }
          return passed;
        }});
        let made;
        try { made = await ordinary(plan, source, description, signal, async ref => { await prefetchParts(io, [ref]); return io.borrow(ref); }); }
        catch (error) {
          if (!passed || io.signal?.aborted) throw error;
          return {state: {...state, tried: true}, work: {phase: 'straight', stepMs: +(now() - started).toFixed(1)}, reads: [], yield: true};
        }
        const bytes = made instanceof Uint8Array ? made : made?.bytes, facts = made instanceof Uint8Array ? null : made?.facts ?? null;
        if (!(bytes instanceof Uint8Array)) invalid('The steps returned no file.');
        return {state: {journal: {}, plan, source: description, hot: []}, work: {phase: 'straight', stepMs: +(now() - started).toFixed(1)},
          output: bytes.length ? bytes : null, result: {schema: 1, length: bytes.length, facts}};
      }
      else if (warm.length) await read(warm);
      warming = false;
      holding();
      const warmBytes = Math.max(readBytes + sourceBytes, io.bytesRead());
      while (true) {
        attempts++; replay = null; attempted = now();
        const missing = new Set(), miss = p => missing.add(p), input = source ?? lazySource(description.byteLength, miss, ranges);
        const owned = new Map(), refs = new Map(), sums = new Map();
        const known = {get: (buffer, from, to) => {
          const ref = refs.get(buffer);
          return ref && ref[2] <= from && to <= ref[3] && (ref[0] === 'source' ? to - from >= SOURCE_REFERENCE : sums.get(buffer) === checksum(buffer)) ? ref : undefined;
        }};
        const sourceRange = (from, to) => {
          const r = ranges.find(r => r.at <= from && to <= r.at + r.bytes.length);
          return r ? r.bytes.subarray(from - r.at, to - r.at) : null;
        };
        const resolve = (p, i) => {
          if (p === 'source') return i !== 0 ? undefined : source ? source.buffer : null;
          if (!owned.has(p)) {
            if (!journal[p]) invalid('A journal value refers to a missing value.');
            const raw = loaded.get(p);
            if (!raw) return null;
            const {meta, bytes} = valueOf(journal[p], raw);
            const given = bytes ? unchanged(p) : null;
            if (bytes && !given && lastHeld + bytes.length > holdLimit) holding(bytes.length);
            const decoded = decodeValue(meta, bytes, resolve, p, miss, sourceRange, undefined, given);
            if (bytes) hold(p, decoded.buffers);
            register(p, decoded.buffers);
          }
          return owned.get(p)?.[i] ?? null;
        };
        const register = (p, buffers, spans = null) => {
          owned.set(p, buffers);
          const known = kept.get(p)?.buffers === buffers ? kept.get(p).sums : null;
          buffers?.forEach((buffer, i) => { refs.set(buffer, [p, i, spans ? spans[i][0] : 0, spans ? spans[i][1] : buffer.byteLength]); sums.set(buffer, known ? known[i] : checksum(buffer)); });
        };
        if (source) refs.set(source.buffer, ['source', 0, 0, source.byteLength]);
        const stack = [{path: '', children: 0}];
        let stopped = false;
        const request = async value => {
          if (missing.size || stopped) throw STOP;
          if (straight) {
            if (now() - started >= budget) { stopped = true; throw STOP; }
            if (value.unit !== undefined) { stack.push({name: value.unit}); return undefined; }
            if (stack.pop()?.name !== (value.unitDone ?? value.unitFailed)) invalid('Unbalanced unit steps.');
            return undefined;
          }
          if (value.unit !== undefined) {
            if (readFull && !value.tail && !stack.some(frame => frame.whole)) { stopped = true; throw STOP; }
            const top = stack.at(-1), path = (top.path ? top.path + '.' : '') + top.children++, entry = journal[path];
            if (entry) {
              if (entry.name !== value.unit || !!entry.carry !== !!value.carry) invalid('The journal does not match this operation\'s steps.');
              if (entry.passed) { answered++; return {[SAVED]: PASSED}; }
              const raw = loaded.get(path) ?? null;
              if (entry.metaLength !== undefined && !raw) {
                if (value.answer !== undefined) { miss(path); throw STOP; }
                answered++; const lazy = lazyValue(entry.kind, () => miss(path)); paths.set(lazy, path); return {[SAVED]: lazy};
              }
              const {meta, bytes} = valueOf(entry, raw);
              const given = bytes ? unchanged(path) : null;
              if (bytes && !given && lastHeld + bytes.length > holdLimit) holding(bytes.length);
              const d0 = now(), decoded = decodeValue(meta, bytes, resolve, path, miss, sourceRange, (piece, used) => request.touched(piece, used), given);
              if (bytes) hold(path, decoded.buffers);
              if (raw) used.add(path);
              if (!entry.carry) register(path, bytes ? decoded.buffers : null);
              decodeMs += now() - d0;
              answered++;
              const answer = value.answer !== undefined ? toolOf(value.answer).answer(decoded.value) : decoded.value;
              if (answer !== null && typeof answer === 'object') paths.set(answer, path);
              return {[SAVED]: answer};
            }
            if (fresh && !value.tail && !stack.some(frame => frame.whole) &&
                (pendingBytes - carriedBytes >= WRITE_BYTES || now() - started - sourceMs + (costs.get(value.unit) ?? longest[1]) >= budget)) { stopped = true; throw STOP; }
            if (value.tail) readFull = false;
            if (replay === null) replay = now() - attempted;
            frontier = top.path;
            stack.push({path, children: 0, name: value.unit, carry: !!value.carry, whole: !!value.whole, cold: !!value.cold, alone: !!value.alone, started: now()});
            return undefined;
          }
          const frame = stack.pop(), ran = now() - frame.started;
          if (frame?.name && !frame.whole) costs.set(frame.name, ran);
          if (ran > longest[1]) longest = [stack.map(f => f.name).filter(Boolean).concat(frame.name).join('/'), +ran.toFixed(1)];
          if (!frame?.name || frame.name !== (value.unitDone ?? value.unitFailed)) invalid('Unbalanced unit steps.');
          if (value.unitFailed !== undefined) return undefined;
          const inside = frame.path + '.';
          const saving = typeof value.save === 'function' ? value.save(value.value)
            : value.save ? toolOf(value.save.tool).save(value.value, value.save.extra?.(value.value)) : value.value;
          const w0 = now(), made = encodeValue(saving,
            {get: (buffer, from, to) => { const ref = known.get(buffer, from, to); return ref && !(typeof ref[0] === 'string' && ref[0].startsWith(inside)) ? ref : undefined; }});
          if (frame.children) {
            for (const p of Object.keys(journal)) if (p.startsWith(inside) && !made.refers.has(p)) { unpend(journal[p]); delete journal[p]; owned.delete(p); loaded.delete(p); kept.delete(p); }
            for (const [buffer, ref] of refs) if (typeof ref[0] === 'string' && ref[0].startsWith(inside)) refs.delete(buffer);
          }
          const {meta, bytes, buffers, spans} = made;
          if (frame.carry) {
            const parent = frame.path.slice(0, frame.path.lastIndexOf('.') + 1), at = +frame.path.slice(parent.length);
            for (let i = 0; i < at; i++) {
              const p = parent + i, before = journal[p];
              if (before?.carry && !before.passed && before.name === frame.name) { unpend(before); journal[p] = {name: before.name, carry: true, passed: true}; owned.delete(p); loaded.delete(p); kept.delete(p); }
            }
          }
          const kind = kindOf(meta.v), text = kind !== undefined ? JSON.stringify(meta) : null, own = text !== null && text.length > META_BYTES;
          const metaBytes = own ? writeData(meta, text) : null, plain = own ? joinedBytes([metaBytes, bytes]) : bytes;
          const entry = journal[frame.path] = {name: frame.name, ...(frame.carry && {carry: true}), ...(frame.cold && {cold: true}),
            ...(own ? {kind, metaLength: metaBytes.length} : {meta}), length: plain.length, bytes: []};
          if (own) parsed.set(plain, {entry, value: {meta, bytes}});
          const item = {entry, bytes: plain, alone: frame.alone};
          pending.push(item); pendingOf.set(entry, item);
          pendingBytes += plain.length; if (frame.carry) carriedBytes += plain.length;
          loaded.set(frame.path, plain);
          if (frame.carry) owned.set(frame.path, buffers); else register(frame.path, buffers, spans);
          saveMs += now() - w0; fresh++;
          if (!stack.some(frame => frame.whole)) readFull = Math.max(readBytes + sourceBytes, io.bytesRead()) - warmBytes - wholeBytes >= READ_BATCH_BYTES;
          holding();
          return undefined;
        };
        let result, parts = null, abandoned = false;
        request.tools = tools;
        journalProtocol(request);
        request.part = async ref => {
          if (hostReads() >= callReads) { stopped = true; throw STOP; }
          await prefetchParts(io, [ref]);
          return io.borrow(ref);
        };
        request.join = pieces => joinedBytes(pieces, request.touched);
        request.done = value => {
          const path = paths.get(value) ?? unreadPath(value) ?? refs.get(value?.buffer)?.[0];
          if (path === undefined || !journal[path]) return;
          finished.add(path); touched.delete(path); loaded.delete(path); kept.delete(path);
        };
        request.touched = (value, used = true) => { const path = paths.get(value) ?? unreadPath(value) ?? refs.get(value?.buffer)?.[0]; if (path !== undefined) used ? touched.add(path) : touched.delete(path); };
        try {
          result = await (run ? run(plan, input, description, request) : driveSteps(open(plan, input, description), request));
          if (plan.verify) {
            if (typeof verify !== 'function') invalid('This operation has no resumable verification.');
            result = await verify(result, plan, input, description, request, host);
          }
          const file = result instanceof Uint8Array ? result : result?.bytes;
          if (journalFact(file, JOIN)) parts = await writeParts(file, request, io);
        }
        catch (error) { if (!missing.size && !stopped) throw error; }
        if (missing.size) abandoned = true;
        const stop = !abandoned && stopped;
        if (abandoned) {
          let extra = 0;
          for (const p of [...missing]) {
            if (!journal[p]) continue;
            missed.add(p);
            const named = journal[p].name;
            if ((misses.get(named) ?? 0) < 1) { misses.set(named, 1); continue; }
            const parent = p.slice(0, p.lastIndexOf('.') + 1), name = journal[p].name;
            for (const [q, e] of Object.entries(journal)) {
              if (missing.has(q) || loaded.has(q) || e.passed || e.name !== name || !q.startsWith(parent) || q.slice(parent.length).includes('.')) continue;
              if ((extra += e.length) > SIBLING_BYTES) break;
              missing.add(q);
            }
          }
          for (const p of missing) if (p.startsWith('source:')) missedRanges.push(p);
          if (hostReads() >= callReads) { capped = true; final = null; break; }
          const ahead = missedRanges.length > 1 ? Math.min(SOURCE_AHEAD, 32768 * 2 ** Math.min(missedRanges.length, 16)) : 0;
          await read([...missing].map(p => {
            if (!ahead || !p.startsWith('source:')) return p;
            const [from, to] = p.split(':').slice(1).map(Number);
            return `source:${from}:${Math.min(description.byteLength, Math.max(to, from + ahead))}`;
          }));
          holding();
          continue;
        }
        final = stop ? null : result; fileParts = parts;
        break;
      }
      if (straight && final === null)
        return {state: {...state, tried: true}, work: {phase: 'straight', stepMs: +(now() - started).toFixed(1), attempts}, reads: [], yield: true};
      const p0 = now(), pathOf = new Map(Object.entries(journal).map(([p, e]) => [e, p]));
      if (final === null) await savePages(io, pending.filter(({entry}) => pathOf.has(entry)));
      const pageMs = now() - p0;
      const work = {phase: 'journal', stepMs: +(now() - started).toFixed(1), decodeMs: +decodeMs.toFixed(1), longest, replayMs: +(replay ?? now() - attempted).toFixed(1), attempts, answered, fresh, entries: Object.keys(journal).length, readBytes, sourceBytes,
        sourceMs: round(sourceMs), loadMs: round(loadMs), saveMs: round(saveMs), pageMs: round(pageMs), savedBytes: pending.reduce((n, {bytes}) => n + (bytes?.length ?? 0), 0),
        hold: {peak, limit: holdLimit}};
      globalThis[OBSERVE]?.(work);
      if (final !== null) {
        const bytes = final instanceof Uint8Array ? final : final?.bytes, facts = final instanceof Uint8Array ? null : final?.facts ?? null;
        if (!(bytes instanceof Uint8Array)) invalid('The steps returned no file.');
        return {state: {journal: {}, plan, source: description, hot: []}, work, output: bytes.length ? bytes : null, ...(fileParts && {outputRefs: fileParts}),
          result: {schema: 1, length: bytes.length, facts, ...(plan.verify && {verification: final.verification})}};
      }
      const keep = new Set([...missed, ...touched]);
      if (capped) for (const p of loaded.keys()) if (journal[p] && !journal[p].passed) keep.add(p);
      for (const {entry} of pending) if (pathOf.has(entry) && !entry.cold) keep.add(pathOf.get(entry));
      const siblings = p => {
        const parent = p.slice(0, p.lastIndexOf('.') + 1), name = journal[p].name;
        return Object.keys(journal).filter(q => journal[q].name === name && q.startsWith(parent) && !q.slice(parent.length).includes('.'))
          .sort((a, b) => +a.slice(parent.length) - +b.slice(parent.length));
      };
      for (const p of hot) if (used.has(p) && journal[p] && !journal[p].passed && !journal[p].cold && siblings(p).at(-1) === p) keep.add(p);
      const series = new Map();
      for (const p of missed) if (journal[p]) { const list = siblings(p), key = list[0]; series.set(key, {list, at: Math.max(series.get(key)?.at ?? -1, list.indexOf(p)), count: (series.get(key)?.count ?? 0) + 1}); }
      for (const {list, at, count} of series.values()) for (const next of list.slice(at + 1, at + 1 + count)) if (!journal[next].passed) keep.add(next);
      let spare = 0;
      const pageBytes = p => slicesOf(journal[p]).reduce((n, [ref]) => n + ref.length, 0);
      for (const p of keep) if (journal[p] && !journal[p].passed) spare += pageBytes(p);
      const fill = Math.min(READ_BATCH_BYTES, Math.max(SPARE_BYTES, (replay ?? now() - attempted) * 262144));
      for (const p of [...used].reverse()) if (!keep.has(p) && journal[p] && !journal[p].passed && !journal[p].cold && (spare += pageBytes(p)) <= fill) keep.add(p);
      const live = p => journal[p] && !journal[p].passed;
      const stays = new Set([...sticky, ...[...missed].filter(p => probation.has(p))].filter(p => live(p) && !journal[p].cold));
      const remembered = [...new Set([...hot.filter(p => journal[p] && !keep.has(p)), ...probation])].filter(p => live(p) && !stays.has(p) && !missed.has(p) && !keep.has(p)).slice(0, PROBATION);
      const stay = prefixSource || replayMissed ? '*' : description.byteLength > NEARBY_BYTES ? null
        : sourceMissed ? frontier : source && sourceStage !== undefined && frontier === sourceStage ? sourceStage : null;
      let nearbyBytes = 0;
      const nearby = stay !== null || source ? [] : [...missedRanges.map(p => {
        const [from, to] = p.split(':').slice(1).map(Number);
        return [from, Math.min(description.byteLength, to + (to - from))];
      }), ...ranges.filter(r => r.used).map(r => r.used)]
        .filter(([from, to]) => (nearbyBytes += to - from) <= NEARBY_BYTES).map(([from, to]) => `source:${from}:${to}`);
      for (const p of finished) if (!missed.has(p)) { keep.delete(p); stays.delete(p); }
      const next = {journal, plan, source: description, ...(tried && {tried}), costs: Object.fromEntries([...costs].map(([name, ms]) => [name, Math.round(ms)])), hot: [...(stay !== null ? ['source@' + stay] : []), ...nearby, ...[...keep].filter(p => live(p) && !stays.has(p)),
        ...[...stays].map(p => '!' + p), ...remembered.map(p => '~' + p)]};
      const reads = [];
      let batch = 0;
      for (const ref of new Map([...stays, ...next.hot.filter(p => journal[p])].flatMap(p => slicesOf(journal[p]).map(([ref]) => [ref.hash, ref]))).values()) {
        if (reads.length === READS || batch + ref.length > READ_BATCH_BYTES) break;
        reads.push(ref); batch += ref.length;
      }
      return {state: next, work, reads, yield: true};
    }});
}
