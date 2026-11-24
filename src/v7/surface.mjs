// SPDX-License-Identifier: MIT
import {readWebGLNow} from './webgl-read.mjs';
import {isVideo, videoFrame} from './video.mjs';
import {dimensions, fail, filePassed, gpuDrawn, plainView, typedName, PIXELS} from './primitives.mjs';
import {isPlainRecord} from './records.mjs';
import {withCost, DEFAULT_INPUT_BYTES} from './ownership.mjs';
import {DESCRIPTION, described, isDecoded, fromDecoded} from './describe.mjs';
import {open2d, glGpuSpace, copy2d, read2d} from './canvas-2d.mjs';
const STILL_FIELDS = /* @__PURE__ */ new Set(['data', 'width', 'height', 'parts', ...DESCRIPTION]);
const ANIMATION_FIELDS = /* @__PURE__ */ new Set(['width', 'height', 'frames', 'loops', ...DESCRIPTION]);
const halfWords = view => {
  try { return new Uint16Array(view.buffer, view.byteOffset, view.length); }
  catch { throw fail('JXL_INPUT', "ArrayBuffer: live and sized"); }
};

function opaque(data, width, height, half, defer) {
  const count = Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0 ? width * height : 0;
  if (!count || !(data instanceof Float32Array || half && data instanceof Uint16Array) || data.length !== count * 3) return null;
  if (defer) return plainView(data);
  const out = new data.constructor(count * 4), one = half ? 0x3c00 : 1;
  for (let i = 0; i < count; i++) { out[i * 4] = data[i * 3]; out[i * 4 + 1] = data[i * 3 + 1]; out[i * 4 + 2] = data[i * 3 + 2]; out[i * 4 + 3] = one; }
  return out;
}

const RGBA = "Wrong pixel data length; pass width * height * 4 straight RGBA samples.";
const sized = (width, height) => Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0;
const samples = (data, width, height) => {
  if (!sized(width, height) || !ArrayBuffer.isView(data) || data instanceof DataView || data.length === width * height * 4) return;
  throw fail('JXL_INPUT', filePassed(data) ?? RGBA);
};
export const admitSamples = ({data, width, height}) => samples(data, width, height);
export function admitFrames({width, height, frames}) {
  if (sized(width, height)) for (const frame of frames) {
    if (frame && typeof frame === 'object' && ((frame.width !== undefined && frame.width !== width) || (frame.height !== undefined && frame.height !== height)))
      throw fail('JXL_INPUT', `frame dimensions: match ${width} x ${height}; pass matching frame width and height`);
    samples(frame?.data, width, height);
    if (frame && typeof frame === 'object' && (typeof frame.duration !== 'number' || !Number.isFinite(frame.duration) || frame.duration < 0 || frame.duration > 0xFFFFFFFF))
      throw fail('JXL_INPUT', "frame duration: finite ms >=0");
  }
}
export function surface(input, options = {}) {
  if (isVideo(input)) { const frame = videoFrame(input); try { return surface(frame, options); } finally { frame.close(); } }
  const {maxPixels = PIXELS, maxPendingBytes = DEFAULT_INPUT_BYTES, retainedBytes = 0, admitSurface, readAs: requested, half: halfAllowed = false, deferPacked = false} = options;
  const proto = input && typeof input === 'object' ? Object.getPrototypeOf(input) : null;
  const typed = typeof ImageData === 'function' && input instanceof ImageData ||
    !!proto && proto !== Object.prototype && Object.getOwnPropertyDescriptor(proto, Symbol.toStringTag)?.value === 'ImageData';
  if ((typed || isPlainRecord(input)) && requested !== undefined)
    throw fail('JXL_OPTIONS', "readAs: raw pixels use colorSpace");
  if (isPlainRecord(input) && Object.values(Object.getOwnPropertyDescriptors(input)).some(field => !('value' in field)))
    throw fail('JXL_INPUT', "record: data values only");
  if (isPlainRecord(input) && isDecoded(input)) return fromDecoded(input);
  if (isPlainRecord(input)) {
    const animation = Array.isArray(input.frames), known = animation ? ANIMATION_FIELDS : STILL_FIELDS;
    for (const key of Object.keys(input)) if (!known.has(key))
      throw fail('JXL_INPUT', `picture.${key}: {data, width, height}, ${DESCRIPTION.join(", ")}`);
    if (animation) {
      if (input.parts !== undefined && (!Number.isSafeInteger(input.parts) || input.parts < 1))
        throw fail('JXL_INPUT', 'Invalid picture parts count; use a positive integer.');
      const description = described(input);
      if (input.frames.some(frame => typedName.call(frame?.data) === 'Float16Array')) {
        if (description.sampleFormat !== undefined && description.sampleFormat !== 'float16') throw fail('JXL_INPUT', "sampleFormat: float16 for Float16Array");
        if (!input.frames.every(frame => typedName.call(frame?.data) === 'Float16Array')) throw fail('JXL_INPUT', "frames: matching sample array types");
        return {width: input.width, height: input.height, ...(input.loops !== undefined && {loops: input.loops}),
          frames: input.frames.map(frame => ({...frame, data: halfWords(frame.data)})),
          ...description, sampleFormat: 'float16'};
      }
      return {width: input.width, height: input.height, ...(input.loops !== undefined && {loops: input.loops}), frames: input.frames, ...description};
    }
    if (input.parts !== undefined && (!Number.isSafeInteger(input.parts) || input.parts < 1))
      throw fail('JXL_INPUT', 'Invalid picture parts count; use a positive integer.');
    const description = described(input);
    const given = plainView(input.data), halves = typeof Float16Array === 'function' && given instanceof Float16Array;
    if (halves && description.sampleFormat !== undefined && description.sampleFormat !== 'float16') throw fail('JXL_INPUT', "sampleFormat: float16 for Float16Array");
    const words = halves ? halfWords(given) : given;
    const floats = opaque(words, input.width, input.height, halves || description.sampleFormat === 'float16', deferPacked);
    const data = floats ?? (ArrayBuffer.isView(words) && !(words instanceof DataView) ? plainView(words) : words);
    if (!deferPacked || floats === null) samples(data, input.width, input.height);
    return {data, width: input.width, height: input.height, ...description, ...(halves && {sampleFormat: 'float16'})};
  }
  if (typed) {
    const {data, width, height, colorSpace = 'srgb'} = input;
    dimensions(width, height, maxPixels);
    if (!ArrayBuffer.isView(data) || data instanceof DataView) throw fail('JXL_INPUT', RGBA);
    samples(data, width, height);
    admitSurface?.({width, height, byteLength: data.byteLength, colorSpace});
    return typedName.call(data) === 'Float16Array'
      ? {data: halfWords(data), width, height, colorSpace, sampleFormat: 'float16'}
      : {data: plainView(data), width, height, colorSpace};
  }
  const canvas = input && typeof input.getContext === 'function';
  const frame = typeof VideoFrame === 'function' && input instanceof VideoFrame;
  const bitmap = frame || typeof ImageBitmap !== 'undefined' && input instanceof ImageBitmap;
  if (!canvas && !bitmap) return input;
  const width = frame ? input.displayWidth : input.width, height = frame ? input.displayHeight : input.height;
  dimensions(width, height, maxPixels);
  const admit = byteLength => {
    admitSurface?.({width, height, byteLength});
    if (byteLength + retainedBytes > maxPendingBytes) throw fail('JXL_MEMORY', "image: raise maxPendingBytes");
  };
  admit(width * height * 4);
  let context = canvas ? context2d(input) : null;
  const half = halfAllowed && context?.getContextAttributes?.().colorType === 'float16';
  if (half) admit(width * height * 8);
  if (requested !== undefined && requested !== 'srgb' && requested !== 'display-p3')
    throw fail('JXL_OPTIONS', "readAs: srgb or display-p3");
  let copied;
  const copy = (from, space) => copy2d(from, width, height, space, c => { copied = c; });
  try {
    const target = bitmap ? copy(input, requested ?? 'srgb').canvas : input;
    context ??= context2d(target);
    if (!context) {
      const own = foreignSpace(target);
      const direct = requested === undefined || requested === own ? readWebGLNow(target) : null;
      if (direct) { gpuDrawn(direct.data); withCost(direct.data, direct.data.byteLength); return direct; }
      const read = read2d(copy(target, requested ?? own).drawn, width, height, requested, half);
      gpuDrawn(read.data);
      return read;
    }
    return read2d(context, width, height, requested, half);
  } finally {
    if (copied) copied.width = copied.height = 0;
  }
}

export const foreignSpace = canvas => glGpuSpace(canvas);
export const context2d = canvas => open2d(canvas);
