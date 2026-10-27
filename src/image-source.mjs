// SPDX-License-Identifier: MIT
import {LIMITS} from './bits.mjs';
import {admitPixels, admitSize, fault} from './admit.mjs';

/** Borrow pixel inputs; own and close only bitmaps made here. No URL fetching. */
export async function readImage(source, keepJpeg = false, limits = LIMITS) {
  if (source?.data !== undefined) {
    admitPixels(source.data, source.width, source.height, limits);
    return {data: source.data, width: source.width, height: source.height,
      ...(source.colorSpace === undefined ? {} : {colorSpace: source.colorSpace})};
  }
  if (keepJpeg && typeof Blob === 'function' && source instanceof Blob) {
    const bytes = new Uint8Array(await source.arrayBuffer());
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return {jpeg: bytes};
  }
  if (source?.getContext) {
    admitSize(source.width, source.height, limits);
    const context = source.getContext('2d', {willReadFrequently: true});
    if (context) {
      const pixels = context.getImageData(0, 0, source.width, source.height);
      return {data: pixels.data, width: pixels.width, height: pixels.height, colorSpace: pixels.colorSpace ?? 'srgb'};
    }
  }
  const borrowed = typeof ImageBitmap === 'function' && source instanceof ImageBitmap;
  if (!borrowed && typeof createImageBitmap !== 'function') throw fault('JXL_INPUT', 'This runtime needs RGBA pixels; browser image decoding is unavailable.');
  let bitmap;
  try {
    bitmap = borrowed ? source : await createImageBitmap(source);
    admitSize(bitmap.width, bitmap.height, limits);
    const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(bitmap.width, bitmap.height)
      : typeof document === 'object' ? Object.assign(document.createElement('canvas'), {width: bitmap.width, height: bitmap.height}) : null;
    const context = canvas?.getContext('2d', {willReadFrequently: true, colorSpace: 'srgb'});
    if (!context) throw fault('JXL_INPUT', 'This runtime needs RGBA pixels; a 2D canvas is unavailable.');
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height);
    return {data: pixels.data, width: pixels.width, height: pixels.height, colorSpace: pixels.colorSpace ?? 'srgb'};
  } finally { if (!borrowed) bitmap?.close(); }
}
