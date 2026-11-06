// SPDX-License-Identifier: MIT
import {digestBytes} from './result-identity.mjs';
import {arrayBufferBytes, typedFields, typedName} from './bytes.mjs';
import {isPlainRecord} from './records.mjs';
import {dimensions, fail, LARGEST} from './primitives.mjs';

const SCOPE_KEYS = new Set(['width', 'height', 'rectangles', 'mask']);
const RECT_KEYS = new Set(['x', 'y', 'width', 'height']);
const MAX_RECTANGLES = 65536;
const PREFIX = new TextEncoder().encode('rapier-jxl:protected-pixels\0');
const HEADER_BYTES = PREFIX.length + 8;
const reject = message => { throw fail('JXL_OPTIONS', message); };

function record(value, keys, name) {
  if (!isPlainRecord(value)) reject(`${name} is a plain data record.`);
  const descriptors = Object.getOwnPropertyDescriptors(value), copied = {};
  for (const key of Reflect.ownKeys(descriptors)) {
    if (!keys.has(key)) reject(`${name} has an unsupported field: ${String(key)}.`);
    if (!('value' in descriptors[key])) reject(`${name} cannot contain getters or setters.`);
    copied[key] = descriptors[key].value;
  }
  return copied;
}

function binaryMask(value, pixels) {
  if (typedName.call(value) !== 'Uint8Array') reject('A protection mask is a binary Uint8Array.');
  const buffer = typedFields.buffer.call(value), length = typedFields.byteLength.call(value);
  if (arrayBufferBytes(buffer) === null || length !== pixels)
    reject('A protection mask has one byte per output pixel on an ordinary, attached ArrayBuffer.');
  try { return new Uint8Array(buffer, typedFields.byteOffset.call(value), length); }
  catch { reject('A protection mask needs an attached ArrayBuffer.'); }
}

function fillBits(bits, start, end) {
  const first = start >>> 3, last = (end - 1) >>> 3;
  const left = 255 << (start & 7), right = 255 >>> (7 - ((end - 1) & 7));
  if (first === last) { bits[first] |= left & right; return; }
  bits[first] |= left;
  bits.fill(255, first + 1, last);
  bits[last] |= right;
}

function rectangleEvents(rectangles, width, height) {
  if (!Array.isArray(rectangles)) reject('Protection rectangles are an array.');
  const length = Object.getOwnPropertyDescriptor(rectangles, 'length')?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_RECTANGLES)
    reject('At most 65,536 protection rectangles are admitted.');
  for (const key of Reflect.ownKeys(rectangles)) {
    if (key === 'length') continue;
    const index = typeof key === 'string' ? Number(key) : NaN;
    if (!Number.isSafeInteger(index) || index < 0 || index >= length || String(index) !== key)
      reject('Protection rectangle arrays contain only indexed data entries.');
  }
  let heads = null;
  const events = [];
  const add = (y, x0, x1, delta) => {
    events.push({next: heads[y], x0, x1, delta}); heads[y] = events.length - 1;
  };
  for (let i = 0; i < length; i++) {
    const entry = Object.getOwnPropertyDescriptor(rectangles, i);
    if (!entry || !('value' in entry)) reject('Protection rectangle entries are data values, without holes or accessors.');
    const {x, y, width: w, height: h} = record(entry.value, RECT_KEYS, 'A protection rectangle');
    if (![x, y, w, h].every(Number.isSafeInteger) || w < 1 || h < 1)
      reject('Protection rectangles have safe-integer x and y and positive safe-integer width and height.');
    const endX = x + w, endY = y + h;
    if (!Number.isSafeInteger(endX) || !Number.isSafeInteger(endY))
      reject('Protection rectangle endpoints must not overflow safe integers.');
    const x0 = Math.max(0, x), x1 = Math.min(width, endX), y0 = Math.max(0, y), y1 = Math.min(height, endY);
    if (x1 <= x0 || y1 <= y0) continue;
    heads ??= new Int32Array(height + 1).fill(-1);
    add(y0, x0, x1, 1); add(y1, x0, x1, -1);
  }
  return {heads, events};
}

function addRectangles(bits, width, height, {heads, events}) {
  if (!heads) return;
  const difference = new Int32Array(width + 1);
  for (let top = 0; top < height;) {
    if (heads[top] < 0) { top++; continue; }
    for (let i = heads[top]; i >= 0; i = events[i].next) {
      const {x0, x1, delta} = events[i]; difference[x0] += delta; difference[x1] -= delta;
    }
    let bottom = top + 1;
    while (bottom < height && heads[bottom] < 0) bottom++;
    let coverage = 0, start = -1;
    for (let x = 0; x <= width; x++) {
      coverage += difference[x];
      if (coverage > 0 && start < 0) start = x;
      else if (coverage === 0 && start >= 0) {
        for (let y = top; y < bottom; y++) fillBits(bits, y * width + start, y * width + x);
        start = -1;
      }
    }
    top = bottom;
  }
}

export function protectedScope(given) {
  const {width, height, rectangles = [], mask} = record(given, SCOPE_KEYS, 'A protected scope');
  dimensions(width, height, LARGEST);
  const pixels = width * height, rects = rectangleEvents(rectangles, width, height);
  const data = mask === undefined ? null : binaryMask(mask, pixels);
  const owned = new Uint8Array(HEADER_BYTES + Math.ceil(pixels / 8)); owned.set(PREFIX);
  const header = new DataView(owned.buffer);
  header.setUint32(PREFIX.length, width, true); header.setUint32(PREFIX.length + 4, height, true);
  const bits = owned.subarray(HEADER_BYTES);
  if (data) for (let i = 0; i < pixels; i++) {
    const value = data[i];
    if (value !== 0 && value !== 1) reject('A protection mask contains only 0 and 1.');
    if (value) bits[i >>> 3] |= 1 << (i & 7);
  }
  addRectangles(bits, width, height, rects);
  let count = 0;
  for (let value of bits) {
    value -= value >>> 1 & 85; value = (value & 51) + (value >>> 2 & 51);
    count += (value + (value >>> 4)) & 15;
  }
  let pending;
  return Object.freeze({width, height, count,
    has: index => Number.isSafeInteger(index) && index >= 0 && index < pixels && (bits[index >>> 3] & 1 << (index & 7)) !== 0,
    digest: () => pending ??= digestBytes(owned)});
}
