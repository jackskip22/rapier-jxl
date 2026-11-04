// SPDX-License-Identifier: MIT
import {dimensions, fail} from './primitives.mjs';

export function outputSides(width, height, maxPixels) {
  if (width === undefined && height === undefined) throw fail('JXL_OPTIONS', 'An output names its width, its height or both.');
  dimensions(width ?? 1, height ?? 1, maxPixels);
}
export function outputSize({width, height}, picture, maxPixels) {
  const size = {width: width ?? Math.max(1, Math.round(height * picture.width / picture.height)),
    height: height ?? Math.max(1, Math.round(width * picture.height / picture.width))};
  dimensions(size.width, size.height, maxPixels);
  return size;
}
