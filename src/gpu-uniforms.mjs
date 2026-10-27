// SPDX-License-Identifier: MIT
const GU_SLOT = 256, GU_SLOTS = 4096, GU_GROUPS = 16384;
const guIds = new WeakMap();
let guNext = 1;
const guId = buffer => { let id = guIds.get(buffer); if (!id) guIds.set(buffer, id = guNext++); return id; };

export class UniformRing {
  constructor(device, slots = GU_SLOTS) {
    this.device = device; this.slots = slots;
    this.buffer = device.createBuffer({size: slots * GU_SLOT, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
    this.data = new ArrayBuffer(slots * GU_SLOT); this.u32 = new Uint32Array(this.data); this.f32 = new Float32Array(this.data);
    this.used = 0; this.flushed = 0; this.overflow = []; this.groups = new Map();
  }

  take() { return this.used < this.slots ? (this.used++) * (GU_SLOT / 4) : null; }

  bind(pipeline, at, buffers, spill) {
    if (at === null) {
      const u = this.device.createBuffer({size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
      this.device.queue.writeBuffer(u, 0, spill); this.overflow.push(u);
      return this.device.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries: [u, ...buffers].map((b, i) => ({binding: i, resource: {buffer: b}}))});
    }
    let key = guId(pipeline) + ':' + at;
    for (const b of buffers) key += ',' + guId(b);
    let group = this.groups.get(key);
    if (!group) {
      if (this.groups.size >= GU_GROUPS) this.groups.clear();
      group = this.device.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries: [
        {binding: 0, resource: {buffer: this.buffer, offset: at * 4, size: 32}}, ...buffers.map((b, i) => ({binding: i + 1, resource: {buffer: b}}))]});
      this.groups.set(key, group);
    }
    return group;
  }

  flush() {
    if (this.used > this.flushed) this.device.queue.writeBuffer(this.buffer, this.flushed * GU_SLOT, this.data, this.flushed * GU_SLOT, (this.used - this.flushed) * GU_SLOT);
    this.flushed = this.used;
  }

  reset() {
    if (this.overflow.length) {
      this.slots *= 2; this.buffer.destroy(); this.groups.clear();
      this.buffer = this.device.createBuffer({size: this.slots * GU_SLOT, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
      this.data = new ArrayBuffer(this.slots * GU_SLOT); this.u32 = new Uint32Array(this.data); this.f32 = new Float32Array(this.data);
    }
    this.used = 0; this.flushed = 0; for (const u of this.overflow) u.destroy(); this.overflow = [];
  }

  destroy() {
    for (const u of this.overflow) u.destroy();
    this.overflow = []; this.buffer.destroy(); this.groups.clear();
    this.data = this.u32 = this.f32 = null; this.used = this.flushed = 0;
  }
}

