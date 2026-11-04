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
export {webgpuSetting} from './primitives.mjs';
let kernelCheck = null;
export const checkKernelsFirst = check => { kernelCheck = check; };
export async function requireWebGPU(setting, lossy = true, effort = GPU_EFFORT) {
  if (setting !== 'required' || !lossy || effort < GPU_EFFORT || await webgpuUsable()) return;
  if (kernelCheck) await kernelCheck();
  throw fail('JXL_WEBGPU', "webgpu: 'required', and this realm has no WebGPU device. Without " +
    "it, efforts 7-9 run on WebAssembly: same file, slower.");
}
