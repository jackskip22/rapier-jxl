// SPDX-License-Identifier: MIT
import {jpegSteps} from '../jpeg-job.mjs';
import {jpegAnsEffortSteps} from '../jpeg-ans-effort.mjs';
import {restoreJPEG} from '../jpeg-reconstruction.mjs';
import {longTail} from '../jpeg-tail.mjs';
import {brotliDictionary} from '../brotli-dictionary.mjs';
import {admitEffort} from '../effort-level.mjs';
import {unit} from '../step-journal.mjs';
import {answer} from '../admit.mjs';
import {imageResult} from './result.mjs';
import {fail, jpegPixels, NO_JPEG} from './primitives.mjs';
import {pictureSize} from './jpeg-size.mjs';

export const STEPS = Symbol.for('rapier-jxl.steps');
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const keys = (options, taken) => {
  if (!record(options)) throw fail('JXL_OPTIONS', 'JPEG options are a record.');
  const unknown = Object.keys(options).find(key => !taken.includes(key));
  if (unknown) throw fail('JXL_OPTIONS', `A resumable JPEG job takes ${taken.join(', ')}; not ${unknown}.`);
};

export function recompressSteps(kernels) {
  return Object.freeze({id: 'jpeg:recompress', prepare: kernels, eager: true,
    normalize(options) {
      keys(options, ['effort', 'icc', 'maxPixels']);
      const effort = admitEffort(options, 7), maxPixels = jpegPixels(options.maxPixels);
      if (options.icc !== undefined && options.icc !== 'preserve') throw fail('JXL_INPUT', 'JPEG icc is preserve, or omitted.');
      return {options: {...options}, effort, maxPixels, ...(options.icc !== undefined && {icc: options.icc})};
    },
    *open(plan, jpeg) {
      let shown = null;
      const bytes = yield* jpegSteps(jpeg, {effort: plan.effort, maxPixels: plan.maxPixels, tails: longTail, bands: {from: 0, packed: 0}, ...(plan.icc && {icc: plan.icc})},
        jpegAnsEffortSteps, size => { shown = {width: size.width, height: size.height}; });
      return {bytes: answer(bytes), facts: shown};
    },
    record: (bytes, plan, source, shown) => imageResult(bytes, shown, {fidelity: 'exact', kept: 'jpeg-bytes', owned: true})});
}
export const restoreSteps = Object.freeze({id: 'jpeg:restore', prepare: null, eager: true,
  normalize(options) {
    keys(options, ['maxPixels']);
    return {options: {...options}, maxPixels: jpegPixels(options.maxPixels)};
  },
  *open(plan, file) {
    const result = yield* unit('restore', () => {
      if (file[0] === 255 && file[1] === 10) throw fail('JXL_RECONSTRUCTION', NO_JPEG);
      const restored = restoreJPEG(file, brotliDictionary, {maxPixels: plan.maxPixels});
      if (!restored) throw fail('JXL_RECONSTRUCTION', NO_JPEG);
      return restored;
    });
    const size = pictureSize(file);
    return {bytes: result, facts: size && {width: size.width, height: size.height}};
  },
  record: (bytes, plan, source, size) => imageResult(bytes, size, {format: 'jpeg', fidelity: 'exact', kept: 'jpeg-bytes', owned: true})});
