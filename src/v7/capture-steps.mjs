// SPDX-License-Identifier: MIT
import {encodeCaptureSteps, CAPTURE_TOOLS} from '../capture-codec.mjs';
import {admitCapture} from './capture-options.mjs';
import {unmeasuredResult} from './result-record.mjs';
import {fail, dimensions, pixelLimit, PIXELS} from './primitives.mjs';

export const STEPS = Symbol.for('rapier-jxl.steps');
const TAKEN = ['fidelity', 'effort'];

export function captureSteps(carried, tools) {
  return Object.freeze({id: 'capture:' + carried.module,
    normalize(options, source) {
      if (!options || typeof options !== 'object' || Array.isArray(options)) throw fail('JXL_OPTIONS', "Invalid capture options; pass a plain record.");
      const unknown = Object.keys(options).find(key => !TAKEN.includes(key));
      if (unknown) throw fail('JXL_OPTIONS', `Unknown resumable capture option: ${unknown}; use ${TAKEN.join(", ")}.`);
      const maxError = admitCapture(options, carried), effort = options.effort ?? 3;
      const {width, height, colorSpace = 'srgb'} = source;
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || source.byteLength !== width * height * 4)
        throw fail('JXL_INPUT', "Capture samples are incomplete; pass width * height * 4 RGBA8 bytes.");
      dimensions(width, height, pixelLimit(options.maxPixels));
      if (colorSpace !== 'srgb' && colorSpace !== 'display-p3') throw fail('JXL_INPUT', "Invalid capture color space; use srgb or display-p3.");
      return {options: Object.fromEntries(TAKEN.filter(key => options[key] !== undefined).map(key => [key, options[key]])), effort, maxError, colorSpace};
    },
    open: (plan, data, {width, height}) => encodeCaptureSteps(data, width, height,
      {effort: plan.effort, maxError: plan.maxError, colorSpace: plan.colorSpace, ...(tools && {[CAPTURE_TOOLS]: tools})}),
    record: (bytes, plan, {width, height}) => unmeasuredResult(bytes, {width, height},
      {fidelity: plan.maxError ? {maxError: plan.maxError} : 'exact', owned: true})});
}
