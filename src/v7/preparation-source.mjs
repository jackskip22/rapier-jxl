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
import {JOURNAL_FILE} from '../step-journal.mjs';
import {journalPNG} from './journal-png.mjs';
import {sRGBWithIntent} from './header-intent.mjs';

const INTENTS = new WeakMap();
export const sourceIntent = picture => INTENTS.get(picture);

export async function acquireSource(input, options, hooks = {}) {
  const {maxPixels = 40000000, readAs, signal} = options;
  check(signal);
  const budget = Math.max(DEFAULT_INPUT_BYTES, maxPixels * 16);
  let picture;
  if (isTexture(input)) {
    if (readAs !== undefined) throw fail('JXL_OPTIONS', 'A texture sets its own color; readAs is for images.');
    if (!hooks.readTexture) throw fail('JXL_UNSUPPORTED', 'This entry does not read GPU textures; use rapier-jxl.');
    picture = await hooks.readTexture(input, maxPixels);
  } else if (hooks.journal !== undefined && input?.[JOURNAL_FILE] !== undefined) {
    const file = input[JOURNAL_FILE];
    picture = await journalPNG(file, readAs, maxPixels, hooks.journal) ?? await image(new Blob([file.subarray(0, file.length)]), {readAs}, {signal, maxPixels, deep: hooks.deep, phone: hooks.phone});
  } else if (typeof Blob === 'function' && input instanceof Blob) {
    picture = await image(input, {readAs}, {signal, maxPixels, deep: hooks.deep, phone: hooks.phone});
  } else if (hooks.journal !== undefined) {
    const {data, width, height, colorSpace} = input;
    dimensions(width, height, maxPixels);
    picture = {data, width, height, ...(colorSpace && {colorSpace})};
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
  let intent;
  [picture, intent] = sRGBWithIntent(picture);
  hooks.reference?.(picture);
  const oriented = await (hooks.orient ?? orientSamples)(picture, {signal, maxPixels});
  if (intent !== undefined) INTENTS.set(oriented, intent);
  return oriented;
}
