// SPDX-License-Identifier: MIT
import {acquireSource} from './preparation-source.mjs';
import {resizeSamples} from '../sample-transforms.mjs';
import {own, DEFAULT_INPUT_BYTES} from './ownership.mjs';
import {check, fail, object, pixelLimit} from './primitives.mjs';
import {outputSides, outputSize} from './preparation-sides.mjs';
import {browserResizable, browserResizer} from './browser-resize.mjs';

export async function mapPrepared(input, outputs, options, consume, hooks = {}) {
  const settings = object(options), maxPixels = pixelLimit(settings.maxPixels), {signal, readAs} = settings;
  if (typeof consume !== 'function') throw fail('JXL_OPTIONS', "Missing prepared-image consumer; pass a function.");
  if (!Array.isArray(outputs) || !outputs.length) throw fail('JXL_OPTIONS', "Invalid outputs; pass a nonempty array of dimensions.");
  const requests = own(outputs, maxPixels, Math.max(DEFAULT_INPUT_BYTES, maxPixels * 16));
  if (requests.length !== outputs.length) throw fail('JXL_OPTIONS', "A prepared output has no dimensions; supply width or height.");
  for (const value of requests) {
    const request = object(value, 'An output');
    for (const key of Object.keys(request)) if (key !== 'width' && key !== 'height')
      throw fail('JXL_OPTIONS', "Invalid prepared output dimensions; supply width and height.");
    outputSides(request.width, request.height, maxPixels);
  }
  check(signal);
  const picture = await acquireSource(input, {signal, readAs, maxPixels}, hooks), results = [];
  const sizes = requests.map(request => outputSize(request, picture, maxPixels));
  const browser = !hooks.resize && browserResizable(picture, typeof Blob === 'function' && input instanceof Blob) ? browserResizer(picture, sizes, signal) : null;
  const shared = new Map();
  try {
    for (let i = 0; i < requests.length; i++) {
      check(signal);
      const {width, height} = sizes[i];
      const first = sizes.findIndex(s => s.width === width && s.height === height);
      const resized = first < i ? shared.get(first) : browser ? await browser.make(i) : await (hooks.resize ?? resizeSamples)(picture, width, height, {signal, maxPixels});
      if (first === i && sizes.some((s, j) => j > i && s.width === width && s.height === height)) shared.set(i, resized);
      check(signal);
      const via = browser?.via(i);
      const result = await consume(resized, i, picture, browser ? {resizer: 'browser', ...(via.length && {via})} : undefined);
      browser?.done(i);
      if (first < i && !sizes.some((s, j) => j > i && s.width === width && s.height === height)) shared.delete(first);
      check(signal); results.push(result);
    }
  } finally { browser?.close(); }
  return results;
}
