// SPDX-License-Identifier: MIT
import {kernelHooks} from './kernel-hooks.mjs';

const PACKED_BYTES = 1 << 20, RESULTS = 1024, INVALID = {};
const coordinates = ['x', 'y', 'width', 'height'];
function value(object, key, optional = false) {
  if (!object || typeof object !== 'object') throw INVALID;
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor) {
    if (optional && !(key in object)) return undefined;
    throw INVALID;
  }
  if (!('value' in descriptor)) throw INVALID;
  return descriptor.value;
}
function dense(array) {
  if (!Array.isArray(array)) return false;
  for (let i = 0; i < array.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(array, i);
    if (!descriptor || !('value' in descriptor)) return false;
  }
  return true;
}
function rectangle(rect, put, exact) {
  for (const key of coordinates) put(value(rect, key));
  if (exact) for (const key of ['solidText', 'edge']) {
    const flag = value(rect, key, true);
    if (flag !== undefined && flag !== false && flag !== true) throw INVALID;
    put(flag === undefined ? 0 : flag === false ? 1 : 2);
  }
}
function rectangles(rects, put, exact = false) {
  if (!Array.isArray(rects)) throw INVALID;
  put(rects.length);
  for (let i = 0; i < rects.length; i++) rectangle(value(rects, i), put, exact);
}
function space(colorSpace, put) {
  if (colorSpace !== 'srgb' && colorSpace !== 'display-p3') throw INVALID;
  put(colorSpace === 'srgb' ? 0 : 1);
}
function lengthOf(walk) {
  let length = 0;
  try { walk(number => { if (!Number.isFinite(number) || ++length * 8 > PACKED_BYTES) throw INVALID; }); }
  catch (error) { if (error !== INVALID) throw error; return null; }
  return length;
}
function matches(key, walk) {
  let at = 0;
  try { walk(number => { if (at >= key.length || !Object.is(key[at++], number)) throw INVALID; }); }
  catch (error) { if (error !== INVALID) throw error; return false; }
  return at === key.length;
}
function packed(walk, length) {
  const key = new Float64Array(length); let at = 0;
  walk(number => { key[at++] = number; }); return key;
}
function finiteVector(answer) {
  if (!Array.isArray(answer) || !answer.length) return false;
  for (let i = 0; i < answer.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(answer, i);
    if (!descriptor || !('value' in descriptor) || !Number.isFinite(descriptor.value)) return false;
  }
  return true;
}

export function photoQualityMemo(owned) {
  let pixels = owned && !(typeof Blob === 'function' && owned instanceof Blob) && typeof owned.rows !== 'function'
    && (owned.data instanceof Uint8Array || owned.data instanceof Uint8ClampedArray) && owned.data.buffer instanceof ArrayBuffer
    && owned.data.length === owned.width * owned.height * 4 ? owned.data : null;
  let buffer = pixels?.buffer ?? null;
  const offset = pixels?.byteOffset, size = pixels?.byteLength, sourceWidth = owned?.width;
  pixels = null; owned = null;
  const looks = [], crops = [];
  let bytes = 0, results = 0, closed = false;
  const check = () => { if (closed) throw new Error('Photo quality memo is destroyed.'); };
  const owns = (data, width) => buffer && (data instanceof Uint8Array || data instanceof Uint8ClampedArray)
    && data.buffer === buffer && data.byteOffset === offset && data.byteLength === size && width === sourceWidth;
  const read = (entries, data, width, walk, compute, vector) => {
    check();
    if (!owns(data, width)) return compute();
    const length = lengthOf(walk);
    if (length === null) return compute();
    const kernel = kernelHooks.rgbTiles, known = entries.find(entry => entry.kernel === kernel && matches(entry.key, walk));
    if (known) return vector ? Array.from(known.answer) : known.answer;
    let key = null, reserved = 0;
    try {
      if (results < RESULTS && bytes + length * 8 <= PACKED_BYTES) {
        reserved = length * 8; bytes += reserved; key = packed(walk, length);
      }
      const answer = compute();
      check();
      if (!key || !owns(data, width) || kernel !== kernelHooks.rgbTiles || !matches(key, walk) || results >= RESULTS
          || (vector ? !Array.isArray(answer) : !Number.isFinite(answer))) return answer;
      const extra = vector ? answer.length * 8 : 0;
      if (bytes + extra > PACKED_BYTES || vector && !finiteVector(answer)) return answer;
      const saved = vector ? Float64Array.from(answer) : answer;
      entries.push({key, kernel, answer: saved}); bytes += extra; results++; reserved = 0;
      return vector ? Array.from(saved) : saved;
    } finally {
      if (reserved && !closed) bytes -= reserved;
    }
  };
  return {
    look(args, compute) {
      check();
      if (!dense(args)) return compute();
      const [data, width, r, reading, webp, dx = 0, dy = 0, exactRects = [], colorSpace = 'srgb', frameQuality = reading, boxes = []] = args;
      return read(looks, data, width, put => {
        for (const number of [reading, webp, dx, dy, frameQuality]) put(number);
        space(colorSpace, put); rectangle(r, put); rectangles(exactRects, put, true); rectangles(boxes, put);
      }, compute, false);
    },
    crop(args, quality, compute) {
      check();
      if (!dense(args)) return compute();
      const [data, width, r, held = [r], dx = 0, dy = 0, exactRects = [], colorSpace = 'srgb', frameQuality] = args;
      return read(crops, data, width, put => {
        put(quality); put(dx); put(dy); put(frameQuality === undefined ? 0 : 1);
        put(frameQuality === undefined ? 0 : frameQuality); space(colorSpace, put);
        rectangle(r, put); rectangles(held, put); rectangles(exactRects, put, true);
      }, compute, true);
    },
    destroy() { closed = true; buffer = null; looks.length = 0; crops.length = 0; bytes = 0; results = 0; },
  };
}
