import {dimensions, fail} from './primitives.mjs';
import {isPlainRecord} from './records.mjs';
import {DESCRIPTION, described, isDecoded, fromDecoded} from './describe.mjs';
const STILL_FIELDS = new Set(['data', 'width', 'height', ...DESCRIPTION]);
const ANIMATION_FIELDS = new Set(['width', 'height', 'frames', 'loops', ...DESCRIPTION]);

export function surface(input, {maxPixels = 40000000, maxPendingBytes = 268435456, retainedBytes = 0, admitSurface, readAs: requested} = {}) {
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
    return {data: input.data, width: input.width, height: input.height, ...described(input)};
  }
  if (typed) {
    const {data, width, height, colorSpace = 'srgb'} = input;
    dimensions(width, height, maxPixels);
    admitSurface?.({width, height, byteLength: data.byteLength, colorSpace});
    return {data, width, height, colorSpace};
  }
  const canvas = input && typeof input.getContext === 'function';
  const bitmap = typeof ImageBitmap !== 'undefined' && input instanceof ImageBitmap;
  if (!canvas && !bitmap) return input;
  const {width, height} = input;
  dimensions(width, height, maxPixels);
  admitSurface?.({width, height});
  if (width * height * 4 + retainedBytes > maxPendingBytes) throw fail('JXL_MEMORY', 'The image exceeds the pending input budget (maxPendingBytes).');
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
  const context = target.getContext('2d', {willReadFrequently: true});
  if (!context) throw fail('JXL_INPUT', 'The canvas must have a 2D context.');
  const colorSpace = requested ?? context.getContextAttributes?.().colorSpace ?? 'srgb';
  const lost = () => { if (context.isContextLost?.()) throw fail('JXL_INPUT', 'The canvas lost its 2D context, so its pixels are gone; draw it again.'); };
  lost();
  let pixels;
  try { pixels = context.getImageData(0, 0, width, height, {colorSpace}); }
  catch (cause) { throw Object.assign(fail('JXL_INPUT', 'The canvas could not be read: ' + (cause?.message || cause)), {cause}); }
  lost();
  return {data: pixels.data, width, height, colorSpace: pixels.colorSpace ?? 'srgb'};
}
