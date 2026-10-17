// SPDX-License-Identifier: MIT
import {LIMITS, complete} from './bits.mjs';
import {job} from './admit.mjs';
import {effortJob} from './effort-job.mjs';

export {LIMITS};

export function encode(data, width, height, options) { return complete(encodeSteps(data, width, height, options)); }

export function encodeSteps(data, width, height, options) { return job(effortJob(data, width, height, options)); }
