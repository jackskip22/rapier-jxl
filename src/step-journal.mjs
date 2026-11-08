// SPDX-License-Identifier: MIT
import {fault} from './fault.mjs';

export const SAVED = Symbol.for('rapier-jxl.journal.saved');
const UNREAD = Symbol.for('rapier-jxl.journal.unread');
export const JOURNAL = Symbol.for('rapier-jxl.journal');
export const JOURNAL_FILE = Symbol.for('rapier-jxl.journal.file');
export const JOIN = Symbol.for('rapier-jxl.journal.join'), FACTS = Symbol.for('rapier-jxl.journal.facts');
const registry = key => typeof key === 'symbol' && Symbol.keyFor(key)?.startsWith('rapier-jxl.journal');
const bytesView = (known, all, byte) => new Proxy(new Uint8Array(0), {
  get: (_, key) => Object.hasOwn(known, key) ? known[key] : key === Symbol.toStringTag ? 'Uint8Array' : registry(key) ? undefined
    : byte && typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key) ? byte(Number(key))
    : (value => typeof value === 'function' ? value.bind(all()) : value)(Reflect.get(all(), key)),
  getPrototypeOf: () => Uint8Array.prototype,
  has: (_, key) => Reflect.has(all(), key), ownKeys: () => Reflect.ownKeys(all()),
  getOwnPropertyDescriptor: (_, key) => Reflect.getOwnPropertyDescriptor(all(), key),
  set: (_, key, value) => Reflect.set(all(), key, value)});
const byteReader = (length, subarray) => {
  let start = -1, part;
  return at => {
    if (at >= length) return undefined;
    if (!part || at < start || at >= start + part.length) { start = Math.floor(at / 65536) * 65536; part = subarray(start, Math.min(length, start + 65536)); }
    return part[at - start];
  };
};
export const journalFact = (value, key) => value !== null && typeof value === 'object' && value[UNREAD] !== true ? value[key] : undefined;
export const journalRequest = value => value !== null && typeof value === 'object' &&
  (Object.hasOwn(value, 'unit') || Object.hasOwn(value, 'unitDone') || Object.hasOwn(value, 'unitFailed'));
const ACTIVE = Symbol.for('rapier-jxl.journal.active');
export function journalNext(steps, reply, journal) {
  const outer = globalThis[ACTIVE];
  globalThis[ACTIVE] = journal;
  try { return steps.next(reply); } finally { globalThis[ACTIVE] = outer; }
}
export const journalJoin = pieces => globalThis[ACTIVE].join(pieces);
export const journalTool = name => globalThis[ACTIVE].tools[name];
export const journalDone = value => { globalThis[ACTIVE]?.done?.(value); };
export const journaling = () => !!globalThis[ACTIVE] && !globalThis[ACTIVE].plain;
export const plainJournal = signal => ({plain: true, *step(name, run, save, kind) {
  if (signal.aborted) throw signal.reason;
  return kind === 2 ? yield* run() : run();
}});
export function* unit(name, run, save, tail = false, cold = false) {
  if (!globalThis[ACTIVE]) return run();
  return yield* globalThis[ACTIVE].step(name, run, save, 0, tail, cold);
}
export const PASSED = Symbol.for('rapier-jxl.journal.passed');
export function* carried(name, run, save, tail = false, cold = false) {
  if (!globalThis[ACTIVE]) return run();
  return yield* globalThis[ACTIVE].step(name, run, save, 1, tail, cold);
}
export function* stage(name, steps, save, whole = false, cold = false) {
  if (!globalThis[ACTIVE]) return yield* steps();
  return yield* globalThis[ACTIVE].step(name, steps, save, 2, whole, cold);
}
export function journalProtocol(journal) { journal.step = savedStep; return journal; }
function* savedStep(name, run, save, kind, flag, cold) {
  const request = {unit: name};
  if (kind === 1) request.carry = true;
  if (kind === 2) {
    if (flag) request.whole = true;
    if (save?.tool) request.answer = save.tool;
  } else if (flag) request.tail = true;
  if (cold) request.cold = true;
  const saved = yield request;
  if (saved && Object.hasOwn(saved, SAVED)) return saved[SAVED];
  let value;
  try { value = kind === 2 ? yield* run() : run(); }
  catch (error) { yield {unitFailed: name}; throw error; }
  yield {unitDone: name, value, save};
  return value;
}

export async function journaled(journal, name, run) {
  if (!journal) return run();
  const saved = await journal({unit: name});
  if (saved && Object.hasOwn(saved, SAVED)) return saved[SAVED];
  let value;
  try { value = await run(); } catch (error) { await journal({unitFailed: name}); throw error; }
  await journal({unitDone: name, value});
  return value;
}

const TYPED = ['Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array',
  'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array'];
const typedProto = Object.getPrototypeOf(Uint8Array.prototype);
const invalid = message => fault('JXL_INPUT', message);

const SPAN = Symbol.for('rapier-jxl.journal.span');
const SLICE = Symbol.for('rapier-jxl.journal.slice');
const spanOf = value => value !== null && typeof value === 'object' ? value[SPAN] : undefined;
const spanInfo = (type, ref, offset, length) => Object.freeze({type, ref: Object.freeze([...ref]), offset, length});
export class Unread extends Error { get [UNREAD]() { return true; } }
const READ = JOIN;
export const readAll = values => (readEach(values.map(value => () => value?.[READ])), values);
export function readEach(runs) {
  let unread = null;
  const out = runs.map(run => { try { return run(); } catch (error) { if (error?.[UNREAD] !== true) throw error; unread ??= error; } });
  if (unread) throw unread;
  return out;
}
function lazyArray(Type, ref, offset, length, miss) {
  const fail = () => { miss(ref[0]); throw new Unread('An unread journal value was used.'); };
  const span = spanInfo(TYPED.indexOf(Type.name), ref, offset, length);
  const proxy = new Proxy(new Type(0), {
    get: (_, key) => key === UNREAD ? true : key === SPAN ? span : key === SLICE ? (begin, end) => sliceView(proxy, begin, end) : fail(),
    set: fail, has: fail, ownKeys: fail, getOwnPropertyDescriptor: fail, defineProperty: fail, deleteProperty: fail,
    getPrototypeOf: () => Type.prototype});
  return proxy;
}

export function lazySource(length, miss, ranges = [], offset = 0, sourceRange = null) {
  const known = {length, byteLength: length, byteOffset: 0, BYTES_PER_ELEMENT: 1, constructor: Uint8Array};
  const span = spanInfo(TYPED.indexOf('Uint8Array'), ['source', 0], offset, length);
  const fail = () => { miss(offset || sourceRange ? `source:${offset}:${offset + length}` : 'source'); throw new Unread('An unread source was used.'); };
  const at = (value, fallback) => {
    if (value === undefined) return fallback;
    const n = Math.trunc(Number(value)) || 0;
    return n < 0 ? Math.max(0, length + n) : Math.min(length, n);
  };
  const subarray = (begin, end) => {
    const from = at(begin, 0), to = Math.max(from, at(end, length));
    if (sourceRange) {
      const view = sourceRange(offset + from, offset + to); if (view) return view;
      if (from === to) return new Uint8Array(0);
      miss(`source:${offset + from}:${offset + to}`); throw new Unread('An unread source range was used.');
    }
    const range = ranges.find(r => r.at <= offset + from && offset + to <= r.at + r.bytes.length);
    if (range) { range.used = [Math.min(range.used?.[0] ?? offset + from, offset + from), Math.max(range.used?.[1] ?? offset + to, offset + to)]; return range.bytes.subarray(offset + from - range.at, offset + to - range.at); }
    if (from === to) return new Uint8Array(0);
    miss(`source:${offset + from}:${offset + to}`);
    throw new Unread('An unread source range was used.');
  };
  const byte = sourceRange || offset ? byteReader(length, subarray) : null;
  const proxy = new Proxy(new Uint8Array(0), {
    get: (_, key) => key === UNREAD ? true : key === SPAN ? span : key === SLICE ? (begin, end) => sliceView(proxy, begin, end) : key === 'subarray' ? subarray : Object.hasOwn(known, key) ? known[key]
      : key === Symbol.toStringTag ? 'Uint8Array' : registry(key) ? undefined
        : byte && typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key) ? byte(Number(key)) : fail(),
    set: fail, has: fail, ownKeys: fail, getOwnPropertyDescriptor: fail, defineProperty: fail, deleteProperty: fail,
    getPrototypeOf: () => Uint8Array.prototype});
  return proxy;
}
export function lazyValue(kind, miss) {
  const target = kind === 'a' ? [] : kind === 'm' ? new Map() : kind === 's' ? new Set() : {}, proto = Object.getPrototypeOf(target);
  const fail = () => { miss(); throw new Unread('An unread journal value was used.'); };
  return new Proxy(target, {get: (_, key) => key === UNREAD ? true : key === SPAN || key === SLICE ? undefined : fail(), set: fail, has: fail, ownKeys: fail,
    getOwnPropertyDescriptor: fail, defineProperty: fail, deleteProperty: fail, getPrototypeOf: () => proto});
}
export const unread = value => value?.[UNREAD] === true;
function piecedBytes(list, rowBytes, rows, touched, known, scale = 1) {
  const length = rowBytes * rows, now = new Set();
  let whole = null;
  const covering = (x, y, w, h) => list.filter(([, px, py, pw, ph]) => px < x + w && x < px + pw && py < y + h && y < py + ph);
  const read = (x, y, w, h, copy) => {
    const cover = covering(x, y, w, h), pieces = cover.map(([piece]) => piece);
    for (const piece of pieces) { now.add(piece); touched(piece); }
    const spans = rows === 1 ? readEach(cover.map(([piece, px, , pw]) => () => piece.subarray(Math.max(0, x - px), Math.min(pw, x + w - px)))) : null;
    if (!spans) readAll(pieces);
    if (spans && cover.length === 1 && !copy) return spans[0];
    const out = new Uint8Array(w * h);
    if (spans) { for (let i = 0; i < spans.length; i++) out.set(spans[i], Math.max(x, cover[i][1]) - x); return out; }
    for (const [piece, px, py, pw, ph] of cover) {
      const x0 = Math.max(x, px), x1 = Math.min(x + w, px + pw);
      for (let r = Math.max(y, py); r < Math.min(y + h, py + ph); r++) out.set(piece.subarray((r - py) * pw + x0 - px, (r - py) * pw + x1 - px), (r - y) * w + x0 - x);
    }
    return out;
  };
  const all = () => whole ??= read(0, 0, rowBytes, rows, true);
  const at = (value, fallback) => value === undefined ? fallback : Math.min(length, Math.max(0, (n => n < 0 ? length + n : n)(Math.trunc(Number(value)) || 0)));
  const span = (begin, end) => {
    const from = at(begin, 0), to = Math.max(from, at(end, length));
    if (rows === 1) return [from, 0, to - from, 1, from, to];
    const y0 = Math.floor(from / rowBytes), y1 = Math.ceil(to / rowBytes);
    return [0, y0, rowBytes, y1 - y0, from - y0 * rowBytes, to - y0 * rowBytes];
  };
  const subarray = (begin, end) => {
    const [x, y, w, h, from, to] = span(begin, end);
    if (whole) return whole.subarray(y * rowBytes + from, y * rowBytes + to);
    if (!h || from === to) return new Uint8Array(0);
    const bytes = read(x, y, w, h);
    return rows === 1 ? bytes : bytes.subarray(from, to);
  };
  const rect = (x, y, w, h) => {
    x *= scale; w *= scale;
    if (!w || !h) return new Uint8Array(0);
    if (!whole) return read(x, y, w, h);
    const out = new Uint8Array(w * h);
    for (let r = 0; r < h; r++) out.set(whole.subarray((y + r) * rowBytes + x, (y + r) * rowBytes + x + w), r * w);
    return out;
  };
  const ahead = (begin, end, x = 0, w = rowBytes / scale) => {
    const [sx, y, sw, h] = span(begin, end), next = new Set(h && sw ? covering(rows === 1 ? sx : x * scale, y, rows === 1 ? sw : w * scale, h).map(([piece]) => piece) : []);
    for (const piece of now) if (!next.has(piece)) touched(piece, false);
    now.clear();
    for (const piece of next) touched(piece);
  };
  return bytesView({length, byteLength: length, byteOffset: 0, BYTES_PER_ELEMENT: 1, constructor: Uint8Array, subarray, rect, ahead, then: undefined,
    [UNREAD]: false, ...known}, all, byteReader(length, subarray));
}
const TILES = Symbol.for('rapier-jxl.journal.tiles');
export function tiledBytes(grid, width, height, rows, cols, touched = () => {}, facts = undefined) {
  const list = grid.flatMap((band, k) => band.map((piece, c) => [piece, c * cols * 4, k * rows, Math.min(cols, width - c * cols) * 4, Math.min(rows, height - k * rows)]));
  return piecedBytes(list, width * 4, height, touched, {[JOIN]: grid.flat(), [FACTS]: facts, [TILES]: true}, 4);
}
export const unreadPath = value => spanOf(value)?.ref[0];

export function joinedBytes(pieces, touched = () => {}, facts = undefined) {
  const sizes = pieces.map(piece => spanOf(piece)?.length ?? piece.length), list = [];
  let length = 0;
  pieces.forEach((piece, k) => { list.push([piece, length, 0, sizes[k], 1]); length += sizes[k]; });
  const view = piecedBytes(list, length, 1, touched, {sizes, [JOIN]: pieces, [FACTS]: facts,
    [SLICE]: (begin, end) => sliceView(view, begin, end)});
  return view;
}

export function sliceBytes(value, begin, end) {
  const slice = value[SLICE];
  return slice ? slice(begin, end) : value.subarray(begin, end);
}
function sliceView(value, begin = 0, end = undefined) {
  const saved = spanOf(value), length = saved?.length ?? value.length;
  const clamp = n => Math.max(0, Math.min(length, n < 0 ? length + Math.trunc(n) : Math.trunc(n)));
  begin = clamp(begin); end = Math.max(begin, end === undefined ? length : clamp(end));
  if (begin === end) return new Uint8Array(0);
  const pieces = journalFact(value, JOIN);
  if (pieces && !journalFact(value, TILES)) {
    const kept = []; let at = 0;
    for (let i = 0; i < pieces.length && at < end; i++) {
      const next = at + value.sizes[i];
      if (next > begin) kept.push(sliceBytes(pieces[i], Math.max(0, begin - at), Math.min(next, end) - at));
      at = next;
    }
    return joinedBytes(kept);
  }
  if (!saved) return value.subarray(begin, end);
  const size = end - begin, subarray = (from = 0, to = size) => value.subarray(begin + Math.max(0, from < 0 ? size + from : Math.min(size, from)),
    begin + Math.max(0, to < 0 ? size + to : Math.min(size, to)));
  const out = bytesView({length: size, byteLength: size, byteOffset: 0, BYTES_PER_ELEMENT: 1, constructor: Uint8Array,
    subarray, [UNREAD]: false, [SPAN]: Object.freeze({...saved, offset: saved.offset + begin, length: size}),
    [SLICE]: (begin, end) => sliceView(out, begin, end)},
  () => value.subarray(begin, end), byteReader(size, subarray));
  return out;
}

export function encodeValue(value, known = null) {
  const buffers = new Map(), list = [], views = [];
  const bufferId = buffer => {
    let id = buffers.get(buffer);
    if (id === undefined) { id = buffers.size; buffers.set(buffer, id); list.push({buffer, from: Infinity, to: 0}); }
    return id;
  };
  const seen = new Map(), refers = new Set();
  const walk = v => {
    if (v === null) return null;
    switch (typeof v) {
      case 'undefined': return {u: 1};
      case 'boolean': case 'string': return v;
      case 'number': return Number.isFinite(v) && !Object.is(v, -0) ? v : {n: Object.is(v, -0) ? '-0' : String(v)};
      case 'object': break;
      default: throw invalid(`A unit value cannot hold a ${typeof v}.`);
    }
    const lazy = spanOf(v), pieces = !lazy && journalFact(v, JOIN);
    if (lazy) { refers.add(lazy.ref[0]); return {t: lazy.type, r: lazy.ref, o: lazy.offset, l: lazy.length}; }
    if (!lazy && journalFact(v, TILES)) throw invalid('A unit value holds a picture\'s pixels.');
    if (pieces) return {j: pieces.map(walk)};
    if (ArrayBuffer.isView(v) && Object.getPrototypeOf(Object.getPrototypeOf(v)) === typedProto) {
      const k = TYPED.indexOf(v.constructor.name);
      if (k < 0) throw invalid('Unknown typed array in a unit value.');
      const ref = known?.get(v.buffer, v.byteOffset, v.byteOffset + v.byteLength);
      if (ref) return {t: k, r: [ref[0], ref[1]], o: v.byteOffset - ref[2], l: v.length};
      const id = bufferId(v.buffer), item = list[id], view = {t: k, b: id, o: v.byteOffset, l: v.length};
      item.from = Math.min(item.from, v.byteOffset); item.to = Math.max(item.to, v.byteOffset + v.byteLength);
      views.push(view);
      return view;
    }
    if (seen.has(v)) return {p: seen.get(v)};
    const proto = Object.getPrototypeOf(v);
    if (!Array.isArray(v) && !(v instanceof Map) && !(v instanceof Set) && proto !== Object.prototype && proto !== null)
      throw invalid(`A unit value holds a ${v.constructor?.name ?? 'class'} instance.`);
    seen.set(v, seen.size);
    if (Array.isArray(v)) return {a: v.map(walk)};
    if (v instanceof Map) return {m: [...v].map(([key, item]) => [walk(key), walk(item)])};
    if (v instanceof Set) return {s: [...v].map(walk)};
    return {o: Object.keys(v).map(key => [key, walk(v[key])])};
  };
  const v = walk(value);
  let size = 0;
  for (const item of list) { item.from = item.to ? item.from & ~7 : 0; item.at = size; size += item.to - item.from; }
  for (const view of views) view.o -= list[view.b].from;
  const meta = {v, buffers: list.map(item => [item.at, item.to - item.from])};
  const bytes = new Uint8Array(size);
  for (const {at, buffer, from, to} of list) bytes.set(new Uint8Array(buffer, from, to - from), at);
  return {meta, bytes, buffers: list.map(item => item.buffer), spans: list.map(item => [item.from, item.to]), refers};
}

export function decodeValue(meta, bytes, resolve = null, self = null, miss = null, sourceRange = null, touched = undefined, given = null) {
  if (!meta || !Array.isArray(meta.buffers)) throw invalid('Invalid unit value.');
  for (const entry of meta.buffers) if (!Array.isArray(entry) || entry.length !== 2 || !Number.isSafeInteger(entry[0]) ||
      !Number.isSafeInteger(entry[1]) || entry[0] < 0 || entry[1] < 0 || bytes && entry[0] + entry[1] > bytes.length) throw invalid('Invalid unit value.');
  const buffers = given ?? (bytes ? meta.buffers.map(([at, length]) => bytes.slice(at, at + length).buffer) : null);
  const made = [];
  const walk = v => {
    if (v === null || typeof v !== 'object') return v;
    if (v.u) return undefined;
    if (v.n !== undefined) return v.n === '-0' ? -0 : Number(v.n);
    if (v.t !== undefined) {
      const Type = globalThis[TYPED[v.t]];
      if (!Type || !Number.isSafeInteger(v.o) || !Number.isSafeInteger(v.l) || v.o < 0 || v.l < 0 || v.o % Type.BYTES_PER_ELEMENT ||
          (v.r ? !Array.isArray(v.r) || v.r.length !== 2 || typeof v.r[0] !== 'string' || !Number.isSafeInteger(v.r[1]) || v.r[1] < 0
            : !Number.isSafeInteger(v.b) || v.b < 0 || v.b >= meta.buffers.length)) throw invalid('Invalid unit value.');
      const buffer = v.r ? resolve?.(v.r[0], v.r[1]) : buffers ? buffers[v.b] : null;
      if (buffer === null && v.r?.[0] === 'source' && sourceRange) {
        const to = v.o + v.l * Type.BYTES_PER_ELEMENT, view = sourceRange(v.o, to);
        if (view) return view.byteOffset % Type.BYTES_PER_ELEMENT ? new Type(view.slice().buffer) : new Type(view.buffer, view.byteOffset, v.l);
        return Type === Uint8Array ? lazySource(v.l, miss, [], v.o, sourceRange)
          : lazyArray(Type, v.r, v.o, v.l, () => miss?.(`source:${v.o}:${to}`));
      }
      if (buffer === null) return lazyArray(Type, v.r ?? [self, v.b], v.o, v.l, miss);
      if (!buffer || v.o + v.l * Type.BYTES_PER_ELEMENT > buffer.byteLength) throw invalid('Invalid unit value.');
      return new Type(buffer, v.o, v.l);
    }
    if (v.j) {
      const pieces = Array.isArray(v.j) ? v.j.map(walk) : [];
      if (!pieces.length || !pieces.every(piece => piece instanceof Uint8Array)) throw invalid('Invalid unit value.');
      return joinedBytes(pieces, touched);
    }
    if (v.p !== undefined) { if (!Number.isSafeInteger(v.p) || v.p < 0 || v.p >= made.length) throw invalid('Invalid unit value.'); return made[v.p]; }
    if (v.a) { const a = []; made.push(a); for (const item of v.a) a.push(walk(item)); return a; }
    if (v.m) { const m = new Map(); made.push(m); for (const [key, item] of v.m) m.set(walk(key), walk(item)); return m; }
    if (v.s) { const set = new Set(); made.push(set); for (const item of v.s) set.add(walk(item)); return set; }
    if (v.o) {
      const o = {};
      made.push(o);
      for (const [key, item] of v.o) {
        if (key === '__proto__') Object.defineProperty(o, key, {value: walk(item), enumerable: true, writable: true, configurable: true});
        else o[key] = walk(item);
      }
      return o;
    }
    throw invalid('Invalid unit value.');
  };
  return {value: walk(meta.v), buffers};
}
