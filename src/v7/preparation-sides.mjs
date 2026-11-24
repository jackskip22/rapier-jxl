// SPDX-License-Identifier: MIT
import {dimensions, fail} from './primitives.mjs';

export function outputSides(width, height, maxPixels) {
  if (width === undefined && height === undefined) throw fail('JXL_OPTIONS', 'output: width or height');
  dimensions(width ?? 1, height ?? 1, maxPixels);
}
export function outputSize({width, height, upscale}, picture, maxPixels) {
  if (upscale !== true) {
    if (width !== undefined) width = Math.min(width, picture.width);
    if (height !== undefined) height = Math.min(height, picture.height);
  }
  const size = {width: width ?? Math.max(1, Math.round(height * picture.width / picture.height)),
    height: height ?? Math.max(1, Math.round(width * picture.height / picture.width))};
  dimensions(size.width, size.height, maxPixels);
  return size;
}
