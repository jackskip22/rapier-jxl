// SPDX-License-Identifier: MIT
import {SRGB_TO_LINEAR, SSIMULACRA2_WEIGHTS, finalCurve, recursiveGaussian} from './ssimulacra2.mjs';
import {toRGBA} from './reconstruct.mjs';
import {UniformRing} from './gpu-uniforms.mjs';

const NS_WG = 64, NS_SCALES = 6, NS_C2 = 0.0009;
const nsF = v => { const s = Math.fround(v).toString(); return /[.eE]/.test(s) ? s : s + '.0'; };
const nsDF = v => { const hi = Math.fround(v); return [hi, Math.fround(v - hi)]; };
const NS_G = recursiveGaussian(1.5), NS_N = NS_G.radius;

function nsThresholds() {
  const level = v => toRGBA([Float32Array.of(v), Float32Array.of(0), Float32Array.of(0)], 1, 1)[0];
  const bits = new Uint32Array(1), f = new Float32Array(bits.buffer), at = b => { bits[0] = b; return f[0]; };
  const out = new Float32Array(256);
  for (let k = 1; k < 256; k++) {
    let lo = 0, hi = 0x3f800000;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (level(at(mid)) >= k) hi = mid; else lo = mid + 1; }
    out[k] = at(lo);
  }
  out[0] = -Infinity;
  return out;
}

const NS_COMMON = `
struct Params { w: u32, h: u32, i0: u32, i1: u32, i2: u32, i3: u32, z: u32, k: u32 }
@group(0) @binding(0) var<uniform> P: Params;
// A value no compiler can fuse with what follows: rounding happens here.
fn opaque(x: f32) -> f32 { return bitcast<f32>(bitcast<u32>(x) ^ P.z); }
fn twoSum(a: f32, b: f32) -> vec2f { let s = opaque(a + b); let bb = opaque(s - a); return vec2f(s, (a - (s - bb)) + (b - bb)); }
fn quick(a: f32, b: f32) -> vec2f { let s = opaque(a + b); return vec2f(s, b - (s - a)); }
fn split(a: f32) -> vec2f { let c = opaque(4097.0 * a); let h = opaque(c - opaque(c - a)); return vec2f(h, a - h); }
fn twoProd(a: f32, b: f32) -> vec2f { let p = opaque(a * b); let x = split(a); let y = split(b); return vec2f(p, ((opaque(x.x * y.x) - p) + opaque(x.x * y.y) + opaque(x.y * y.x)) + opaque(x.y * y.y)); }
// a b + c rounded once to f32.
fn fx(a: f32, b: f32, c: f32) -> f32 { let p = twoProd(a, b); let s = twoSum(p.x, c); return opaque(s.x + opaque(s.y + p.y)); }
// Double-float arithmetic (hi, lo).
fn dadd(a: vec2f, b: vec2f) -> vec2f { let s = twoSum(a.x, b.x); return quick(s.x, s.y + a.y + b.y); }
fn dmul(a: vec2f, b: vec2f) -> vec2f { let p = twoProd(a.x, b.x); return quick(p.x, p.y + opaque(a.x * b.y) + opaque(a.y * b.x)); }
fn dscale(a: vec2f, s: f32) -> vec2f { let p = twoProd(a.x, s); return quick(p.x, p.y + opaque(a.y * s)); }
fn ddiv(a: vec2f, b: vec2f) -> vec2f {
  let q1 = a.x / b.x; let r1 = dadd(a, -dscale(b, q1)); let q2 = r1.x / b.x; let r2 = dadd(r1, -dscale(b, q2)); let q3 = r2.x / b.x;
  let s = quick(q1, q2); return dadd(s, vec2f(q3, 0.0));
}
`;

function nsShader(buffers, body, extra = '', reduce = false) {
  return NS_COMMON + `
${buffers.map(([name, access, type = 'array<f32>'], k) => `@group(0) @binding(${k + 1}) var<storage, ${access}> ${name}: ${type};`).join('\n')}
${extra}
${reduce ? `var<workgroup> acc: array<f32, ${6 * NS_WG}>;` : ''}
@compute @workgroup_size(${NS_WG})
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_index) li: u32, @builtin(workgroup_id) wg: vec3u) {
  let i = gid.x + gid.y * ${65535 * NS_WG}u; let inside = i < P.w * P.h; let group = wg.x + wg.y * 65535u;
  ${reduce ? '' : 'if (!inside) { return; }'}
  let x = i % P.w; let y = i / P.w;
  ${body}
}`;
}
const nativeReadBindings = (...n) => n.map(x => [x, 'read']), nativeWriteBindings = (...n) => n.map(x => [x, 'read_write']);
const RU = (...n) => n.map(x => [x, 'read', 'array<u32>']), WU = (...n) => n.map(x => [x, 'read_write', 'array<u32>']);

const NS_XYB = `
const M0 = vec2f(${nsDF(0.30).map(nsF)}); const M1 = vec2f(${nsDF(0.622).map(nsF)}); const M2 = vec2f(${nsDF(0.078).map(nsF)});
const M3 = vec2f(${nsDF(0.23).map(nsF)}); const M4 = vec2f(${nsDF(0.692).map(nsF)}); const M5 = vec2f(${nsDF(0.078).map(nsF)});
const M6 = vec2f(${nsDF(0.24342268924547819).map(nsF)}); const M7 = vec2f(${nsDF(0.20476744424496821).map(nsF)}); const M8 = vec2f(${nsDF(0.55180986650955360).map(nsF)});
const BIAS = vec2f(${nsDF(0.0037930732552754493).map(nsF)}); const ROOT = vec2f(${nsDF(Math.cbrt(0.0037930732552754493)).map(nsF)});
fn dcbrt(v: vec2f) -> vec2f {
  if (v.x <= 0.0) { return vec2f(0.0, 0.0); }
  var r = vec2f(pow(v.x, 1.0 / 3.0), 0.0);
  r = vec2f(r.x - (r.x * r.x * r.x - v.x) / (3.0 * r.x * r.x), 0.0);
  for (var k = 0; k < 2; k++) { let r2 = dmul(r, r); r = dadd(r, -ddiv(dadd(dmul(r2, r), -v), dscale(r2, 3.0))); }
  return r;
}
fn dpos(v: vec2f) -> vec2f { return select(v, vec2f(0.0, 0.0), v.x < 0.0 || (v.x == 0.0 && v.y < 0.0)); }
fn xyb(r: vec2f, g: vec2f, b: vec2f, c: u32) -> f32 {
  let l = dadd(dcbrt(dpos(dadd(dadd(dadd(dmul(M0, r), dmul(M1, g)), dmul(M2, b)), BIAS))), -ROOT);
  let m = dadd(dcbrt(dpos(dadd(dadd(dadd(dmul(M3, r), dmul(M4, g)), dmul(M5, b)), BIAS))), -ROOT);
  if (c == 0u) { return dadd(dscale(dscale(dadd(l, -m), 0.5), 14.0), vec2f(0.42, ${nsF(0.42 - Math.fround(0.42))})).x; }
  let Y = dscale(dadd(l, m), 0.5);
  if (c == 1u) { return dadd(Y, vec2f(${nsDF(0.01).map(nsF)})).x; }
  let s = dadd(dcbrt(dpos(dadd(dadd(dadd(dmul(M6, r), dmul(M7, g)), dmul(M8, b)), BIAS))), -ROOT);
  return dadd(dadd(s, -Y), vec2f(${nsDF(0.55).map(nsF)})).x;
}
`;
const NS_LIN8 = `fn lin8(p: u32, c: u32) -> vec2f { let v = (p >> (8u * c)) & 255u; return vec2f(lut[v * 2u], lut[v * 2u + 1u]); }`;

const NS_SHADERS = {
  place: nsShader([...nativeReadBindings('r', 'g', 'b', 'th'), ...WU('dist')], `
    let k = (y + (P.i2 >> 16u)) * P.i0 + x + (P.i2 & 65535u); let o = (y + (P.i3 >> 16u)) * P.i1 + x + (P.i3 & 65535u);
    dist[o] = level(r[k]) | (level(g[k]) << 8u) | (level(b[k]) << 16u) | 0xff000000u;`, `
fn level(v: f32) -> u32 { var lo = 0u; var hi = 255u; while (lo < hi) { let mid = (lo + hi + 1u) >> 1u; if (v >= th[mid]) { lo = mid; } else { hi = mid - 1u; } } return lo; }`),
  down0: nsShader([...nativeReadBindings('lut'), ...RU('rgba'), ...nativeWriteBindings('out')], `
    let x0 = 2u * x; let y0 = 2u * y; let x1 = min(x0 + 1u, P.i0 - 1u); let y1 = min(y0 + 1u, P.i1 - 1u); let n = P.w * P.h;
    let a = rgba[y0 * P.i0 + x0]; let b = rgba[y0 * P.i0 + x1]; let c = rgba[y1 * P.i0 + x0]; let d = rgba[y1 * P.i0 + x1];
    for (var ch = 0u; ch < 3u; ch++) {
      let s = dscale(dadd(dadd(dadd(lin8(a, ch), lin8(b, ch)), lin8(c, ch)), lin8(d, ch)), 0.25);
      out[(ch * 2u) * n + i] = s.x; out[(ch * 2u + 1u) * n + i] = s.y;
    }`, NS_LIN8),
  down: nsShader([...nativeReadBindings('src'), ...nativeWriteBindings('out')], `
    let x0 = 2u * x; let y0 = 2u * y; let x1 = min(x0 + 1u, P.i0 - 1u); let y1 = min(y0 + 1u, P.i1 - 1u); let n = P.w * P.h; let pn = P.i0 * P.i1;
    let a = y0 * P.i0 + x0; let b = y0 * P.i0 + x1; let c = y1 * P.i0 + x0; let d = y1 * P.i0 + x1;
    for (var ch = 0u; ch < 3u; ch++) {
      let H = ch * 2u * pn; let L = (ch * 2u + 1u) * pn;
      let s = dscale(dadd(dadd(dadd(vec2f(src[H + a], src[L + a]), vec2f(src[H + b], src[L + b])), vec2f(src[H + c], src[L + c])), vec2f(src[H + d], src[L + d])), 0.25);
      out[(ch * 2u) * n + i] = s.x; out[(ch * 2u + 1u) * n + i] = s.y;
    }`),
  xyb0: nsShader([...nativeReadBindings('lut'), ...RU('ra', 'rb'), ...nativeWriteBindings('p1', 'p2')], `
    let a = ra[i]; let b = rb[i];
    p1[i] = xyb(lin8(a, 0u), lin8(a, 1u), lin8(a, 2u), P.k); p2[i] = xyb(lin8(b, 0u), lin8(b, 1u), lin8(b, 2u), P.k);`, NS_XYB + NS_LIN8),
  xyb: nsShader([...nativeReadBindings('da', 'db'), ...nativeWriteBindings('p1', 'p2')], `
    let n = P.w * P.h;
    p1[i] = xyb(vec2f(da[i], da[n + i]), vec2f(da[2u * n + i], da[3u * n + i]), vec2f(da[4u * n + i], da[5u * n + i]), P.k);
    p2[i] = xyb(vec2f(db[i], db[n + i]), vec2f(db[2u * n + i], db[3u * n + i]), vec2f(db[4u * n + i], db[5u * n + i]), P.k);`, `${NS_XYB}`),
  rows: nsShader([...nativeReadBindings('p1', 'p2'), ...nativeWriteBindings('tmp')], `
    let rowY = i; let wd = i32(P.i0);
    var a1 = 0.0; var b1 = 0.0; var a3 = 0.0; var b3 = 0.0; var a5 = 0.0; var b5 = 0.0;
    for (var k = ${-NS_N + 1}; k < wd; k++) {
      let left = k - ${NS_N + 1}; let right = k + ${NS_N - 1}; let at = rowY * P.i0;
      var sum = 0.0;
      if (left >= 0) { sum = sample(at + u32(left)); }
      if (right < wd) { sum = opaque(sum + sample(at + u32(right))); }
      let o1 = fx(N1, sum, -fx(D1, a1, b1)); let o3 = fx(N3, sum, -fx(D3, a3, b3)); let o5 = fx(N5, sum, -fx(D5, a5, b5));
      b1 = a1; a1 = o1; b3 = a3; a3 = o3; b5 = a5; a5 = o5;
      if (k >= 0) { tmp[at + u32(k)] = opaque(opaque(o1 + o3) + o5); }
    }`, `${'' }
const N1 = ${nsF(NS_G.n2[0])}; const N3 = ${nsF(NS_G.n2[1])}; const N5 = ${nsF(NS_G.n2[2])};
const D1 = ${nsF(NS_G.d1[0])}; const D3 = ${nsF(NS_G.d1[1])}; const D5 = ${nsF(NS_G.d1[2])};
fn sample(j: u32) -> f32 {
  switch P.k { case 0u: { return p1[j]; } case 1u: { return p2[j]; } case 2u: { return opaque(p1[j] * p1[j]); }
    case 3u: { return opaque(p2[j] * p2[j]); } default: { return opaque(p1[j] * p2[j]); } }
}`),
  cols: nsShader([...nativeReadBindings('tmp'), ...nativeWriteBindings('out')], `
    let col = i; let ht = i32(P.i1);
    var a1 = 0.0; var b1 = 0.0; var a3 = 0.0; var b3 = 0.0; var a5 = 0.0; var b5 = 0.0;
    for (var k = ${-NS_N + 1}; k < ht; k++) {
      let left = k - ${NS_N + 1}; let right = k + ${NS_N - 1};
      var sum = 0.0;
      if (left >= 0) { sum = tmp[u32(left) * P.i0 + col]; }
      if (right < ht) { sum = opaque(sum + tmp[u32(right) * P.i0 + col]); }
      let o1 = fx(N1, sum, -fx(D1, a1, b1)); let o3 = fx(N3, sum, -fx(D3, a3, b3)); let o5 = fx(N5, sum, -fx(D5, a5, b5));
      b1 = a1; a1 = o1; b3 = a3; a3 = o3; b5 = a5; a5 = o5;
      if (k >= 0) { out[u32(k) * P.i0 + col] = opaque(opaque(o1 + o3) + o5); }
    }`, `
const N1 = ${nsF(NS_G.n2[0])}; const N3 = ${nsF(NS_G.n2[1])}; const N5 = ${nsF(NS_G.n2[2])};
const D1 = ${nsF(NS_G.d1[0])}; const D3 = ${nsF(NS_G.d1[1])}; const D5 = ${nsF(NS_G.d1[2])};`),
  ssim: nsShader([...nativeReadBindings('p1', 'p2', 'mu1', 'mu2', 's11', 's22', 's12'), ...nativeWriteBindings('partial')], `
    var v = vec3f(0.0);
    if (inside) {
      let m1 = mu1[i]; let m2 = mu2[i];
      let delta = opaque(m1 - m2); let numM = opaque(1.0 - opaque(delta * delta));
      let numS = opaque(opaque(2.0 * opaque(s12[i] - opaque(m1 * m2))) + ${nsF(NS_C2)});
      let denS = opaque(opaque(opaque(s11[i] - opaque(m1 * m1)) + opaque(s22[i] - opaque(m2 * m2))) + ${nsF(NS_C2)});
      let e = max(0.0, 1.0 - div(opaque(numM * numS), denS));
      let d1 = (1.0 + abs(opaque(p2[i] - m2))) / (1.0 + abs(opaque(p1[i] - m1))) - 1.0;
      v = vec3f(e, max(d1, 0.0), max(-d1, 0.0));
    }
    for (var t = 0u; t < 3u; t++) { let q = v[t] * v[t]; acc[(t * 2u) * ${NS_WG}u + li] = v[t]; acc[(t * 2u + 1u) * ${NS_WG}u + li] = q * q; }
    workgroupBarrier();
    for (var s = ${NS_WG / 2}u; s > 0u; s >>= 1u) {
      if (li < s) { for (var j = 0u; j < 6u; j++) { acc[j * ${NS_WG}u + li] += acc[j * ${NS_WG}u + li + s]; } }
      workgroupBarrier();
    }
    if (li == 0u) { let o = (P.i2 + group) * 6u; for (var j = 0u; j < 6u; j++) { partial[o + j] = acc[j * ${NS_WG}u]; } }`, `
// a / b rounded once, as the CPU divides f32 values in f64 and rounds (an adapter's division may be off by 2.5 ulp).
fn div(a: f32, b: f32) -> f32 {
  var q = a / b;
  for (var k = 0; k < 2; k++) { let r = fx(-q, b, a); q = opaque(q + r / b); }
  let r = fx(-q, b, a); let up = bitcast<f32>(bitcast<u32>(q) + 1u); let down = bitcast<f32>(bitcast<u32>(q) - 1u);
  // Of q and its neighbours, the one whose residual is smallest is the nearest to a / b.
  let ru = abs(fx(-up, b, a)); let rd = abs(fx(-down, b, a)); var best = q; var br = abs(r);
  if (ru < br) { best = up; br = ru; } if (rd < br) { best = down; }
  return best;
}`, true),
};

function nsScales(width, height) {
  const scales = [];
  let w = width, h = height;
  for (let s = 0; s < NS_SCALES; s++) {
    if (w < 8 || h < 8) break;
    if (s) { w = (w + 1) >> 1; h = (h + 1) >> 1; }
    scales.push({w, h});
  }
  return scales;
}

export class GpuNativeSsimulacra2 {
  static async create(device, rgba, width, height) {
    const limit = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize);
    if (width < 8 || height < 8 || width * height * 4 > limit || 6 * Math.ceil(width / 2) * Math.ceil(height / 2) * 4 > limit) return null;
    device.pushErrorScope('out-of-memory'); device.pushErrorScope('validation');
    let self = null, thrown = null, remaining = 2;
    try {
      try { self = new GpuNativeSsimulacra2(device, rgba, width, height); } catch (error) { thrown = error; }
      remaining--; const validation = await device.popErrorScope();
      remaining--; const memory = await device.popErrorScope();
      GpuNativeSsimulacra2.failure = validation?.message || memory?.message || thrown?.message || null;
      if (validation || memory || !self) { self?.destroy(); return null; }
      return self;
    } catch (error) { self?.destroy(); throw error; }
    finally { while (remaining-- > 0) await device.popErrorScope().catch(() => null); }
  }

  constructor(device, rgba, width, height) {
    this.buffers = [];
    try { this.init(device, rgba, width, height); }
    catch (error) { this.destroy(); throw error; }
  }

  init(device, rgba, width, height) {
    this.device = device; this.width = width; this.height = height;
    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC, buffers = this.buffers = [];
    const buffer = bytes => { const b = device.createBuffer({size: Math.max(16, Math.ceil(bytes / 16) * 16), usage}); buffers.push(b); return b; };
    const n = width * height;
    this.scales = nsScales(width, height);
    const lut = new Float32Array(512);
    for (let v = 0; v < 256; v++) [lut[2 * v], lut[2 * v + 1]] = nsDF(SRGB_TO_LINEAR[v]);
    this.lut = buffer(lut.byteLength); device.queue.writeBuffer(this.lut, 0, lut);
    this.th = buffer(256 * 4); device.queue.writeBuffer(this.th, 0, nsThresholds());
    this.ref = buffer(n * 4); device.queue.writeBuffer(this.ref, 0, new Uint32Array(Uint8Array.from(rgba.subarray(0, n * 4)).buffer));
    this.dist = buffer(n * 4);
    for (const [s, sc] of this.scales.entries()) if (s) { sc.ref = buffer(6 * sc.w * sc.h * 4); sc.dist = buffer(6 * sc.w * sc.h * 4); }
    this.p1 = buffer(n * 4); this.p2 = buffer(n * 4); this.tmp = buffer(n * 4);
    this.blurred = [0, 1, 2, 3, 4].map(() => buffer(n * 4));
    let slots = 0;
    for (const sc of this.scales) { sc.slot = slots; sc.groups = Math.ceil(sc.w * sc.h / NS_WG); slots += 3 * sc.groups; }
    this.slots = slots; this.partial = buffer(slots * 6 * 4);
    this.read = device.createBuffer({size: this.partial.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST});
    this.pipelines = Object.fromEntries(Object.entries(NS_SHADERS).map(([name, code]) =>
      [name, device.createComputePipeline({layout: 'auto', compute: {module: device.createShaderModule({code}), entryPoint: 'main'}})]));
    this.ring = new UniformRing(device, 1024);
    this.referenceReady = false;
  }

  run(pass, name, grid, buffers, params = {}) {
    const ring = this.ring, at = ring.take(), uv = at === null ? new Uint32Array(8) : ring.u32, o = at ?? 0;
    uv[o] = grid[0]; uv[o + 1] = grid[1]; uv[o + 2] = params.i0 ?? 0; uv[o + 3] = params.i1 ?? 0; uv[o + 4] = params.i2 ?? 0; uv[o + 5] = params.i3 ?? 0;
    uv[o + 6] = 0; uv[o + 7] = params.k ?? 0;
    const p = this.pipelines[name];
    pass.setPipeline(p);
    pass.setBindGroup(0, ring.bind(p, at, buffers, uv));
    const groups = Math.ceil(grid[0] * grid[1] / NS_WG);
    pass.dispatchWorkgroups(Math.min(groups, 65535), Math.ceil(groups / 65535));
  }

  place(pass, rgb, t) {
    this.run(pass, 'place', [t.cw, t.ch], [...rgb, this.th, this.dist], {i0: t.rw, i1: this.width, i2: (t.x - t.rx) | (t.y - t.ry) << 16, i3: t.x | t.y << 16});
  }

  async score() {
    const device = this.device, encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
    for (const [s, sc] of this.scales.entries()) {
      const n = sc.w * sc.h;
      if (s === 1) {
        const p = this.scales[0];
        if (!this.referenceReady) this.run(pass, 'down0', [sc.w, sc.h], [this.lut, this.ref, sc.ref], {i0: p.w, i1: p.h});
        this.run(pass, 'down0', [sc.w, sc.h], [this.lut, this.dist, sc.dist], {i0: p.w, i1: p.h});
      } else if (s > 1) {
        const p = this.scales[s - 1];
        if (!this.referenceReady) this.run(pass, 'down', [sc.w, sc.h], [p.ref, sc.ref], {i0: p.w, i1: p.h});
        this.run(pass, 'down', [sc.w, sc.h], [p.dist, sc.dist], {i0: p.w, i1: p.h});
      }
      for (let c = 0; c < 3; c++) {
        if (s === 0) this.run(pass, 'xyb0', [sc.w, sc.h], [this.lut, this.ref, this.dist, this.p1, this.p2], {k: c});
        else this.run(pass, 'xyb', [sc.w, sc.h], [sc.ref, sc.dist, this.p1, this.p2], {k: c});
        for (let q = 0; q < 5; q++) {
          this.run(pass, 'rows', [sc.h, 1], [this.p1, this.p2, this.tmp], {i0: sc.w, i1: sc.h, k: q});
          this.run(pass, 'cols', [sc.w, 1], [this.tmp, this.blurred[q]], {i0: sc.w, i1: sc.h});
        }
        this.run(pass, 'ssim', [sc.w, sc.h], [this.p1, this.p2, ...this.blurred, this.partial], {i2: sc.slot + c * sc.groups});
      }
      void n;
    }
    pass.end();
    encoder.copyBufferToBuffer(this.partial, 0, this.read, 0, this.slots * 6 * 4);
    this.ring.flush();
    device.queue.submit([encoder.finish()]);
    await this.read.mapAsync(GPUMapMode.READ, 0, this.slots * 6 * 4);
    const partial = new Float32Array(this.read.getMappedRange(0, this.slots * 6 * 4).slice(0));
    this.read.unmap(); this.ring.reset();
    this.referenceReady = true;
    const norms = this.scales.map(sc => {
      const n = sc.w * sc.h, per = {ssim: new Float64Array(6), edge: new Float64Array(12)}, root4 = v => Math.sqrt(Math.sqrt(v));
      for (let c = 0; c < 3; c++) {
        const sums = new Float64Array(6);
        for (let g = 0; g < sc.groups; g++) for (let j = 0; j < 6; j++) sums[j] += partial[(sc.slot + c * sc.groups + g) * 6 + j];
        per.ssim[c * 2] = sums[0] / n; per.ssim[c * 2 + 1] = root4(sums[1] / n);
        per.edge[c * 4] = sums[2] / n; per.edge[c * 4 + 1] = root4(sums[3] / n);
        per.edge[c * 4 + 2] = sums[4] / n; per.edge[c * 4 + 3] = root4(sums[5] / n);
      }
      return per;
    });
    let sum = 0, i = 0;
    for (let c = 0; c < 3; c++) for (let s = 0; s < norms.length; s++) for (let k = 0; k < 2; k++) {
      sum += SSIMULACRA2_WEIGHTS[i++] * Math.abs(norms[s].ssim[c * 2 + k]);
      sum += SSIMULACRA2_WEIGHTS[i++] * Math.abs(norms[s].edge[c * 4 + k]);
      sum += SSIMULACRA2_WEIGHTS[i++] * Math.abs(norms[s].edge[c * 4 + k + 2]);
    }
    return {score: finalCurve(sum), sum, norms};
  }

  destroy() { for (const b of this.buffers ?? []) b.destroy(); this.buffers = []; this.read?.destroy(); this.ring?.destroy(); }
}

