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

export const captureBlockPlanes = (device, request, signal) => ({
  encodePlanes(_encoder, buffer, _data, _width, _height, from, to) {
    check(signal);
    const bound = request.planeBound;
    if (!(Number.isFinite(bound) && bound >= 0 && Math.fround(bound) === bound))
      throw new Error('Photo block plane bound must be a finite nonnegative f32.');
    const {planes, top, stride} = request.planeRows(from, to), width = request.input.stride * 8;
    if (!Array.isArray(planes) || planes.length !== 3 || stride !== width || !Number.isSafeInteger(top) || top < 0 || top > from)
      throw new Error('Photo block planes do not cover the requested band.');
    const count = width * (to - from), offset = width * (from - top), pairs = new Float32Array(count * 2);
    const out = [];
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
      const gpu = buffer(pairs.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
      device.queue.writeBuffer(gpu, 0, pairs);
      out.push(gpu);
    }
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
