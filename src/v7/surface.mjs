import {dimensions, fail} from './primitives.mjs';
import {isPlainRecord} from './records.mjs';

export function surface(input, {maxPixels = 40000000, maxInputBytes = 268435456, retainedBytes = 0, admitSurface, colorSpace: requested} = {}) {
  if (isPlainRecord(input)) return input;
  if (typeof ImageData === 'function' && input instanceof ImageData) {
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
  if (width * height * 4 + retainedBytes > maxInputBytes) throw fail('JXL_MEMORY', 'The image exceeds the captured input budget.');
  if (requested !== undefined && requested !== 'srgb' && requested !== 'display-p3')
    throw fail('JXL_OPTIONS', 'A canvas or bitmap reads as colorSpace srgb or display-p3.');
  let target = input;
  if (bitmap) {
    target = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(width, height) : document.createElement('canvas');
    target.width = width; target.height = height;
    target.getContext('2d', {willReadFrequently: true, colorSpace: requested ?? 'srgb'}).drawImage(input, 0, 0);
  }
  const context = target.getContext('2d', {willReadFrequently: true});
  if (!context) throw fail('JXL_INPUT', 'The canvas must have a 2D context.');
  const colorSpace = requested ?? context.getContextAttributes?.().colorSpace ?? 'srgb';
  const lost = () => { if (context.isContextLost?.()) throw fail('JXL_INPUT', 'The canvas lost its 2D context, so its pixels are gone; draw it again.'); };
  lost();
  const pixels = context.getImageData(0, 0, width, height, {colorSpace});
  lost();
  return {data: pixels.data, width, height, colorSpace: pixels.colorSpace ?? 'srgb'};
}
