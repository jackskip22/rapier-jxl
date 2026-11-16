// SPDX-License-Identifier: MIT
import {realmAdapter, adopted, adapterRefused, limited} from './gpu-gate.mjs';
import {deviceLost} from './device-trial.mjs';
let current;
export function gpuDevice() {
  if (current) return limited(current);
  const pending = (async () => {
    const adapter = await realmAdapter();
    if (!adapter) return null;
    adopted(adapter);
    const device = await adapter.requestDevice({requiredLimits: {maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize, maxBufferSize: adapter.limits.maxBufferSize}}).catch(error => { adapterRefused(adapter); throw error; });
    device.lost.then(() => { if (current === pending) current = undefined; deviceLost(device); });
    return device;
  })().catch(() => null).then(device => {
    if (!device && current === pending) current = undefined;
    return device;
  });
  return limited(current = pending);
}
