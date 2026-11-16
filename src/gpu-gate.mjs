// SPDX-License-Identifier: MIT
export const GPU_FROM = Object.freeze({7: 0, 8: 0, 9: 0});
export const gpuOffered = (width, height, effort) => width * height >= (GPU_FROM[effort] ?? Infinity);
export const hostGPU = () => { try { return globalThis.navigator?.gpu; } catch { return undefined; } };
export const REFUSED_MS = 30000;
export const REQUEST_MS = 3000;
const late = new WeakSet();
export function limited(request) {
  if (late.has(request)) return Promise.resolve(null);
  let timer;
  const limit = new Promise(done => { timer = setTimeout(() => { late.add(request); done(null); }, REQUEST_MS); });
  request.then(() => late.delete(request), () => late.delete(request));
  return Promise.race([request, limit]).finally(() => clearTimeout(timer));
}
let inFlight = null, refusedAt = -Infinity, arrived = null, latest = 0;
const generation = new WeakMap();
const isFallback = adapter => adapter.info?.isFallbackAdapter ?? adapter.isFallbackAdapter;
export function realmAdapter(fresh = false) {
  if (arrived) return Promise.resolve(arrived);
  if (inFlight) return limited(inFlight);
  const gpu = hostGPU();
  if (!gpu || typeof gpu.requestAdapter !== 'function' || !fresh && Date.now() - refusedAt < REFUSED_MS) return Promise.resolve(null);
  const asked = inFlight = Promise.resolve().then(() => gpu.requestAdapter({powerPreference: 'high-performance'})).catch(() => null).then(adapter => {
    if (inFlight === asked) inFlight = null;
    if (!adapter || isFallback(adapter)) { refusedAt = Date.now(); return null; }
    refusedAt = -Infinity;
    generation.set(adapter, ++latest);
    if (late.has(asked)) arrived = adapter;
    return adapter;
  });
  return limited(asked);
}
export const adopted = adapter => { if (arrived === adapter) arrived = null; };
export const adapterRefused = adapter => {
  if (generation.get(adapter) !== latest) return;
  if (arrived === adapter) arrived = null;
  refusedAt = Date.now();
};
