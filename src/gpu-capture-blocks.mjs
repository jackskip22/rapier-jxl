// SPDX-License-Identifier: MIT
import {fault} from './fault.mjs';
import {gpuDevice} from './gpu-device.mjs';
import {GC_DS, gpuCoreQualified} from './gpu-arithmetic.mjs';
import {gpuBlocksCosts, gpuBlocksLevels} from './gpu-blocks.mjs';

const check = signal => { if (signal?.aborted) throw signal.reason; };
const refused = new WeakSet();
const unavailable = webgpu => {
  if (webgpu === 'required') throw fault('JXL_WEBGPU', "webgpu: 'required', and the device could not run the photo block search. Leave webgpu out for the same file on WebAssembly.");
  return null;
};

const RESIDENT_BYTES = 1 << 30;
const residentBands = (held, device) => {
  if (!held || (held.device && held.device !== device)) return null;
  if (!held.device) Object.assign(held, {device, bands: new Map(), bytes: 0, release() {
    for (const planes of held.bands.values()) for (const b of planes) b.destroy();
    held.bands.clear(); held.staged?.clear(); held.bytes = 0;
  }});
  return held;
};
const captureBlockPlanes = (device, request, signal) => ({
  encodePlanes(_encoder, buffer, _data, _width, _height, from, to) {
    check(signal);
    const held = residentBands(request.devicePlanes, device), key = from + ':' + to, kept = held?.bands.get(key);
    if (kept) return {planes: kept, row: 0};
    const bound = request.planeBound;
    if (!(Number.isFinite(bound) && bound >= 0 && Math.fround(bound) === bound))
      throw new Error('Photo block plane bound must be a finite nonnegative f32.');
    const staged = held?.staged?.get(key);
    if (staged) {
      held.staged.delete(key);
      const byteLength = staged[0].byteLength, keep = held.bytes + 3 * byteLength <= RESIDENT_BYTES;
      const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, out = [];
      for (const pairs of staged) {
        check(signal);
        const gpu = keep ? device.createBuffer({size: Math.max(16, Math.ceil(byteLength / 16) * 16), usage}) : buffer(byteLength, usage);
        device.queue.writeBuffer(gpu, 0, pairs);
        out.push(gpu);
      }
      if (keep) { held.bands.set(key, out); held.bytes += 3 * byteLength; }
      return {planes: out, row: 0};
    }
    const {planes, top, stride} = request.planeRows(from, to), width = request.input.stride * 8;
    if (!Array.isArray(planes) || planes.length !== 3 || stride !== width || !Number.isSafeInteger(top) || top < 0 || top > from)
      throw new Error('Photo block planes do not cover the requested band.');
    const count = width * (to - from), offset = width * (from - top), pairs = new Float32Array(count * 2);
    const out = [], keep = held && held.bytes + 3 * pairs.byteLength <= RESIDENT_BYTES;
    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    for (const plane of planes) {
      if (!ArrayBuffer.isView(plane) || plane.length < offset + count) throw new Error('Photo block plane is too short.');
      for (let i = 0; i < count; i++) {
        const value = plane[offset + i], hi = Math.fround(value), lo = Math.fround(value - hi);
        if (!Number.isFinite(value) || !Number.isFinite(hi) || !Number.isFinite(lo))
          throw new Error('Photo block plane has no finite double-single representation.');
        if (Math.abs(value - (hi + lo)) > bound) throw new Error('Photo block plane exceeds its supplied error bound.');
        pairs[i * 2] = hi; pairs[i * 2 + 1] = lo;
      }
      check(signal);
      const gpu = keep ? device.createBuffer({size: Math.max(16, Math.ceil(pairs.byteLength / 16) * 16), usage}) : buffer(pairs.byteLength, usage);
      device.queue.writeBuffer(gpu, 0, pairs);
      out.push(gpu);
    }
    if (keep) { held.bands.set(key, out); held.bytes += 3 * pairs.byteLength; }
    return {planes: out, row: 0};
  },
});

export async function captureBlockRequest(webgpu, request, signal) {
  check(signal);
  if (webgpu === false) return null;
  const device = await gpuDevice();
  check(signal);
  if (!device || refused.has(device)) return unavailable(webgpu);
  const qualified = await gpuCoreQualified(device);
  check(signal);
  if (!qualified) return unavailable(webgpu);
  try {
    const run = request.kind === 'photo-block-costs' ? gpuBlocksCosts : request.kind === 'photo-block-levels' ? gpuBlocksLevels : null;
    if (!run) return null;
    const answer = await run(device, request, GC_DS, captureBlockPlanes(device, request, signal));
    check(signal);
    if ((request.kind === 'photo-block-costs' || request.audit) && !(request.audit(answer) <= 1)) {
      refused.add(device);
      return unavailable(webgpu);
    }
    check(signal);
    return answer;
  } catch {
    check(signal);
    return unavailable(webgpu);
  }
}
