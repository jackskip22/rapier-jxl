// SPDX-License-Identifier: MIT
import {linearFromTransform} from './color-transform.mjs';
import {toRGBA} from './rgb8-output.mjs';

export function photoReference(rgba, width, height, transform = null) {
  return {rgba: transform ? toRGBA(linearFromTransform(rgba, width * height, transform), width, height) : rgba};
}
