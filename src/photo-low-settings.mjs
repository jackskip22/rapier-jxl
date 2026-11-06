// SPDX-License-Identifier: MIT
import {BAND_PIXELS, WHOLE} from './memory-device.mjs';

export const largePhoto = (width, height) => Math.min(width, height) >= 2048 &&
  width * height > BAND_PIXELS && width * height <= WHOLE;
