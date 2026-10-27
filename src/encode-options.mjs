// SPDX-License-Identifier: MIT
import {fault} from './fault.mjs';
import {checkSignal} from './async-job.mjs';

export function imageOptions(options, limits) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw fault('JXL_OPTIONS', 'Encoding options must be an object.');
  checkSignal(options.signal);
  if (options.onProgress !== undefined && typeof options.onProgress !== 'function') throw fault('JXL_OPTIONS', 'onProgress must be a function.');
  if (options.gpu !== undefined && options.gpu !== 'auto' && options.gpu !== 'cpu') throw fault('JXL_OPTIONS', 'gpu is auto or cpu.');
  const maxPixels = options.maxPixels === undefined ? limits.pixels : options.maxPixels;
  if (!Number.isSafeInteger(maxPixels) || maxPixels < 1 || maxPixels > limits.pixels) throw fault('JXL_OPTIONS', 'maxPixels must fit this encoder’s pixel limit.');
  return {...limits, pixels: maxPixels};
}

export function imageColor(image, options) {
  if (image.colorSpace !== undefined && options.colorSpace !== undefined && image.colorSpace !== options.colorSpace)
    throw fault('JXL_INPUT', 'The declared color space differs from the source pixels.');
  return options.colorSpace ?? image.colorSpace ?? 'srgb';
}
