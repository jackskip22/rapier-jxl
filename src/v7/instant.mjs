import {encodeSteps} from '../core-steps.mjs';
import {admitSampleFormat} from '../admit-samples.mjs';
import {screenLike} from '../screen.mjs';
export function* coreSteps(data, width, height, options) {
  const colorSpace = options?.colorSpace, samples = admitSampleFormat(data, options);
  if (samples.native8 && !samples.iccSpace && typeof colorSpace !== 'object' && screenLike(data, width, height)) {
    const captured = yield {capture: {data, width, height, colorSpace}};
    if (captured instanceof Uint8Array) return captured;
  }
  return yield* encodeSteps(data, width, height, options);
}
