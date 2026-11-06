// SPDX-License-Identifier: MIT
import {fault} from './fault.mjs';

export const SAVED = Symbol.for('rapier-jxl.journal.saved');
const UNREAD = Symbol.for('rapier-jxl.journal.unread');
export const JOURNAL = Symbol.for('rapier-jxl.journal');
export const journalRequest = value => value !== null && typeof value === 'object' &&
  (Object.hasOwn(value, 'unit') || Object.hasOwn(value, 'unitDone') || Object.hasOwn(value, 'unitFailed'));
let journalDepth = 0;
export function journalNext(steps, reply) {
  journalDepth++;
  try { return steps.next(reply); } finally { journalDepth--; }
}
export function* unit(name, run, save) {
  if (!journalDepth) return run();
  const saved = yield {unit: name};
  if (saved && Object.hasOwn(saved, SAVED)) return saved[SAVED];
  let value;
  try { value = run(); } catch (error) { yield {unitFailed: name}; throw error; }
  yield {unitDone: name, value, save};
  return value;
}
export const PASSED = Symbol.for('rapier-jxl.journal.passed');
export function* carried(name, run, save) {
  if (!journalDepth) return run();
  const saved = yield {unit: name, carry: true};
  if (saved && Object.hasOwn(saved, SAVED)) return saved[SAVED];
  let value;
  try { value = run(); } catch (error) { yield {unitFailed: name}; throw error; }
  yield {unitDone: name, value, save};
  return value;
}
export function* stage(name, steps, save) {
  if (!journalDepth) return yield* steps();
  const saved = yield {unit: name};
  if (saved && Object.hasOwn(saved, SAVED)) return saved[SAVED];
  let value;
  try { value = yield* steps(); } catch (error) { yield {unitFailed: name}; throw error; }
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

const lazyArrays = new WeakMap();
export class Unread extends Error {}
function lazyArray(Type, ref, offset, length, miss) {
  const fail = () => { miss(ref[0]); throw new Unread('An unread journal value was used.'); };
  const proxy = new Proxy(new Type(0), {
    get: (_, key) => key === UNREAD ? true : fail(), set: fail, has: fail, ownKeys: fail, getOwnPropertyDescriptor: fail, defineProperty: fail, deleteProperty: fail,
    getPrototypeOf: () => Type.prototype});
  lazyArrays.set(proxy, {type: TYPED.indexOf(Type.name), ref, offset, length});
  return proxy;
}

export function lazySource(length, miss) {
  const known = {length, byteLength: length, byteOffset: 0, BYTES_PER_ELEMENT: 1, constructor: Uint8Array};
  const fail = () => { miss('source'); throw new Unread('An unread source was used.'); };
  const proxy = new Proxy(new Uint8Array(0), {
    get: (_, key) => key === UNREAD ? true : Object.hasOwn(known, key) ? known[key] : key === Symbol.toStringTag ? 'Uint8Array' : fail(),
    set: fail, has: fail, ownKeys: fail, getOwnPropertyDescriptor: fail, defineProperty: fail, deleteProperty: fail,
    getPrototypeOf: () => Uint8Array.prototype});
  lazyArrays.set(proxy, {type: TYPED.indexOf('Uint8Array'), ref: ['source', 0], offset: 0, length});
  return proxy;
}
export const unread = value => value?.[UNREAD] === true;

export function encodeValue(value, known = null) {
  const buffers = new Map(), chunks = [];
  let size = 0;
  const bufferId = buffer => {
    let id = buffers.get(buffer);
    if (id === undefined) { id = buffers.size; buffers.set(buffer, id); chunks.push({at: size, buffer}); size += buffer.byteLength; }
    return id;
  };
  const seen = new Map();
  const walk = v => {
    if (v === null) return null;
    switch (typeof v) {
      case 'undefined': return {u: 1};
      case 'boolean': case 'string': return v;
      case 'number': return Number.isFinite(v) && !Object.is(v, -0) ? v : {n: Object.is(v, -0) ? '-0' : String(v)};
      case 'object': break;
      default: throw invalid(`A unit value cannot hold a ${typeof v}.`);
    }
    const lazy = lazyArrays.get(v);
    if (lazy) return {t: lazy.type, r: lazy.ref, o: lazy.offset, l: lazy.length};
    if (ArrayBuffer.isView(v) && Object.getPrototypeOf(Object.getPrototypeOf(v)) === typedProto) {
      const k = TYPED.indexOf(v.constructor.name);
      if (k < 0) throw invalid('Unknown typed array in a unit value.');
      const ref = known?.get(v.buffer);
      return ref ? {t: k, r: ref, o: v.byteOffset, l: v.length} : {t: k, b: bufferId(v.buffer), o: v.byteOffset, l: v.length};
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
  const meta = {v: walk(value), buffers: chunks.map(c => [c.at, c.buffer.byteLength])};
  const bytes = new Uint8Array(size);
  for (const {at, buffer} of chunks) bytes.set(new Uint8Array(buffer), at);
  return {meta, bytes, buffers: chunks.map(c => c.buffer)};
}

export function decodeValue(meta, bytes, resolve = null, self = null, miss = null) {
  if (!meta || !Array.isArray(meta.buffers)) throw invalid('Invalid unit value.');
  for (const entry of meta.buffers) if (!Array.isArray(entry) || entry.length !== 2 || !Number.isSafeInteger(entry[0]) ||
      !Number.isSafeInteger(entry[1]) || entry[0] < 0 || entry[1] < 0 || bytes && entry[0] + entry[1] > bytes.length) throw invalid('Invalid unit value.');
  const buffers = bytes ? meta.buffers.map(([at, length]) => bytes.slice(at, at + length).buffer) : null;
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
      if (buffer === null) return lazyArray(Type, v.r ?? [self, v.b], v.o, v.l, miss);
      if (!buffer || v.o + v.l * Type.BYTES_PER_ELEMENT > buffer.byteLength) throw invalid('Invalid unit value.');
      return new Type(buffer, v.o, v.l);
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
