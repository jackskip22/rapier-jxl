// SPDX-License-Identifier: MIT
import {complete} from './bits.mjs';
import {captureRefused} from './fault.mjs';
import {turn, exclusive} from './turn.mjs';
import {screenPhotoRegions} from './screen-photo-regions.mjs';
export async function captureAnswer({data, width, height, colorSpace, effort, patchEffort, tools, sizes, floor, frame, instant}, signal) {
  const {encodeCaptureBytes, encodeCaptureSteps, compileCaptureKernels, CAPTURE_TOOLS, CAPTURE_SIZES, CAPTURE_FLOOR, CAPTURE_PATCHES, CAPTURE_PATCH_EFFORT, CAPTURE_LEVEL, INSTANT} = await import('./capture-codec.mjs');
  await compileCaptureKernels();
  const options = {colorSpace, effort, [CAPTURE_TOOLS]: tools, [CAPTURE_SIZES]: sizes, [CAPTURE_FLOOR]: floor,
    [CAPTURE_PATCHES]: frame ? false : undefined, [CAPTURE_PATCH_EFFORT]: instant ? 1 : patchEffort, ...(instant && {[CAPTURE_LEVEL]: INSTANT})};
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
  const {screenPhotoSteps, compileCaptureKernels, compileJpegKernels} = await import('./screen-photo-mixed.mjs');
  await compileCaptureKernels(); await compileJpegKernels().catch(() => false);
  try { return await exclusive(() => complete(screenPhotoSteps({...request,
    regions: request.regions ?? screenPhotoRegions(request.data, request.width, request.height)})), signal); }
  catch (error) { if (signal?.aborted && error === signal.reason || !captureRefused(error)) throw error; return null; }
}
