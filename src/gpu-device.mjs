// SPDX-License-Identifier: MIT
import {realmAdapter, adopted, kept, adapterRefused, limited, setDeviceUp} from './gpu-gate.mjs';
import {deviceLost} from './device-trial.mjs';
import {holdDevice} from './device-held.mjs';
let current, asking = null;
export function gpuDevice(signal) {
  if (current) { asking?.push(signal); return limited(current); }
  const callers = asking = [signal];
  const pending = (async () => {
    const adapter = await realmAdapter();
    if (!adapter) return null;
    if (callers.every(s => s?.aborted)) { kept(adapter); return null; }
    if (asking === callers) asking = null;
    callers.length = 0;
    adopted(adapter);
    const device = await adapter.requestDevice({requiredLimits: {maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize, maxBufferSize: adapter.limits.maxBufferSize}}).catch(error => { adapterRefused(adapter); throw error; });
    setDeviceUp(true);
    device.lost.then(() => { if (current === pending) { current = undefined; holdDevice(false); setDeviceUp(false); } deviceLost(device); });
    holdDevice(true);
    return device;
  })().catch(() => null).then(device => {
    if (asking === callers) asking = null;
    if (!device && current === pending) current = undefined;
    return device;
  });
  return limited(current = pending);
}
