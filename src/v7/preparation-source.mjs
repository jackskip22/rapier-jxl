// SPDX-License-Identifier: MIT
import {image, pixels} from './input.mjs';
import {own, DEFAULT_INPUT_BYTES} from './ownership.mjs';
import {isTexture} from './texture.mjs';
import {isDecoded, fromDecoded} from './describe.mjs';
import {admitPixels} from '../admit.mjs';
import {EDGE} from '../limits.mjs';
import {admitSampleFormat} from '../admit-samples.mjs';
import {check, fail, dimensions, PIXELS, isBlob, abortable} from './primitives.mjs';
import {orientSamples, resizeBands} from '../sample-transforms.mjs';
import {JOURNAL_FILE} from '../step-journal.mjs';
import {journalPNG} from './journal-png.mjs';
import {sRGBWithIntent} from './header-intent.mjs';
import {withArenaLease} from '../call-scope.mjs';
import {prepareKernels, ensureKernels} from '../kernels.mjs';
import {wasmRequired} from '../capture-wasm-error.mjs';

const INTENTS = new WeakMap();
export const sourceIntent = picture => INTENTS.get(picture);
const SIZED = new WeakMap();
export const sizedPictures = source => SIZED.get(source);

export async function acquireSource(input, options, hooks = {}) {
  const {maxPixels = PIXELS, readAs, signal} = options;
  check(signal);
  const budget = Math.max(DEFAULT_INPUT_BYTES, maxPixels * 16);
  let picture, sized;
  if (isTexture(input)) {
    if (readAs !== undefined) throw fail('JXL_OPTIONS', 'readAs: not with texture');
    if (!hooks.readTexture) throw fail('JXL_UNSUPPORTED', 'texture: use jpegxl');
    picture = await abortable(hooks.readTexture(input, maxPixels), signal);
  } else if (hooks.journal !== undefined && input?.[JOURNAL_FILE] !== undefined) {
    const file = input[JOURNAL_FILE];
    picture = await withArenaLease(signal, async () => await journalPNG(file, readAs, maxPixels, hooks.journal) ?? image(new Blob([file.subarray(0, file.length)]), {readAs}, {signal, maxPixels, deep: hooks.deep, phone: hooks.phone, jpegPixels: hooks.jpegPixels}));
  } else if (isBlob(input)) {
    const jpegPixels = hooks.sizes && hooks.jpegPixels && ((bytes, read) => hooks.jpegPixels(bytes, {...read, bands: ({width, height, orientation, ...color}) => {
      const targets = orientation === 1 && hooks.sizes({width, height});
      if (!targets || !targets.every(t => t.width < width && t.height < height)) return null;
      sized = resizeBands({width, height, ...color}, targets);
      return (y, rows, view) => sized.feed(y, rows, view);
    }}));
    if (jpegPixels && (!await prepareKernels() || !ensureKernels())) throw wasmRequired();
    picture = await withArenaLease(signal, () => image(input, {readAs}, {signal, maxPixels, deep: hooks.deep, phone: hooks.phone, jpegPixels: jpegPixels || hooks.jpegPixels}));
  } else if (hooks.journal !== undefined) {
    const {data, width, height, colorSpace, colorEncoding, icc} = input;
    dimensions(width, height, maxPixels);
    picture = {data, width, height, ...(colorSpace && {colorSpace}), ...(colorEncoding && {colorEncoding}), ...(icc && {icc})};
  } else {
    const source = isDecoded(input) ? fromDecoded(input) : input;
    if (source?.frames) throw fail('JXL_UNSUPPORTED', 'source: single still image required');
    picture = own(pixels(source, {readAs}, maxPixels, true), maxPixels, budget);
  }
  check(signal);
  if (sized && !picture.data) return sizedSource(picture, sized.finish(), maxPixels);
  if (picture?.frames) throw fail('JXL_UNSUPPORTED', 'source: single still image required');
  dimensions(picture?.width, picture?.height, maxPixels);
  admitPixels(picture.data, picture.width, picture.height, {edge: EDGE, pixels: maxPixels});
  admitSampleFormat(picture.data, picture);
  let intent;
  [picture, intent] = sRGBWithIntent(picture);
  hooks.reference?.(picture);
  const oriented = await withArenaLease(signal, () => (hooks.orient ?? orientSamples)(picture, {signal, maxPixels}));
  if (intent !== undefined) INTENTS.set(oriented, intent);
  return oriented;
}

function sizedSource({orientation: _one, ...whole}, pictures, maxPixels) {
  const [described, intent] = sRGBWithIntent({...whole, data: new Uint8Array(0)});
  const {data: _none, ...source} = described;
  dimensions(source.width, source.height, maxPixels);
  admitSampleFormat(new Uint8Array(0), described);
  const {width: _w, height: _h, ...color} = source;
  if (intent !== undefined) INTENTS.set(source, intent);
  SIZED.set(source, pictures.map(({rgb, width, height}) => ({...color, rgb, width, height})));
  return source;
}
