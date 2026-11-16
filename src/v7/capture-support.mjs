import {wasmRequired} from '../capture-wasm-error.mjs';
import {fail} from './primitives.mjs';
import {webgpuUsable} from './webgpu.mjs';
import {simd} from './simd-probe.mjs';
import * as captureKernels from '../capture-kernels.mjs';

export const supported = async feature => feature === 'webgpu' ? webgpuUsable() : answer(feature, true);
export const wasmOnlySupported = feature => answer(feature, true);
export const captureSupported = feature => answer(feature, false);
async function answer(feature, needsSimd) {
  if (feature === 'webgpu') return false;
  if (feature !== undefined) throw fail('JXL_OPTIONS', "Feature is unknown; call supported() or supported('webgpu').");
  if (needsSimd && !simd()) return false;
  try { return !!await captureKernels.compileCaptureKernels(); }
  catch { return false; }
}

export async function requireCapture() {
  if (!await captureKernels.compileCaptureKernels()) throw wasmRequired();
  return captureKernels;
}
