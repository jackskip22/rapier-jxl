import {wasmRequired} from '../capture-wasm-error.mjs';
import {fail} from './primitives.mjs';

const SIMD = Uint8Array.of(0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11);
const simd = () => { try { return typeof WebAssembly === 'object' && WebAssembly.validate(SIMD); } catch { return false; } };
export const supported = feature => answer(feature, true, true);
export const wasmOnlySupported = feature => answer(feature, true, false);
export const captureSupported = feature => answer(feature, false, false);
async function answer(feature, needsSimd, gpu) {
  if (feature === 'webgpu') return gpu && (await import('./webgpu.mjs')).webgpuUsable();
  if (feature !== undefined) throw fail('JXL_OPTIONS', "supported takes nothing, or 'webgpu'.");
  if (needsSimd && !simd()) return false;
  try { return !!await (await import('../capture-kernels.mjs')).compileCaptureKernels(); }
  catch { return false; }
}

export async function requireCapture() {
  let core;
  try { core = await import('../capture-kernels.mjs'); } catch {}
  if (!await core?.compileCaptureKernels()) throw wasmRequired();
  return core;
}
