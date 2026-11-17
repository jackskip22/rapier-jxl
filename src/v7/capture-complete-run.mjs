// SPDX-License-Identifier: MIT
import {captureRunner} from './run-capture-photo.mjs';
import {CAPTURE_TOOLS_COMPLETE} from '../capture-ans.mjs';
import {webgpuUsable} from './webgpu.mjs';
import {captureEngine} from '../gpu-capture.mjs';
import {engineAnswerer} from './capture-engine.mjs';
import {fail} from './primitives.mjs';

const required = async () => {
  if (!await webgpuUsable(true)) throw fail('JXL_WEBGPU', 'no WebGPU device: omit webgpu');
};
export const runCaptureComplete = captureRunner(CAPTURE_TOOLS_COMPLETE, {device: required, answerer: engineAnswerer(captureEngine, CAPTURE_TOOLS_COMPLETE.gpu)});
