// SPDX-License-Identifier: MIT
import {SSIMULACRA2_WEIGHTS, finalCurve, gaussianTaps} from './ssimulacra2.mjs';
import {UniformRing} from './gpu-uniforms.mjs';
import {gpuPipelineSet} from './gpu-pipelines.mjs';

const S2G_WG = 128, S2G_SCALES = 6, S2G_REACH = 4;
const S2G_TAPS = gaussianTaps();
const S2G_INV_S2 = (() => { let s = 0; for (const t of S2G_TAPS) s += Math.fround(t); return 1 / (s * s); })();
const S2G_K = [0.42, 0.45, 0.55];
const s2gF = v => { const s = Math.fround(v).toString(); return /[.eE]/.test(s) ? s : s + '.0'; };

function s2gShader(buffers, body, extra = '', reduce = false) {
  return `struct Params { w: u32, h: u32, i0: u32, i1: u32, i2: u32, i3: u32, a: f32, b: f32 }
@group(0) @binding(0) var<uniform> P: Params;
${buffers.map(([name, access], k) => `@group(0) @binding(${k + 1}) var<storage, ${access}> ${name}: array<f32>;`).join('\n')}
const TAPS = array<f32, ${S2G_TAPS.length}>(${Array.from(S2G_TAPS, s2gF).join(', ')});
const INV_S2 = ${s2gF(S2G_INV_S2)};
const KC = vec3f(${S2G_K.map(s2gF).join(', ')});
${extra}
${reduce ? `var<workgroup> acc: array<f32, ${18 * S2G_WG}>;` : ''}
@compute @workgroup_size(${S2G_WG})
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_index) li: u32, @builtin(workgroup_id) wg: vec3u) {
  let i = gid.x + gid.y * ${65535 * S2G_WG}u; let inside = i < P.w * P.h; let group = wg.x + wg.y * 65535u;
  ${reduce ? '' : 'if (!inside) { return; }'}
  let x = i % P.w; let y = i / P.w;
  ${body}
}`;
}
const R = (...n) => n.map(x => [x, 'read']), W = (...n) => n.map(x => [x, 'read_write']);

const S2G_SHADERS = {
  place: s2gShader([...R('r', 'g', 'b'), ...W('dr', 'dg', 'db')], `
    let k = (y + (P.i2 >> 16u)) * P.i0 + x + (P.i2 & 65535u); let o = (y + (P.i3 >> 16u)) * P.i1 + x + (P.i3 & 65535u);
    dr[o] = r[k]; dg[o] = g[k]; db[o] = b[k];`),
  down: s2gShader([...R('r', 'g', 'b'), ...W('or', 'og', 'ob')], `
    let x0 = 2u * x; let y0 = 2u * y; let x1 = min(x0 + 1u, P.i0 - 1u); let y1 = min(y0 + 1u, P.i1 - 1u);
    let a = y0 * P.i0 + x0; let b2 = y0 * P.i0 + x1; let c = y1 * P.i0 + x0; let d = y1 * P.i0 + x1;
    or[i] = 0.25 * (r[a] + r[b2] + r[c] + r[d]); og[i] = 0.25 * (g[a] + g[b2] + g[c] + g[d]); ob[i] = 0.25 * (b[a] + b[b2] + b[c] + b[d]);`),
  prepare: s2gShader([...R('r1', 'g1', 'b1', 'r2', 'g2', 'b2'), ...W('src')], `
    let k = (y + P.i0) * P.w + x; let n = P.w * P.h;
    let pa = xyb(r1[k], g1[k], b1[k]); let pb = xyb(r2[k], g2[k], b2[k]); let a = pa - KC; let b = pb - KC; let d = pa - pb;
    for (var c = 0u; c < 3u; c++) {
      src[c * n + i] = a[c]; src[(3u + c) * n + i] = b[c];
      src[(6u + c) * n + i] = a[c] * a[c]; src[(9u + c) * n + i] = b[c] * b[c]; src[(12u + c) * n + i] = d[c] * d[c];
    }`, `
// pow's cube root to full f32 precision with one Newton step (pow is exp2 · log2, a few ulps on some adapters).
fn cbrt(v: f32) -> f32 { if (v <= 0.0) { return 0.0; } let r = pow(v, 1.0 / 3.0); return r - (r * r * r - v) / (3.0 * r * r); }
fn xyb(r: f32, g: f32, b: f32) -> vec3f {
  let bias = ${s2gF(0.0037930732552754493)}; let root = ${s2gF(Math.cbrt(0.0037930732552754493))};
  let l = cbrt(max(0.0, ${s2gF(0.30)} * r + ${s2gF(0.622)} * g + ${s2gF(0.078)} * b + bias)) - root;
  let m = cbrt(max(0.0, ${s2gF(0.23)} * r + ${s2gF(0.692)} * g + ${s2gF(0.078)} * b + bias)) - root;
  let s = cbrt(max(0.0, ${s2gF(0.24342268924547819)} * r + ${s2gF(0.20476744424496821)} * g + ${s2gF(0.55180986650955360)} * b + bias)) - root;
  let X = 0.5 * (l - m); let Y = 0.5 * (l + m);
  return vec3f(X * 14.0 + 0.42, Y + 0.01, (s - Y) + 0.55);
}`),
  rows: s2gShader([...R('src'), ...W('hb')], `
    let row = y % P.i0; let plane = y / P.i0; let base = plane * P.w * P.i0 + row * P.w;
    var sum = 0.0;
    for (var t = -${S2G_REACH}; t <= ${S2G_REACH}; t++) {
      let p = i32(x) + t;
      if (p >= 0 && p < i32(P.w)) { sum += TAPS[t + ${S2G_REACH}] * src[base + u32(p)]; }
    }
    hb[i] = sum;`),
  cols: s2gShader([...R('src', 'hb'), ...W('partial')], `
    var v: array<vec3f, 3>;
    if (inside) {
      let n = P.w * P.i1; let br = P.i0 + y; let yi = i32(P.i2 + br);
      // The normalized blur of one: exactly one wherever all nine taps fall inside, so the centering terms vanish there.
      let full = x >= ${S2G_REACH}u && x + ${S2G_REACH}u < P.w && yi >= ${S2G_REACH} && yi + ${S2G_REACH} < i32(P.i3);
      let B = select(reach(i32(x), i32(P.w)) * reach(yi, i32(P.i3)) * INV_S2, 1.0, full);
      for (var c = 0u; c < 3u; c++) {
        var m1 = 0.0; var m2 = 0.0; var q11 = 0.0; var q22 = 0.0; var qdd = 0.0;
        for (var t = -${S2G_REACH}; t <= ${S2G_REACH}; t++) {
          let yy = yi + t;
          if (yy >= 0 && yy < i32(P.i3)) {
            let k = u32(i32(br) + t) * P.w + x; let w = TAPS[t + ${S2G_REACH}];
            m1 += w * hb[c * n + k]; m2 += w * hb[(3u + c) * n + k];
            q11 += w * hb[(6u + c) * n + k]; q22 += w * hb[(9u + c) * n + k]; qdd += w * hb[(12u + c) * n + k];
          }
        }
        m1 *= INV_S2; m2 *= INV_S2; q11 *= INV_S2; q22 *= INV_S2; qdd *= INV_S2;
        // The planes were blurred centered (q = p - K); B is the blur of one here (one inside, less near the borders):
        // mu = m + K B, var = qq - m² + 2K m (1 - B) + K² (B - B²), and p - mu = (q - m) - K (B - 1).
        // ssimulacra2.mjs's e = 1 - numM (2 cov + C2) / (var1 + var2 + C2) is worked as md² + numM D / (var1 + var2 + C2),
        // the same value, with D = var1 + var2 - 2 cov = blur(d²) - md² the variance of d = p1 - p2 and md = mu1 - mu2:
        // every term is then small where the two pictures agree, and f32 keeps them (three separate variances of 0.16
        // cancelling to 1e-6 do not).
        let K = KC[c]; let edge = K * (1.0 - B); let border = K * K * (B - B * B);
        let v1 = q11 - m1 * m1 + 2.0 * K * m1 * (1.0 - B) + border;
        let v2 = q22 - m2 * m2 + 2.0 * K * m2 * (1.0 - B) + border;
        let md = m1 - m2; let numM = 1.0 - md * md;
        let e = max(0.0, md * md + numM * (qdd - md * md) / (v1 + v2 + 0.0009));
        let k0 = br * P.w + x;
        let d1 = (1.0 + abs(src[(3u + c) * n + k0] - m2 + edge)) / (1.0 + abs(src[c * n + k0] - m1 + edge)) - 1.0;
        v[c] = vec3f(e, max(d1, 0.0), max(-d1, 0.0));
      }
    }
    for (var c = 0u; c < 3u; c++) { for (var t = 0u; t < 3u; t++) {
      let val = v[c][t]; let q = val * val;
      acc[(c * 6u + t * 2u) * ${S2G_WG}u + li] = val; acc[(c * 6u + t * 2u + 1u) * ${S2G_WG}u + li] = q * q;
    } }
    workgroupBarrier();
    for (var s = ${S2G_WG / 2}u; s > 0u; s >>= 1u) {
      if (li < s) { for (var j = 0u; j < 18u; j++) { acc[j * ${S2G_WG}u + li] += acc[j * ${S2G_WG}u + li + s]; } }
      workgroupBarrier();
    }
    if (li == 0u) { let o = (bitcast<u32>(P.a) + group) * 18u; for (var j = 0u; j < 18u; j++) { partial[o + j] = acc[j * ${S2G_WG}u]; } }`,
  `fn reach(at: i32, count: i32) -> f32 {
  var w = 0.0;
  for (var t = -${S2G_REACH}; t <= ${S2G_REACH}; t++) { let p = at + t; if (p >= 0 && p < count) { w += TAPS[t + ${S2G_REACH}]; } }
  return w;
}`, true),
};

function s2gScales(width, height) {
  const scales = [];
  let w = width, h = height;
  for (let s = 0; s < S2G_SCALES; s++) {
    if (w < 8 || h < 8) break;
    if (s) { w = (w + 1) >> 1; h = (h + 1) >> 1; }
    scales.push({w, h});
  }
  return scales;
}

const s2gPipelines = gpuPipelineSet(S2G_SHADERS);
export class GpuSsimulacra2Measure {
  static fits(device, width, height) {
    const limit = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize);
    return width >= 8 && height >= 8 && width * height * 4 <= limit && 15 * width * (8 + 2 * S2G_REACH + 1) * 4 <= limit;
  }

  static async create(device, width, height, reference) {
    const self = new GpuSsimulacra2Measure();
    try { self.init(device, width, height, reference, await s2gPipelines(device)); return self; }
    catch (error) { self.destroy(); throw error; }
  }

  init(device, width, height, reference, pipelines) {
    this.device = device; this.width = width; this.height = height;
    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC, buffers = this.buffers = [];
    const buffer = bytes => { const b = device.createBuffer({size: Math.max(16, Math.ceil(bytes / 16) * 16), usage}); buffers.push(b); return b; };
    const limit = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize);
    this.scales = s2gScales(width, height);
    let slots = 0;
    for (const [s, sc] of this.scales.entries()) {
      sc.ref = s ? [0, 1, 2].map(() => buffer(sc.w * sc.h * 4)) : reference;
      sc.dist = [0, 1, 2].map(() => buffer(sc.w * sc.h * 4));
      sc.band = Math.max(1, Math.min(sc.h, Math.floor(limit / (15 * sc.w * 4)) - 2 * S2G_REACH, 512));
      sc.bands = [];
      for (let y0 = 0; y0 < sc.h; y0 += sc.band) {
        const rows = Math.min(sc.band, sc.h - y0), lo = Math.max(0, y0 - S2G_REACH), hi = Math.min(sc.h, y0 + rows + S2G_REACH);
        sc.bands.push({y0, rows, lo, h: hi - lo, slot: slots, groups: Math.ceil(sc.w * rows / S2G_WG)});
        slots += Math.ceil(sc.w * rows / S2G_WG);
      }
    }
    this.dist = this.scales[0].dist;
    const maxBand = Math.max(...this.scales.map(sc => Math.max(...sc.bands.map(b => sc.w * b.h))));
    this.src = buffer(15 * maxBand * 4); this.hb = buffer(15 * maxBand * 4);
    this.partial = buffer(slots * 18 * 4);
    this.read = device.createBuffer({size: this.partial.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST});
    this.slots = slots;
    this.pipelines = pipelines;
    this.ring = new UniformRing(device, 1024);
    this.referenceReady = false;
  }

  run(pass, name, grid, buffers, params = {}) {
    const ring = this.ring, at = ring.take(), uv = at === null ? new Uint32Array(8) : ring.u32, fv = at === null ? new Float32Array(uv.buffer) : ring.f32, o = at ?? 0;
    uv[o] = grid[0]; uv[o + 1] = grid[1]; uv[o + 2] = params.i0 ?? 0; uv[o + 3] = params.i1 ?? 0; uv[o + 4] = params.i2 ?? 0; uv[o + 5] = params.i3 ?? 0;
    fv[o + 6] = params.a ?? 0; fv[o + 7] = params.b ?? 0;
    if (params.slot !== undefined) uv[o + 6] = params.slot;
    const p = this.pipelines[name];
    pass.setPipeline(p);
    pass.setBindGroup(0, ring.bind(p, at, buffers, uv));
    const groups = Math.ceil(grid[0] * grid[1] / S2G_WG);
    pass.dispatchWorkgroups(Math.min(groups, 65535), Math.ceil(groups / 65535));
  }

  place(pass, rgb, t) {
    this.run(pass, 'place', [t.cw, t.ch], [...rgb, ...this.dist], {i0: t.rw, i1: this.width, i2: (t.x - t.rx) | (t.y - t.ry) << 16, i3: t.x | t.y << 16});
  }

  async score() {
    const device = this.device, encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
    for (const [s, sc] of this.scales.entries()) {
      if (s) {
        const prev = this.scales[s - 1];
        if (!this.referenceReady) this.run(pass, 'down', [sc.w, sc.h], [...prev.ref, ...sc.ref], {i0: prev.w, i1: prev.h});
        this.run(pass, 'down', [sc.w, sc.h], [...prev.dist, ...sc.dist], {i0: prev.w, i1: prev.h});
      }
      for (const band of sc.bands) {
        this.run(pass, 'prepare', [sc.w, band.h], [...sc.ref, ...sc.dist, this.src], {i0: band.lo});
        this.run(pass, 'rows', [sc.w, 15 * band.h], [this.src, this.hb], {i0: band.h});
        this.run(pass, 'cols', [sc.w, band.rows], [this.src, this.hb, this.partial], {i0: band.y0 - band.lo, i1: band.h, i2: band.lo, i3: sc.h, slot: band.slot});
      }
    }
    pass.end();
    encoder.copyBufferToBuffer(this.partial, 0, this.read, 0, this.slots * 18 * 4);
    this.ring.flush();
    device.queue.submit([encoder.finish()]);
    await this.read.mapAsync(GPUMapMode.READ, 0, this.slots * 18 * 4);
    const partial = new Float32Array(this.read.getMappedRange(0, this.slots * 18 * 4).slice(0));
    this.read.unmap(); this.ring.reset();
    this.referenceReady = true;
    const norms = this.scales.map(sc => {
      const sums = new Float64Array(18), n = sc.w * sc.h;
      for (const band of sc.bands) for (let g = 0; g < band.groups; g++) for (let j = 0; j < 18; j++) sums[j] += partial[(band.slot + g) * 18 + j];
      const per = {ssim: new Float64Array(6), edge: new Float64Array(12)}, root4 = v => Math.sqrt(Math.sqrt(v));
      for (let c = 0; c < 3; c++) {
        per.ssim[c * 2] = sums[c * 6] / n; per.ssim[c * 2 + 1] = root4(sums[c * 6 + 1] / n);
        per.edge[c * 4] = sums[c * 6 + 2] / n; per.edge[c * 4 + 1] = root4(sums[c * 6 + 3] / n);
        per.edge[c * 4 + 2] = sums[c * 6 + 4] / n; per.edge[c * 4 + 3] = root4(sums[c * 6 + 5] / n);
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

