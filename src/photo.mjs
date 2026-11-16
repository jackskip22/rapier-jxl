// SPDX-License-Identifier: MIT
import {LIMITS} from './limits.mjs';
import {complete} from './bits.mjs';
import {photoJob, photoJobSteps} from './photo-job.mjs';
import {searchV6} from './photo-v6-search.mjs';
import {photoAnsSteps} from './photo-v6-blocks.mjs';

export {LIMITS};
export function encodePhoto(data, width, height, options) { return complete(encodePhotoSteps(data, width, height, options)); }
export function encodePhotoSteps(data, width, height, options) {
  return photoJob(data, width, height, options, photoAnsSteps, searchV6);
}
export function encodePhotoJobSteps(data, width, height, options) {
  return photoJobSteps(data, width, height, options, photoAnsSteps, searchV6);
}
export function encodePhotoGpuSteps(data, width, height, options) {
  return photoJobSteps(data, width, height, options, photoAnsSteps, searchV6, true);
}
