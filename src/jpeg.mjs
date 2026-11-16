// SPDX-License-Identifier: MIT
import {reconstructJPEG} from './jpeg-restore.mjs';
import {LIMITS} from './limits.mjs';
import {jpegAnswer, jpegJob} from './jpeg-job.mjs';
import {jpegEffortSteps} from './jpeg-effort.mjs';

export {LIMITS};
export {reconstructJPEG};
export function transcode(jpeg, options) { return jpegAnswer(transcodeSteps(jpeg, options)); }
export function transcodeSteps(jpeg, options) { return jpegJob(jpeg, options, jpegEffortSteps); }
