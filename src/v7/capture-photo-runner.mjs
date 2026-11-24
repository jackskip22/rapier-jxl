// SPDX-License-Identifier: MIT
import {runCaptureUsing, prepareCapture, exactCoderWith, finished} from './run-capture.mjs';
import {captureExact, markCaptureExact} from '../capture-codec.mjs';
import {journaled} from '../step-journal.mjs';
import {exactCouldWin, WITHIN, FLOOR} from './exact-cap.mjs';
import {encodeCapturePhotoBytes, encodeCapturePhotoSteps, capturePhotoBand, capturePhotoBandSteps,
  capturePhotoRegions, capturePatchedLargeSteps} from '../capture-photo.mjs';
import {CAPTURE_TOOLS_LEAN} from '../capture-codec.mjs';
import {kernelsReady} from './kernels-ready.mjs';
import {compileJpegKernels} from '../jpeg-kernels.mjs';
import {wasmRequired} from '../capture-wasm-error.mjs';
import {intentCoding, smallReading} from './intent-quality.mjs';
import {smallPicture} from '../photo-v6-settings.mjs';
import {lowCaptureReading} from './low-intent-quality.mjs';
import {lookingReader, LOOK_FROM} from './capture-region-look.mjs';
import {MEASURED_EFFORT} from '../effort-level.mjs';
import {captureRectangles} from './capture-photo-options.mjs';
import {planCapturePhotoBands} from './capture-photo-bands.mjs';

const jpegReady = async () => { if (!await compileJpegKernels()) throw wasmRequired(); };
async function ready() { await Promise.all([prepareCapture(), kernelsReady(), jpegReady()]); }

const wholeSmall = (intent, region) => (data, width, rect, offGrid, colorSpace, ...rest) => {
  if (colorSpace === 'srgb' && !rect.x && !rect.y && rect.width === width && data.length === width * rect.height * 4 &&
      smallPicture(rect.width, rect.height)) {
    let opaque = true;
    for (let at = 3; at < data.length; at += 4) if (data[at] !== 255) { opaque = false; break; }
    const reading = opaque && smallReading(intent, Math.min(rect.width, rect.height));
    if (opaque && reading < 100) return Math.min(LOW_LOSSY, reading);
  }
  return region(data, width, rect, offGrid, colorSpace, ...rest);
};
const LOW_LOSSY = 99.99;
const photoCoder = {ready, whole: encodeCapturePhotoBytes, band: capturePhotoBand, steps: encodeCapturePhotoSteps,
  bandSteps: capturePhotoBandSteps, regions: capturePhotoRegions, rectangles: captureRectangles, planBands: planCapturePhotoBands, large: capturePatchedLargeSteps};
export const prepareCapturePhoto = ready;

export function capturePhotoRunner(tools, {device = null, answerer = null}, runPhoto = null) {
  const exact = {...exactCoderWith(tools), device, answerer, rectangles: captureRectangles};
  const photo = {...photoCoder, tools, device, answerer, effortCap: 4};
  return async (input, options, hooks) => {
    const fidelity = options.fidelity;
    if (fidelity?.qualityIntent === undefined)
      return runCaptureUsing(input, options, hooks, {maxError: fidelity?.maxError ?? 0}, exact);
    const intent = fidelity.qualityIntent, coding = intentCoding(intent);
    const reading = smooth => (data, width, rect, offGrid, colorSpace) =>
      lowCaptureReading(intent, data, width, rect, offGrid, colorSpace, smooth);
    coding.regionQuality = reading(true);
    const effort = options.effort ?? 3;
    coding.wholeQuality = wholeSmall(intent, coding.regionQuality);
    if (effort >= LOOK_FROM) {
      coding.regionQuality = lookingReader(intent, reading(false), {measureLarge: true, measured: Boolean(runPhoto) && effort >= MEASURED_EFFORT, effort, effortOne: coding.regionQuality});
      if (runPhoto && effort >= MEASURED_EFFORT) coding.lowerRegionQuality = lookingReader(intent, reading(false), {measureLarge: true, effort: MEASURED_EFFORT - 1, full: true});
    }
    if (runPhoto && effort >= MEASURED_EFFORT) return runPhoto({input, options, hooks, coding, photo, exact});
    let record = null, picture = null;
    const quiet = progress => ({...hooks, onProgress: progress && hooks.onProgress ? f => { if (f < 1) hooks.onProgress(f); } : undefined, onEncoded: r => { record = r; },
      onPicture: p => { picture ??= p; }});
    const lossy = runPhoto ? await runPhoto({input, options, hooks: quiet(true), coding, photo, exact})
      : await runCaptureUsing(input, options, quiet(true), coding, photo);
    let answer = lossy, facts = record;
    const at = Math.max(FLOOR, effort);
    if ((!captureExact(lossy) || Math.min(effort, photo.effortCap) !== at) && exactCouldWin(lossy, picture ?? input, effort)) {
      const made = await journaled(hooks.journal, 'exact-cap', async () => {
        const bytes = await runCaptureUsing(picture ?? input, {...options, effort: at}, quiet(false), {maxError: 0}, exact);
        return {bytes, got: record};
      });
      if (!captureExact(made.bytes)) markCaptureExact(made.bytes);
      if (lossy.length > (captureExact(lossy) ? 1 : WITHIN) * made.bytes.length) { answer = made.bytes; facts = made.got; }
    }
    const {exact: _exact, ...rest} = facts ?? {};
    return finished(answer, hooks, rest);
  };
}

export function lowCaptureRunner(tools = CAPTURE_TOOLS_LEAN, backend = {}) {
  return capturePhotoRunner(tools, backend);
}
