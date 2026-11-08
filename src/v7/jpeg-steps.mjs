// SPDX-License-Identifier: MIT
import {jpegSteps} from '../jpeg-job.mjs';
import {jpegAnsEffortSteps} from '../jpeg-ans-effort.mjs';
import {longTail} from '../jpeg-tail.mjs';
import {admitEffort} from '../effort-level.mjs';
import {answer} from '../admit.mjs';
import {imageResult} from './result.mjs';
import {fail, jpegPixels} from './primitives.mjs';
import {keys, restoreSteps} from './jpeg-restore-steps.mjs';

export {restoreSteps};

export const STEPS = Symbol.for('rapier-jxl.steps');

export function recompressSteps(kernels) {
  return Object.freeze({id: 'jpeg:recompress', prepare: kernels, eager: false, restore: restoreSteps,
    normalize(options) {
      keys(options, ['effort', 'icc', 'maxPixels']);
      const effort = admitEffort(options, 7), maxPixels = jpegPixels(options.maxPixels);
      if (options.icc !== undefined && options.icc !== 'preserve') throw fail('JXL_INPUT', 'JPEG icc is preserve, or omitted.');
      return {options: {...options}, effort, maxPixels, ...(options.icc !== undefined && {icc: options.icc})};
    },
    *open(plan, jpeg, source, straight = false) {
      let shown = null;
      const bytes = yield* jpegSteps(jpeg, {effort: plan.effort, maxPixels: plan.maxPixels, tails: longTail, ...(!straight && {bands: {from: 0, packed: 0}}), ...(plan.icc && {icc: plan.icc})},
        jpegAnsEffortSteps, size => { shown = {width: size.width, height: size.height}; });
      return {bytes: answer(bytes), facts: shown};
    },
    record: (bytes, plan, source, shown) => imageResult(bytes, shown, {fidelity: 'exact', kept: 'jpeg-bytes', owned: true})});
}
