// SPDX-License-Identifier: MIT
import {captureWith} from './capture-core.mjs';
import {imageResult} from './result.mjs';
import {readTexture} from './texture.mjs';
import {admitCapturePhoto, captureRectangles} from './capture-photo-options.mjs';
import {captureRunner, prepareCapturePhoto} from './run-capture-photo.mjs';
import {CAPTURE_TOOLS_COMPLETE} from '../capture-ans.mjs';
import {webgpuUsable} from './webgpu.mjs';
import {captureEngine} from '../gpu-capture.mjs';
import {engineAnswerer} from './capture-engine.mjs';
import {fail} from './primitives.mjs';
import {CAPTURE_COMPLETE, carriedBy} from './capture-levels.mjs';
import {declared} from './primitives.mjs';
import {captureSupported} from './capture-support.mjs';
import {photoKernels} from '../capture-kernels.mjs';
import {verbSteps, STEPS} from './verb-steps.mjs';
export {configureWasm} from '../wasm-modules.mjs';
const required = async () => {
  if (!await webgpuUsable()) throw fail('JXL_WEBGPU', "webgpu: 'required', and this realm has no WebGPU device. Leave webgpu out for the same file on WebAssembly.");
};
export const supported = async feature => {
  if (feature === 'webgpu') return webgpuUsable();
  if (!await captureSupported(feature)) return false;
  try { return !!await photoKernels().prepare(); } catch { return false; }
};
export const prepare = () => prepareCapturePhoto().catch(error => { throw declared(error); });
const carried = carriedBy('rapier-jxl/capture-complete', CAPTURE_COMPLETE);
export const capture = captureWith(readTexture, {admit: options => admitCapturePhoto(options, carried), rectangles: captureRectangles, run: captureRunner(CAPTURE_TOOLS_COMPLETE, {device: required, answerer: engineAnswerer(captureEngine, CAPTURE_TOOLS_COMPLETE.gpu)})}, imageResult);
Object.defineProperty(capture, STEPS, {value: verbSteps('capture-complete:rapier-jxl', capture,
  {taken: ['fidelity', 'effort', 'webgpu', 'exactRects', 'photoRects', 'maxPixels'], rows: true})});
