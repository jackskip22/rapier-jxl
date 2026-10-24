// SPDX-License-Identifier: MIT
import {LIMITS, complete} from './bits.mjs';
import {job} from './admit.mjs';
import {effortJob} from './effort-job.mjs';
import {driveGpu, gpuWanted} from './gpu-drive.mjs';

export {LIMITS};

export function encode(data, width, height, options) { return complete(encodeSteps(data, width, height, options)); }

export function encodeSteps(data, width, height, options) { return job(effortJob(data, width, height, options)); }

export function encodeAsync(data, width, height, options) {
  try { return driveGpu(effortJob(data, width, height, options, undefined, false, undefined, gpuWanted(options, width, height)), options?.gpu); }
  catch (error) { return Promise.reject(error); }
}
