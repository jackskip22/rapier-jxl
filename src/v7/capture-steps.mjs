// SPDX-License-Identifier: MIT
import {encodeCaptureSteps, CAPTURE_TOOLS} from '../capture-codec.mjs';
import {admitCapture} from './capture-options.mjs';
import {unmeasuredResult as imageResult} from './result-record.mjs';
import {fail} from './primitives.mjs';

export const STEPS = Symbol.for('rapier-jxl.steps');
const TAKEN = ['fidelity', 'effort', 'webgpu'];

export function captureSteps(carried, tools) {
  return Object.freeze({id: 'capture:' + carried.module,
    normalize(options, source) {
      if (!options || typeof options !== 'object' || Array.isArray(options)) throw fail('JXL_OPTIONS', 'Capture options are a record.');
      const unknown = Object.keys(options).find(key => !TAKEN.includes(key));
      if (unknown) throw fail('JXL_OPTIONS', `A resumable capture takes ${TAKEN.join(', ')}; not ${unknown}.`);
      const maxError = admitCapture(options, carried), effort = options.effort ?? 3;
      const {width, height, colorSpace = 'srgb'} = source;
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || source.byteLength !== width * height * 4)
        throw fail('JXL_INPUT', 'A resumable capture\'s source is straight RGBA8 rows: byteLength is width * height * 4.');
      if (colorSpace !== 'srgb' && colorSpace !== 'display-p3') throw fail('JXL_INPUT', 'A capture source is srgb or display-p3.');
      return {options: Object.fromEntries(TAKEN.filter(key => options[key] !== undefined).map(key => [key, options[key]])), effort, maxError, colorSpace};
    },
    open: (plan, data, {width, height}) => encodeCaptureSteps(data, width, height,
      {effort: plan.effort, maxError: plan.maxError, colorSpace: plan.colorSpace, ...(tools && {[CAPTURE_TOOLS]: tools})}),
    record: (bytes, plan, {width, height}) => imageResult(bytes, {width, height},
      {fidelity: plan.maxError ? {maxError: plan.maxError} : 'exact', owned: true})});
}
