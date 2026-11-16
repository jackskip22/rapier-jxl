// SPDX-License-Identifier: MIT
import {readWebGLNow} from './webgl-read.mjs';
import {isVideo, videoFrame} from './video.mjs';
import {dimensions, fail, plainView, lostBlank, proveRead, LOST, PIXELS} from './primitives.mjs';
import {isPlainRecord} from './records.mjs';
import {withCost, DEFAULT_INPUT_BYTES} from './ownership.mjs';
import {DESCRIPTION, described, isDecoded, fromDecoded} from './describe.mjs';
const STILL_FIELDS = /* @__PURE__ */ new Set(['data', 'width', 'height', ...DESCRIPTION]);
const ANIMATION_FIELDS = /* @__PURE__ */ new Set(['width', 'height', 'frames', 'loops', ...DESCRIPTION]);

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
const samples = (data, width, height) => { if (sized(width, height) && ArrayBuffer.isView(data) && !(data instanceof DataView) && data.length !== width * height * 4) throw fail('JXL_INPUT', RGBA); };
export const admitSamples = ({data, width, height}) => samples(data, width, height);
export function admitFrames({width, height, frames}) {
  if (sized(width, height)) for (const frame of frames) {
    samples(frame?.data, width, height);
    if (frame && typeof frame === 'object' && (typeof frame.duration !== 'number' || !Number.isFinite(frame.duration) || frame.duration < 0 || frame.duration > 0xFFFFFFFF))
      throw fail('JXL_INPUT', "Invalid frame duration; use finite nonnegative milliseconds.");
  }
}
export function surface(input, options = {}) {
  if (isVideo(input)) { const frame = videoFrame(input); try { return surface(frame, options); } finally { frame.close(); } }
  const {maxPixels = PIXELS, maxPendingBytes = DEFAULT_INPUT_BYTES, retainedBytes = 0, admitSurface, readAs: requested, half: halfAllowed = false, deferPacked = false} = options;
  const typed = typeof ImageData === 'function' && input instanceof ImageData;
  if ((typed || isPlainRecord(input)) && requested !== undefined)
    throw fail('JXL_OPTIONS', "readAs does not apply to raw pixels; set colorSpace on the image.");
  if (isPlainRecord(input) && Object.values(Object.getOwnPropertyDescriptors(input)).some(field => !('value' in field)))
    throw fail('JXL_INPUT', "Queue records contain accessors; pass plain data values.");
  if (isPlainRecord(input) && isDecoded(input)) return fromDecoded(input);
  if (isPlainRecord(input)) {
    const animation = Array.isArray(input.frames), known = animation ? ANIMATION_FIELDS : STILL_FIELDS;
    for (const key of Object.keys(input)) if (!known.has(key))
      throw fail('JXL_INPUT', `Unknown picture field: ${key}; use {data, width, height} and ${DESCRIPTION.join(", ")}.`);
    if (animation) {
      const description = described(input);
      if (typeof Float16Array === 'function' && input.frames.some(frame => frame?.data instanceof Float16Array)) {
        if (description.sampleFormat !== undefined && description.sampleFormat !== 'float16') throw fail('JXL_INPUT', "Float16Array sample format conflicts; use sampleFormat float16.");
        if (!input.frames.every(frame => frame?.data instanceof Float16Array)) throw fail('JXL_INPUT', "Frame sample arrays differ; pass the same sample array type for every frame.");
        return {width: input.width, height: input.height, ...(input.loops !== undefined && {loops: input.loops}),
          frames: input.frames.map(frame => ({...frame, data: new Uint16Array(frame.data.buffer, frame.data.byteOffset, frame.data.length)})),
          ...description, sampleFormat: 'float16'};
      }
      return {width: input.width, height: input.height, ...(input.loops !== undefined && {loops: input.loops}), frames: input.frames, ...description};
    }
    const description = described(input);
    const halves = typeof Float16Array === 'function' && input.data instanceof Float16Array;
    if (halves && description.sampleFormat !== undefined && description.sampleFormat !== 'float16') throw fail('JXL_INPUT', "Float16Array sample format conflicts; use sampleFormat float16.");
    const words = halves ? new Uint16Array(input.data.buffer, input.data.byteOffset, input.data.length) : input.data;
    const floats = opaque(words, input.width, input.height, halves || description.sampleFormat === 'float16', deferPacked);
    const data = floats ?? (ArrayBuffer.isView(words) && !(words instanceof DataView) ? plainView(words) : words);
    if (!deferPacked || floats === null) samples(data, input.width, input.height);
    return {data, width: input.width, height: input.height, ...description, ...(halves && {sampleFormat: 'float16'})};
  }
  if (typed) {
    const {data, width, height, colorSpace = 'srgb'} = input;
    dimensions(width, height, maxPixels);
    admitSurface?.({width, height, byteLength: data.byteLength, colorSpace});
    return typeof Float16Array === 'function' && data instanceof Float16Array
      ? {data: new Uint16Array(data.buffer, data.byteOffset, data.length), width, height, colorSpace, sampleFormat: 'float16'}
      : {data, width, height, colorSpace};
  }
  const canvas = input && typeof input.getContext === 'function';
  const frame = typeof VideoFrame === 'function' && input instanceof VideoFrame;
  const bitmap = frame || typeof ImageBitmap !== 'undefined' && input instanceof ImageBitmap;
  if (!canvas && !bitmap) return input;
  const width = frame ? input.displayWidth : input.width, height = frame ? input.displayHeight : input.height;
  dimensions(width, height, maxPixels);
  const admit = byteLength => {
    admitSurface?.({width, height, byteLength});
    if (byteLength + retainedBytes > maxPendingBytes) throw fail('JXL_MEMORY', "Image exceeds maxPendingBytes; pass a smaller image or raise maxPendingBytes.");
  };
  admit(width * height * 4);
  let context = canvas ? context2d(input) : null;
  const half = halfAllowed && context?.getContextAttributes?.().colorType === 'float16';
  if (half) admit(width * height * 8);
  if (requested !== undefined && requested !== 'srgb' && requested !== 'display-p3')
    throw fail('JXL_OPTIONS', "Invalid readAs; use srgb or display-p3.");
  let copied;
  const copy = (from, space) => {
    const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(width, height) : document.createElement('canvas');
    copied = canvas;
    canvas.width = width; canvas.height = height;
    const drawn = canvas.getContext('2d', {willReadFrequently: true, colorSpace: space});
    if (!drawn) throw fail('JXL_PLATFORM', 'No 2D canvas here; pass RGBA pixels.');
    drawn.drawImage(from, 0, 0);
    return {canvas, drawn};
  };
  try {
    let target = input;
    if (bitmap) target = copy(input, requested ?? 'srgb').canvas;
    context ??= context2d(target);
    if (!context) {
      const own = foreignSpace(target);
      const direct = requested === undefined || requested === own ? readWebGLNow(target) : null;
      if (direct) { withCost(direct.data, direct.data.byteLength); return direct; }
      context = copy(target, requested ?? own).drawn;
    }
    const colorSpace = requested ?? context.getContextAttributes?.().colorSpace ?? 'srgb';
    proveRead(context);
    let pixels;
    try { pixels = context.getImageData(0, 0, width, height, half ? {colorSpace, pixelFormat: 'rgba-float16'} : {colorSpace}); }
    catch (cause) { throw Object.assign(fail('JXL_INPUT', "Canvas read failed; draw it again or pass RGBA pixels."), {cause}); }
    if (lostBlank(context, pixels.data)) throw fail('JXL_INPUT', LOST);
    const halfRead = half && pixels.data.BYTES_PER_ELEMENT === 2;
    const data = halfRead ? new Uint16Array(pixels.data.buffer, pixels.data.byteOffset, pixels.data.length) : pixels.data;
    withCost(data, data.byteLength);
    return {data, width, height, colorSpace: pixels.colorSpace ?? 'srgb', ...(halfRead && {transferFunction: 'srgb', sampleFormat: 'float16'})};
  } finally {
    if (copied) copied.width = copied.height = 0;
  }
}

export function foreignSpace(canvas) {
  for (const id of ['webgl2', 'webgl', 'webgpu']) {
    let c; try { c = canvas.getContext(id); } catch {}
    if (c?.isContextLost?.()) throw fail('JXL_INPUT', "Canvas lost its context; draw it again.");
    if (c) return c.drawingBufferColorSpace ?? c.getConfiguration?.()?.colorSpace ?? 'srgb';
  }
  throw fail('JXL_INPUT', "Canvas has no readable context; create a 2D, WebGL, or WebGPU context.");
}

export function context2d(canvas) {
  try { return canvas.getContext('2d', {willReadFrequently: true}); }
  catch (cause) { throw Object.assign(fail('JXL_INPUT', "Canvas has no readable 2D context; pass its OffscreenCanvas if transferred, or pass RGBA pixels."), {cause}); }
}
