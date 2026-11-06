// SPDX-License-Identifier: MIT
import {photoMeasuredSteps} from './photo-measured-steps.mjs';
import {auditCosts} from './varblocks.mjs';
import {planeRequest, planeLevelsSteps} from './photo-plane-levels.mjs';
const check = signal => { if (signal?.aborted) throw signal.reason; };
const unitWeight = base => new Float64Array(base.components[0].stride * base.components[0].rows).fill(1);

export function* planeMeasuredSteps(steps, measure, signal) {
  let priced = null;
  const transforms = function* (request) {
    if (request.kind === 'costs') {
      const {base, width, height, options} = request;
      const search = {...options, perceptual: false, detailWeight: 1, maskWeight: unitWeight(base)};
      const answer = yield {gpu: {kind: 'photo-block-costs', ...planeRequest(base, width, height, search),
        audit: response => auditCosts(base, width, height, search, response)}};
      check(signal);
      const reply = answer?.costs?.certified ? answer.costs : null;
      priced = reply ? {base, width, height, options} : null;
      return reply;
    }
    if (request.kind === 'exact' || request.kind === 'layout') {
      const current = request.kind === 'layout' ? request : priced;
      return current ? yield* planeLevelsSteps(current.base, current.width, current.height, request.layout, current.options, signal) : null;
    }
    if (request.kind === 'release') { priced = null; return null; }
    throw new Error('Unknown photographic transform request.');
  };
  try { return yield* photoMeasuredSteps(steps, measure, signal, transforms); }
  finally { priced = null; }
}
