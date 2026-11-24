// SPDX-License-Identifier: MIT
import {tracing, traced} from './stage-trace.mjs';
import {leftDevice, requestPixels} from './device-trial.mjs';

export function gpuQueue(run) {
  let queue = Promise.resolve(), refused = false, closed = false, retirement;
  const pending = new Set();
  const watch = promise => {
    if (typeof promise?.then !== 'function') return promise;
    const value = Promise.resolve(promise);
    if (!pending.has(value)) {
      pending.add(value);
      value.then(() => pending.delete(value), () => pending.delete(value));
    }
    return value;
  };
  const trials = run?.trials === true;
  return Object.defineProperties(request => {
    if (closed) return Promise.resolve(null);
    if (request?.kind === 'refuse') refused = true;
    if (refused) return Promise.resolve(null);
    if ((trials || !!run?.phoneRequired) && leftDevice(request?.kind ?? 'core', requestPixels(request))) { if (tracing()) traced(`left-device:${request?.kind ?? 'core'}`, 0); return Promise.resolve(null); }
    const answer = watch(queue.then(() => {
      if (closed) return null;
      if (!tracing()) return run(request);
      const t0 = performance.now(), name = 'device:' + (request?.kind ?? 'core'), done = () => traced(name, performance.now() - t0);
      return Promise.resolve(run(request)).finally(done);
    }));
    queue = answer.then(() => {}, () => {});
    return answer;
  }, {
    trials: {value: trials}, generation: {get: () => run?.generation ?? 0}, phoneRequired: {get: () => run?.phoneRequired ?? 0}, watch: {value: watch},
    concurrent: {value: request => closed ? Promise.resolve(null) : watch(Promise.resolve().then(() => closed ? null : run(request)))},
    end: {value: () => {
      closed = true;
      return retirement ?? (pending.size ? retirement = Promise.allSettled([...pending]).then(() => {}) : null);
    }},
  });
}
