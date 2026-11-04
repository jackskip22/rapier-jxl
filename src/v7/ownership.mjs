import {fail as error} from './primitives.mjs';
import {EDGE} from '../limits.mjs';
import {arrayBufferBytes, typedFields, typedName} from './bytes.mjs';
import {plain} from './records.mjs';
export const DEFAULT_INPUT_BYTES = 256 * 1024 * 1024;
export const DEFAULT_PIXELS = 40_000_000;
export const SNAPSHOTS = new WeakMap();
export const withCost = (value, cost) => { SNAPSHOTS.set(value, cost); return value; };
export const HANDED = new WeakSet();
function blob(value) { return typeof Blob === 'function' && value instanceof Blob; }
const viewFields = Object.fromEntries(['buffer', 'byteOffset', 'byteLength'].map(key => [key, Object.getOwnPropertyDescriptor(DataView.prototype, key).get]));
const constructors = {Uint8Array, Uint8ClampedArray, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array, DataView};
function view(value) {
  let fields = typedFields, name;
  try { name = typedName.call(value); typedFields.buffer.call(value); }
  catch { fields = viewFields; name = 'DataView'; }
  const buffer = fields.buffer.call(value), byteOffset = fields.byteOffset.call(value), byteLength = fields.byteLength.call(value);
  if (arrayBufferBytes(buffer) === null) throw error('JXL_INPUT', 'Shared buffers are not queue inputs.');
  reach(buffer, byteOffset, byteLength);
  const Type = constructors[name];
  if (!Type) throw error('JXL_INPUT', 'Unsupported sample array.');
  return {kind: 'view', buffer, byteOffset, byteLength, Type};
}
function reach(buffer, byteOffset, byteLength) {
  try { new Uint8Array(buffer, byteOffset, byteLength); }
  catch { throw error('JXL_INPUT', 'The ArrayBuffer is detached or too small; pass a live one.'); }
}
export const MAX_NODES = 1048576;
const NODES = {};
export function record(value) {
  if (Array.isArray(value) && value.length > MAX_NODES) throw error('JXL_MEMORY', 'Queue input has too many fields; at most ' + MAX_NODES + ' records and fields.');
  const proto = Object.getPrototypeOf(value);
  if (!plain(proto) && !Array.isArray(value)) {
    throw error('JXL_INPUT', 'Queue inputs are pixels, bytes, Blobs or plain records.');
  }
  if (Object.getOwnPropertySymbols(value).some(key => Object.getOwnPropertyDescriptor(value, key).enumerable))
    throw error('JXL_INPUT', 'Queue records cannot contain symbol keys.');
  return Object.entries(Object.getOwnPropertyDescriptors(value)).filter(([key, descriptor]) => {
    if (!descriptor.enumerable) return false;
    if (!('value' in descriptor)) throw error('JXL_INPUT', 'Queue records cannot contain accessors.');
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
      throw error('JXL_DIMENSIONS', 'An image side is a whole number from 1 to 32,767 pixels.');
    return;
  }
  if (!w || !h) throw error('JXL_INPUT', 'Image dimensions must be plain numeric values.');
  if (!('value' in w) || !('value' in h)) throw error('JXL_INPUT', 'Image dimensions must be plain numeric values.');
  const width = w.value, height = h.value;
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1)
    throw error('JXL_DIMENSIONS', 'Image width and height must be positive safe integers.');
  if (width > EDGE || height > EDGE || width > Math.floor(maxPixels / height))
    throw error('JXL_DIMENSIONS', 'Over maxPixels or 32,767 pixels a side; resize, or raise maxPixels in createCodec().');
}
export function measure(value, maxPixels, plans = new Map(), depth = 0) {
  if (depth > 64) throw error('JXL_INPUT', 'Queue input is nested too deeply.');
  if (value === null || value === undefined) return 0;
  if (typeof value === 'string') return value.length * 2;
  if (typeof value === 'number' || typeof value === 'bigint') return 8;
  if (typeof value === 'boolean') return 1;
  if (typeof value !== 'object') throw error('JXL_INPUT', 'Queue input contains a value that cannot be copied.');
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
    if (HANDED.has(value)) { plan.kind = 'handed'; plan.cost = arrayBufferBytes(plan.buffer); } else plan.cost = plan.byteLength;
    plans.set(value, plan); return plan.cost;
  }
  const fields = record(value);
  dimensions(value, maxPixels, fields);
  const nodes = plans.get(NODES) ?? plans.set(NODES, {count: 0}).get(NODES);
  if ((nodes.count += 1 + fields.length) > MAX_NODES) throw error('JXL_MEMORY', 'Queue input has too many fields; at most ' + MAX_NODES + ' records and fields.');
  const plan = {kind: 'record', array: Array.isArray(value), fields, cost: undefined};
  plans.set(value, plan);
  let bytes = 0;
  for (const [key, descriptor] of fields) {
    bytes += key.length * 2 + measure(descriptor.value, maxPixels, plans, depth + 1);
    if (!Number.isSafeInteger(bytes)) throw error('JXL_MEMORY', 'Queue input is too large.');
  }
  plan.cost = bytes;
  return bytes;
}
export function snapshot(value, plans, seen = new Map()) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  const plan = plans.get(value);
  if (plan.kind === 'blob') return value;
  let result;
  if (plan.kind === 'handed') {
    let moved;
    try { moved = structuredClone(plan.buffer, {transfer: [plan.buffer]}); } catch { throw error('JXL_INPUT', 'transfer takes an ArrayBuffer.'); }
    result = new plan.Type(moved, plan.byteOffset, plan.byteLength / plan.Type.BYTES_PER_ELEMENT);
  } else if (plan.kind === 'buffer' || plan.kind === 'view') {
    const source = new Uint8Array(plan.buffer, plan.byteOffset, plan.byteLength);
    const buffer = new ArrayBuffer(plan.byteLength);
    new Uint8Array(buffer).set(source);
    result = plan.kind === 'buffer' ? buffer : new plan.Type(buffer);
  } else {
    result = plan.array ? [] : {};
    seen.set(value, result);
    for (const [key, descriptor] of plan.fields) Object.defineProperty(result, key, {value: snapshot(descriptor.value, plans, seen), writable: true, enumerable: true, configurable: true});
  }
  seen.set(value, result);
  return result;
}
export function own(value, maxPixels = DEFAULT_PIXELS, maxBytes = DEFAULT_INPUT_BYTES) {
  const plans = new Map();
  if (measure(value, maxPixels, plans) > maxBytes) throw error('JXL_MEMORY', 'Captured input exceeds its byte budget.');
  return snapshot(value, plans);
}
