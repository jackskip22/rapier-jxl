// SPDX-License-Identifier: MIT
import {gpuCheck, gpuWait} from './gpu-kit.mjs';

const gpDevices = /* @__PURE__ */ new WeakMap();
const gpLost = () => Object.assign(new Error('device unavailable'), {code: 'JXL_GPU'});

export function gpuPipelineSet(shaders) {
  const sources = Object.entries(shaders);
  return device => {
    try { gpuCheck(device); } catch (error) { return Promise.reject(error); }
    let state = gpDevices.get(device);
    if (!state) {
      state = {lost: false, sets: new Map()}; gpDevices.set(device, state);
      device.lost.then(() => { state.lost = true; state.sets.clear(); });
    }
    if (state.lost) return Promise.reject(gpLost());
    let pending = state.sets.get(sources);
    if (!pending) {
      pending = (async () => {
        const entries = await Promise.all(sources.map(([name, code]) => {
          if (state.lost) throw gpLost();
          return gpuWait(device, device.createComputePipelineAsync({layout: 'auto', compute: {module: device.createShaderModule({code}), entryPoint: 'main'}}))
            .then(pipeline => [name, pipeline]);
        }));
        if (state.lost) throw gpLost();
        return Object.freeze(Object.fromEntries(entries));
      })().catch(error => {
        if (state.sets.get(sources) === pending) state.sets.delete(sources);
        throw error;
      });
      state.sets.set(sources, pending);
    }
    return pending;
  };
}
