import {fail as error, unreadInput, isBlob} from './primitives.mjs';
import {EDGE, PIXELS} from '../limits.mjs';
import {arrayBufferBytes, liveView, typedName} from './bytes.mjs';
import {plain} from './records.mjs';
export const DEFAULT_INPUT_BYTES = Number.MAX_SAFE_INTEGER;
export const hostPendingBytes = (host = globalThis) => {
  if (host?.process?.versions?.node || host?.Deno || host?.Bun) return DEFAULT_INPUT_BYTES;
  let nav;
  try { nav = host?.navigator; if (nav?.userAgent === 'Cloudflare-Workers') return DEFAULT_INPUT_BYTES; } catch {}
  if (host?.document === undefined && host?.WorkerGlobalScope === undefined) return DEFAULT_INPUT_BYTES;
  let gigabytes;
  try { gigabytes = nav?.deviceMemory; } catch {}
  if (typeof gigabytes !== 'number' || !Number.isFinite(gigabytes) || gigabytes <= 0) return 2 ** 30;
  const bytes = Math.floor(gigabytes * 2 ** 28);
  return Number.isFinite(bytes) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, bytes)) : Number.MAX_SAFE_INTEGER;
};
export const RETAIN_INPUT = Symbol.for('rapier-jxl.retain-input');
export const SNAPSHOTS = new WeakMap();
export const withCost = (value, cost) => { SNAPSHOTS.set(value, cost); return value; };
export const HANDED = new WeakSet();
function blob(value) { return isBlob(value); }
const sliceBytes = Uint8Array.prototype.slice;
const constructors = {Uint8Array, Uint8ClampedArray, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array, ...(typeof Float16Array === 'function' && {Float16Array}), Float32Array, Float64Array, BigInt64Array, BigUint64Array, DataView};
function view(value) {
  const name = typedName.call(value) ?? 'DataView', fields = liveView(value);
  if (!fields) throw error('JXL_INPUT', "ArrayBuffer: live and sized");
  const [buffer, byteOffset, byteLength] = fields;
  if (arrayBufferBytes(buffer) === null) throw error('JXL_INPUT', "shared buffer: copy to ArrayBuffer");
  reach(buffer, byteOffset, byteLength);
  const Type = constructors[name];
  if (!Type) throw error('JXL_INPUT', 'samples: Uint8Array or Float32Array');
  return {kind: 'view', buffer, byteOffset, byteLength, Type};
}
function reach(buffer, byteOffset, byteLength) {
  try { if (new Uint8Array(buffer, byteOffset, byteLength).byteLength !== byteLength) throw 0; }
  catch { throw error('JXL_INPUT', "ArrayBuffer: live and sized"); }
}
const NODE_BYTES = 512;
class Over extends Error {}
const NODES = {};
const TRANSFERS = {};
export function record(value) {
  const proto = Object.getPrototypeOf(value);
  if (!plain(proto) && !Array.isArray(value)) {
    throw error('JXL_INPUT', unreadInput(value));
  }
  if (Object.getOwnPropertySymbols(value).some(key => Object.getOwnPropertyDescriptor(value, key).enumerable))
    throw error('JXL_INPUT', "record keys: no symbols");
  return Object.entries(Object.getOwnPropertyDescriptors(value)).filter(([key, descriptor]) => {
    if (!descriptor.enumerable) return false;
    if (!('value' in descriptor)) throw error('JXL_INPUT', "record: data values only");
    return true;
  });
}
export function dimensions(value, maxPixels, fields) {
  if (!value || typeof value !== 'object') return;
  const w = fields ? fields.find(([key]) => key === 'width')?.[1] : Object.getOwnPropertyDescriptor(value, 'width');
  const h = fields ? fields.find(([key]) => key === 'height')?.[1] : Object.getOwnPropertyDescriptor(value, 'height');
  if (!w && !h) return;
  const given = d => !!d && 'value' in d && d.value !== undefined;
  const absent = name => { const d = Object.getOwnPropertyDescriptor(value, name); return !d || 'value' in d && d.value === undefined; };
  if (given(w) !== given(h) && absent(given(w) ? 'height' : 'width')) {
    const side = (given(w) ? w : h).value;
    if (!Number.isSafeInteger(side) || side < 1 || side > EDGE)
      throw error('JXL_DIMENSIONS', 'side: integer 1-1073741824');
    return;
  }
  if (!w || !h) throw error('JXL_INPUT', "dimensions: numeric width, height");
  if (!('value' in w) || !('value' in h)) throw error('JXL_INPUT', "dimensions: numeric width, height");
  const width = w.value, height = h.value;
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1)
    throw error('JXL_DIMENSIONS', "dimensions: positive safe integers");
  if (width > EDGE || height > EDGE || width > Math.floor(maxPixels / height))
    throw error('JXL_DIMENSIONS', 'dimensions: over maxPixels or 2^30 px per side; raise maxPixels');
}
export function measure(value, maxPixels, plans = new Map(), limit = Infinity) {
  try { return walk(value, maxPixels, plans, limit); }
  catch (cause) {
    if (cause instanceof Over) return Infinity;
    if (cause instanceof RangeError) throw error('JXL_MEMORY', "input nesting: flatten record");
    throw cause;
  }
}
function walk(value, maxPixels, plans, limit) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'string') return value.length * 2;
  if (typeof value === 'number' || typeof value === 'bigint') return 8;
  if (typeof value === 'boolean') return 1;
  if (typeof value !== 'object') throw error('JXL_INPUT', "input: structured-cloneable data");
  const seen = plans.get(value);
  if (seen) return seen.cost ?? 0;
  if (SNAPSHOTS.has(value)) {
    const cost = SNAPSHOTS.get(value);
    plans.set(value, {kind: 'blob', cost});
    return cost;
  }
  if (blob(value)) {
    const cost = Object.getOwnPropertyDescriptor(Blob.prototype, 'size').get.call(value);
    plans.set(value, {kind: 'blob', cost});
    return cost;
  }
  const byteLength = Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype ? null : arrayBufferBytes(value);
  if (byteLength !== null) {
    reach(value, 0, byteLength);
    plans.set(value, {kind: 'buffer', buffer: value, byteOffset: 0, byteLength, cost: byteLength});
    return byteLength;
  }
  if (ArrayBuffer.isView(value)) {
    const plan = view(value);
    if (HANDED.has(value)) {
      plan.kind = 'handed'; plan.cost = arrayBufferBytes(plan.buffer);
      if (!plans.has(TRANSFERS)) plans.set(TRANSFERS, new Set());
      plans.get(TRANSFERS).add(plan.buffer);
    } else plan.cost = plan.byteLength;
    plans.set(value, plan); return plan.cost;
  }
  if (Array.isArray(value) && value.length * NODE_BYTES > limit) throw new Over();
  const fields = record(value);
  dimensions(value, maxPixels, fields);
  const nodes = plans.get(NODES) ?? plans.set(NODES, {bytes: 0}).get(NODES);
  if ((nodes.bytes += (1 + fields.length) * NODE_BYTES) > limit) throw new Over();
  const plan = {kind: 'record', array: Array.isArray(value), fields, cost: undefined};
  plans.set(value, plan);
  let bytes = NODE_BYTES * (1 + fields.length);
  for (const [key, descriptor] of fields) {
    bytes += key.length * 2 + walk(descriptor.value, maxPixels, plans, limit);
    if (!Number.isSafeInteger(bytes)) throw error('JXL_MEMORY', "input bytes: raise maxPendingBytes");
  }
  plan.cost = bytes;
  return bytes;
}
export function snapshot(value, plans, seen, moved = new Map()) {
  if (value === null || typeof value !== 'object') return value;
  if (!seen) {
    seen = new Map();
    const buffers = [...(plans.get(TRANSFERS) ?? [])].filter(buffer => !moved.has(buffer));
    if (buffers.length) {
      let taken;
      try { taken = structuredClone(buffers, {transfer: buffers}); }
      catch { throw error('JXL_INPUT', "ArrayBuffer: copy before transfer"); }
      for (let i = 0; i < buffers.length; i++) moved.set(buffers[i], taken[i]);
    }
  }
  if (seen.has(value)) return seen.get(value);
  const plan = plans.get(value);
  if (plan.kind === 'blob') return value;
  let result;
  if (plan.kind === 'handed') {
    result = new plan.Type(moved.get(plan.buffer), plan.byteOffset, plan.byteLength / (plan.Type.BYTES_PER_ELEMENT ?? 1));
  } else if (plan.kind === 'buffer' || plan.kind === 'view') {
    const source = new Uint8Array(moved.get(plan.buffer) ?? plan.buffer, plan.byteOffset, plan.byteLength);
    const buffer = sliceBytes.call(source).buffer;
    result = plan.kind === 'buffer' ? buffer : new plan.Type(buffer);
  } else {
    result = plan.array ? [] : {};
    seen.set(value, result);
    for (const [key, descriptor] of plan.fields) Object.defineProperty(result, key, {value: snapshot(descriptor.value, plans, seen, moved), writable: true, enumerable: true, configurable: true});
  }
  seen.set(value, result);
  return result;
}
export const MiB = bytes => (bytes / 2 ** 20).toFixed(bytes < 2 ** 20 ? 2 : 0);
export function own(value, maxPixels = PIXELS, maxBytes = DEFAULT_INPUT_BYTES, refusal) {
  const plans = new Map(), need = measure(value, maxPixels, plans, maxBytes);
  if (need > maxBytes) throw error('JXL_MEMORY', refusal && need !== Infinity ? refusal(need, maxBytes) : `input: ${need === Infinity ? 'more than ' + MiB(maxBytes) : MiB(need)} MiB > ${MiB(maxBytes)} MiB, raise maxPendingBytes`);
  return snapshot(value, plans);
}
