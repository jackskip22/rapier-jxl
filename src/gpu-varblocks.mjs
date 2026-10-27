// SPDX-License-Identifier: MIT
import {strategyInputs} from './varblocks.mjs';
import {COEFF_FREQ_CONTEXT, COEFF_NUM_NONZERO_CONTEXT} from './vardct.mjs';
import {gpuSetup} from './gpu-reconstruct.mjs';

const QS = 256, ZD = 458, NZ = 37;
const SHADER =  `
struct P { w: u32, h: u32, bw: u32, bh: u32, W: u32, stride: u32, rows: u32, cflW: u32, area: u32, size: u32, hasDead: u32, tall: u32,
  oBasisW: u32, oBasisH: u32, oSteps: u32, oZd: u32, oNz: u32, oConst: u32, oOrder: u32, oHigh: u32, oCtx: u32, oFine: u32, oCfl: u32, gridW: u32, mode: u32, oLow: u32, gy0: u32, count: u32, oPos: u32, pad0: u32, pad1: u32, pad2: u32 }
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read> planeX: array<f32>;
@group(0) @binding(2) var<storage, read> planeY: array<f32>;
@group(0) @binding(3) var<storage, read> planeB: array<f32>;
@group(0) @binding(4) var<storage, read> tf: array<f32>;
@group(0) @binding(5) var<storage, read> tu: array<u32>;
@group(0) @binding(6) var<storage, read> blk: array<f32>;
@group(0) @binding(7) var<storage, read_write> out: array<f32>;
var<workgroup> transY: array<f32, 1024>;
var<workgroup> trans: array<f32, 1024>;
var<workgroup> tmp: array<f32, 1024>;
var<workgroup> partA: array<f32, 64>;
var<workgroup> partB: array<f32, 64>;
var<workgroup> total: f32;
var<workgroup> magnitude: array<f32, 3>;
var<workgroup> uncertain: atomic<u32>;
// f32's unit roundoff, and the margin on the error bounds of mode 2's levels.
const U32 = 5.9604645e-8;
const SAFETY = 4.0;

fn pixel(c: u32, i: u32) -> f32 {
  if (c == 0u) { return planeX[i]; }
  if (c == 1u) { return planeY[i]; }
  return planeB[i];
}
fn tokenOf(value: u32) -> vec2<u32> {
  if (value < 16u) { return vec2<u32>(value, 0u); }
  let n = firstLeadingBit(value);
  let t = 16u + (((n - 4u) << 1u) | ((value - (1u << n)) >> (n - 1u)));
  return vec2<u32>(min(63u, t), n - 1u);
}

@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) g: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  // Modes 0 and 1: every grid position of the transform; mode 2: the listed blocks (a chosen layout), certified.
  let listed = g.y * p.gridW + g.x;
  if (p.mode == 2u && listed >= p.count) { return; }
  var bx = g.x * p.bw;
  var by = (g.y + p.gy0) * p.bh;
  if (p.mode == 2u) { bx = tu[p.oPos + 2u * listed]; by = tu[p.oPos + 2u * listed + 1u]; }
  if (bx + p.bw > p.stride || by + p.bh > p.rows) { return; }
  if (lid == 0u) { atomicStore(&uncertain, 0u); }
  let w = p.w; let h = p.h; let size = p.size; let area = p.area;
  let fine = blk[p.oFine + by * p.stride + bx];
  let ti = (by >> 3u) * p.cflW + (bx >> 3u);
  var D = 0.0; var R = 0.0;
  for (var ci = 0u; ci < 3u; ci++) {
    let c = select(select(2u, 0u, ci == 1u), 1u, ci == 0u);
    // Modes 0 and 2: the channel's sum of |pixel|, which bounds the f32 transform's error (two summation passes).
    if (p.mode != 1u) {
      var m = 0.0;
      for (var i = lid; i < w * h; i += 64u) { m += abs(pixel(c, (by * 8u + i / w) * p.W + bx * 8u + i % w)); }
      partA[lid] = m;
      workgroupBarrier();
      if (lid == 0u) { var t = 0.0; for (var i = 0u; i < 64u; i++) { t += partA[i]; } magnitude[c] = t; }
      workgroupBarrier();
    }
    // Rows, then columns: the scaled DCT (varblocks's gpuBasis), into transY for luma, trans for chroma.
    for (var i = lid; i < w * h; i += 64u) {
      let y = i / w; let u = i % w;
      let base = (by * 8u + y) * p.W + bx * 8u;
      var s = 0.0;
      for (var x = 0u; x < w; x++) { s += pixel(c, base + x) * tf[p.oBasisW + u * w + x]; }
      tmp[y * w + u] = s;
    }
    workgroupBarrier();
    for (var i = lid; i < w * h; i += 64u) {
      let v = i / w; let u = i % w;
      var s = 0.0;
      for (var y = 0u; y < h; y++) { s += tmp[y * w + u] * tf[p.oBasisH + v * h + y]; }
      let at = select(v * w + u, u * h + v, p.tall == 1u);
      if (c == 1u) { transY[at] = s; } else { trans[at] = s; }
    }
    workgroupBarrier();
    let blockOut = (g.y * p.gridW + g.x) * (3u * size + 3u * area + select(0u, 1u, p.mode == 2u));
    // A coefficient's error bound in mode 2: the transform's, from the channel's pixel magnitude.
    let errT = SAFETY * f32(w + h + 8u) * U32 * 2.0 * magnitude[c] / f32(w * h);
    let errY = SAFETY * f32(w + h + 8u) * U32 * 2.0 * magnitude[1] / f32(w * h);
    if (p.mode >= 1u && lid < area) {
      // The DC of each 8x8 cell (lowFrequencies): the lowest coefficients scaled, then the small inverse DCT, in levels.
      let xx = lid % p.bw; let yy = lid / p.bw;
      let L = max(p.bw, p.bh);
      var s = 0.0; var lowErr = 0.0;
      for (var v = 0u; v < p.bh; v++) { for (var u = 0u; u < p.bw; u++) {
        let li = select(v * p.bw + u, u * p.bh + v, p.bh >= p.bw);
        let ly = li / L; let lx = li % L;
        var coefficient = trans[ly * L * 8u + lx];
        if (c == 1u) { coefficient = transY[ly * L * 8u + lx]; }
        let scale = tf[p.oLow + lx] * tf[p.oLow + 32u + ly]; let low = coefficient * scale;
        let weight = tf[p.oLow + 64u + u * p.bw + xx] * tf[p.oLow + 64u + 16u + v * p.bh + yy];
        s += low * weight;
        lowErr += abs(weight) * (abs(scale) * errT + f32(area + 4u) * U32 * abs(low));
      } }
      let dcv = s * 8.0 / tf[p.oConst + 12u + c];
      out[blockOut + 3u * size + c * area + lid] = bitcast<f32>(i32(floor(dcv + 0.5)));
      if (p.mode == 2u) {
        let e = SAFETY * (lowErr * 8.0 / tf[p.oConst + 12u + c] + 2.0 * U32 * abs(dcv));
        if (abs(dcv - floor(dcv) - 0.5) <= e) { atomicOr(&uncertain, 1u); out[blockOut + 3u * size + c * area + lid] = bitcast<f32>(0x7f000000u); }
      }
    }
    // Quantize in scan order: tmp[k] the signed level, the error into this thread's sum.
    let factor = select(0.0, blk[p.oCfl + 2u * ti + select(1u, 0u, c == 0u)], c != 1u);
    var d = 0.0;
    for (var k = area + lid; k < size; k += 64u) {
      let pos = tu[p.oOrder + k];
      let step = tf[p.oSteps + c * size + pos];
      var coefficient = transY[pos];
      if (c != 1u) { coefficient = trans[pos] - factor * transY[pos]; }
      let v = coefficient * 8.0 * ${QS}.0 / step * fine;
      let a = abs(v);
      var threshold = 0.5;
      if (p.hasDead == 1u) { threshold = tf[p.oConst + c * 2u + tu[p.oHigh + pos]]; }
      var q = 0.0;
      if (a >= threshold) { q = floor(a + 0.5); }
      var recon = 0.0;
      if (q == 1.0) { recon = tf[p.oConst + 9u + c]; } else if (q > 1.0) { recon = q - 0.145 / q; }
      let e = (a - recon) * step / (8.0 * ${QS}.0 * fine);
      d += e * e;
      tmp[k] = select(q, -q, v < 0.0);
      if (p.mode >= 1u) { out[blockOut + c * size + pos] = bitcast<f32>(i32(tmp[k])); }
      if (p.mode != 1u) {
        // Certain when no rounding the f32 error allows crosses the dead zone or a half step (mode 0: the position's
        // rate is then the CPU's to price).
        var errC = errT;
        if (c != 1u) { errC = errT + abs(factor) * errY + 2.0 * U32 * (abs(trans[pos]) + abs(factor * transY[pos])); }
        let errA = SAFETY * (errC * 8.0 * ${QS}.0 / step * fine + 4.0 * U32 * a) + U32 * threshold;
        if (abs(a - threshold) <= errA || (a >= threshold && abs(a - floor(a) - 0.5) <= errA)) {
          atomicOr(&uncertain, 1u);
          if (p.mode == 2u) { out[blockOut + c * size + pos] = bitcast<f32>(0x7f000000u); }
        }
      }
    }
    if (p.mode >= 1u) { for (var k = lid; k < area; k += 64u) { out[blockOut + c * size + tu[p.oOrder + k]] = bitcast<f32>(0i); } }
    partA[lid] = d;
    workgroupBarrier();
    // Nonzeros before each scan position (trans[k]), by chunks and a scan of the chunk sums.
    let span = size - area;
    let chunk = (span + 63u) / 64u;
    let start = area + lid * chunk;
    let end = min(size, start + chunk);
    var own = 0.0;
    for (var k = start; k < end; k++) { if (tmp[k] != 0.0) { own += 1.0; } }
    partB[lid] = own;
    workgroupBarrier();
    if (lid == 0u) {
      var run = 0.0;
      for (var i = 0u; i < 64u; i++) { let n = partB[i]; partB[i] = run; run += n; }
      total = run;
      var dsum = 0.0;
      for (var i = 0u; i < 64u; i++) { dsum += partA[i]; }
      D += tf[p.oConst + 6u + c] * dsum * f32(w * h);
    }
    workgroupBarrier();
    var before = partB[lid];
    for (var k = start; k < end; k++) { trans[k] = before; if (tmp[k] != 0.0) { before += 1.0; } }
    workgroupBarrier();
    // Token bits as varblocks's tokenBits: the count, then every level while nonzeros remain.
    let count = u32(total);
    var bits = 0.0;
    for (var k = start; k < end; k++) {
      let left = count - u32(trans[k]);
      if (left == 0u) { continue; }
      var prev = 0u;
      if (k == area) { prev = select(1u, 0u, count > size / 16u); } else if (tmp[k - 1u] != 0.0) { prev = 1u; }
      let lc = (left + area - 1u) / area;
      let ctx = (tu[p.oCtx + lc] + tu[p.oCtx + 64u + k / area]) * 2u + prev;
      let q = i32(tmp[k]);
      let packed = select(u32(2 * q), u32(-2 * q - 1), q < 0);
      let t = tokenOf(packed);
      bits += tf[p.oZd + (c * ${ZD}u + ctx) * 64u + t.x] + f32(t.y);
    }
    partA[lid] = bits;
    workgroupBarrier();
    if (lid == 0u) {
      var b = 0.0;
      for (var i = 0u; i < 64u; i++) { b += partA[i]; }
      let pc = min((count + area - 1u) / area, 64u);
      let bucket = select(4u + (pc >> 1u), pc, pc < 8u);
      let t = tokenOf(count);
      R += b + tf[p.oNz + (c * ${NZ}u + bucket) * 64u + t.x] + f32(t.y);
    }
    workgroupBarrier();
  }
  if (lid == 0u && p.mode == 0u) {
    let at = (g.y * p.gridW + g.x) * 3u;
    out[at] = D; out[at + 1u] = R; out[at + 2u] = f32(atomicLoad(&uncertain));
  }
  if (lid == 0u && p.mode == 2u) { out[(g.y * p.gridW + g.x) * (3u * size + 3u * area + 1u) + 3u * size + 3u * area] = f32(atomicLoad(&uncertain)); }
}`;

export const GPU_VARBLOCKS_SHADER = SHADER;

function gpuBasis(size) {
  const b = new Float32Array(size * size);
  for (let k = 0; k < size; k++) for (let x = 0; x < size; x++) b[k * size + x] = k ? Math.SQRT2 * Math.cos((2 * x + 1) * k * Math.PI / (2 * size)) / size : 1 / size;
  return b;
}
function gpuLowTables(bw, bh) {
  const L = Math.max(bw, bh) * 8, S = Math.min(bw, bh) * 8, cos = (n, d) => Math.cos(n * Math.PI / d);
  const scale = (k, size) => cos(k, 2 * size) * cos(k, size) * cos(2 * k, size), out = new Float32Array(64 + 32);
  for (let k = 0; k < 32; k++) { out[k] = scale(k, L); out[32 + k] = scale(k, S); }
  const inv = n => { const b = gpuBasis(n); return b.map(v => v * n); };
  out.set(inv(bw), 64); out.set(inv(bh), 80);
  return out;
}

class GpuVarblockSession {
  constructor(owner, input) {
    this.owner = owner; this.input = input;
    const {planes, fine, cfl} = input;
    this.planes = owner.planeBuffers(planes);
    const blk = new Float32Array(fine.length + 2 * cfl.x.length);
    blk.set(fine);
    for (let i = 0; i < cfl.x.length; i++) { blk[fine.length + 2 * i] = cfl.x[i] / 84; blk[fine.length + 2 * i + 1] = cfl.b[i] / 84; }
    this.blk = owner.buffer(blk);
  }
  async run(id, mode, gy0 = 0, bandRows, positions) {
    this.owner.assertOpen();
    const {stride, rows, transforms, tokens, norm, dead, fine, cfl, one, dcSteps} = this.input, t = transforms.get(id), owner = this.owner, device = owner.device;
    const W = stride * 8, size = t.w * t.h, area = t.bw * t.bh;
    const f = [], offsets = {};
    const put = (name, array) => { offsets[name] = f.length; for (const v of array) f.push(v); };
    put('basisW', gpuBasis(t.w)); put('basisH', gpuBasis(t.h));
    put('steps', [...t.steps[0], ...t.steps[1], ...t.steps[2]]);
    put('zd', tokens ? [...tokens.zd[0], ...tokens.zd[1], ...tokens.zd[2]] : new Float32Array(3 * 458 * 64));
    put('nz', tokens ? [...tokens.nz[0], ...tokens.nz[1], ...tokens.nz[2]] : new Float32Array(3 * 37 * 64));
    put('const', [...(dead || [0, 0, 0, 0, 0, 0]), ...norm, ...one, ...dcSteps]);
    put('low', gpuLowTables(t.bw, t.bh));
    const u = [], uo = {};
    const putU = (name, array) => { uo[name] = u.length; for (const v of array) u.push(v); };
    putU('order', t.order); putU('high', t.high); putU('ctx', [...COEFF_NUM_NONZERO_CONTEXT, ...COEFF_FREQ_CONTEXT]);
    if (positions) putU('pos', positions);
    const count = positions ? positions.length / 2 : 0;
    const gridW = positions ? Math.min(count, 1024) : Math.floor(stride / t.bw), gridH = positions ? Math.ceil(count / gridW) : bandRows ?? Math.floor(rows / t.bh) - gy0;
    const per = mode === 2 ? 3 * size + 3 * area + 1 : mode ? 3 * size + 3 * area : 3, bytes = gridW * gridH * per * 4;
    const params = new Uint32Array([t.w, t.h, t.bw, t.bh, W, stride, rows, cfl.width, area, size, dead ? 1 : 0, t.h >= t.w ? 1 : 0,
      offsets.basisW, offsets.basisH, offsets.steps, offsets.zd, offsets.nz, offsets.const, uo.order, uo.high, uo.ctx, 0, fine.length, gridW, mode, offsets.low, gy0, count, uo.pos ?? 0, 0, 0, 0]);
    device.pushErrorScope('out-of-memory'); device.pushErrorScope('validation');
    let outBuffer = null, readBuffer = null, scopes = 2;
    const temporary = [];
    try {
      outBuffer = owner.track(device.createBuffer({size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC}));
      readBuffer = owner.track(device.createBuffer({size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST}));
      temporary.push(owner.buffer(params, GPUBufferUsage.UNIFORM));
      temporary.push(owner.buffer(Float32Array.from(f))); temporary.push(owner.buffer(Uint32Array.from(u)));
      const bind = device.createBindGroup({layout: owner.pipeline.getBindGroupLayout(0), entries: [
        {binding: 0, resource: {buffer: temporary[0]}},
        ...this.planes.map((buffer, i) => ({binding: 1 + i, resource: {buffer}})),
        {binding: 4, resource: {buffer: temporary[1]}}, {binding: 5, resource: {buffer: temporary[2]}},
        {binding: 6, resource: {buffer: this.blk}}, {binding: 7, resource: {buffer: outBuffer}}]});
      const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
      pass.setPipeline(owner.pipeline); pass.setBindGroup(0, bind); pass.dispatchWorkgroups(gridW, gridH); pass.end();
      encoder.copyBufferToBuffer(outBuffer, 0, readBuffer, 0, bytes);
      device.queue.submit([encoder.finish()]);
      const failed = Promise.all([device.popErrorScope(), device.popErrorScope()]); scopes = 0;
      const [errors] = await Promise.all([failed, readBuffer.mapAsync(GPUMapMode.READ)]);
      owner.assertOpen();
      if (errors.some(Boolean)) throw new Error('GPU varblocks: ' + errors.find(Boolean).message);
      const values = new Float32Array(readBuffer.getMappedRange().slice(0));
      readBuffer.unmap();
      return {values, gridW, gridH, t, size, area, per};
    } finally {
      while (scopes-- > 0) await device.popErrorScope().catch(() => null);
      owner.free(readBuffer); owner.free(outBuffer); for (const b of temporary) owner.free(b);
    }
  }

  async costs() {
    const {stride, rows, transforms} = this.input, results = new Map();
    await Promise.all([...transforms.keys()].map(id => this.run(id, 0).then(({values, gridW, gridH, t}) => {
      this.owner.assertOpen();
      const D = new Float64Array(stride * rows), R = new Float64Array(stride * rows), uncertain = new Uint8Array(stride * rows);
      for (let gy = 0; gy < gridH; gy++) for (let gx = 0; gx < gridW; gx++) {
        const at = (gy * t.bh) * stride + gx * t.bw, i = (gy * gridW + gx) * 3;
        D[at] = values[i]; R[at] = values[i + 1]; uncertain[at] = values[i + 2] !== 0 ? 1 : 0;
      }
      results.set(id, {D, R, uncertain});
    })));
    return results;
  }
  async blocks(id) {
    const {stride, rows, transforms} = this.input, t = transforms.get(id), gridW = Math.floor(stride / t.bw), gridH = Math.floor(rows / t.bh);
    const per = 3 * t.w * t.h + 3 * t.bw * t.bh, band = Math.max(1, Math.floor((this.owner.bandBytes ?? 32 * 1048576) / (gridW * per * 4))), bands = [];
    for (let gy = 0; gy < gridH; gy += band) bands.push(this.run(id, 1, gy, Math.min(band, gridH - gy)));
    const parts = await Promise.all(bands), size = t.w * t.h, area = t.bw * t.bh;
    this.owner.assertOpen();
    return (bx, by) => {
      const gy = by / t.bh, values = parts[Math.floor(gy / band)].values, at = ((gy % band) * gridW + bx / t.bw) * per;
      const ints = new Int32Array(values.buffer, values.byteOffset, values.length);
      return {coeffs: [0, 1, 2].map(c => ints.subarray(at + c * size, at + (c + 1) * size)),
        dc: [0, 1, 2].map(c => ints.subarray(at + 3 * size + c * area, at + 3 * size + (c + 1) * area))};
    };
  }
  async exact(layout) {
    const byId = new Map(), result = new Map();
    for (const {id, bx, by} of layout) if (this.input.transforms.has(id)) (byId.get(id) || byId.set(id, []).get(id)).push(bx, by);
    const jobs = [];
    for (const [id, list] of byId) {
      const t = this.input.transforms.get(id), size = t.w * t.h, area = t.bw * t.bh, per = 3 * size + 3 * area + 1;
      const chunk = 2 * Math.max(1, Math.floor((this.owner.bandBytes ?? 32 * 1048576) / (per * 4)));
      for (let at = 0; at < list.length; at += chunk) {
        const positions = Uint32Array.from(list.slice(at, at + chunk));
        jobs.push(this.run(id, 2, 0, undefined, positions).then(({values}) => {
          this.owner.assertOpen();
          const ints = new Int32Array(values.buffer, values.byteOffset, values.length);
          for (let b = 0; b < positions.length / 2; b++) {
            const o = b * per;
            result.set(id + ':' + positions[2 * b] + ':' + positions[2 * b + 1], {
              coeffs: [0, 1, 2].map(c => ints.subarray(o + c * size, o + (c + 1) * size)),
              dc: [0, 1, 2].map(c => ints.subarray(o + 3 * size + c * area, o + 3 * size + (c + 1) * area)), uncertain: values[o + per - 1] !== 0});
          }
        }));
      }
    }
    await Promise.all(jobs);
    return result;
  }
  release() { this.owner.free(this.blk); this.input = null; }
}

export class GpuVarblockCosts {
  static async create(device) {
    const self = new GpuVarblockCosts();
    self.device = device; self.buffers = new Set(); self.allocatedBytes = 0; self.peakBufferBytes = 0; self.failures = 0; self.destroyed = false;
    self.pipeline = await device.createComputePipelineAsync({layout: 'auto', compute: {module: device.createShaderModule({code: SHADER}), entryPoint: 'main'}});
    return self;
  }
  assertOpen() { if (this.destroyed) throw new Error('GPU varblock owner is closed.'); }
  planeBuffers(planes) {
    this.assertOpen();
    if (this.planesOf !== planes) {
      for (const b of this.planeUpload || []) this.free(b);
      this.planesOf = null; this.planeUpload = [];
      try { for (const plane of planes) this.planeUpload.push(this.buffer(plane instanceof Float32Array ? plane : Float32Array.from(plane))); }
      catch (error) { for (const b of this.planeUpload) this.free(b); this.planeUpload = []; throw error; }
      this.planesOf = planes;
    }
    return this.planeUpload;
  }
  track(buffer) {
    if (this.destroyed) { buffer.destroy(); this.assertOpen(); }
    this.buffers.add(buffer); this.allocatedBytes += buffer.size; this.peakBufferBytes = Math.max(this.peakBufferBytes, this.allocatedBytes); return buffer;
  }
  free(buffer) {
    if (!buffer || !this.buffers.delete(buffer)) return;
    this.allocatedBytes -= buffer.size; buffer.destroy();
  }
  buffer(data, usage = GPUBufferUsage.STORAGE) {
    this.assertOpen();
    const buffer = this.track(this.device.createBuffer({size: Math.max(16, Math.ceil(data.byteLength / 4) * 4), usage: usage | GPUBufferUsage.COPY_DST}));
    try { this.device.queue.writeBuffer(buffer, 0, data); return buffer; }
    catch (error) { this.free(buffer); throw error; }
  }
  destroy() {
    if (this.destroyed) return; this.destroyed = true;
    this.session?.release(); this.session = null;
    for (const buffer of [...this.buffers]) this.free(buffer);
    this.planeUpload = []; this.planesOf = null;
    this.pipeline = this.device = null;
  }
  open(base, width, height, options = {}, priced = true) {
    this.assertOpen();
    const input = strategyInputs(base, width, height, priced ? options : {...options, model: 'simple'});
    for (const [id, t] of input.transforms) if (t.w * t.h > 1024) input.transforms.delete(id);
    return input.tokens || !priced ? new GpuVarblockSession(this, input) : null;
  }
  async costs(base, width, height, options = {}) {
    const session = this.open(base, width, height, options);
    if (!session) return null;
    try { return await session.costs(); } finally { session.release(); }
  }
  async request(r) {
    if (this.destroyed) return null;
    try { return await this.answer(r); }
    catch (error) { if (!this.destroyed) { this.failures++; this.lastError = error; this.destroy(); } return null; }
  }
  async answer(r) {
    if (r.kind === 'costs') { this.session?.release(); this.session = this.open(r.base, r.width, r.height, r.options); return this.session ? this.session.costs() : null; }
    if (r.kind === 'blocks') return this.session ? this.session.blocks(r.id) : null;
    if (r.kind === 'exact') return this.session ? this.session.exact(r.layout) : null;
    if (r.kind === 'layout') { const session = this.open(r.base, r.width, r.height, r.options, false); try { return await session.exact(r.layout); } finally { session.release(); } }
    if (r.kind === 'release') { this.session?.release(); this.session = null; }
    return null;
  }
}

export async function attachVarblocks(measurer, device, {signal} = {}) {
  const gpu = await gpuSetup(() => GpuVarblockCosts.create(device), {signal});
  measurer.varblockResources = gpu;
  measurer.varblocks = r => gpu.request(r);
  const destroy = measurer.destroy.bind(measurer);
  measurer.destroy = () => { gpu.destroy(); destroy(); };
  return measurer;
}
