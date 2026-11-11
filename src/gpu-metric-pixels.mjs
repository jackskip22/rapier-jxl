// SPDX-License-Identifier: MIT
import {s2Dimensions} from './ssimulacra2-input.mjs';
import {UniformRing} from './gpu-uniforms.mjs';
import {gpuPipelineSet} from './gpu-pipelines.mjs';

const METRIC_PLACE_WG = 128;
const unavailable = () => Object.assign(new Error('Metric pixel owner is unavailable.'), {code: 'JXL_GPU'});

export function metricPlaceShader(bindings, body, extra = '') {
  return `struct Params { w: u32, h: u32, stride: u32, width: u32, source: u32, target: u32, z: u32, k: u32 }
@group(0) @binding(0) var<uniform> P: Params;
${bindings.map(([name, access, type = 'f32'], i) => `@group(0) @binding(${i + 1}) var<storage, ${access}> ${name}: array<${type}>;`).join('\n')}
${extra}
@compute @workgroup_size(${METRIC_PLACE_WG})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x + gid.y * ${65535 * METRIC_PLACE_WG}u;
  if (i >= P.w * P.h) { return; }
  let x = i % P.w; let y = i / P.w;
  let k = (y + (P.source >> 16u)) * P.stride + x + (P.source & 65535u);
  let o = (y + (P.target >> 16u)) * P.width + x + (P.target & 65535u);
  ${body}
}`;
}

const linearPipelines = gpuPipelineSet({place: metricPlaceShader([
  ['r', 'read'], ['g', 'read'], ['b', 'read'], ['dr', 'read_write'], ['dg', 'read_write'], ['db', 'read_write'],
], 'dr[o] = r[k]; dg[o] = g[k]; db[o] = b[k];')});

class MetricReadback {
  static fits(device, width, height) {
    const pixels = s2Dimensions(width, height);
    return pixels * 4 <= Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize);
  }

  init(device, width, height, pipelines) {
    s2Dimensions(width, height);
    this.device = device; this.width = width; this.height = height; this.pipelines = pipelines;
    this.buffers = []; this.read = []; this.destroyed = false; this.busy = false;
    this.ring = new UniformRing(device, 1024);
  }

  buffer(bytes, usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC) {
    if (this.destroyed) throw unavailable();
    const buffer = this.device.createBuffer({size: Math.max(16, Math.ceil(bytes / 16) * 16), usage});
    this.buffers.push(buffer); return buffer;
  }

  placeBuffers(pass, buffers, t) {
    if (this.destroyed) throw unavailable();
    const ring = this.ring, at = ring.take(), uv = at === null ? new Uint32Array(8) : ring.u32, o = at ?? 0;
    uv[o] = t.cw; uv[o + 1] = t.ch; uv[o + 2] = t.rw; uv[o + 3] = this.width;
    uv[o + 4] = (t.x - t.rx) | (t.y - t.ry) << 16; uv[o + 5] = t.x | t.y << 16;
    uv[o + 6] = uv[o + 7] = 0;
    const pipeline = this.pipelines.place;
    pass.setPipeline(pipeline); pass.setBindGroup(0, ring.bind(pipeline, at, buffers, uv));
    const groups = Math.ceil(t.cw * t.ch / METRIC_PLACE_WG);
    pass.dispatchWorkgroups(Math.min(groups, 65535), Math.ceil(groups / 65535));
  }

  async pixels(buffers, Type) {
    if (this.destroyed) throw unavailable();
    const bytes = this.width * this.height * 4, encoder = this.device.createCommandEncoder();
    while (this.read.length < buffers.length) this.read.push(this.buffer(bytes, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST));
    const reads = this.read.slice(0,buffers.length);
    for (let c = 0; c < buffers.length; c++) encoder.copyBufferToBuffer(buffers[c], 0, reads[c], 0, bytes);
    this.ring.flush(); this.device.queue.submit([encoder.finish()]);
    const mapped = await Promise.allSettled(reads.map(b => b.mapAsync(GPUMapMode.READ, 0, bytes)));
    try {
      if (this.destroyed) throw unavailable();
      for (const result of mapped) if (result.status === 'rejected') throw result.reason;
      return buffers.map((_, c) => new Type(reads[c].getMappedRange(0, bytes).slice(0)));
    } finally {
      for (let c = 0; c < buffers.length; c++) if (mapped[c].status === 'fulfilled' && reads[c].mapState === 'mapped') reads[c].unmap();
      if (!this.destroyed) this.ring.reset();
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const buffer of this.buffers ?? []) buffer.destroy();
    this.buffers = []; this.read = []; this.ring?.destroy(); this.ring = null; this.pipelines = this.device = null;
  }
}

export class GpuLinearPixels extends MetricReadback {
  async initLinear(device, width, height) {
    if (!MetricReadback.fits(device, width, height)) throw unavailable();
    this.init(device, width, height, await linearPipelines(device));
    this.dist = [0, 1, 2].map(() => this.buffer(width * height * 4));
  }

  static async create(device, width, height) {
    const self = new GpuLinearPixels();
    try { await self.initLinear(device, width, height); return self; }
    catch (error) { self.destroy(); throw error; }
  }

  place(pass, rgb, tile) { this.placeBuffers(pass, [...rgb, ...this.dist], tile); }

  async readPlanes() {
    if (this.destroyed || this.busy) throw unavailable();
    this.busy = true;
    try { return await this.pixels(this.dist, Float32Array); }
    finally { this.busy = false; }
  }

  destroy() { super.destroy(); this.dist = null; }
}
