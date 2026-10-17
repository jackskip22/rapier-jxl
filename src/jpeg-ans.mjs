// SPDX-License-Identifier: MIT
import {reconstructJPEG} from './jpeg-reconstruction.mjs';
import {JPEG_LIMITS} from './bits.mjs';
import {jpegAnswer, jpegJob} from './jpeg-job.mjs';
import {jpegAnsEffortSteps} from './jpeg-ans-effort.mjs';

export {JPEG_LIMITS as LIMITS};
export {reconstructJPEG};
export function transcode(jpeg, options) { return jpegAnswer(transcodeSteps(jpeg, options)); }
export function transcodeSteps(jpeg, options) { return jpegJob(jpeg, options, jpegAnsEffortSteps); }
