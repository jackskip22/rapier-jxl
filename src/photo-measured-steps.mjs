// SPDX-License-Identifier: MIT
export function* photoMeasuredSteps(steps, measure, signal, transforms = null) {
  let step, reply;
  const scored = function* (image, want) { const answer = measure(image, want); return typeof answer?.next === 'function' ? yield* answer : answer; };
  const check = () => { if (signal?.aborted) throw signal.reason; };
  try {
    while (!(step = steps.next(reply)).done) {
      check();
      const value = step.value;
      if (value?.measure) { reply = yield* scored(value.measure, value.want); yield {photoMeasure: true}; }
      else if (value?.varblocks && transforms) reply = yield* transforms(value.varblocks);
      else if (value?.exact) {
        if (!value.exact.image) throw new Error('An exact capture measure needs its canonical image.');
        reply = yield* scored(value.exact.image, {ssimulacra2: true, p: value.exact.p, margin: value.exact.margin});
      } else reply = yield value;
    }
    return step.value;
  } finally { steps.return?.(); }
}
