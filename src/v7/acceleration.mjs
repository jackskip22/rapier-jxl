import {kernelHooks} from '../kernel-hooks.mjs';

export async function acceleration(mode = 'js', width = 0, height = 0, effort = 7) {
  for (const key of Object.keys(kernelHooks)) kernelHooks[key] = null;
  if (mode === 'wasm' || mode === 'auto') {
    const {configureKernels} = await import('../kernels.mjs');
    configureKernels('auto');
  }
  if ((mode === 'webgpu' || mode === 'auto') && width > 0 && height > 0 && effort >= 4 && effort <= 7 && !(effort === 7 && width * height >= 8000000) && globalThis.navigator?.gpu) {
    const core = await import('../gpu-core.mjs');
    const device = await core.gpuCoreDevice();
    if (device) return async request => { try { return await core.gpuCoreImage(device, request); } catch { return null; } };
  }
  return undefined;
}
