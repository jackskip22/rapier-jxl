// SPDX-License-Identifier: MIT
// Rapier JXL's JPEG door: a JPEG carried as its quantised DCT coefficients,
// quantisation tables, colour and subsampling, with only the entropy coding changed.
// Baseline, extended sequential and progressive scans, restarts; 8-bit grey, YCbCr or RGB;
// Exif orientation and an admitted sRGB or Display P3 declaration are kept.
// Not carried: JPEG reconstruction data, ICC bytes, Exif beyond orientation or XMP.
// Arithmetic, 12-bit, lossless, CMYK, DNL, another colour profile, truncation or a table
// libjpeg refuses is JXL_JPEG: decode it and encode its pixels instead.
import {JPEG_LIMITS} from './bits.mjs';
import {jpegAnswer, jpegJob} from './jpeg-job.mjs';
import {coefficientEffortSteps} from './coefficient-effort.mjs';

export {JPEG_LIMITS as LIMITS};
export function transcode(jpeg, options) { return jpegAnswer(transcodeSteps(jpeg, options)); }
export function transcodeSteps(jpeg, options) { return jpegJob(jpeg, options, coefficientEffortSteps); }
