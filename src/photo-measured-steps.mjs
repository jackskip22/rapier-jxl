// SPDX-License-Identifier: MIT
import {fault} from './fault.mjs';
export function* spannedSteps(steps, from = 0, to = 0, keepZero = false) {
  let step, reply;
  try {
    while (!(step = steps.next(reply)).done)
      reply = typeof step.value === 'number' && (!keepZero || step.value !== 0) ? (yield from + (to - from) * step.value, undefined) : yield step.value;
    return step.value;
  } finally { if (!step?.done) steps.return?.(); }
}

export function* photoMeasuredSteps(steps, measure, signal, transforms = null) {
  let step, reply;
  const callMeasure = typeof measure === 'function' ? measure : measure?.measure?.bind(measure);
  const callMany = typeof measure?.many === 'function' ? measure.many.bind(measure) : typeof measure?.measureMany === 'function' ? measure.measureMany.bind(measure) : null;
  const scored = function* (image, want) { const answer = callMeasure(image, want); return typeof answer?.next === 'function' ? yield* answer : answer; };
  const check = () => { if (signal?.aborted) throw signal.reason; };
  try {
    while (!(step = steps.next(reply)).done) {
      check();
      const value = step.value;
      if (value?.measure) { reply = yield* scored(value.measure, value.want); yield {photoMeasure: true}; }
      else if (value?.measureMany) {
        if (callMany) {
          const answer = callMany(value.measureMany, value.want);
          reply = typeof answer?.next === 'function' ? yield* answer : answer;
          for (let k = 0; k < value.measureMany.length; k++) yield {photoMeasure: true};
        } else {
          const list = [];
          for (const item of value.measureMany) { list.push(yield* scored(item, value.want)); yield {photoMeasure: true}; }
          reply = list;
        }
      }
      else if (value?.varblocks && transforms) reply = yield* transforms(value.varblocks);
      else if (value?.exact) {
        if (!value.exact.image) throw fault('JXL_INTERNAL', 'photo-measured-steps:image');
        reply = yield* scored(value.exact.image, {ssimulacra2: true, p: value.exact.p, margin: value.exact.margin});
      } else reply = yield value;
    }
    return step.value;
  } finally { steps.return?.(); }
}
