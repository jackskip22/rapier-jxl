import {wasmRequired} from '../capture-wasm-error.mjs';
import {fail} from './primitives.mjs';
import {webgpuUsable} from './webgpu.mjs';
import * as captureKernels from '../capture-kernels.mjs';

const SIMD = Uint8Array.of(0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11);
const simd = () => { try { return typeof WebAssembly === 'object' && WebAssembly.validate(SIMD); } catch { return false; } };
export const supported = async feature => feature === 'webgpu' ? webgpuUsable() : answer(feature, true);
export const wasmOnlySupported = feature => answer(feature, true);
export const captureSupported = feature => answer(feature, false);
async function answer(feature, needsSimd) {
  if (feature === 'webgpu') return false;
  if (feature !== undefined) throw fail('JXL_OPTIONS', "supported takes nothing, or 'webgpu'.");
  if (needsSimd && !simd()) return false;
  try { return !!await captureKernels.compileCaptureKernels(); }
  catch { return false; }
}

export async function requireCapture() {
  if (!await captureKernels.compileCaptureKernels()) throw wasmRequired();
  return captureKernels;
}
