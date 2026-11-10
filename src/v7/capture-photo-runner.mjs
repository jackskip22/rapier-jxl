// SPDX-License-Identifier: MIT
import {runCaptureUsing, prepareCapture, exactCoderWith} from './run-capture.mjs';
import {encodeCapturePhotoBytes, encodeCapturePhotoSteps, capturePhotoBand, capturePhotoBandSteps,
  capturePhotoRegions, capturePatchedLargeSteps} from '../capture-photo.mjs';
import {CAPTURE_TOOLS_LEAN} from '../capture-codec.mjs';
import {kernelsReady} from './kernels-ready.mjs';
import {webpCoding} from './webp-quality.mjs';
import {lowCaptureReading} from './low-webp-quality.mjs';
import {lookingReader, LOOK_FROM} from './capture-region-look.mjs';
import {captureSmallReading} from './capture-small-reading.mjs';
import {captureRectangles} from './capture-photo-options.mjs';
import {planCapturePhotoBands} from './capture-photo-bands.mjs';

async function ready() { await Promise.all([prepareCapture(), kernelsReady()]); }
const photoCoder = {ready, whole: encodeCapturePhotoBytes, band: capturePhotoBand, steps: encodeCapturePhotoSteps,
  bandSteps: capturePhotoBandSteps, regions: capturePhotoRegions, rectangles: captureRectangles, planBands: planCapturePhotoBands, large: capturePatchedLargeSteps};
export const prepareCapturePhoto = ready;

export function capturePhotoRunner(tools, {device = null, answerer = null}, runPhoto = null) {
  const exact = {...exactCoderWith(tools), device, answerer};
  const photo = {...photoCoder, tools, device, answerer, effortCap: 4};
  return async (input, options, hooks) => {
    const fidelity = options.fidelity;
    if (fidelity?.qualityIntent === undefined)
      return runCaptureUsing(input, options, hooks, {maxError: fidelity?.maxError ?? 0}, exact);
    const intent = fidelity.qualityIntent, coding = webpCoding(intent);
    coding.regionQuality = (data, width, rect, offGrid, colorSpace, small = false) => small
      ? captureSmallReading(intent, data, width, rect, offGrid, colorSpace)
      : lowCaptureReading(intent, data, width, rect, offGrid, colorSpace);
    const effort = options.effort ?? 3;
    if (effort >= LOOK_FROM) coding.wholeQuality = coding.regionQuality;
    if (effort >= 1) coding.regionQuality = lookingReader(intent, coding.regionQuality, {
      measureLarge: effort >= LOOK_FROM, measureSmall: effort < 6,
    });
    return runPhoto ? runPhoto({input, options, hooks, coding, photo, exact})
      : runCaptureUsing(input, options, hooks, coding, photo);
  };
}

export function lowCaptureRunner(tools = CAPTURE_TOOLS_LEAN, backend = {}) {
  return capturePhotoRunner(tools, backend);
}
