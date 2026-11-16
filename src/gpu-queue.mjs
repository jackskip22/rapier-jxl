// SPDX-License-Identifier: MIT
import {tracing, traced} from './stage-trace.mjs';
import {leftDevice, requestPixels} from './device-trial.mjs';

export function gpuQueue(run) {
  let queue = Promise.resolve(), refused = false;
  const trials = run?.trials === true;
  return Object.defineProperties(request => {
    if (request?.kind === 'refuse') refused = true;
    if (refused) return Promise.resolve(null);
    if (trials && leftDevice(request?.kind ?? 'core', requestPixels(request))) { if (tracing()) traced(`left-device:${request?.kind ?? 'core'}`, 0); return Promise.resolve(null); }
    const answer = queue.then(() => {
      if (!tracing()) return run(request);
      const t0 = performance.now(), name = 'device:' + (request?.kind ?? 'core'), done = () => traced(name, performance.now() - t0);
      return Promise.resolve(run(request)).finally(done);
    });
    queue = answer.then(() => {}, () => {});
    return answer;
  }, {trials: {value: trials}, generation: {get: () => run?.generation ?? 0}});
}
