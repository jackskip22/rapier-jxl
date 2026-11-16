// SPDX-License-Identifier: MIT
import {configuredDecoder, DECODER_SNAPSHOT} from '../shown-picture.mjs';
import {captureWith} from './capture-core.mjs';
import {imageResult} from './result.mjs';
import {readTexture} from './texture.mjs';
import {admitCapturePhoto, captureRectangles} from './capture-photo-options.mjs';
import {prepareCapturePhoto} from './run-capture-photo.mjs';
import {runCaptureComplete} from './capture-complete-run.mjs';
import {webgpuUsable} from './webgpu.mjs';
import {CAPTURE_COMPLETE, carriedBy} from './capture-levels.mjs';
import {declared, preparedAlone} from './primitives.mjs';
import {captureSupported} from './capture-support.mjs';
import {photoKernels} from '../capture-kernels.mjs';
import {verbSteps, STEPS} from './verb-steps.mjs';
export const supported = async feature => {
  if (feature === 'webgpu') return webgpuUsable();
  if (!await captureSupported(feature)) return false;
  try { return !!await photoKernels().prepare(); } catch { return false; }
};
export const prepare = preparedAlone(() => prepareCapturePhoto().catch(error => { throw declared(error); }));
const carried = carriedBy('rapier-jxl/capture-complete', CAPTURE_COMPLETE);
export const capture = captureWith(readTexture, {admit: options => { const f = admitCapturePhoto(options, carried); if (f && typeof f === 'object') f[DECODER_SNAPSHOT] = configuredDecoder(); return f; }, rectangles: captureRectangles, run: runCaptureComplete}, imageResult, true);
if (!(typeof __RAPIER_JXL_UNSTEPPED__ !== 'undefined' && __RAPIER_JXL_UNSTEPPED__ === true)) Object.defineProperty(capture, STEPS, {value: verbSteps('capture-complete:rapier-jxl', capture,
  {taken: ['fidelity', 'effort', 'webgpu', 'exactRects', 'photoRects', 'textComplete', 'maxPixels'], rows: true})});
