import {fail} from './primitives.mjs';
import {realmAdapter, isDeviceUp} from '../gpu-gate.mjs';
export const GPU_EFFORT = 7;
export const CONFIGURED_WEBGPU = Symbol.for('rapier-jxl.configured-webgpu');
let usable;
export function webgpuUsable(fresh = false) {
  if (usable && (!fresh || isDeviceUp())) return usable;
  const answer = realmAdapter(fresh).then(adapter => !!adapter);
  answer.then(yes => { usable = yes ? answer : undefined; });
  return answer;
}
export {webgpuSetting} from './primitives.mjs';
let kernelCheck = null;
export const checkKernelsFirst = check => { kernelCheck = check; };
export const EXACT_GPU_EFFORT = 10;
export const NOT_DEVICE = 'lossy efforts 7-10 or exact effort 10 only, or omit webgpu';
export async function requireWebGPU(setting, lossy = true, effort = GPU_EFFORT) {
  if (setting !== 'required') return;
  if (!lossy && effort !== EXACT_GPU_EFFORT || effort < GPU_EFFORT) throw fail('JXL_WEBGPU', NOT_DEVICE);
  if (await webgpuUsable(true)) return;
  if (kernelCheck) await kernelCheck();
  throw fail('JXL_WEBGPU', 'no WebGPU device: omit webgpu');
}
