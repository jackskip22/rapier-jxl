// SPDX-License-Identifier: MIT
export const GPU_FROM = /* @__PURE__ */ Object.freeze({7: 0, 8: 0, 9: 0, 10: 65536});
export const gpuOffered = (width, height, effort) => width * height >= (GPU_FROM[effort] ?? Infinity);
export const hostGPU = () => { try { return globalThis.navigator?.gpu; } catch { return undefined; } };
export const REFUSED_MS = 30000;
export const NULL_MS = 2000, NULL_AGAIN_MS = 250;
export const REQUEST_MS = 3000;
const late = /* @__PURE__ */ new WeakSet();
export function limited(request) {
  if (late.has(request)) return Promise.resolve(null);
  let timer;
  const limit = new Promise(done => { timer = setTimeout(() => { late.add(request); done(null); }, REQUEST_MS); });
  request.then(() => late.delete(request), () => late.delete(request));
  return Promise.race([request, limit]).finally(() => clearTimeout(timer));
}
let inFlight = null, refusedAt = -Infinity, refusedFor = REFUSED_MS, arrived = null, latest = 0, askedAgain = false;
const THREW = Symbol('threw');
const generation = /* @__PURE__ */ new WeakMap();
const isFallback = adapter => adapter.info?.isFallbackAdapter ?? adapter.isFallbackAdapter;
export function realmAdapter(fresh = false) {
  if (arrived) return Promise.resolve(arrived);
  if (inFlight) return limited(inFlight);
  const gpu = hostGPU();
  if (!gpu || typeof gpu.requestAdapter !== 'function' || !fresh && Date.now() - refusedAt < refusedFor) return Promise.resolve(null);
  return limited(ask(gpu));
}
function ask(gpu) {
  const asked = inFlight = Promise.resolve().then(() => gpu.requestAdapter({powerPreference: 'high-performance'})).catch(() => THREW).then(adapter => {
    if (inFlight === asked) inFlight = null;
    if (!adapter || adapter === THREW || isFallback(adapter)) {
      refusedAt = Date.now(); refusedFor = adapter ? REFUSED_MS : NULL_MS;
      if (!adapter && !askedAgain) {
        askedAgain = true;
        const again = setTimeout(() => {
          if (inFlight || arrived || refusedAt === -Infinity || hostGPU() !== gpu) return;
          ask(gpu).then(answer => { if (answer && generation.get(answer) === latest && hostGPU() === gpu) arrived = answer; });
        }, NULL_AGAIN_MS);
        again.unref?.();
      }
      return null;
    }
    refusedAt = -Infinity;
    generation.set(adapter, ++latest);
    if (late.has(asked)) arrived = adapter;
    return adapter;
  });
  return asked;
}
let deviceUp = false;
export const setDeviceUp = up => { deviceUp = up; };
export const isDeviceUp = () => deviceUp;
export const adopted = adapter => { if (arrived === adapter) arrived = null; };
export const kept = adapter => { if (generation.get(adapter) === latest) arrived = adapter; };
export const adapterRefused = adapter => {
  if (generation.get(adapter) !== latest) return;
  if (arrived === adapter) arrived = null;
  refusedAt = Date.now(); refusedFor = REFUSED_MS;
};
