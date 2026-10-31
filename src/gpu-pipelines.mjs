// SPDX-License-Identifier: MIT
const gpDevices = new WeakMap();
const gpLost = () => Object.assign(new Error('GPU pipeline device is unavailable.'), {code: 'JXL_GPU'});

export function gpuPipelineSet(shaders) {
  const sources = Object.entries(shaders);
  return device => {
    let state = gpDevices.get(device);
    if (!state) {
      state = {lost: false, sets: new Map()}; gpDevices.set(device, state);
      device.lost.then(() => { state.lost = true; state.sets.clear(); });
    }
    if (state.lost) return Promise.reject(gpLost());
    let pending = state.sets.get(sources);
    if (!pending) {
      pending = (async () => {
        const pipelines = {};
        for (const [name, code] of sources) {
          if (state.lost) throw gpLost();
          pipelines[name] = await device.createComputePipelineAsync({layout: 'auto', compute: {module: device.createShaderModule({code}), entryPoint: 'main'}});
        }
        if (state.lost) throw gpLost();
        return Object.freeze(pipelines);
      })().catch(error => {
        if (state.sets.get(sources) === pending) state.sets.delete(sources);
        throw error;
      });
      state.sets.set(sources, pending);
    }
    return pending;
  };
}
