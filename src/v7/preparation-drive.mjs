// SPDX-License-Identifier: MIT
import {acquireSource} from './preparation-source.mjs';
import {resizeSamples} from '../sample-transforms.mjs';
import {own, DEFAULT_INPUT_BYTES} from './ownership.mjs';
import {check, fail, object, pixelLimit} from './primitives.mjs';
import {outputSides, outputSize} from './preparation-sides.mjs';

export async function mapPrepared(input, outputs, options, consume, hooks = {}) {
  const settings = object(options), maxPixels = pixelLimit(settings.maxPixels), {signal, readAs} = settings;
  if (typeof consume !== 'function') throw fail('JXL_OPTIONS', 'A prepared-image consumer is required.');
  if (!Array.isArray(outputs) || !outputs.length) throw fail('JXL_OPTIONS', 'outputs is a nonempty array of dimensions.');
  const requests = own(outputs, maxPixels, Math.max(DEFAULT_INPUT_BYTES, maxPixels * 16));
  if (requests.length !== outputs.length) throw fail('JXL_OPTIONS', 'Every prepared-image output needs dimensions.');
  for (const value of requests) {
    const request = object(value, 'An output');
    for (const key of Object.keys(request)) if (key !== 'width' && key !== 'height')
      throw fail('JXL_OPTIONS', 'A prepared-image output specifies width and height.');
    outputSides(request.width, request.height, maxPixels);
  }
  check(signal);
  const picture = await acquireSource(input, {signal, readAs, maxPixels}, hooks), results = [];
  for (let i = 0; i < requests.length; i++) {
    check(signal);
    const {width, height} = outputSize(requests[i], picture, maxPixels);
    const resized = await (hooks.resize ?? resizeSamples)(picture, width, height, {signal, maxPixels});
    check(signal);
    const result = await consume(resized, i, picture);
    check(signal); results.push(result);
  }
  return results;
}
