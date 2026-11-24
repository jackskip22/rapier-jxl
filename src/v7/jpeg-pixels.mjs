// SPDX-License-Identifier: MIT
import {fail} from './primitives.mjs';
import {configuredDecoder} from '../shown-picture.mjs';

const JPEG_PIXELS = Symbol.for('rapier-jxl.jpeg.pixels');

const reader = () => configuredDecoder()?.recompress?.[JPEG_PIXELS];
const SETUP = 'jpeg pixels: configureDecoder(decode, null, recompress); jpegxl/decode, jpegxl/jpeg or RGBA pixels';

export function jpegPixelsReady() {
  if (typeof createImageBitmap !== 'function' && !reader()) throw fail('JXL_PLATFORM', SETUP);
}

export async function jpegPixels(bytes, {maxPixels, signal, bands} = {}) {
  const read = reader();
  if (!read) throw fail('JXL_PLATFORM', SETUP);
  return read(bytes, {maxPixels, signal, scale: 8, ...(bands && {bands})});
}
