// SPDX-License-Identifier: MIT
// Photographic pixels through the carrier's VarDCT writer: sRGB to YCbCr, DCT8,
// quantization, then entropy coding. Quality 90 by default; 100 is exact, including
// RGB below transparent alpha. Alpha is always exact, and the color space is declared.
import {PHOTO_LIMITS, complete} from './bits.mjs';
import {photoJob} from './photo-job.mjs';
import {coefficientEffortSteps} from './coefficient-effort.mjs';

export {PHOTO_LIMITS as LIMITS};
export function encodePhoto(data, width, height, options) { return complete(encodePhotoSteps(data, width, height, options)); }
export function encodePhotoSteps(data, width, height, options) { return photoJob(data, width, height, options, coefficientEffortSteps); }
