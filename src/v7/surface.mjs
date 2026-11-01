import {readWebGLNow} from './webgl-read.mjs';
import {isVideo, videoFrame} from './video.mjs';
import {dimensions, fail} from './primitives.mjs';
import {isPlainRecord} from './records.mjs';
import {DESCRIPTION, described, isDecoded, fromDecoded} from './describe.mjs';
const STILL_FIELDS = new Set(['data', 'width', 'height', ...DESCRIPTION]);
const ANIMATION_FIELDS = new Set(['width', 'height', 'frames', 'loops', ...DESCRIPTION]);

export function surface(input, options = {}) {
  if (isVideo(input)) { const frame = videoFrame(input); try { return surface(frame, options); } finally { frame.close(); } }
  const {maxPixels = 40000000, maxPendingBytes = 268435456, retainedBytes = 0, admitSurface, readAs: requested, half: halfAllowed = false} = options;
  const typed = typeof ImageData === 'function' && input instanceof ImageData;
  if ((typed || isPlainRecord(input)) && requested !== undefined)
    throw fail('JXL_OPTIONS', 'readAs converts a canvas, bitmap or Blob as it is read; pixels describe themselves: set colorSpace on the image.');
  if (isPlainRecord(input) && Object.values(Object.getOwnPropertyDescriptors(input)).some(field => !('value' in field)))
    throw fail('JXL_INPUT', 'Queue records cannot contain accessors.');
  if (isPlainRecord(input) && isDecoded(input)) return fromDecoded(input);
  if (isPlainRecord(input)) {
    const animation = Array.isArray(input.frames), known = animation ? ANIMATION_FIELDS : STILL_FIELDS;
    for (const key of Object.keys(input)) if (!known.has(key))
      throw fail('JXL_INPUT', `Unknown picture field: ${key}. A picture is {data, width, height} and its description (${DESCRIPTION.join(', ')}).`);
    if (animation)
      return {width: input.width, height: input.height, ...(input.loops !== undefined && {loops: input.loops}), frames: input.frames, ...described(input)};
    const description = described(input);
    if (typeof Float16Array === 'function' && input.data instanceof Float16Array) {
      if (description.sampleFormat !== undefined && description.sampleFormat !== 'float16') throw fail('JXL_INPUT', 'A Float16Array holds float16 samples.');
      return {data: new Uint16Array(input.data.buffer, input.data.byteOffset, input.data.length), width: input.width, height: input.height, ...description, sampleFormat: 'float16'};
    }
    return {data: input.data, width: input.width, height: input.height, ...description};
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
    if (byteLength + retainedBytes > maxPendingBytes) throw fail('JXL_MEMORY', 'The image exceeds the pending input budget (maxPendingBytes).');
  };
  admit(width * height * 4);
  let context = canvas ? input.getContext('2d', {willReadFrequently: true}) : null;
  const half = halfAllowed && context?.getContextAttributes?.().colorType === 'float16';
  if (half) admit(width * height * 8);
  if (requested !== undefined && requested !== 'srgb' && requested !== 'display-p3')
    throw fail('JXL_OPTIONS', 'readAs is srgb or display-p3.');
  let target = input;
  if (bitmap) {
    target = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(width, height) : document.createElement('canvas');
    target.width = width; target.height = height;
    const drawn = target.getContext('2d', {willReadFrequently: true, colorSpace: requested ?? 'srgb'});
    if (!drawn) throw fail('JXL_PLATFORM', 'This runtime has no 2D canvas to read the picture. Supply RGBA pixels, a 16-bit PNG Blob, or use JPEG recompression.');
    drawn.drawImage(input, 0, 0);
  }
  context ??= target.getContext('2d', {willReadFrequently: true});
  if (!context) {
    const own = foreignSpace(target);
    const direct = requested === undefined || requested === own ? readWebGLNow(target) : null;
    if (direct) return direct;
    context = new OffscreenCanvas(width, height).getContext('2d', {willReadFrequently: true, colorSpace: requested ?? own});
    context.drawImage(target, 0, 0);
  }
  const colorSpace = requested ?? context.getContextAttributes?.().colorSpace ?? 'srgb';
  const lost = () => { if (context.isContextLost?.()) throw fail('JXL_INPUT', 'The canvas lost its 2D context, so its pixels are gone; draw it again.'); };
  lost();
  let pixels;
  try { pixels = context.getImageData(0, 0, width, height, half ? {colorSpace, pixelFormat: 'rgba-float16'} : {colorSpace}); }
  catch (cause) { throw Object.assign(fail('JXL_INPUT', 'The canvas could not be read: ' + (cause?.message || cause)), {cause}); }
  lost();
  if (half && pixels.data.BYTES_PER_ELEMENT === 2)
    return {data: new Uint16Array(pixels.data.buffer, pixels.data.byteOffset, pixels.data.length), width, height, colorSpace: pixels.colorSpace ?? 'srgb',
      transferFunction: 'srgb', sampleFormat: 'float16'};
  return {data: pixels.data, width, height, colorSpace: pixels.colorSpace ?? 'srgb'};
}

export function foreignSpace(canvas) {
  for (const id of ['webgl2', 'webgl', 'webgpu']) {
    let c; try { c = canvas.getContext(id); } catch {}
    if (c?.isContextLost?.()) throw fail('JXL_INPUT', 'The canvas lost its context; draw it again.');
    if (c) return c.drawingBufferColorSpace ?? c.getConfiguration?.()?.colorSpace ?? 'srgb';
  }
  throw fail('JXL_INPUT', 'The canvas must have a 2D, WebGL or WebGPU context.');
}
