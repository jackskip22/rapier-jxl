// SPDX-License-Identifier: MIT
import {complete} from './bits.mjs';
import {turn, exclusive} from './turn.mjs';
import {screenPhotoRegions} from './screen-photo-regions.mjs';
export async function captureAnswer({data, width, height, colorSpace, effort, tools}, signal) {
  const {encodeCaptureBytes, encodeCaptureSteps, compileCaptureKernels, CAPTURE_TOOLS} = await import('./capture-codec.mjs');
  await compileCaptureKernels();
  const options = {colorSpace, effort, [CAPTURE_TOOLS]: tools};
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
  const {screenPhotoSteps, compileCaptureKernels} = await import('./screen-photo-mixed.mjs');
  await compileCaptureKernels();
  try { return await exclusive(() => complete(screenPhotoSteps({...request,
    regions: request.regions ?? screenPhotoRegions(request.data, request.width, request.height)})), signal); }
  catch (error) { if (signal?.aborted && error === signal.reason || typeof error?.code !== 'string' || !error.code.startsWith('JXL_') || error.code === 'JXL_ABORTED') throw error; return null; }
}
