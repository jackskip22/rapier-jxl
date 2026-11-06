import {readWebGLNow} from './webgl-read.mjs';
import {isVideo, videoFrame} from './video.mjs';
import {dimensions, fail, plainView, lostBlank, proveRead, LOST} from './primitives.mjs';
import {isPlainRecord} from './records.mjs';
import {withCost} from './ownership.mjs';
import {DESCRIPTION, described, isDecoded, fromDecoded} from './describe.mjs';
const STILL_FIELDS = new Set(['data', 'width', 'height', ...DESCRIPTION]);
const ANIMATION_FIELDS = new Set(['width', 'height', 'frames', 'loops', ...DESCRIPTION]);

export function surface(input, options = {}) {
  if (isVideo(input)) { const frame = videoFrame(input); try { return surface(frame, options); } finally { frame.close(); } }
  const {maxPixels = 40000000, maxPendingBytes = 268435456, retainedBytes = 0, admitSurface, readAs: requested, half: halfAllowed = false} = options;
  const typed = typeof ImageData === 'function' && input instanceof ImageData;
  if ((typed || isPlainRecord(input)) && requested !== undefined)
    throw fail('JXL_OPTIONS', 'readAs is for a canvas, bitmap or Blob; for pixels, set colorSpace on the image.');
  if (isPlainRecord(input) && Object.values(Object.getOwnPropertyDescriptors(input)).some(field => !('value' in field)))
    throw fail('JXL_INPUT', 'Queue records cannot contain accessors.');
  if (isPlainRecord(input) && isDecoded(input)) return fromDecoded(input);
  if (isPlainRecord(input)) {
    const animation = Array.isArray(input.frames), known = animation ? ANIMATION_FIELDS : STILL_FIELDS;
    for (const key of Object.keys(input)) if (!known.has(key))
      throw fail('JXL_INPUT', `Unknown picture field: ${key}. A picture is {data, width, height} and ${DESCRIPTION.join(', ')}.`);
    if (animation)
      return {width: input.width, height: input.height, ...(input.loops !== undefined && {loops: input.loops}), frames: input.frames, ...described(input)};
    const description = described(input);
    if (typeof Float16Array === 'function' && input.data instanceof Float16Array) {
      if (description.sampleFormat !== undefined && description.sampleFormat !== 'float16') throw fail('JXL_INPUT', 'A Float16Array holds float16 samples.');
      return {data: new Uint16Array(input.data.buffer, input.data.byteOffset, input.data.length), width: input.width, height: input.height, ...description, sampleFormat: 'float16'};
    }
    return {data: ArrayBuffer.isView(input.data) && !(input.data instanceof DataView) ? plainView(input.data) : input.data, width: input.width, height: input.height, ...description};
  }
  if (typed) {
    const {data, width, height, colorSpace = 'srgb'} = input;
    dimensions(width, height, maxPixels);
    admitSurface?.({width, height, byteLength: data.byteLength, colorSpace});
    if (typeof Float16Array === 'function' && data instanceof Float16Array)
      return {data: new Uint16Array(data.buffer, data.byteOffset, data.length), width, height, colorSpace, sampleFormat: 'float16'};
    return {data, width, height, colorSpace};
  }
  const canvas = input && typeof input.getContext === 'function';
  const frame = typeof VideoFrame === 'function' && input instanceof VideoFrame;
  const bitmap = frame || typeof ImageBitmap !== 'undefined' && input instanceof ImageBitmap;
  if (!canvas && !bitmap) return input;
  const {width, height} = frame ? {width: input.displayWidth, height: input.displayHeight} : input;
  dimensions(width, height, maxPixels);
  const admit = byteLength => {
    admitSurface?.({width, height, byteLength});
    if (byteLength + retainedBytes > maxPendingBytes) throw fail('JXL_MEMORY', 'The image is over maxPendingBytes.');
  };
  admit(width * height * 4);
  let context = canvas ? input.getContext('2d', {willReadFrequently: true}) : null;
  const half = halfAllowed && context?.getContextAttributes?.().colorType === 'float16';
  if (half) admit(width * height * 8);
  if (requested !== undefined && requested !== 'srgb' && requested !== 'display-p3')
    throw fail('JXL_OPTIONS', 'readAs is srgb or display-p3.');
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
    context ??= target.getContext('2d', {willReadFrequently: true});
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
    catch (cause) { throw Object.assign(fail('JXL_INPUT', 'The canvas could not be read: ' + (cause?.message || cause)), {cause}); }
    if (lostBlank(context, pixels.data)) throw fail('JXL_INPUT', LOST);
    const data = half && pixels.data.BYTES_PER_ELEMENT === 2
      ? new Uint16Array(pixels.data.buffer, pixels.data.byteOffset, pixels.data.length) : pixels.data;
    withCost(data, data.byteLength);
    if (half && pixels.data.BYTES_PER_ELEMENT === 2)
      return {data, width, height, colorSpace: pixels.colorSpace ?? 'srgb',
        transferFunction: 'srgb', sampleFormat: 'float16'};
    return {data, width, height, colorSpace: pixels.colorSpace ?? 'srgb'};
  } finally {
    if (copied) copied.width = copied.height = 0;
  }
}

export function foreignSpace(canvas) {
  for (const id of ['webgl2', 'webgl', 'webgpu']) {
    let c; try { c = canvas.getContext(id); } catch {}
    if (c?.isContextLost?.()) throw fail('JXL_INPUT', 'The canvas lost its context; draw it again.');
    if (c) return c.drawingBufferColorSpace ?? c.getConfiguration?.()?.colorSpace ?? 'srgb';
  }
  throw fail('JXL_INPUT', 'The canvas must have a 2D, WebGL or WebGPU context.');
}
