import {fail} from './primitives.mjs';
import {realmAdapter} from '../gpu-gate.mjs';
export const GPU_EFFORT = 7;
export const CONFIGURED_WEBGPU = Symbol.for('rapier-jxl.configured-webgpu');
let usable;
export function webgpuUsable(fresh = false) {
  if (usable && !fresh) return usable;
  const answer = realmAdapter(fresh).then(adapter => !!adapter);
  answer.then(yes => { usable = yes ? answer : undefined; });
  return answer;
}
export {webgpuSetting} from './primitives.mjs';
let kernelCheck = null;
export const checkKernelsFirst = check => { kernelCheck = check; };
export const NOT_DEVICE = 'lossy efforts 7-9 only, or omit webgpu';
export async function requireWebGPU(setting, lossy = true, effort = GPU_EFFORT) {
  if (setting !== 'required') return;
  if (!lossy || effort < GPU_EFFORT) throw fail('JXL_WEBGPU', NOT_DEVICE);
  if (await webgpuUsable(true)) return;
  if (kernelCheck) await kernelCheck();
  throw fail('JXL_WEBGPU', 'no WebGPU device: omit webgpu');
}
