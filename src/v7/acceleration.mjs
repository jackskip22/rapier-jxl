import {gpuCoreDevice, gpuCoreReady, gpuCoreSettled, gpuCoreImage} from '../gpu-core.mjs';
import {kernelsReady} from './kernels-ready.mjs';
import {gpuOffered, hostGPU} from '../gpu-gate.mjs';
import {GPU_EFFORT, requireWebGPU, NOT_DEVICE} from './webgpu.mjs';
import {fail} from './primitives.mjs';
import {deviceFor, deviceUp} from '../device-trial.mjs';

export async function acceleration(webgpu, width = 0, height = 0, effort = 0, route = 'still', ran) {
  const gpu = await deviceRoute(webgpu, width, height, effort, route);
  return gpu && ran ? marked(async request => { const image = await gpu(request); if (image != null) ran(); return image; }, gpu) : gpu;
}
const marked = (answer, from) => Object.defineProperties(answer, {trials: {get: () => from.trials === true}, generation: {get: () => from.generation ?? 0}});
async function deviceRoute(webgpu, width, height, effort, route) {
  await kernelsReady();
  if (webgpu === false) return undefined;
  const required = webgpu === 'required';
  if (route !== 'still') {
    if (required) throw fail('JXL_WEBGPU', `${route} runs on WebAssembly only; leave webgpu out.`);
    return undefined;
  }
  if (effort < GPU_EFFORT) { if (required) throw fail('JXL_WEBGPU', NOT_DEVICE); return undefined; }
  if (!required && !gpuOffered(width, height, effort)) return undefined;
  await requireWebGPU(webgpu, true, effort);
  if (!hostGPU()) return undefined;
  if (!required) {
    const run = {trials: true, generation: 0};
    const ready = gpuCoreDevice().then(device => { if (!device) return null; run.generation = deviceFor(device); return gpuCoreReady(device, effort).then(ok => { if (ok) gpuCoreSettled(device, effort).then(() => deviceUp(device), () => {}); return ok ? device : null; }); }).catch(() => null);
    return marked(async request => {
      const device = await ready;
      if (!device) return null;
      try { return await gpuCoreImage(device, request, false); } catch { return null; }
    }, run);
  }
  let device = null;
  try { device = await gpuCoreDevice(); } catch (cause) { throw gpuFailed(cause); }
  if (!device) throw gpuFailed();
  return async request => {
    let image;
    try { image = await gpuCoreImage(device, request, required); }
    catch (cause) { if (required) throw gpuFailed(cause); return null; }
    if (image == null && required) throw gpuFailed();
    return image;
  };
}
export async function deviceAgain(webgpu, code) {
  try { return await code(webgpu); }
  catch (error) {
    if (!error?.again) throw error;
    if (webgpu === 'required') throw gpuFailed(error);
    return code(false);
  }
}
const gpuFailed = cause => Object.assign(fail('JXL_WEBGPU', "Required WebGPU device could not run this job; use a capable device or leave webgpu out."), cause ? {cause} : {});

export function describedRoute(data, codec) {
  if (codec.icc !== undefined) return 'a picture with an ICC profile';
  if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray) || (codec.bitDepth ?? 8) !== 8) return 'samples deeper than 8 bits';
  if ((codec.transferFunction ?? 'srgb') !== 'srgb' || (codec.intensityTarget ?? 255) !== 255) return 'an HDR picture';
  if (codec.alphaPremultiplied) return 'premultiplied alpha';
  if (typeof codec.colorSpace === 'object' || (codec.colorSpace ?? 'srgb') !== 'srgb') return `a ${typeof codec.colorSpace === 'string' ? codec.colorSpace : 'non-sRGB'} picture`;
  return 'still';
}
