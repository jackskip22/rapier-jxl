// SPDX-License-Identifier: MIT
// Lossless compression search. Effort 1 writes the core stream; higher levels retain only smaller complete
// candidates. effort-job.mjs defines the candidate order, progress, and hurry behavior.
import {LIMITS, complete} from './bits.mjs';
import {job} from './admit.mjs';
import {effortJob} from './effort-job.mjs';

export {LIMITS};

export function encode(data, width, height, options) { return complete(encodeSteps(data, width, height, options)); }

// effortJob validates options before returning the incremental work.
export function encodeSteps(data, width, height, options) { return job(effortJob(data, width, height, options)); }
