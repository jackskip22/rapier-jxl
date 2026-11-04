// SPDX-License-Identifier: MIT
let current;
export function gpuDevice() {
  if (current) return current;
  const pending = (async () => {
    const adapter = await globalThis.navigator?.gpu?.requestAdapter({powerPreference: 'high-performance'});
    if (!adapter || adapter.info.isFallbackAdapter) return null;
    const device = await adapter.requestDevice({requiredLimits: {maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize, maxBufferSize: adapter.limits.maxBufferSize}});
    device.lost.then(() => { if (current === pending) current = undefined; });
    return device;
  })().catch(() => null).then(device => {
    if (!device && current === pending) current = undefined;
    return device;
  });
  return current = pending;
}
