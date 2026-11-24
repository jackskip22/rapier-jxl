import {wasmRequired} from '../capture-wasm-error.mjs';
import {fail} from './primitives.mjs';
import {webgpuUsable} from './webgpu.mjs';
import {simd} from './simd-probe.mjs';
import * as captureKernels from '../capture-kernels.mjs';

export const supported = (typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) ? null : async feature => feature === 'webgpu' ? webgpuUsable() : answer(feature, true);
export const wasmOnlySupported = (typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) ? null : feature => answer(feature, true);
export const captureSupported = feature => answer(feature, false);
async function answer(feature, needsSimd) {
  if (feature === 'webgpu') return false;
  if (feature !== undefined) throw fail('JXL_OPTIONS', "supported(): no argument or 'webgpu'");
  if (!(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && needsSimd && !simd()) return false;
  try { return !!await captureKernels.compileCaptureKernels(); }
  catch { return false; }
}

export async function requireCapture() {
  if (!await captureKernels.compileCaptureKernels()) throw wasmRequired();
  return captureKernels;
}
