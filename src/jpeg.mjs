// SPDX-License-Identifier: MIT
// JPEG coefficients, quantization, subsampling, orientation, and supported color declarations to JPEG XL.
// Reconstruction data and other metadata are omitted. Unsupported or malformed JPEGs raise JXL_JPEG.
import {JPEG_LIMITS} from './bits.mjs';
import {jpegAnswer, jpegJob} from './jpeg-job.mjs';
import {coefficientEffortSteps} from './coefficient-effort.mjs';

export {JPEG_LIMITS as LIMITS};
export function transcode(jpeg, options) { return jpegAnswer(transcodeSteps(jpeg, options)); }
export function transcodeSteps(jpeg, options) { return jpegJob(jpeg, options, coefficientEffortSteps); }
