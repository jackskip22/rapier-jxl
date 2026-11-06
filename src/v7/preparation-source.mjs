// SPDX-License-Identifier: MIT
import {image, pixels} from './input.mjs';
import {own, DEFAULT_INPUT_BYTES} from './ownership.mjs';
import {isTexture} from './texture.mjs';
import {isDecoded, fromDecoded} from './describe.mjs';
import {admitPixels} from '../admit.mjs';
import {EDGE} from '../limits.mjs';
import {admitSampleFormat} from '../admit-samples.mjs';
import {check, fail, dimensions} from './primitives.mjs';
import {orientSamples} from '../sample-transforms.mjs';

export async function acquireSource(input, options, hooks = {}) {
  const {maxPixels = 40000000, readAs, signal} = options;
  check(signal);
  const budget = Math.max(DEFAULT_INPUT_BYTES, maxPixels * 16);
  let picture;
  if (isTexture(input)) {
    if (readAs !== undefined) throw fail('JXL_OPTIONS', 'A texture sets its own color; readAs is for images.');
    if (!hooks.readTexture) throw fail('JXL_UNSUPPORTED', 'This entry does not read GPU textures; use rapier-jxl.');
    picture = await hooks.readTexture(input, maxPixels);
  } else if (typeof Blob === 'function' && input instanceof Blob) {
    picture = await image(input, {readAs}, {signal, maxPixels, deep: hooks.deep, phone: hooks.phone});
  } else {
    const source = isDecoded(input) ? fromDecoded(input) : input;
    if (source?.frames) throw fail('JXL_UNSUPPORTED', 'Image preparation takes one still image.');
    picture = own(pixels(source, {readAs}, maxPixels, true), maxPixels, budget);
  }
  check(signal);
  if (picture?.frames) throw fail('JXL_UNSUPPORTED', 'Image preparation takes one still image.');
  dimensions(picture?.width, picture?.height, maxPixels);
  admitPixels(picture.data, picture.width, picture.height, {edge: EDGE, pixels: maxPixels});
  admitSampleFormat(picture.data, picture);
  hooks.reference?.(picture);
  return (hooks.orient ?? orientSamples)(picture, {signal, maxPixels});
}
