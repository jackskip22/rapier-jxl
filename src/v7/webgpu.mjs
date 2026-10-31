import {fail} from './primitives.mjs';
export const GPU_EFFORT = 7;
let usable;
export function webgpuUsable() {
  return usable ??= (async () => {
    const gpu = globalThis.navigator?.gpu;
    if (!gpu || typeof gpu.requestAdapter !== 'function') return false;
    try {
      const adapter = await gpu.requestAdapter();
      return !!adapter && !(adapter.info?.isFallbackAdapter ?? adapter.isFallbackAdapter);
    } catch { return false; }
  })();
}
export function webgpuSetting(value) {
  if (value !== undefined && value !== 'required' && value !== false)
    throw fail('JXL_OPTIONS', "webgpu is 'required' or false; leave it out to use WebGPU where this realm has it.");
  return value;
}
let kernelCheck = null;
export const checkKernelsFirst = check => { kernelCheck = check; };
export async function requireWebGPU(setting, lossy = true, effort = GPU_EFFORT) {
  if (setting !== 'required' || !lossy || effort < GPU_EFFORT || await webgpuUsable()) return;
  if (kernelCheck) await kernelCheck();
  throw fail('JXL_WEBGPU', "This codec requires WebGPU (webgpu: 'required') and this realm has no usable WebGPU device. Without " +
    "the setting, lossy efforts 7-9 run on WebAssembly here and write the same file, more slowly; efforts 1-6 never need it.");
}
