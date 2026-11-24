// SPDX-License-Identifier: MIT
import {linearFromTransform} from './color-bytes.mjs';
import {captureLinearRGBA as toRGBA} from './capture-kernels.mjs';

export function photoReference(rgba, width, height, transform = null) {
  return {rgba: transform ? toRGBA(linearFromTransform(rgba, width * height, transform), width, height) : rgba};
}
