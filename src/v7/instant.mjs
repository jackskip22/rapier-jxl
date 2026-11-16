import {encodeSteps} from '../core-steps.mjs';
import {effortJob, exactCapture, paletteCutout} from '../effort-job.mjs';
import {perfectSmoothSample} from '../smooth-sample.mjs';
import {admitSampleFormat} from '../admit-samples.mjs';
import {CAPTURE_FLAT, flatSurround, screenLike, sharedFlatSamples} from '../screen.mjs';
import {exactSignal, signalSpace} from '../color-signal.mjs';
import {softPicture} from './intent-quality.mjs';
import {inspectPixels} from '../lossless.mjs';
import {capture} from '../call-memo.mjs';
const INSTANT_PHOTO_PIXELS = 524288, INSTANT_SCREEN_PIXELS = 2100000, INSTANT_PATCH_PIXELS = 1100000;
export function* coreSteps(data, width, height, options, hdr = null) {
  const colorSpace = options?.colorSpace, samples = admitSampleFormat(data, options);
  const signal = !samples.native8 && (options?.quality ?? 100) >= 100 && exactSignal(samples);
  const exact = (options?.quality ?? 100) >= 100;
  const plain = !samples.iccSpace && typeof colorSpace !== 'object';
  const space = signal ? signalSpace(samples) : colorSpace;
  if (exact && samples.iccSpace && screenLike(data, width, height)) {
    const floor = yield* encodeSteps(data, width, height, options, hdr);
    const captured = yield* exactCapture({data, width, height, colorSpace: samples.iccSpace, instant: true});
    return captured instanceof Uint8Array && captured.length < floor.length ? captured : floor;
  }
  if (plain && (samples.native8 || signal) && screenLike(data, width, height) && (exact || !softPicture(data, width, height))) {
    const captured = yield {capture: {data, width, height, colorSpace: space, instant: true}};
    if (captured instanceof Uint8Array) return captured;
  }
  if (exact && plain && samples.native8 && flatSurround(data, width, height) && paletteCutout(data, width, height, space, inspectPixels(data, width, height))) {
    const captured = yield {capture: {data, width, height, colorSpace: space, instant: true}};
    if (captured instanceof Uint8Array) return captured;
  }
  if (exact && plain && samples.native8 && perfectSmoothSample(data, width, height)) return yield* effortJob(data, width, height, {...options, quality: 100, effort: 3}, false);
  if (exact && plain && samples.native8 && flatSurround(data, width, height)) {
    const captured = yield {capture: {data, width, height, colorSpace: space, instant: true}};
    if (captured instanceof Uint8Array) return captured;
  }
  const pixels = width * height;
  if (exact && plain && (samples.native8 || signal) && pixels >= 4096) {
    const shared = pixels <= INSTANT_SCREEN_PIXELS ? sharedFlatSamples(data, width, height) : 0;
    if (pixels <= INSTANT_PHOTO_PIXELS || shared >= CAPTURE_FLAT) {
      const floor = pixels <= 65536 ? yield* encodeSteps(data, width, height, options, hdr) : null;
      const captured = yield {capture: {data, width, height, colorSpace: space, instant: true, frame: !(shared >= 160 && pixels <= INSTANT_PATCH_PIXELS)}};
      if (captured instanceof Uint8Array) return floor && floor.length <= captured.length ? floor : captured;
      if (floor) return floor;
    }
  }
  if (!exact && plain && samples.native8 && flatSurround(data, width, height) && paletteCutout(data, width, height, space, inspectPixels(data, width, height))) {
    const captured = yield* capture({data, width, height, colorSpace: space});
    if (captured instanceof Uint8Array) return captured;
  }
  return yield* encodeSteps(data, width, height, options, hdr);
}
