import {encodeSteps} from '../core-steps.mjs';
import {effortJob, exactCapture, paletteCutout} from '../effort-job.mjs';
import {perfectSmoothSample} from '../smooth-sample.mjs';
import {admitSampleFormat} from '../admit-samples.mjs';
import {CAPTURE_FLAT, flatSurround, screenLike, sharedFlatSamples, tilesFit} from '../screen.mjs';
import {exactSignal, signalSpace} from '../color-signal.mjs';
import {softPicture} from './intent-quality.mjs';
import {inspectPixels} from '../lossless.mjs';
import {capture} from '../call-memo.mjs';
import {markCaptureExact} from '../capture-codec.mjs';
const INSTANT_PHOTO_PIXELS = 524288, CAPTURE_UNDER_CORE = 1100000;
export function* coreSteps(data, width, height, options, hdr = null) {
  const colorSpace = options?.colorSpace, samples = admitSampleFormat(data, options);
  const signal = !samples.native8 && (options?.quality ?? 100) >= 100 && exactSignal(samples);
  const exact = (options?.quality ?? 100) >= 100;
  const plain = !samples.iccSpace && typeof colorSpace !== 'object';
  const space = signal ? signalSpace(samples) : colorSpace;
  if (exact && samples.iccSpace && screenLike(data, width, height)) {
    const floor = yield* encodeSteps(data, width, height, options, hdr);
    const captured = yield* exactCapture({data, width, height, colorSpace: samples.iccSpace, effort: 1, small: true});
    return captured instanceof Uint8Array && captured.length < floor.length ? captured : floor;
  }
  if (plain && (samples.native8 || signal) && screenLike(data, width, height) && (exact || !softPicture(data, width, height))) {
    const floor = exact && width * height <= 16384 ? yield* encodeSteps(data, width, height, options, hdr) : null;
    const captured = yield {capture: {data, width, height, colorSpace: space, effort: 1, small: true}};
    if (captured instanceof Uint8Array) return floor && floor.length < captured.length ? floor : captured;
    if (floor) return floor;
  }
  if (exact && plain && samples.native8 && flatSurround(data, width, height) && paletteCutout(data, width, height, space, inspectPixels(data, width, height))) {
    const captured = yield {capture: {data, width, height, colorSpace: space, effort: 1, small: true}};
    if (captured instanceof Uint8Array) return captured;
  }
  if (exact && plain && samples.native8 && perfectSmoothSample(data, width, height)) return yield* effortJob(data, width, height, {...options, quality: 100, effort: 3}, false);
  if (exact && plain && samples.native8 && flatSurround(data, width, height)) {
    const captured = yield {capture: {data, width, height, colorSpace: space, effort: 1, small: true}};
    if (captured instanceof Uint8Array) return captured;
  }
  const pixels = width * height;
  const profiled = samples.iccSpace && typeof colorSpace !== 'object';
  if (exact && (plain && (samples.native8 || signal) || profiled)) {
    const shared = sharedFlatSamples(data, width, height);
    if (pixels <= (plain && samples.native8 ? CAPTURE_UNDER_CORE : INSTANT_PHOTO_PIXELS) || shared >= CAPTURE_FLAT) {
      const floor = pixels <= 65536 ? yield* encodeSteps(data, width, height, options, hdr) : null;
      const request = {data, width, height, colorSpace: profiled ? samples.iccSpace : space, effort: 1, small: true};
      const captured = profiled ? yield* exactCapture(request) : yield {capture: request};
      if (captured instanceof Uint8Array) return floor && floor.length <= captured.length ? floor : captured;
      if (floor) return floor;
    } else if (plain && samples.native8 && tilesFit(data, width, height)) {
      const captured = yield {capture: {data, width, height, colorSpace: space, effort: 1, small: true}};
      if (captured instanceof Uint8Array) return captured;
    }
  }
  if (!exact && plain && samples.native8 && flatSurround(data, width, height) && paletteCutout(data, width, height, space, inspectPixels(data, width, height))) {
    const captured = yield* capture({data, width, height, colorSpace: space});
    if (captured instanceof Uint8Array) return captured;
  }
  if (!exact && !samples.native8 && exactSignal(samples)) {
    let facts = null;
    const lossy = yield* encodeSteps(data, width, height, options, {...hdr, report: found => { facts = found; }});
    if (facts?.kept === 'pixels' || pixels <= 65536 || lossy.length * 8 >= 6 * pixels) {
      const ownExact = yield* coreSteps(data, width, height, {...options, quality: 100}, null);
      if (ownExact.length <= lossy.length) {
        hdr?.report?.({kept: 'pixels', measurements: []});
        return markCaptureExact(ownExact);
      }
    }
    if (facts) hdr?.report?.(facts);
    return facts?.kept === 'pixels' ? markCaptureExact(lossy) : lossy;
  }
  return yield* encodeSteps(data, width, height, options, hdr);
}
