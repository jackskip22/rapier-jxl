// SPDX-License-Identifier: MIT
// Rapier JXL's effort door: the core's `encode` with a search above it. {effort: 1} (the default) writes the core's
// stream byte for byte; a higher effort prices more candidates for every channel of an exact picture and keeps the
// smallest stream: never larger than the effort below it, effort 1's on a tie. The rungs, each from its effort up:
// 2. the specification's self-correcting (weighted) predictor, one context per channel;
// 3. the weighted predictor with its channel's tokens split by the predictor's own error, neighbouring intervals of
//    libjxl's cut points merged wherever a shared prefix code costs less.
// 4. palette indices with local trees and histograms, the predictor and error intervals learned per group;
//    also a sampled search over all 42 reversible colour transforms, accepted only after a smaller complete stream;
// 6. direct and palette planes with splits on the unclamped gradient and west-minus-northwest difference.
// A lossy request is effort 1's. Above effort 1 an exact picture's job spends its first half (fractions up to 0.5)
// writing effort 1's stream and its second searching, so a caller's clock can tell the search's own pace; `hurry`
// ends the search at its next step with the smallest stream written so far. Every choice is integer arithmetic: the
// same input and options write the same bytes everywhere.
import {LIMITS, complete} from './bits.mjs';
import {job} from './admit.mjs';
import {effortJob} from './effort-job.mjs';

export {LIMITS};

export function encode(data, width, height, options) { return complete(encodeSteps(data, width, height, options)); }

// The options as every door reads them, and the effort, which this door alone reads (the core, one rung, does not): a
// whole number from 1 to 9, 1 when absent.
export function encodeSteps(data, width, height, options) { return job(effortJob(data, width, height, options)); }
