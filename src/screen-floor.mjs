// SPDX-License-Identifier: MIT
import {complete} from './bits.mjs';
import {captureRefused} from './fault.mjs';
import {turn, exclusive} from './turn.mjs';
import {screenPhotoRegions} from './screen-photo-regions.mjs';
import {encodeCaptureBytes, encodeCaptureSteps, compileCaptureKernels, CAPTURE_TOOLS, CAPTURE_SIZES, CAPTURE_FLOOR, frameCapture, CAPTURE_LIMIT} from './capture-codec.mjs';
import {screenPhotoSteps, compileJpegKernels} from './screen-photo-mixed.mjs';
export async function captureAnswer({data, width, height, colorSpace, effort, tools, sizes, floor, frame, limit, small}, signal) {
  await compileCaptureKernels();
  const options = {colorSpace, effort, small, [CAPTURE_TOOLS]: tools, [CAPTURE_SIZES]: sizes, [CAPTURE_FLOOR]: floor,
    ...frameCapture(frame, floor), [CAPTURE_LIMIT]: limit};
  return exclusive(async () => {
    if (!signal) return encodeCaptureBytes(data, width, height, options);
    if (signal.aborted) throw signal.reason;
    const steps = encodeCaptureSteps(data, width, height, options);
    try {
      let step, last = performance.now();
      while (!(step = steps.next()).done) {
        if (performance.now() - last >= 8) { await turn(); last = performance.now(); }
        if (signal.aborted) throw signal.reason;
      }
      return step.value;
    } finally { steps.return(); }
  }, signal);
}

export async function screenPhotoAnswer(request, signal) {
  await compileCaptureKernels(); await compileJpegKernels().catch(() => false);
  try { return await exclusive(() => complete(screenPhotoSteps({...request,
    regions: request.regions ?? screenPhotoRegions(request.data, request.width, request.height)})), signal); }
  catch (error) { if (signal?.aborted && error === signal.reason || !captureRefused(error)) throw error; return null; }
}
