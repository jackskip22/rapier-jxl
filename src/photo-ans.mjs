// SPDX-License-Identifier: MIT
import {PHOTO_LIMITS, complete} from './bits.mjs';
import {photoJob} from './photo-job.mjs';
import {searchV6} from './photo-v6-search.mjs';
import {coefficientAnsSteps} from './coefficient-ans.mjs';

export {PHOTO_LIMITS as LIMITS};
export function encodePhoto(data, width, height, options) { return complete(encodePhotoSteps(data, width, height, options)); }
export function encodePhotoSteps(data, width, height, options) { return photoJob(data, width, height, options, coefficientAnsSteps, searchV6); }
