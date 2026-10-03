// SPDX-License-Identifier: MIT
// JPEG coefficients carried without reconstruction boxes; one checked job owner.
import {JPEG_LIMITS} from './bits.mjs';
import {jpegAnswer, jpegJob} from './jpeg-job.mjs';
import {coefficientAnsSteps} from './coefficient-ans.mjs';

export {JPEG_LIMITS as LIMITS};
export function transcode(jpeg, options) { return jpegAnswer(transcodeSteps(jpeg, options)); }
export function transcodeSteps(jpeg, options) { return jpegJob(jpeg, options, coefficientAnsSteps); }
