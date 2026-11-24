// SPDX-License-Identifier: MIT
import {photoMeasuredSteps} from './photo-measured-steps.mjs';
import {planeLevelsSteps} from './photo-plane-levels.mjs';
import {planeSearchSteps} from './photo-plane-search.mjs';
import {blockSearchOptions} from './photo-v6.mjs';
import {scoreSteps, AQ, CANDIDATES} from './photo-search.mjs';
import {fault} from './fault.mjs';

export function* planeMeasuredSteps(steps, measure, signal) {
  const transforms = function* (request) {
    if (request.kind === 'costs' || request.kind === 'exact' || request.kind === 'release') return null;
    if (request.kind === 'layout') return yield* planeLevelsSteps(request.base, request.width, request.height, request.layout, request.options, signal);
    throw fault('JXL_INTERNAL', 'photo-plane-measured:request');
  };
  return yield* photoMeasuredSteps(steps, measure, signal, transforms);
}

export const SHARED_PHOTO_SEARCH = {blocks: planeSearchSteps, options: blockSearchOptions, measured: planeMeasuredSteps, score: scoreSteps, aq: AQ, candidates: CANDIDATES};
