// SPDX-License-Identifier: MIT
import {LIMITS} from './limits.mjs';
import {fault} from './fault.mjs';

const typed = Object.getPrototypeOf(Uint8Array.prototype);
const get = name => Object.getOwnPropertyDescriptor(typed, name).get;
const kind = get(Symbol.toStringTag), length = get('length'), buffer = get('buffer'), offset = get('byteOffset');
const byteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get;
const kinds = {Uint8Array, Uint8ClampedArray, Float32Array, Float64Array};

export function s2Dimensions(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
      || width > LIMITS.edge || height > LIMITS.edge || width * height > LIMITS.pixels)
    throw fault('JXL_DIMENSIONS', 'SSIMULACRA2 needs positive image dimensions within the picture limits.');
  return width * height;
}

function samples(value, count, allowed, exact = false) {
  try {
    if (!Number.isSafeInteger(count) || count < 1) throw 0;
    const name = kind.call(value), memory = buffer.call(value), size = length.call(value);
    if (!allowed.includes(name) || size < count || exact && size !== count || byteLength.call(memory) < 1) throw 0;
    return new kinds[name](memory, offset.call(value), count);
  } catch { throw fault('JXL_INPUT', 'SSIMULACRA2 needs complete, nonshared typed sample arrays.'); }
}

const sampleCount = pixels => {
  if (!Number.isSafeInteger(pixels) || pixels < 1 || pixels > LIMITS.pixels)
    throw fault('JXL_DIMENSIONS', 'SSIMULACRA2 needs a positive sample count within the picture limits.');
  return pixels;
};
export const s2RGBA = (rgba, pixels, exact = false) => samples(rgba, sampleCount(pixels) * 4, ['Uint8Array', 'Uint8ClampedArray'], exact);

export function s2Planes(planes, pixels) {
  sampleCount(pixels);
  if (!Array.isArray(planes) || planes.length !== 3)
    throw fault('JXL_INPUT', 'SSIMULACRA2 needs three linear RGB planes.');
  const out = [0, 1, 2].map(c => samples(planes[c], pixels, ['Float32Array', 'Float64Array']));
  for (const plane of out) for (let i = 0; i < pixels; i++)
    if (!Number.isFinite(Math.fround(plane[i]))) throw fault('JXL_INPUT', 'SSIMULACRA2 samples must be finite binary32 values.');
  return out;
}

export function s2Samples(value, pixels) {
  const rgba = value?.rgba;
  return rgba === undefined ? s2Planes(value, pixels) : {rgba: s2RGBA(rgba, pixels)};
}

export function s2Pad(input, width, height) {
  if (width >= 8 && height >= 8) return input;
  const w = Math.max(8, width), h = Math.max(8, height), rgba = input.rgba;
  const out = rgba ? new Uint8Array(w * h * 4)
    : input.map(plane => new (plane instanceof Float32Array ? Float32Array : Float64Array)(w * h));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const from = Math.min(y, height - 1) * width + Math.min(x, width - 1), to = y * w + x;
    if (rgba) for (let c = 0; c < 4; c++) out[to * 4 + c] = rgba[from * 4 + c];
    else for (let c = 0; c < 3; c++) out[c][to] = input[c][from];
  }
  return rgba ? {rgba: out} : out;
}

