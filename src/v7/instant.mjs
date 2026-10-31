import {encodeSteps} from '../index.mjs';
import {admitSampleFormat} from '../admit-samples.mjs';
import {screenLike, flatSamples, CAPTURE_FLAT} from '../screen.mjs';
import {screenPhotoRegions} from '../screen-photo-regions.mjs';
export function* coreSteps(data, width, height, options) {
  const steps = encodeSteps(data, width, height, options), colorSpace = options?.colorSpace, samples = admitSampleFormat(data, options);
  if (samples.native8 && !samples.iccSpace && typeof colorSpace !== 'object' && screenLike(data, width, height)) {
    const captured = yield {capture: {data, width, height, colorSpace}};
    if (captured instanceof Uint8Array) {
      if (!(options.quality < 100)) { steps.return?.(); return captured; }
      let best = captured;
      if (colorSpace === undefined || colorSpace === 'srgb') {
        const regions = screenPhotoRegions(data, width, height);
        if (regions.length) {
          const mixed = yield {screenPhoto: {data, width, height, quality: options.quality, regions}};
          if (mixed instanceof Uint8Array && mixed.length < best.length) best = mixed;
        }
      }
      const own = yield* steps;
      return own.length < best.length ? own : best;
    }
  }
  if (samples.native8 && !samples.iccSpace && typeof colorSpace !== 'object' && flatSamples(data, width, height) >= CAPTURE_FLAT) {
    const own = yield* steps, captured = yield {capture: {data, width, height, colorSpace}};
    const lossy = options.quality < 100;
    return captured instanceof Uint8Array && (lossy ? captured.length <= own.length : captured.length < own.length) ? captured : own;
  }
  return yield* steps;
}
