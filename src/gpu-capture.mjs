// SPDX-License-Identifier: MIT
import {fault} from './fault.mjs';
import {gpuDevice} from './gpu-device.mjs';
import {weightedOnDevice} from './gpu-weighted.mjs';
import {compileCaptureKernels, captureWeighted} from './capture-kernels.mjs';

export async function captureDevice(webgpu) {
  const device = webgpu === false ? null : await gpuDevice();
  if (!device && webgpu === 'required') throw fault('JXL_WEBGPU', "webgpu: 'required', and this realm has no WebGPU device. Leave webgpu out for the same file on WebAssembly.");
  return device;
}
export const CAPTURE_GPU_PIXELS = 1 << 20;

export const WEIGHTED = Object.freeze({
  name: 'weighted',
  run: (device, request, signal) => weightedOnDevice(device, request.planes, {signal}),
  audit(request, answer, turn) {
    const k = turn % request.planes.length, {plane, width, height} = request.planes[k], rows = Math.min(height, Math.ceil(4096 / width)), n = width * rows;
    const residuals = new Uint32Array(n), properties = new Int32Array(n);
    if (!captureWeighted(null, null, plane.subarray(0, n), width, rows, 0, undefined, residuals, properties)) return false;
    for (let i = 0; i < n; i++) if (answer[k].residuals[i] !== residuals[i] || answer[k].properties[i] !== properties[i]) return false;
    return true;
  },
  async selfTest(device) {
    if (!await compileCaptureKernels()) return false;
    let s = 7;
    const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
    const plane = (width, height, range) => ({width, height, plane: Int16Array.from({length: width * height}, () => Math.round((rnd() - 0.5) * range))});
    const request = {kind: 'weighted', planes: [plane(1, 1, 500), plane(17, 5, 65535), plane(256, 3, 510), plane(64, 64, 300)]}, answer = await weightedOnDevice(device, request.planes);
    return request.planes.every((_, k) => WEIGHTED.audit(request, answer, k));
  },
});

const refused = new WeakSet(), tested = new WeakMap();
export async function captureEngine(webgpu, kinds = [WEIGHTED], {note = () => {}} = {}) {
  const device = await captureDevice(webgpu);
  if (!device) { note('unavailable'); return null; }
  let passed = tested.get(device);
  if (!passed) tested.set(device, passed = new Map());
  for (const kind of kinds) if (!passed.has(kind.name)) passed.set(kind.name, kind.selfTest(device).catch(() => false));
  const ok = !refused.has(device) && (await Promise.all(kinds.map(kind => passed.get(kind.name)))).every(Boolean);
  if (!ok) {
    refused.add(device);
    if (webgpu === 'required') throw fault('JXL_WEBGPU', "webgpu: 'required', and this device failed its check. Leave webgpu out for the same file on WebAssembly.");
    note('device-refused');
    return null;
  }
  const byName = new Map(kinds.map(kind => [kind.name, kind]));
  let turn = 0;
  return async (request, signal) => {
    const kind = byName.get(request.kind);
    if (!kind) { note('unknown-kind'); return null; }
    if (refused.has(device)) { note('device-refused'); return null; }
    let answer;
    try { answer = await kind.run(device, request, signal); } catch { note(signal?.aborted ? 'aborted' : 'run-failed'); return null; }
    if (!kind.audit(request, answer, turn++)) { refused.add(device); note('audit-failed'); return null; }
    note('used');
    return answer;
  };
}
