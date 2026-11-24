// SPDX-License-Identifier: MIT
import {fault} from './fault.mjs';

const KIND = {u: 'uniform', r: 'read-only-storage', s: 'storage'};
const U = () => globalThis.GPUBufferUsage ?? {MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128};
const READ = () => globalThis.GPUMapMode?.READ ?? 1;

export const gpuFloat = v => { const s = Math.fround(v).toString(); return /[.eE]/.test(s) ? s : s + '.0'; };
export const gpuSplit = (v, out, at = 0) => { const hi = Math.fround(v); out[at] = hi; out[at + 1] = Math.fround(v - hi); };
export const gpuSplits = (values, out = new Float32Array(values.length * 2), at = 0) => {
  for (let i = 0; i < values.length; i++) gpuSplit(values[i], out, at + 2 * i);
  return out;
};
export const gpuSize = bytes => Math.max(16, Math.ceil(bytes / 16) * 16);
export const gpuGroupsX = (count, wg = 64) => Math.min(Math.ceil(count / wg), 65535);
export const gpuDestroy = list => { for (const b of list) b.destroy(); list.length = 0; };

const GPU_WAIT_MS = 30000, waiting = new WeakMap();
const stopWaiting = (state, error) => {
  if (state.failure) return;
  state.failure = error;
  for (const reject of [...state.waiters]) reject(error);
};
const waitState = device => {
  let state = waiting.get(device);
  if (!state) {
    state = {failure: null, waiters: new Set()}; waiting.set(device, state);
    device.lost?.then(info => stopWaiting(state, Object.assign(fault('JXL_WEBGPU', 'device lost'), {cause: info})),
      cause => stopWaiting(state, Object.assign(fault('JXL_WEBGPU', 'device loss notification failed'), {cause})));
  }
  return state;
};
export function gpuCheck(device) {
  const error = waitState(device).failure;
  if (error) throw error;
}
export function gpuWait(device, pending) {
  const state = waitState(device), native = Promise.resolve(pending);
  if (state.failure) { native.catch(() => {}); return Promise.reject(state.failure); }
  return new Promise((resolve, reject) => {
    let active = true, timer;
    const finish = (failed, value) => {
      if (!active) return;
      active = false; clearTimeout(timer); timer = null; state.waiters.delete(fail);
      const done = failed ? reject : resolve; resolve = reject = null;
      done(value);
    };
    const fail = error => finish(true, error);
    state.waiters.add(fail);
    timer = setTimeout(() => stopWaiting(state, fault('JXL_WEBGPU', 'device wait exceeded 30000 ms')), GPU_WAIT_MS);
    native.then(value => finish(false, value), fail);
  });
}
export async function gpuMap(device, buffer, offset = 0, size) {
  gpuCheck(device);
  try { await gpuWait(device, buffer.mapAsync(READ(), offset, size)); }
  catch (error) {
    if (waitState(device).failure === error) try { buffer.unmap(); } catch {  }
    throw error;
  }
}

export function gpuCached(store, device, key, start) {
  const failure = waitState(device).failure;
  if (failure) return Promise.reject(failure);
  let held = store.get(device);
  if (!held) store.set(device, held = new Map());
  let pending = held.get(key);
  if (!pending) {
    pending = start();
    held.set(key, pending);
    pending.catch(() => { if (held.get(key) === pending) held.delete(key); });
  }
  return pending;
}

const compiled = new WeakMap();

export const gpuModule = (device, key, code) =>
  gpuCached(compiled, device, 'mod:' + key, () => Promise.resolve(device.createShaderModule({code: typeof code === 'function' ? code() : code})));

export const gpuKernel = (device, key, code, wg = 64, entryPoint = 'main', label) =>
  gpuCached(compiled, device, key, () => gpuWait(device, device.createComputePipelineAsync({
    ...(label && {label}),
    layout: 'auto',
    compute: {module: device.createShaderModule({code: typeof code === 'function' ? code() : code}), entryPoint},
  })).then(p => [p, wg]));

export const gpuKernels = (device, prefix, table) => {
  const entries = Object.entries(table);
  return Promise.all(entries.map(([name, spec]) =>
    Array.isArray(spec) ? gpuKernel(device, prefix + ':' + name, spec[0], spec[1]) : gpuKernel(device, prefix + ':' + name, spec)
  )).then(list => Object.fromEntries(entries.map(([name], i) => [name, list[i]])));
};

export const gpuAutoSet = (device, key, code, entries) =>
  Promise.all(entries.map(([name, wg = 64, entryPoint = name]) =>
    gpuCached(compiled, device, 'auto:' + key + ':' + entryPoint + ':' + wg, () => gpuModule(device, key, code).then(module =>
      gpuWait(device, device.createComputePipelineAsync({layout: 'auto', compute: {module, entryPoint}})).then(p => [p, wg])
    ))
  )).then(made => Object.fromEntries(entries.map(([name], k) => [name, made[k]])));

export const gpuComputeSet = (device, key, code, kinds, entries, wg = 64) =>
  gpuCached(compiled, device, key, () => {
    const list = typeof kinds === 'string' ? [...kinds].map(k => KIND[k]) : kinds;
    const visibility = globalThis.GPUShaderStage?.COMPUTE ?? 4;
    const group = device.createBindGroupLayout({entries: list.map((type, binding) => ({binding, visibility, buffer: {type}}))});
    const layout = device.createPipelineLayout({bindGroupLayouts: [group]});
    const readyModule = code && typeof code === 'object' ? Promise.resolve(code)
      : Promise.resolve(device.createShaderModule({code: typeof code === 'function' ? code() : code}));
    return readyModule.then(module => Promise.all(entries.map(entryPoint => gpuWait(device, device.createComputePipelineAsync({layout, compute: {module, entryPoint}}))))
      .then(made => ({group, ...Object.fromEntries(entries.map((e, k) => [e, [made[k], wg, group]]))})));
  });

export async function gpuScoped(device, label, work, oom = true, onFault = null) {
  gpuCheck(device);
  device.pushErrorScope('validation');
  if (oom) device.pushErrorScope('out-of-memory');
  let pops = null;
  const seal = () => {
    if (pops) return;
    pops = (oom ? [device.popErrorScope(), device.popErrorScope()] : [device.popErrorScope()]).map(p => gpuWait(device, p));
    for (const p of pops) p.catch(() => {});
  };
  let result;
  try { result = await work(seal); }
  catch (error) { seal(); await Promise.allSettled(pops); throw error; }
  seal();
  const [first, second] = await Promise.all(pops);
  gpuCheck(device);
  const err = oom ? first || second : first;
  if (err) {
    if (onFault) return onFault(err);
    throw fault('JXL_WEBGPU', label + ': ' + err.message);
  }
  return result;
}

export async function gpuAbort(signal, work) {
  if (signal?.aborted) throw signal.reason;
  let onAbort = null;
  const abort = signal && new Promise((_, reject) => signal.addEventListener('abort', onAbort = () => reject(signal.reason), {once: true}));
  abort?.catch(() => {});
  try { return await work(promise => abort ? Promise.race([promise, abort]) : promise); }
  finally { if (onAbort) signal.removeEventListener?.('abort', onAbort); }
}

export const gpuWrite = (device, b, array, dstOffset = 0) => {
  if (dstOffset === 0 && array.byteOffset === 0 && array.byteLength === array.buffer.byteLength) device.queue.writeBuffer(b, 0, array);
  else device.queue.writeBuffer(b, dstOffset, array.buffer, array.byteOffset, array.byteLength);
  return b;
};

export function gpuAlloc(device, made, pool = null) {
  const f = U(), st = f.STORAGE | f.COPY_DST | f.COPY_SRC;
  return (bytes, usage = st, role) => {
    const size = gpuSize(bytes), old = pool && role ? pool.get(role) : null;
    if (old && old.size >= size && (old.usage === undefined || old.usage === usage)) return old;
    const b = device.createBuffer({size, usage});
    if (pool && role) { old?.destroy(); pool.set(role, b); } else made.push(b);
    return b;
  };
}

export const gpuUpload = (device, alloc, array, usage = U().STORAGE | U().COPY_DST, role) =>
  gpuWrite(device, alloc(array.byteLength, usage, role), array);

export const gpuUni = (device, alloc, words, floats, oneAt, bytes, role) => {
  const f = U(), len = gpuSize(bytes ?? Math.max((words?.length ?? 0) * 4, ((oneAt ?? -1) + 1) * 4, 16));
  const ab = new ArrayBuffer(len), u32 = new Uint32Array(ab), f32 = new Float32Array(ab);
  if (words) u32.set(words);
  if (floats) for (const [i, v] of floats) f32[i] = v;
  if (oneAt !== undefined) f32[oneAt] = 1;
  return gpuWrite(device, alloc(len, (f.UNIFORM ?? 64) | f.COPY_DST, role), f32);
};

export const gpuBind = (device, layout, buffers) => device.createBindGroup({
  layout,
  entries: buffers.map((b, binding) => ({binding, resource: b?.buffer ? b : {buffer: b}})),
});

export function gpuStep(device, target, kernel, bindings, count, gy) {
  const [p, wg = 64, layout] = Array.isArray(kernel) ? kernel : [kernel, 64, undefined];
  const group = Array.isArray(bindings) ? gpuBind(device, layout ?? p.getBindGroupLayout(0), bindings) : bindings;
  let gx = count, groupsY = gy ?? 1;
  if (gy === undefined) {
    const all = wg > 1 ? Math.ceil(count / wg) : count;
    gx = Math.min(all, 65535); groupsY = Math.ceil(all / gx);
  }
  const own = typeof target.beginComputePass === 'function', pass = own ? target.beginComputePass() : target;
  pass.setPipeline(p); pass.setBindGroup(0, group); pass.dispatchWorkgroups(gx, groupsY);
  if (own) pass.end();
}

export function gpuStage(device, alloc, encoder, sources, role, kept) {
  const f = U(), mapUse = f.MAP_READ | f.COPY_DST;
  const total = sources.reduce((t, [, , bytes]) => t + Math.ceil(bytes / 8) * 8, 0);
  const r = kept ? kept(role, total, mapUse) : alloc(total, mapUse, role);
  let at = 0;
  for (const [source, offset, bytes] of sources) {
    encoder.copyBufferToBuffer(source, offset, r, at, Math.ceil(bytes / 4) * 4);
    at += Math.ceil(bytes / 8) * 8;
  }
  const map = () => gpuMap(device, r, 0, total);
  const take = (read = null) => {
    try {
      const all = r.getMappedRange(0, total);
      let o = 0;
      const at = sources.map(([, , bytes]) => { const p = o; o += Math.ceil(bytes / 8) * 8; return p; });
      return read ? read(all, at) : sources.map(([, , bytes], k) => all.slice(at[k], at[k] + bytes));
    } finally {
      r.unmap();
      if (!role) r.destroy();
    }
  };
  return [map, take];
}

export async function gpuRead(device, alloc, sources, encoder = device.createCommandEncoder(), role, kept) {
  const [map, take] = gpuStage(device, alloc, encoder, sources, role, kept);
  device.queue.submit([encoder.finish()]);
  await map();
  return take();
}

export function gpuHeld(device, held, alloc) {
  const f = U(), st = f.STORAGE | f.COPY_DST | f.COPY_SRC;
  if (held && !held.device) Object.assign(held, {device, bufs: new Map(), filled: new Set(), release() {
    for (const b of held.bufs.values()) b.destroy();
    held.bufs.clear(); held.filled.clear();
  }});
  if (held?.device !== device) held = null;
  const kept = (name, bytes, usage = st) => {
    if (!held) return alloc(bytes, usage);
    const sz = gpuSize(bytes), old = held.bufs.get(name);
    if (old && old.size >= sz && old.usage === usage) return old;
    const b = device.createBuffer({size: sz, usage});
    old?.destroy(); held.filled.delete(name); held.bufs.set(name, b); return b;
  };
  const upKept = (name, array, usage = st) => gpuWrite(device, kept(name, array.byteLength, usage), array);
  const once = (name, make) => {
    if (held?.filled.has(name)) return held.bufs.get(name);
    const b = upKept(name, make()); held?.filled.add(name); return b;
  };
  return [kept, upKept, once];
}
