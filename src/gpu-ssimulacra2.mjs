// SPDX-License-Identifier: MIT
import {SSIMULACRA2_WEIGHTS, SRGB_TO_LINEAR, gaussianTaps, finalCurve} from './ssimulacra2.mjs';

const TAPS = gaussianTaps(), REACH = (TAPS.length - 1) / 2, GS_SCALES = 6, GS_WG = 128;
const gsF = v => {
  const s = Math.fround(v).toString();
  return /[.eE]/.test(s) ? s : s + '.0';
};

const COMMON = `
struct Dims { w: u32, h: u32, pw: u32, ph: u32, scale: u32, groups: u32, pad0: u32, pad1: u32, k: vec4f }
@group(0) @binding(0) var<uniform> dims: Dims;
`;

const LINEARIZE = COMMON + `
@group(0) @binding(1) var<storage, read> lut: array<f32, 256>;
@group(0) @binding(2) var<storage, read> refImage: array<u32>;
@group(0) @binding(3) var<storage, read> dist: array<u32>;
@group(0) @binding(4) var<storage, read_write> lin: array<f32>;
@compute @workgroup_size(${GS_WG})
fn main(@builtin(global_invocation_id) id: vec3u) {
  let n = dims.w * dims.h; let i = id.x;
  if (i >= n) { return; }
  let a = refImage[i]; let b = dist[i];
  for (var c = 0u; c < 3u; c++) {
    lin[c * n + i] = lut[(a >> (8u * c)) & 255u];
    lin[3u * n + c * n + i] = lut[(b >> (8u * c)) & 255u];
  }
}`;

const DOWNSAMPLE = COMMON + `
@group(0) @binding(1) var<storage, read> prev: array<f32>;
@group(0) @binding(2) var<storage, read_write> cur: array<f32>;
@compute @workgroup_size(${GS_WG})
fn main(@builtin(global_invocation_id) id: vec3u) {
  let n = dims.w * dims.h; let pn = dims.pw * dims.ph; let i = id.x;
  if (i >= n) { return; }
  let x = i % dims.w; let y = i / dims.w;
  let x0 = 2u * x; let y0 = 2u * y; let x1 = min(x0 + 1u, dims.pw - 1u); let y1 = min(y0 + 1u, dims.ph - 1u);
  for (var p = 0u; p < 6u; p++) {
    let s = p * pn;
    cur[p * n + i] = 0.25 * (prev[s + y0 * dims.pw + x0] + prev[s + y0 * dims.pw + x1] + prev[s + y1 * dims.pw + x0] + prev[s + y1 * dims.pw + x1]);
  }
}`;

const PREPARE = COMMON + `
@group(0) @binding(1) var<storage, read> lin: array<f32>;
@group(0) @binding(2) var<storage, read_write> src: array<f32>;
// pow's cube root to full f32 precision with one Newton step (pow is exp2 · log2, a few ulps on some adapters).
fn cbrt(v: f32) -> f32 { if (v <= 0.0) { return 0.0; } let r = pow(v, 1.0 / 3.0); return r - (r * r * r - v) / (3.0 * r * r); }
fn xyb(r: f32, g: f32, b: f32) -> vec3f {
  let bias = ${gsF(0.0037930732552754493)}; let root = ${gsF(Math.cbrt(0.0037930732552754493))};
  let l = cbrt(max(0.0, ${gsF(0.30)} * r + ${gsF(0.622)} * g + ${gsF(0.078)} * b + bias)) - root;
  let m = cbrt(max(0.0, ${gsF(0.23)} * r + ${gsF(0.692)} * g + ${gsF(0.078)} * b + bias)) - root;
  let s = cbrt(max(0.0, ${gsF(0.24342268924547819)} * r + ${gsF(0.20476744424496821)} * g + ${gsF(0.55180986650955360)} * b + bias)) - root;
  let X = 0.5 * (l - m); let Y = 0.5 * (l + m);
  return vec3f(X * 14.0 + 0.42, Y + 0.01, (s - Y) + 0.55);
}
@compute @workgroup_size(${GS_WG})
fn main(@builtin(global_invocation_id) id: vec3u) {
  let n = dims.w * dims.h; let i = id.x;
  if (i >= n) { return; }
  // Centered on the reference's mean: the blurred products then keep their small variances in f32.
  let a = xyb(lin[i], lin[n + i], lin[2u * n + i]) - dims.k.xyz;
  let b = xyb(lin[3u * n + i], lin[4u * n + i], lin[5u * n + i]) - dims.k.xyz;
  for (var c = 0u; c < 3u; c++) {
    src[c * n + i] = a[c]; src[(3u + c) * n + i] = b[c];
    src[(6u + c) * n + i] = a[c] * a[c]; src[(9u + c) * n + i] = b[c] * b[c]; src[(12u + c) * n + i] = a[c] * b[c];
  }
}`;

const blurShader = vertical => COMMON + `
@group(0) @binding(1) var<storage, read> inp: array<f32>;
@group(0) @binding(2) var<storage, read_write> outp: array<f32>;
const TAPS = array<f32, ${TAPS.length}>(${Array.from(TAPS, gsF).join(', ')});
@compute @workgroup_size(${GS_WG})
fn main(@builtin(global_invocation_id) id: vec3u) {
  let n = dims.w * dims.h;
  if (id.x >= 15u * n) { return; }
  let plane = id.x / n; let i = id.x % n; let x = i32(i % dims.w); let y = i32(i / dims.w);
  let count = i32(${vertical ? 'dims.h' : 'dims.w'}); let at = ${vertical ? 'y' : 'x'};
  var sum = 0.0;
  for (var k = -${REACH}; k <= ${REACH}; k++) {
    let p = at + k;
    if (p >= 0 && p < count) { sum += TAPS[k + ${REACH}] * inp[plane * n + u32(${vertical ? 'p * i32(dims.w) + x' : 'y * i32(dims.w) + p'})]; }
  }
  outp[id.x] = sum;
}`;

const MAPS = `
const MTAPS = array<f32, ${TAPS.length}>(${Array.from(TAPS, gsF).join(', ')});
fn reachWeight(at: i32, count: i32) -> f32 {
  var w = 0.0;
  for (var k = -${REACH}; k <= ${REACH}; k++) { let p = at + k; if (p >= 0 && p < count) { w += MTAPS[k + ${REACH}]; } }
  return w;
}
fn maps(i: u32, n: u32, c: u32) -> vec3f {
  let K = dims.k[c];
  let B = reachWeight(i32(i % dims.w), i32(dims.w)) * reachWeight(i32(i / dims.w), i32(dims.h));
  let m1 = blurred[c * n + i]; let m2 = blurred[(3u + c) * n + i];
  let q11 = blurred[(6u + c) * n + i]; let q22 = blurred[(9u + c) * n + i]; let q12 = blurred[(12u + c) * n + i];
  let edge = K * (1.0 - B); let border = K * K * (B - B * B);
  let v1 = q11 - m1 * m1 + 2.0 * K * m1 * (1.0 - B) + border;
  let v2 = q22 - m2 * m2 + 2.0 * K * m2 * (1.0 - B) + border;
  let cv = q12 - m1 * m2 + K * (m1 + m2) * (1.0 - B) + border;
  let numM = 1.0 - (m1 - m2) * (m1 - m2);
  let e = max(0.0, 1.0 - numM * (2.0 * cv + 0.0009) / (v1 + v2 + 0.0009));
  let d1 = (1.0 + abs(src[(3u + c) * n + i] - m2 + edge)) / (1.0 + abs(src[c * n + i] - m1 + edge)) - 1.0;
  return vec3f(e, max(d1, 0.0), max(-d1, 0.0));
}`;

const GS_REDUCE = COMMON + `
@group(0) @binding(1) var<storage, read> src: array<f32>;
@group(0) @binding(2) var<storage, read> blurred: array<f32>;
@group(0) @binding(3) var<storage, read_write> partial: array<f32>;
var<workgroup> acc: array<f32, ${18 * GS_WG}>;
${MAPS}
@compute @workgroup_size(${GS_WG})
fn main(@builtin(global_invocation_id) id: vec3u, @builtin(local_invocation_index) li: u32, @builtin(workgroup_id) wg: vec3u) {
  let n = dims.w * dims.h; let i = id.x;
  for (var c = 0u; c < 3u; c++) {
    var v = vec3f(0.0);
    if (i < n) { v = maps(i, n, c); }
    for (var t = 0u; t < 3u; t++) {
      let q = v[t] * v[t];
      acc[(c * 6u + t * 2u) * ${GS_WG}u + li] = v[t];
      acc[(c * 6u + t * 2u + 1u) * ${GS_WG}u + li] = q * q;
    }
  }
  workgroupBarrier();
  for (var s = ${GS_WG / 2}u; s > 0u; s >>= 1u) {
    if (li < s) { for (var j = 0u; j < 18u; j++) { acc[j * ${GS_WG}u + li] += acc[j * ${GS_WG}u + li + s]; } }
    workgroupBarrier();
  }
  if (li == 0u) { for (var j = 0u; j < 18u; j++) { partial[wg.x * 18u + j] = acc[j * ${GS_WG}u]; } }
}`;

const SHARE = COMMON + `
@group(0) @binding(1) var<storage, read> src: array<f32>;
@group(0) @binding(2) var<storage, read> blurred: array<f32>;
@group(0) @binding(3) var<storage, read> k: array<f32, 18>;
@group(0) @binding(4) var<storage, read_write> share: array<f32>;
${MAPS}
@compute @workgroup_size(${GS_WG})
fn main(@builtin(global_invocation_id) id: vec3u) {
  let n = dims.w * dims.h; let i = id.x;
  if (i >= n) { return; }
  var sum = 0.0;
  for (var c = 0u; c < 3u; c++) {
    let v = maps(i, n, c);
    for (var t = 0u; t < 3u; t++) { let q = v[t] * v[t]; sum += k[c * 3u + t] * v[t] + k[9u + c * 3u + t] * q * q; }
  }
  share[i] = sum;
}`;

const GATHER = COMMON + `
@group(0) @binding(1) var<storage, read> shares: array<f32>;
@group(0) @binding(2) var<storage, read> scaleLayout: array<u32, 24>;
@group(0) @binding(3) var<storage, read_write> map: array<f32>;
@compute @workgroup_size(${GS_WG})
fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= dims.w * dims.h) { return; }
  let x = i % dims.w; let y = i / dims.w;
  var sum = 0.0;
  for (var s = 0u; s < dims.scale; s++) {
    let offset = scaleLayout[s * 4u]; let w = scaleLayout[s * 4u + 1u]; let h = scaleLayout[s * 4u + 2u];
    let sx = min(w - 1u, x >> s); let sy = min(h - 1u, y >> s);
    sum += shares[offset + sy * w + sx] / f32(1u << (2u * s));
  }
  map[i] = sum;
}`;

export class GpuSsimulacra2 {
  static async create(device, width, height) {
    const self = new GpuSsimulacra2();
    await self.init(device, width, height);
    return self;
  }

  async init(device, width, height) {
    this.device = device; this.width = width; this.height = height;
    const n = width * height, storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    const buffer = (bytes, usage = storage) => device.createBuffer({size: Math.max(16, Math.ceil(bytes / 16) * 16), usage});
    this.scales = [];
    let w = width, h = height, pw = 0, ph = 0, shareOffset = 0;
    for (let s = 0; s < GS_SCALES; s++) {
      if (w < 8 || h < 8) break;
      if (s) { pw = w; ph = h; w = (w + 1) >> 1; h = (h + 1) >> 1; }
      const groups = Math.ceil(w * h / GS_WG);
      this.scales.push({w, h, pw, ph, groups, shareOffset});
      shareOffset += Math.ceil(w * h / 64) * 64;
    }
    this.lut = buffer(1024); device.queue.writeBuffer(this.lut, 0, Float32Array.from(SRGB_TO_LINEAR));
    this.ref = buffer(n * 4); this.dist = buffer(n * 4);
    this.lin = [buffer(6 * n * 4), buffer(6 * n * 4)];
    this.src = buffer(15 * n * 4); this.tmp = buffer(15 * n * 4); this.blurred = buffer(15 * n * 4);
    const stride = Math.ceil(Math.max(...this.scales.map(s => s.groups)) * 18 / 64) * 64;
    this.partial = buffer(stride * 4 * this.scales.length);
    this.read = device.createBuffer({size: this.partial.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST});
    this.shares = buffer(shareOffset * 4); this.map = buffer(n * 4);
    this.mapRead = device.createBuffer({size: this.map.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST});
    this.k = this.scales.map(() => buffer(18 * 4));
    this.layout = buffer(24 * 4);
    device.queue.writeBuffer(this.layout, 0, Uint32Array.from({length: 24}, (_, i) => {
      const s = this.scales[i >> 2]; if (!s) return 0; return [s.shareOffset, s.w, s.h, 0][i & 3];
    }));
    this.uniforms = this.scales.map(s => {
      const u = buffer(48, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
      device.queue.writeBuffer(u, 0, Uint32Array.of(s.w, s.h, s.pw, s.ph, this.scales.length, s.groups, 0, 0));
      return u;
    });
    const pipeline = code => device.createComputePipeline({layout: 'auto', compute: {module: device.createShaderModule({code}), entryPoint: 'main'}});
    this.p = {linearize: pipeline(LINEARIZE), downsample: pipeline(DOWNSAMPLE), prepare: pipeline(PREPARE),
      blurH: pipeline(blurShader(false)), blurV: pipeline(blurShader(true)), reduce: pipeline(GS_REDUCE), share: pipeline(SHARE), gather: pipeline(GATHER)};
    const bind = (p, ...buffers) => device.createBindGroup({layout: p.getBindGroupLayout(0), entries: buffers.map((b, i) => ({binding: i, resource: {buffer: b}}))});
    this.groups = this.scales.map((s, i) => {
      const u = this.uniforms[i], lin = this.lin[i & 1], prev = this.lin[(i + 1) & 1];
      return {
        first: i === 0 ? bind(this.p.linearize, u, this.lut, this.ref, this.dist, lin) : bind(this.p.downsample, u, prev, lin),
        prepare: bind(this.p.prepare, u, lin, this.src),
        blurH: bind(this.p.blurH, u, this.src, this.tmp), blurV: bind(this.p.blurV, u, this.tmp, this.blurred),
        reduce: device.createBindGroup({layout: this.p.reduce.getBindGroupLayout(0), entries: [
          {binding: 0, resource: {buffer: u}}, {binding: 1, resource: {buffer: this.src}}, {binding: 2, resource: {buffer: this.blurred}},
          {binding: 3, resource: {buffer: this.partial, offset: i * stride * 4, size: stride * 4}}]}),
        share: device.createBindGroup({layout: this.p.share.getBindGroupLayout(0), entries: [
          {binding: 0, resource: {buffer: u}}, {binding: 1, resource: {buffer: this.src}}, {binding: 2, resource: {buffer: this.blurred}},
          {binding: 3, resource: {buffer: this.k[i]}}, {binding: 4, resource: {buffer: this.shares, offset: s.shareOffset * 4, size: Math.ceil(s.w * s.h / 4) * 16}}]}),
      };
    });
    this.stride = stride;
    this.gatherGroup = bind(this.p.gather, this.uniforms[0], this.shares, this.layout, this.map);
  }

  setReference(rgba) {
    this.device.queue.writeBuffer(this.ref, 0, rgba.buffer, rgba.byteOffset, this.width * this.height * 4);
    const k = referenceMean(rgba, this.width * this.height);
    for (const u of this.uniforms) this.device.queue.writeBuffer(u, 32, k);
  }

  encodePasses(encoder, i, share) {
    const s = this.scales[i], g = this.groups[i], pass = encoder.beginComputePass();
    const run = (p, group, count) => { pass.setPipeline(p); pass.setBindGroup(0, group); pass.dispatchWorkgroups(count); };
    if (!share) {
      run(i === 0 ? this.p.linearize : this.p.downsample, g.first, Math.ceil(s.w * s.h / GS_WG));
      run(this.p.prepare, g.prepare, Math.ceil(s.w * s.h / GS_WG));
      run(this.p.blurH, g.blurH, Math.ceil(15 * s.w * s.h / GS_WG));
      run(this.p.blurV, g.blurV, Math.ceil(15 * s.w * s.h / GS_WG));
      run(this.p.reduce, g.reduce, s.groups);
    } else run(this.p.share, g.share, Math.ceil(s.w * s.h / GS_WG));
    pass.end();
  }

  async score(rgba, {wantMap = false} = {}) {
    const {device} = this;
    device.queue.writeBuffer(this.dist, 0, rgba.buffer, rgba.byteOffset, this.width * this.height * 4);
    const norms = [];
    const partials = [];
    if (!wantMap) {
      const encoder = device.createCommandEncoder();
      for (let i = 0; i < this.scales.length; i++) this.encodePasses(encoder, i, false);
      encoder.copyBufferToBuffer(this.partial, 0, this.read, 0, this.partial.size);
      device.queue.submit([encoder.finish()]);
      await this.read.mapAsync(GPUMapMode.READ);
      const all = new Float32Array(this.read.getMappedRange().slice(0));
      this.read.unmap();
      for (let i = 0; i < this.scales.length; i++) partials.push(all.subarray(i * this.stride, i * this.stride + this.scales[i].groups * 18));
      for (let i = 0; i < this.scales.length; i++) norms.push(normsFrom(partials[i], this.scales[i]));
    } else {
      for (let i = 0; i < this.scales.length; i++) {
        let encoder = device.createCommandEncoder();
        this.encodePasses(encoder, i, false);
        encoder.copyBufferToBuffer(this.partial, i * this.stride * 4, this.read, 0, this.scales[i].groups * 18 * 4);
        device.queue.submit([encoder.finish()]);
        await this.read.mapAsync(GPUMapMode.READ, 0, this.scales[i].groups * 18 * 4);
        const part = new Float32Array(this.read.getMappedRange(0, this.scales[i].groups * 18 * 4).slice(0));
        this.read.unmap();
        norms.push(normsFrom(part, this.scales[i]));
        device.queue.writeBuffer(this.k[i], 0, shareCoefficients(norms, i, this.scales.length, this.scales[i]));
        encoder = device.createCommandEncoder();
        this.encodePasses(encoder, i, true);
        device.queue.submit([encoder.finish()]);
      }
    }
    let sum = 0, j = 0;
    for (let c = 0; c < 3; c++) for (let s = 0; s < norms.length; s++) for (let k = 0; k < 2; k++) {
      sum += SSIMULACRA2_WEIGHTS[j++] * Math.abs(norms[s].ssim[c * 2 + k]);
      sum += SSIMULACRA2_WEIGHTS[j++] * Math.abs(norms[s].edge[c * 4 + k]);
      sum += SSIMULACRA2_WEIGHTS[j++] * Math.abs(norms[s].edge[c * 4 + k + 2]);
    }
    const result = {score: finalCurve(sum), sum, norms, map: null};
    if (wantMap) {
      const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
      pass.setPipeline(this.p.gather); pass.setBindGroup(0, this.gatherGroup); pass.dispatchWorkgroups(Math.ceil(this.width * this.height / GS_WG)); pass.end();
      encoder.copyBufferToBuffer(this.map, 0, this.mapRead, 0, this.map.size);
      device.queue.submit([encoder.finish()]);
      await this.mapRead.mapAsync(GPUMapMode.READ);
      result.map = new Float32Array(this.mapRead.getMappedRange().slice(0, this.width * this.height * 4));
      this.mapRead.unmap();
    }
    return result;
  }

  destroy() {
    for (const b of [this.lut, this.ref, this.dist, ...this.lin, this.src, this.tmp, this.blurred, this.partial, this.read,
      this.shares, this.map, this.mapRead, ...this.k, this.layout, ...this.uniforms]) b.destroy();
  }
}

function referenceMean(rgba, n) {
  const step = Math.max(1, Math.floor(n / 65536)), sum = [0, 0, 0], cb = Math.cbrt(0.0037930732552754493);
  let count = 0;
  for (let i = 0; i < n; i += step) {
    const r = SRGB_TO_LINEAR[rgba[i * 4]], g = SRGB_TO_LINEAR[rgba[i * 4 + 1]], b = SRGB_TO_LINEAR[rgba[i * 4 + 2]];
    const l = Math.cbrt(0.30 * r + 0.622 * g + 0.078 * b + 0.0037930732552754493) - cb, m = Math.cbrt(0.23 * r + 0.692 * g + 0.078 * b + 0.0037930732552754493) - cb;
    const s = Math.cbrt(0.24342268924547819 * r + 0.20476744424496821 * g + 0.55180986650955360 * b + 0.0037930732552754493) - cb;
    const X = 0.5 * (l - m), Y = 0.5 * (l + m);
    sum[0] += X * 14 + 0.42; sum[1] += Y + 0.01; sum[2] += s - Y + 0.55; count++;
  }
  return Float32Array.of(sum[0] / count, sum[1] / count, sum[2] / count, 0);
}

function normsFrom(partial, scale) {
  const sums = new Float64Array(18), n = scale.w * scale.h;
  for (let g = 0; g < scale.groups; g++) for (let j = 0; j < 18; j++) sums[j] += partial[g * 18 + j];
  const ssim = new Float64Array(6), edge = new Float64Array(12);
  for (let c = 0; c < 3; c++) {
    const at = c * 6;
    ssim[c * 2] = sums[at] / n; ssim[c * 2 + 1] = Math.sqrt(Math.sqrt(sums[at + 1] / n));
    edge[c * 4] = sums[at + 2] / n; edge[c * 4 + 1] = Math.sqrt(Math.sqrt(sums[at + 3] / n));
    edge[c * 4 + 2] = sums[at + 4] / n; edge[c * 4 + 3] = Math.sqrt(Math.sqrt(sums[at + 5] / n));
  }
  return {ssim, edge};
}

function shareCoefficients(norms, s, scales, scale) {
  const n = scale.w * scale.h, k = new Float32Array(18);
  for (let c = 0; c < 3; c++) {
    const base = c * scales * 6 + s * 6, w = j => SSIMULACRA2_WEIGHTS[base + j];
    const l4 = [norms[s].ssim[c * 2 + 1], norms[s].edge[c * 4 + 1], norms[s].edge[c * 4 + 3]];
    for (let t = 0; t < 3; t++) {
      k[c * 3 + t] = w(t) / n;
      k[9 + c * 3 + t] = l4[t] > 0 ? w(3 + t) / (n * l4[t] ** 3) : 0;
    }
  }
  return k;
}

