// SPDX-License-Identifier: MIT
const sets = new WeakMap();
export function gpuComputeSet(device, key, code, kinds, entries) {
  let held = sets.get(device);
  if (!held) sets.set(device, held = new Map());
  if (!held.has(key)) {
    const group = device.createBindGroupLayout({entries: kinds.map((type, binding) => ({binding, visibility: GPUShaderStage.COMPUTE, buffer: {type}}))});
    const module = device.createShaderModule({code}), layout = device.createPipelineLayout({bindGroupLayouts: [group]});
    held.set(key, Promise.all(entries.map(entryPoint => device.createComputePipelineAsync({layout, compute: {module, entryPoint}})))
      .then(list => ({group, ...Object.fromEntries(entries.map((e, k) => [e, list[k]]))})));
  }
  return held.get(key);
}

export function gpuBuffers(device, held, made) {
  const st = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC, size = bytes => Math.max(16, Math.ceil(bytes / 16) * 16);
  if (held && !held.device) Object.assign(held, {device, bufs: new Map(), filled: new Set(), release() { for (const b of held.bufs.values()) b.destroy(); held.bufs.clear(); held.filled.clear(); }});
  if (held?.device !== device) held = null;
  const buf = (bytes, usage = st) => { const b = device.createBuffer({size: size(bytes), usage}); made.push(b); return b; };
  const kept = (name, bytes, usage = st) => {
    if (!held) return buf(bytes, usage);
    const old = held.bufs.get(name);
    if (old && old.size >= size(bytes) && old.usage === usage) return old;
    old?.destroy(); held.filled.delete(name); const b = device.createBuffer({size: size(bytes), usage}); held.bufs.set(name, b); return b;
  };
  const upKept = (name, array, usage = st) => { const b = kept(name, array.byteLength, usage); device.queue.writeBuffer(b, 0, array.buffer, array.byteOffset, array.byteLength); return b; };
  const once = (name, make) => {
    if (held?.filled.has(name)) return held.bufs.get(name);
    const b = upKept(name, make()); held?.filled.add(name); return b;
  };
  const map = GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST;
  const read = async (sources, name) => {
    const total = sources.reduce((t, [, , bytes]) => t + Math.ceil(bytes / 8) * 8, 0), r = name ? kept(name, total, map) : buf(total, map), e = device.createCommandEncoder();
    let at = 0;
    for (const [source, offset, bytes] of sources) { e.copyBufferToBuffer(source, offset, r, at, Math.ceil(bytes / 4) * 4); at += Math.ceil(bytes / 8) * 8; }
    device.queue.submit([e.finish()]);
    await r.mapAsync(GPUMapMode.READ, 0, total); const all = r.getMappedRange(0, total);
    at = 0; const out = sources.map(([, , bytes]) => { const part = all.slice(at, at + bytes); at += Math.ceil(bytes / 8) * 8; return part; });
    r.unmap(); return out;
  };
  const dispatch = (encoder, pipeline, group, count) => {
    const all = Math.ceil(count / 64), gx = Math.min(all, 65535), pass = encoder.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(gx, Math.ceil(all / gx)); pass.end();
  };
  const bind = (layout, buffers) => device.createBindGroup({layout, entries: buffers.map((b, k) => ({binding: k, resource: {buffer: b}}))});
  return {st, buf, kept, upKept, once, read, dispatch, bind};
}
