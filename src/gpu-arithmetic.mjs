// SPDX-License-Identifier: MIT
import {fault} from './fault.mjs';
import {gpuWait, gpuFloat as gcF, gpuSplit as gcSplit, gpuDestroy, gpuCached, gpuKernel, gpuScoped, gpuAlloc, gpuUpload, gpuUni, gpuStep, gpuStage} from './gpu-kit.mjs';
export {gcF, gcSplit};
export const GC_BOUNDS = /* @__PURE__ */ Object.freeze({op: 4e-14, plane: 2e-8, planeMax: 1300, sum: 1e-11, rel: 1e-12, frac: 2.4e-7, floor: 1e-30});

export function gcPlaneBound(planes) {
  let worst = 0;
  for (const plane of planes) for (const value of plane) {
    const hi = Math.fround(value), lo = Math.fround(value - hi);
    if (!Number.isFinite(value) || !Number.isFinite(hi) || !Number.isFinite(lo))
      throw fault('JXL_INTERNAL', 'gpu-arithmetic:ds');
    worst = Math.max(worst, Math.abs(value - (hi + lo)));
  }
  const bound = new Float32Array([worst]);
  if (bound[0] < worst) new Uint32Array(bound.buffer)[0]++;
  if (!Number.isFinite(bound[0])) throw fault('JXL_INTERNAL', 'gpu-arithmetic:bound');
  return bound[0];
}

export const GC_DS_BASE = `
fn gcO(x: f32) -> f32 { return bitcast<f32>(bitcast<u32>(x) | (bitcast<u32>(gcOne()) ^ 0x3f800000u)); }
fn ts(a0: f32, b0: f32) -> vec2f { let a = gcO(a0); let b = gcO(b0); let s = gcO(a + b); let v = gcO(s - a); let w = gcO(s - v); return vec2f(s, gcO(gcO(a - w) + gcO(b - v))); }
fn fs(a0: f32, b0: f32) -> vec2f { let a = gcO(a0); let b = gcO(b0); let s = gcO(a + b); return vec2f(s, gcO(b - gcO(s - a))); }
fn sp(a: f32) -> vec2f { let h = bitcast<f32>((bitcast<u32>(a) + 0x800u) & 0xfffff000u); return vec2f(h, gcO(a - h)); }
fn tp(a0: f32, b0: f32) -> vec2f {
  let a = gcO(a0); let b = gcO(b0); let p = gcO(a * b); let x = sp(a); let y = sp(b);
  return vec2f(p, gcO(gcO(gcO(gcO(gcO(x.x * y.x) - p) + gcO(x.x * y.y)) + gcO(x.y * y.x)) + gcO(x.y * y.y)));
}
fn dadd(a: vec2f, b: vec2f) -> vec2f { let s = ts(a.x, b.x); let t = ts(a.y, b.y); let v = fs(s.x, gcO(s.y + t.x)); return fs(v.x, gcO(t.y + v.y)); }
fn dsub(a: vec2f, b: vec2f) -> vec2f { return dadd(a, -b); }
fn dmul(a: vec2f, b: vec2f) -> vec2f { let c = tp(a.x, b.x); return fs(c.x, gcO(c.y + gcO(gcO(a.x * b.y) + gcO(a.y * b.x)))); }
fn dabs(a: vec2f) -> vec2f { return select(a, -a, a.x < 0.0); }
fn dround(v: vec2f, half: vec2f, e: f32) -> vec2f {
  let w = dadd(v, half); var n = floor(w.x); var f = gcO(gcO(w.x - n) + w.y);
  if (f < 0.0) { n -= 1.0; f = gcO(f + 1.0); } else if (f >= 1.0) { n += 1.0; f = gcO(f - 1.0); }
  return vec2f(n, select(0.0, 1.0, f <= e || f >= 1.0 - e));
}`;

export const GC_DS = `${GC_DS_BASE}
fn ddiv(a: vec2f, b: vec2f) -> vec2f {
  let q1 = gcO(a.x / b.x); let r1 = dsub(a, dmul(b, vec2f(q1, 0.0))); let q2 = gcO(r1.x / b.x); let r2 = dsub(r1, dmul(b, vec2f(q2, 0.0)));
  return dadd(fs(q1, q2), vec2f(gcO(r2.x / b.x), 0.0));
}`;

export const GC_CBRT = `
fn dcbrt(v: vec2f, third: vec2f) -> vec2f {
  var r = exp2(log2(v.x) / 3.0); r = (2.0 * r + v.x / (r * r)) / 3.0; r = (2.0 * r + v.x / (r * r)) / 3.0;
  var d = vec2f(r, 0.0);
  for (var i = u32(gcOne() < 0.0); i < 2u; i++) { d = dadd(d, dmul(dsub(ddiv(v, dmul(d, d)), d), third)); }
  return d;
}`;

const GC_NEED_CBRT = !(typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true);
const GC_QUALIFY = (ds = GC_DS) => `${ds}
${GC_NEED_CBRT ? GC_CBRT : ''}
@group(0) @binding(0) var<storage, read> inp: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> out: array<vec4f>;
@group(0) @binding(2) var<uniform> U: vec4f;
fn gcOne() -> f32 { return U.x; }
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x; if (i >= arrayLength(&inp)) { return; }
  let q = inp[i]; let a = q.xy; let b = q.zw;
  out[i * 3u] = vec4f(ts(a.x, b.x), tp(a.x, b.x)); out[i * 3u + 1u] = vec4f(dadd(a, b), dmul(a, b));
  out[i * 3u + 2u] = vec4f(ddiv(a, b), ${GC_NEED_CBRT ? `dcbrt(dabs(a), vec2f(${gcF(1 / 3)}, ${gcF(1 / 3 - Math.fround(1 / 3))}))` : 'vec2f(0.0)'});
}`;

export function gcQualificationCases(count = 65536) {
  let seed = 0x9e3779b9;
  const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
  const value = (e0, span) => (next() < 0.5 ? -1 : 1) * (1 + next()) * 2 ** Math.floor(e0 + next() * span);
  const cases = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const e = Math.floor(next() * 53) - 40, A = value(e, 10), Bv = value(e, 10);
    gcSplit(A, cases, i * 4); gcSplit(Bv, cases, i * 4 + 2);
    if (i % 4 === 3) { cases[i * 4 + 1] = 0; cases[i * 4 + 3] = 0; }
  }
  return cases;
}

export function gcQualificationCheck(cases, out) {
  const tol = GC_BOUNDS.op, failures = {twoSum: 0, twoProd: 0, add: 0, mul: 0, div: 0, cbrt: 0};
  for (let i = 0; i < cases.length / 4; i++) {
    const [ah, al, bh, bl] = cases.subarray(i * 4, i * 4 + 4), A = ah + al, Bv = bh + bl, o = out.subarray(i * 12, i * 12 + 12);
    if (o[0] !== Math.fround(ah + bh) || o[0] + o[1] !== ah + bh) failures.twoSum++;
    if (o[2] !== Math.fround(ah * bh) || o[2] + o[3] !== ah * bh) failures.twoProd++;
    const near = (hi, lo, ref, scale) => Math.abs(hi + lo - ref) <= tol * scale + 1e-30;
    if (!near(o[4], o[5], A + Bv, Math.abs(A + Bv))) failures.add++;
    if (!near(o[6], o[7], A * Bv, 2 * Math.abs(A * Bv))) failures.mul++;
    if (!near(o[8], o[9], A / Bv, 4 * Math.abs(A / Bv))) failures.div++;
    if (GC_NEED_CBRT && !near(o[10], o[11], Math.cbrt(Math.abs(A)), 4 * Math.cbrt(Math.abs(A)))) failures.cbrt++;
  }
  return failures;
}

const gcQualifications = /* @__PURE__ */ new WeakMap();
const gcReadMs = /* @__PURE__ */ new WeakMap();
export const gpuCoreReadMs = device => gcReadMs.get(device) ?? 0;
export async function gpuCoreQualification(device, ds = GC_DS) {
  const cases = gcQualificationCases(), made = [], alloc = gpuAlloc(device, made);
  try {
    const take = await gpuScoped(device, 'GpuCore qualification', async seal => {
      const kernel = ds === GC_DS ? await gpuKernel(device, 'qualify', () => GC_QUALIFY(ds), 64)
        : [await gpuWait(device, device.createComputePipelineAsync({layout: 'auto', compute: {module: device.createShaderModule({code: GC_QUALIFY(ds)}), entryPoint: 'main'}})), 64];
      const inp = gpuUpload(device, alloc, cases), out = alloc(cases.byteLength * 3), one = gpuUni(device, alloc, null, null, 0, 16);
      const encoder = device.createCommandEncoder();
      gpuStep(device, encoder, kernel, [inp, out, one], cases.length / 4);
      const [map, take] = gpuStage(device, alloc, encoder, [[out, 0, cases.byteLength * 3]]);
      const t0 = performance.now();
      device.queue.submit([encoder.finish()]);
      seal();
      await map();
      gcReadMs.set(device, performance.now() - t0);
      return take;
    }, false);
    const failures = gcQualificationCheck(cases, new Float32Array(take()[0]));
    return {ok: Object.values(failures).every(n => n === 0), cases: cases.length / 4, failures};
  } finally { gpuDestroy(made); }
}

export const gpuCoreQualified = device =>
  gpuCached(gcQualifications, device, 'ok', () => gpuCoreQualification(device).then(r => r.ok));

const gcProbes = /* @__PURE__ */ new WeakMap();
export function gpuDeviceProbe(device) {
  if (!(device?.limits?.maxBufferSize >= 4096)) return Promise.resolve({ok: true, ms: 0, synthetic: true});
  return gpuCached(gcProbes, device, 'probe', async () => {
    const words = new Uint32Array(1024);
    let seed = 0x9e3779b9;
    for (let i = 0; i < 1024; i++) {
      seed = (Math.imul(seed ^ (i + 1), 0x85ebca6b) + 0xc2b2ae35) >>> 0;
      words[i] = seed || 1;
    }
    const made = [], alloc = gpuAlloc(device, made);
    try {
      return await gpuScoped(device, 'device-probe', async seal => {
        const src = alloc(4096, GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
        const dst = alloc(4096, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
        device.queue.writeBuffer(src, 0, words);
        const encoder = device.createCommandEncoder();
        encoder.copyBufferToBuffer(src, 0, dst, 0, 4096);
        const t0 = performance.now();
        device.queue.submit([encoder.finish()]);
        seal();
        let mapped = false;
        try {
          await gpuWait(device, dst.mapAsync(GPUMapMode.READ, 0, 4096));
          mapped = true;
          const ms = performance.now() - t0;
          const got = new Uint32Array(dst.getMappedRange(0, 4096));
          let ok = got.length === 1024;
          for (let i = 0; ok && i < 1024; i++) if (got[i] !== words[i]) ok = false;
          return {ok, ms, synthetic: false};
        } finally {
          if (mapped) try { dst.unmap(); } catch {}
        }
      }, false);
    } finally { gpuDestroy(made); }
  });
}

const gcBulk = /* @__PURE__ */ new WeakMap();
export const PROBE_BULK_BYTES = 1 << 16;
export function gpuBulkProbe(device) {
  if (!(device?.limits?.maxBufferSize >= PROBE_BULK_BYTES)) return Promise.resolve({ok: true, ms: 0, synthetic: true});
  return gpuCached(gcBulk, device, 'bulk', async () => {
    const made = [], alloc = gpuAlloc(device, made);
    try {
      return await gpuScoped(device, 'device-bulk-probe', async seal => {
        const src = alloc(PROBE_BULK_BYTES, GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
        const dst = alloc(PROBE_BULK_BYTES, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
        device.queue.writeBuffer(src, 0, new Uint32Array(PROBE_BULK_BYTES / 4).fill(7));
        const encoder = device.createCommandEncoder();
        encoder.copyBufferToBuffer(src, 0, dst, 0, PROBE_BULK_BYTES);
        const t0 = performance.now();
        device.queue.submit([encoder.finish()]);
        seal();
        let mapped = false;
        try {
          await gpuWait(device, dst.mapAsync(GPUMapMode.READ, 0, PROBE_BULK_BYTES));
          mapped = true;
          return {ok: true, ms: performance.now() - t0, synthetic: false};
        } finally { if (mapped) try { dst.unmap(); } catch {} }
      }, false);
    } finally { gpuDestroy(made); }
  });
}
