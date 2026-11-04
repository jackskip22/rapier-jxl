// SPDX-License-Identifier: MIT
const WEIGHTED_WGSL =  `
struct Job { offset: u32, width: u32, height: u32, total: u32 }
@group(0) @binding(0) var<storage, read> plane: array<i32>;
@group(0) @binding(1) var<storage, read> jobs: array<Job>;
@group(0) @binding(2) var<storage, read_write> errs: array<vec4<i32>>;
@group(0) @binding(3) var<storage, read_write> terr: array<i32>;
@group(0) @binding(4) var<storage, read_write> out: array<u32>;
@group(0) @binding(5) var<storage, read> divisors: array<u32, 64>;

fn weightOf(sum: i32, most: i32) -> i32 {
  let shift = max(0, 26 - i32(countLeadingZeros(u32(sum + 1))));
  return 4 + ((most * i32(divisors[u32(sum >> u32(shift))])) >> u32(shift));
}
// floor(a * d / 2^24) for |a| < 2^31, d < 2^25, as the CPU's double arithmetic gives it.
fn mulShift24(a: i32, d: u32) -> i32 {
  let m = u32(abs(a)); let ah = m >> 16u; let al = m & 0xffffu; let dh = d >> 16u; let dl = d & 0xffffu;
  let ll = al * dl; let mid = ah * dl + al * dh; let hh = ah * dh;
  // p = hh 2^32 + mid 2^16 + ll, as (hi, lo).
  var lo = ll + (mid << 16u); var carry = select(0u, 1u, lo < ll);
  var hi = hh + (mid >> 16u) + carry;
  if (a >= 0) { return i32((lo >> 24u) | (hi << 8u)); }
  // -ceil(p / 2^24) = -floor((p + 2^24 - 1) / 2^24)
  let lo2 = lo + 0xffffffu; hi = hi + select(0u, 1u, lo2 < lo);
  return -i32((lo2 >> 24u) | (hi << 8u));
}

@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  let job = jobs[wg.x];
  let w = i32(job.width); let h = i32(job.height); let o = job.offset; let lastX = w - 1;
  let steps = (w - 1) + 2 * (h - 1) + 1;
  for (var t = 0; t < steps; t++) {
    for (var y = i32(lid); y < h; y += 256) {
      let x = t - 2 * y;
      if (x < 0 || x >= w) { continue; }
      let at = o + u32(y * w + x);
      let up = at - u32(w);
      let v = plane[at] * 8;
      var W = 0; if (x > 0) { W = plane[at - 1u] * 8; } else if (y > 0) { W = plane[up] * 8; }
      var N = W; if (y > 0) { N = plane[up] * 8; }
      var NE = N; if (x < lastX && y > 0) { NE = plane[up + 1u] * 8; }
      var teW = 0; if (x > 0) { teW = terr[at - 1u]; }
      var teN = 0; if (y > 0) { teN = terr[up]; }
      var teNW = teN; if (x > 0) { teNW = select(0, terr[up - 1u], y > 0); }
      var teNE = 0; if (y > 0) { teNE = select(terr[up], terr[up + 1u], x < lastX); }
      // Sub-error sums: the N slot holds row y - 1's error and this row's W, the NW slot row y - 1's NW and this row's WW.
      var eN = vec4<i32>(0); if (y > 0) { eN = errs[up]; }
      if (x > 0) { eN += errs[at - 1u]; }
      var eNE = eN; if (x < lastX) { eNE = select(vec4<i32>(0), errs[up + 1u], y > 0); }
      var eNW = eN; if (x > 0) { eNW = select(vec4<i32>(0), errs[up - 1u], y > 0); if (x > 1) { eNW += errs[at - 2u]; } }
      let s = eN + eNE + eNW;
      var w0 = weightOf(s.x, 13); var w1 = weightOf(s.y, 12); var w2 = weightOf(s.z, 12); var w3 = weightOf(s.w, 12);
      let sumWN = teN + teW;
      var most = teW; var absMost = abs(teW);
      if (abs(teN) > absMost) { absMost = abs(teN); most = teN; }
      if (abs(teNW) > absMost) { absMost = abs(teNW); most = teNW; }
      if (abs(teNE) > absMost) { most = teNE; }
      let p0 = W + NE - N; let p1 = N - (((sumWN + teNE) * 16) >> 5u); let p2 = W - (((sumWN + teNW) * 10) >> 5u);
      let p3 = N - (((teNW + teN + teNE) * 7) >> 5u);
      let shift = u32(27 - i32(countLeadingZeros(u32(w0 + w1 + w2 + w3))));
      w0 = w0 >> shift; w1 = w1 >> shift; w2 = w2 >> shift; w3 = w3 >> shift;
      let sum = w0 + w1 + w2 + w3;
      var pred = mulShift24((sum >> 1u) - 1 + p0 * w0 + p1 * w1 + p2 * w2 + p3 * w3, divisors[u32(sum - 1)]);
      if (((teN ^ teW) | (teN ^ teNW)) <= 0) {
        var lo = min(W, NE); var hi = max(W, NE);
        if (N < lo) { lo = N; } else if (N > hi) { hi = N; }
        pred = clamp(pred, lo, hi);
      }
      let r = plane[at] - ((pred + 3) >> 3u);
      out[at] = select(u32(-r) * 2u - 1u, u32(r) * 2u, r >= 0);
      out[job.total + at] = bitcast<u32>(most);
      errs[at] = (abs(vec4<i32>(p0, p1, p2, p3) - vec4<i32>(v)) + vec4<i32>(3)) >> vec4<u32>(3u);
      terr[at] = pred - v;
    }
    storageBarrier();
    workgroupBarrier();
  }
}`;

const DIVISORS = Uint32Array.from({length: 64}, (_, i) => Math.floor(16777216 / (i + 1)));
const PLANE_LIMIT = 1 << 20;
const pipelines = new WeakMap();
const check = signal => { if (signal?.aborted) throw signal.reason; };
export async function weightedOnDevice(device, planes, {passSamples = 1 << 21, signal} = {}) {
  check(signal);
  let onAbort = null;
  const abort = signal && new Promise((_, reject) => signal.addEventListener('abort', onAbort = () => reject(signal.reason), {once: true}));
  abort?.catch(() => {});
  try { return await predict(device, planes, passSamples, signal, promise => abort ? Promise.race([promise, abort]) : promise); }
  finally { if (onAbort) signal.removeEventListener?.('abort', onAbort); }
}
async function predict(device, planes, passSamples, signal, waits) {
  for (const p of planes) if (!(p.plane instanceof Int16Array) || !(p.width >= 1 && p.height >= 1 && p.width * p.height <= PLANE_LIMIT) || p.plane.length < p.width * p.height)
    throw new RangeError('weightedOnDevice: each plane is an Int16Array of at most 2^20 samples.');
  let pipeline = pipelines.get(device);
  if (!pipeline) {
    const made = device.createComputePipelineAsync({layout: 'auto', compute: {module: device.createShaderModule({code: WEIGHTED_WGSL}), entryPoint: 'main'}});
    made.catch(() => {});
    pipelines.set(device, pipeline = await waits(made));
  }
  const passes = [];
  for (let k = 0, size = 0; k < planes.length; k++) {
    const n = planes[k].width * planes[k].height;
    if (!passes.length || size + n > passSamples || passes.at(-1).length === 65535) { passes.push([]); size = 0; }
    passes.at(-1).push(k); size += n;
  }
  const most = Math.max(...passes.map(pass => pass.reduce((s, k) => s + planes[k].width * planes[k].height, 0)));
  const S = GPUBufferUsage.STORAGE, D = GPUBufferUsage.COPY_DST, made = [];
  const buffer = (size, usage) => { const b = device.createBuffer({size: Math.max(16, size), usage}); made.push(b); return b; };
  const set = divB => {
    const planeB = buffer(most * 4, S | D), jobsB = buffer(Math.min(65535, planes.length) * 16, S | D), outB = buffer(most * 8, S | GPUBufferUsage.COPY_SRC);
    const entries = [planeB, jobsB, buffer(most * 16, S), buffer(most * 4, S), outB, divB].map((b, binding) => ({binding, resource: {buffer: b}}));
    return {planeB, jobsB, outB, readB: buffer(most * 8, GPUBufferUsage.MAP_READ | D), bind: device.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries})};
  };
  const results = new Array(planes.length);
  const collect = async ({buffers, pass, total, mapped}) => {
    await waits(mapped);
    const words = buffers.readB.getMappedRange(0, total * 8);
    let offset = 0;
    for (const k of pass) {
      const n = planes[k].width * planes[k].height;
      results[k] = {residuals: new Uint32Array(words.slice(offset * 4, (offset + n) * 4)), properties: new Int32Array(words.slice((total + offset) * 4, (total + offset + n) * 4))};
      offset += n;
    }
    buffers.readB.unmap();
  };
  let pending = null;
  try {
    const divB = buffer(256, S | D);
    device.queue.writeBuffer(divB, 0, DIVISORS);
    const sets = [set(divB), passes.length > 1 ? set(divB) : null];
    for (let i = 0; i < passes.length; i++) {
      check(signal);
      const pass = passes[i], buffers = sets[i & 1], table = new Uint32Array(pass.length * 4), total = pass.reduce((s, k) => s + planes[k].width * planes[k].height, 0), samples = new Int32Array(total);
      let offset = 0;
      pass.forEach((k, j) => { const {plane, width, height} = planes[k], n = width * height; table.set([offset, width, height, total], j * 4); samples.set(plane.subarray(0, n), offset); offset += n; });
      device.queue.writeBuffer(buffers.planeB, 0, samples); device.queue.writeBuffer(buffers.jobsB, 0, table);
      const encoder = device.createCommandEncoder(), compute = encoder.beginComputePass();
      compute.setPipeline(pipeline); compute.setBindGroup(0, buffers.bind); compute.dispatchWorkgroups(pass.length); compute.end();
      encoder.copyBufferToBuffer(buffers.outB, 0, buffers.readB, 0, total * 8);
      device.queue.submit([encoder.finish()]);
      const next = {buffers, pass, total, mapped: buffers.readB.mapAsync(GPUMapMode.READ, 0, total * 8)};
      next.mapped.catch(() => {});
      if (pending) await collect(pending);
      pending = next;
    }
    await collect(pending);
  } finally {
    for (const b of made) b.destroy();
  }
  return results;
}
