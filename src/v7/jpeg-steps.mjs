// SPDX-License-Identifier: MIT
import {jpegSteps} from '../jpeg-job.mjs';
import {jpegAnsEffortSteps} from '../jpeg-ans-effort.mjs';
import {longTail} from '../jpeg-tail.mjs';
import {promotedGainMap} from '../gain-map-xmp.mjs';
import {answer} from '../admit.mjs';
import {imageResult} from './result.mjs';
import {fail, pixelLimit} from './primitives.mjs';
import {keys, restoreSteps} from './jpeg-restore-steps.mjs';

export {restoreSteps};

export const STEPS = Symbol.for('rapier-jxl.steps');

export function jpegSettings({effort = 7}) {
  if (!Number.isInteger(effort) || effort < 1 || effort > 9) throw fail('JXL_OPTIONS', effort === 10 ? "effort 10: import {encode} from 'jpegxl/max'" : "effort: integer 1-9");
  return effort;
}

export function recompressSteps(kernels) {
  return Object.freeze({id: 'jpeg:recompress', prepare: kernels, eager: false, restore: restoreSteps,
    normalize(options) {
      keys(options, ['effort', 'maxPixels', 'gainMap']);
      if (options?.gainMap !== undefined && typeof options.gainMap !== 'boolean')
        throw fail('JXL_OPTIONS', 'gainMap: boolean');
      const effort = jpegSettings(options), maxPixels = pixelLimit(options.maxPixels);
      return {options: {...options}, effort, maxPixels, gainMap: options?.gainMap !== false};
    },
    *open(plan, jpeg, source, straight = false) {
      let shown = null, otherDecoders = null;
      const bytes = yield* jpegSteps(jpeg, {effort: plan.effort, maxPixels: plan.maxPixels, ...(plan.gainMap && {gainMap: promotedGainMap}), tails: longTail, outside: missing => { otherDecoders = {missing, reason: 'past-jbrd'}; },
        ...(!straight && {bands: {from: 0, packed: 0}})},
        jpegAnsEffortSteps, size => { shown = {width: size.width, height: size.height}; });
      return {bytes: answer(bytes), facts: {...shown, originalBytes: jpeg.length, ...(otherDecoders && {otherDecoders})}};
    },
    record: (bytes, plan, source, shown) => imageResult(bytes, shown, {fidelity: 'exact', kept: 'jpeg-bytes', originalBytes: shown.originalBytes, owned: true, ...(shown?.otherDecoders && {otherDecoders: shown.otherDecoders})})});
}
