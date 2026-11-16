// SPDX-License-Identifier: MIT
import {photoMeasuredSteps} from './photo-measured-steps.mjs';
import {planeLevelsSteps} from './photo-plane-levels.mjs';
import {fault} from './fault.mjs';

export function* planeMeasuredSteps(steps, measure, signal) {
  const transforms = function* (request) {
    if (request.kind === 'costs' || request.kind === 'exact' || request.kind === 'release') return null;
    if (request.kind === 'layout') return yield* planeLevelsSteps(request.base, request.width, request.height, request.layout, request.options, signal);
    throw fault('JXL_INTERNAL', 'Unknown photographic transform request.');
  };
  return yield* photoMeasuredSteps(steps, measure, signal, transforms);
}
