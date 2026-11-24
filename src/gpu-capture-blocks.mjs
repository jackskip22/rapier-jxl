// SPDX-License-Identifier: MIT
import {fault} from './fault.mjs';
import {gpuDevice} from './gpu-device.mjs';
import {gpuSize, gpuWrite} from './gpu-kit.mjs';
import {GC_DS, gpuCoreQualified} from './gpu-arithmetic.mjs';
import {gpuBlocksCosts, gpuBlocksLevels} from './gpu-blocks.mjs';

const check = signal => { if (signal?.aborted) throw signal.reason; };
const refused = new WeakSet();
const unavailable = (webgpu, why) => {
  if (webgpu === 'required') throw fault('JXL_WEBGPU', `block search (${why}): omit webgpu`);
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

const captureBlockPlanes = (device, request, signal) => {
  const storeBand = (held, key, arrays, buffer) => {
    const byteLength = arrays[0].byteLength, keep = held && held.bytes + 3 * byteLength <= RESIDENT_BYTES;
    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    const out = arrays.map(pairs => {
      check(signal);
      return gpuWrite(device, keep ? device.createBuffer({size: gpuSize(byteLength), usage}) : buffer(byteLength, usage), pairs);
    });
    if (keep) { held.bands.set(key, out); held.bytes += 3 * byteLength; }
    return {planes: out, row: 0};
  };
  return {
    encodePlanes(_encoder, buffer, _data, _width, _height, from, to) {
      check(signal);
      const held = residentBands(request.devicePlanes, device), key = from + ':' + to, kept = held?.bands.get(key);
      if (kept) return {planes: kept, row: 0};
      const bound = request.planeBound;
      if (!(Number.isFinite(bound) && bound >= 0 && Math.fround(bound) === bound))
        throw fault('JXL_INTERNAL', 'gpu-capture-blocks:bound');
      const staged = held?.staged?.get(key);
      if (staged) { held.staged.delete(key); return storeBand(held, key, staged, buffer); }
      const {planes, top, stride} = request.planeRows(from, to), width = request.input.stride * 8;
      if (!Array.isArray(planes) || planes.length !== 3 || stride !== width || !Number.isSafeInteger(top) || top < 0 || top > from)
        throw fault('JXL_INTERNAL', 'gpu-capture-blocks:band');
      const count = width * (to - from), offset = width * (from - top);
      const split = planes.map(plane => {
        if (!ArrayBuffer.isView(plane) || plane.length < offset + count) throw fault('JXL_INTERNAL', 'gpu-capture-blocks:length');
        const pairs = new Float32Array(count * 2);
        for (let i = 0; i < count; i++) {
          const value = plane[offset + i], hi = Math.fround(value), lo = Math.fround(value - hi);
          if (!Number.isFinite(value) || !Number.isFinite(hi) || !Number.isFinite(lo))
            throw fault('JXL_INTERNAL', 'gpu-capture-blocks:ds');
          if (Math.abs(value - (hi + lo)) > bound) throw fault('JXL_INTERNAL', 'gpu-capture-blocks:error');
          pairs[i * 2] = hi; pairs[i * 2 + 1] = lo;
        }
        return pairs;
      });
      return storeBand(held, key, split, buffer);
    },
  };
};

export async function captureBlockRequest(webgpu, request, signal) {
  check(signal);
  if (webgpu === false) return null;
  const device = await gpuDevice(signal);
  check(signal);
  if (!device || refused.has(device)) return unavailable(webgpu, device ? 'prior audit failed' : 'no device');
  const qualified = await gpuCoreQualified(device).catch(() => false);
  check(signal);
  if (!qualified) return unavailable(webgpu, 'unqualified arithmetic');
  const run = request.kind === 'photo-block-costs' ? gpuBlocksCosts : request.kind === 'photo-block-levels' ? gpuBlocksLevels : null;
  if (!run) return null;
  let answer;
  try { answer = await run(device, request, GC_DS, captureBlockPlanes(device, request, signal)); } catch (error) {
    check(signal);
    return unavailable(webgpu, `${error?.message ?? error}`);
  }
  check(signal);
  const audited = request.kind === 'photo-block-costs' || request.audit ? request.audit(answer) : 0;
  if (!(audited <= 1)) {
    refused.add(device);
    return unavailable(webgpu, `${request.kind} audit ${audited} > 1`);
  }
  return answer;
}
