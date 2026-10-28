import {encodeSteps} from '../index.mjs';
import {admitSampleFormat} from '../admit-samples.mjs';
import {screenLike} from '../screen.mjs';
export function* coreSteps(data, width, height, options) {
  const steps = encodeSteps(data, width, height, options), colorSpace = options?.colorSpace, samples = admitSampleFormat(data, options);
  if (samples.native8 && !samples.iccSpace && typeof colorSpace !== 'object' && screenLike(data, width, height)) {
    const captured = yield {capture: {data, width, height, colorSpace}};
    if (captured instanceof Uint8Array) { steps.return?.(); return captured; }
  }
  return yield* steps;
}
