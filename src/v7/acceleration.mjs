import {kernelsReady} from './kernels-ready.mjs';
import {gpuOffered} from '../gpu-gate.mjs';
import {GPU_EFFORT, requireWebGPU} from './webgpu.mjs';
import {fail} from './primitives.mjs';

export async function acceleration(webgpu, width = 0, height = 0, effort = 0, route = 'still') {
  await kernelsReady();
  if (effort < GPU_EFFORT || webgpu === false) return undefined;
  const required = webgpu === 'required';
  if (route !== 'still') {
    if (required) throw fail('JXL_WEBGPU', `This codec requires WebGPU (webgpu: 'required'), and this version runs ${route} on WebAssembly only. Leave the setting out to run it on WebAssembly, the same file.`);
    return undefined;
  }
  if (!required && !gpuOffered(width, height, effort)) return undefined;
  await requireWebGPU(webgpu, true, effort);
  if (!globalThis.navigator?.gpu) return undefined;
  const core = await import('../gpu-core.mjs');
  let device = null;
  try { device = await core.gpuCoreDevice(); if (device && !required && !await core.gpuCoreReady(device)) device = null; } catch (cause) { if (required) throw gpuFailed(cause); device = null; }
  if (!device) { if (required) throw gpuFailed(); return undefined; }
  return async request => {
    let image;
    try { image = await core.gpuCoreImage(device, request, required); }
    catch (cause) { if (required) throw gpuFailed(cause); return null; }
    if (image == null && required) throw gpuFailed();
    return image;
  };
}
const gpuFailed = cause => Object.assign(fail('JXL_WEBGPU', "This codec requires WebGPU (webgpu: 'required') and the device could not run this job" + (cause?.message ? ': ' + cause.message : '.')), cause ? {cause} : {});

export function describedRoute(data, codec) {
  if (codec.icc !== undefined) return 'a picture with an ICC profile';
  if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray) || (codec.bitDepth ?? 8) !== 8) return 'samples deeper than 8 bits';
  if ((codec.transferFunction ?? 'srgb') !== 'srgb' || (codec.intensityTarget ?? 255) !== 255) return 'an HDR picture';
  if (codec.alphaPremultiplied) return 'premultiplied alpha';
  if (typeof codec.colorSpace === 'object' || (codec.colorSpace ?? 'srgb') !== 'srgb') return `a ${typeof codec.colorSpace === 'string' ? codec.colorSpace : 'non-sRGB'} picture`;
  return 'still';
}
