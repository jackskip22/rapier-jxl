import {gpuCoreDevice, gpuCoreDefaultReady, gpuCoreImage, gpuCorePrewarm, gpuCorePrewarmCells} from '../gpu-core.mjs';
import {gpuDeviceProbe} from '../gpu-arithmetic.mjs';
import {kernelsReady} from './kernels-ready.mjs';
import {gpuOffered, hostGPU} from '../gpu-gate.mjs';
import {GPU_EFFORT, EXACT_GPU_EFFORT, requireWebGPU, NOT_DEVICE} from './webgpu.mjs';
import {fail, check, abortable} from './primitives.mjs';
import {currentDeviceGeneration, deviceFor, devicePhone, deviceUp} from '../device-trial.mjs';
import {gpuCheck} from '../gpu-kit.mjs';

export async function acceleration(webgpu, width = 0, height = 0, effort = 0, route = 'still', ran, signal, exact = false, cellsRoute = false) {
  const gpu = await abortable(deviceRoute(webgpu, width, height, effort, route, signal, exact, cellsRoute), signal);
  const answer = gpu && ran ? marked(async request => { const image = await gpu(request); if (image != null && !request.end && !request.failed) ran(); return image; }, gpu) : gpu;
  return answer && Object.defineProperties(answer, {mode: {value: webgpu === 'required' ? 'required' : 'auto'}, ran: {value: ran}});
}
const marked = (answer, from) => Object.defineProperties(answer, {
  trials: {get: () => from.trials === true},
  generation: {get: () => from.generation ?? 0},
  phoneRequired: {get: () => from.phoneRequired ?? 0},
  ...(from.warm && {warm: {value: from.warm}}),
});
export function mobileHost(nav = globalThis.navigator) {
  try {
    const hint = nav?.userAgentData?.mobile;
    if (typeof hint === 'boolean') return hint;
    return /Android|iPhone|iPod|Mobile/i.test(String(nav?.userAgent || ''));
  } catch { return false; }
}
async function deviceRoute(webgpu, width, height, effort, route, signal, exact = false, cellsRoute = false) {
  await kernelsReady();
  if (webgpu === false) return undefined;
  const required = webgpu === 'required';
  if (route !== 'still') {
    if (required) throw fail('JXL_WEBGPU', `${route}: WebAssembly only`);
    return undefined;
  }
  if ((typeof __RAPIER_JXL_EFFORT_TEN__ === 'undefined' || __RAPIER_JXL_EFFORT_TEN__ === true) && effort === 10 && !exact) effort = 9;
  if (effort < GPU_EFFORT) { if (required) throw fail('JXL_WEBGPU', NOT_DEVICE); return undefined; }
  if (!required && !gpuOffered(width, height, effort)) return undefined;
  if (!required && mobileHost()) return undefined;
  await requireWebGPU(webgpu, true, effort);
  if (!hostGPU()) return undefined;
  if (!required && effort === EXACT_GPU_EFFORT) return tenDevice(signal);
  if (!required) {
    const run = {trials: true, generation: currentDeviceGeneration()};
    const ready = gpuCoreDevice(signal).then(async device => {
      if (!device || signal?.aborted) return null;
      run.generation = deviceFor(device);
      const state = await gpuCoreDefaultReady(device, effort);
      if (!state.ok || signal?.aborted) return null;
      if (state.phone) { devicePhone(device, state.floorMs, state.perMB); return null; }
      state.ready.then(ok => { if (ok) deviceUp(device); }, () => {});
      return device;
    }).catch(() => null);
    return marked(async request => {
      const device = await ready;
      if (!device) return null;
      try { return await gpuCoreImage(device, request, false, signal); } catch { return null; }
    }, run);
  }
  let device = null;
  try { device = await gpuCoreDevice(signal); } catch (cause) { throw gpuFailed(cause); }
  check(signal);
  if (!device) throw gpuFailed();
  try { gpuCheck(device); } catch (cause) { throw gpuFailed(cause); }
  const state = {trials: false, generation: 0, phoneRequired: 0, warm: null};
  let warmPromise = null;
  const warm = () => warmPromise ??= (async () => {
    if (signal?.aborted) return;
    let probed;
    try { probed = await gpuDeviceProbe(device); } catch (cause) { check(signal); throw gpuFailed(cause); }
    check(signal);
    if (!probed.ok) throw gpuFailed();
    if (cellsRoute && !probed.synthetic && probed.ms > 25) {
      state.phoneRequired = effort;
      gpuCorePrewarmCells(device);
    } else {
      try { gpuCorePrewarm(device); } catch {}
    }
  })();
  state.warm = warm;
  const strict = async request => {
    if (!exact) await warm();
    let image;
    try { image = await gpuCoreImage(device, request, required, signal); }
    catch (cause) { check(signal); if (required) throw gpuFailed(cause); return null; }
    check(signal);
    if (image == null && required) throw gpuFailed();
    return image;
  };
  return exact ? strict : marked(strict, state);
}
export async function deviceAgain(webgpu, code) {
  try { return await code(webgpu); }
  catch (error) {
    if (!error?.again) throw error;
    if (webgpu === 'required') throw gpuFailed(error);
    return code(false);
  }
}
function tenDevice(signal) {
  const run = {trials: false, generation: 0};
  let device = null, asking = null;
  const ask = () => {
    asking ??= gpuCoreDevice(signal).then(found => { if (found) { device = found; run.generation = deviceFor(found); deviceUp(found); found.lost?.then(() => { if (device === found) device = null; }); } }, () => {}).finally(() => { asking = null; });
  };
  ask();
  return marked(async request => {
    if (!device) { ask(); return null; }
    try { return await gpuCoreImage(device, request, false, signal); } catch { return null; }
  }, run);
}
const gpuFailed = cause => Object.assign(fail('JXL_WEBGPU', "webgpu: capable device or omit"), cause ? {cause} : {});

export function describedRoute(data, codec) {
  if (codec.icc !== undefined) return 'a picture with an ICC profile';
  if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray) || (codec.bitDepth ?? 8) !== 8) return 'samples deeper than 8 bits';
  if ((codec.transferFunction ?? 'srgb') !== 'srgb' || (codec.intensityTarget ?? 255) !== 255) return 'an HDR picture';
  if (codec.alphaPremultiplied) return 'premultiplied alpha';
  if (typeof codec.colorSpace === 'object' || (codec.colorSpace ?? 'srgb') !== 'srgb') return `a ${typeof codec.colorSpace === 'string' ? codec.colorSpace : 'non-sRGB'} picture`;
  return 'still';
}
