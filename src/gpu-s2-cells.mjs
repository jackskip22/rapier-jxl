// SPDX-License-Identifier: MIT
import {SSIMULACRA2_WEIGHTS} from './ssimulacra2.mjs';
import {S2C_LIN, S2C_MIX, S2C_TAPS, s2cScales} from './s2-cells.mjs';
import {IS_CBRT_LO, IS_CBRT_HI, IS_BIAS, BLACK} from './int-spec.mjs';
import {INT_WGSL} from './int-ops.mjs';

const GSC_BAND = 128, GSC_HALO = 4, GSC_WG = 64, GSC_HI = 256 + IS_CBRT_LO.length;

const GSC_DIV =  `
fn udiv64by32(a: vec2u, b: u32) -> u32 {
  var r = 0u; var q = 0u;
  for (var i = 43i; i >= 0i; i--) {
    var bit = 0u;
    if (i >= 32i) { bit = (a.y >> u32(i - 32i)) & 1u; } else { bit = (a.x >> u32(i)) & 1u; }
    r = (r << 1u) | bit;
    if (r >= b) { r = r - b; if (i < 32i) { q = q | (1u << u32(i)); } }
  }
  return q;
}`;

const GSC_HEAD =  `
struct U { w: u32, h: u32, pw: u32, ph: u32, y0: u32, y1: u32, ys: u32, ye: u32,
  c: u32, sh: u32, cstride: u32, n: u32, mode: u32, count: u32, plane: u32, cw: u32 }
@group(0) @binding(0) var<uniform> u: U;
fn Ri(s: i32, k: u32) -> i32 { return (s + (1i << (k - 1u))) >> k; }
fn round64(a: vec2u, k: u32) -> i32 { return bitcast<i32>(shr64s(add64(a, vec2u(1u << (k - 1u), 0u)), k).x); }
var<private> TAPS: array<i32, 9> = array<i32, 9>(${Array.from(S2C_TAPS).join(', ')});
${INT_WGSL}
${GSC_DIV}
fn flat(wg: vec3u, nw: vec3u, l: u32) -> u32 { return (wg.y * nw.x + wg.x) * ${GSC_WG}u + l; }
`;

const GSC_SHADERS = {
  down: GSC_HEAD +  `
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(2) var<storage, read_write> dst: array<u32>;
@group(0) @binding(3) var<storage, read> T: array<i32>;
fn at(c: u32, k: u32) -> u32 {
  if (u.mode == 1u) { return u32(T[(src[k] >> (8u * c)) & 255u]); }
  return src[c * u.pw * u.ph + k];
}
@compute @workgroup_size(${GSC_WG}) fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nw: vec3u, @builtin(local_invocation_index) l: u32) {
  let i = flat(wg, nw, l);
  if (i >= u.w * u.h) { return; }
  let x = i % u.w; let y = i / u.w; let x0 = 2u * x; let y0 = 2u * y;
  let x1 = min(x0 + 1u, u.pw - 1u); let y1 = min(y0 + 1u, u.ph - 1u);
  for (var c = 0u; c < 3u; c++) {
    dst[c * u.w * u.h + i] = (at(c, y0 * u.pw + x0) + at(c, y0 * u.pw + x1) + at(c, y1 * u.pw + x0) + at(c, y1 * u.pw + x1) + 2u) >> 2u;
  }
}`,
  xyb: GSC_HEAD +  `
@group(0) @binding(1) var<storage, read> srcA: array<u32>;
@group(0) @binding(2) var<storage, read> srcB: array<u32>;
@group(0) @binding(3) var<storage, read_write> outA: array<i32>;
@group(0) @binding(4) var<storage, read_write> outB: array<i32>;
@group(0) @binding(5) var<storage, read> T: array<i32>;
var<private> MIX: array<i32, 9> = array<i32, 9>(${Array.from(S2C_MIX).join(', ')});
fn cbrt(v: i32) -> i32 { if (v < 65536i) { return T[256 + v]; } return T[${GSC_HI} + Ri(v, 4u)]; }
fn rgb(k: u32, b: bool) -> vec3i {
  if (u.mode == 1u) { let v = select(srcA[k], srcB[k], b); return vec3i(T[v & 255u], T[(v >> 8u) & 255u], T[(v >> 16u) & 255u]); }
  let n = u.w * u.h;
  if (b) { return vec3i(i32(srcB[k]), i32(srcB[n + k]), i32(srcB[2u * n + k])); }
  return vec3i(i32(srcA[k]), i32(srcA[n + k]), i32(srcA[2u * n + k]));
}
fn value(v: vec3i) -> i32 {
  let r = v.x; let g = v.y; let b = v.z;
  let l = cbrt(Ri(MIX[0] * r + MIX[1] * g + MIX[2] * b, 9u) + ${IS_BIAS}i) - ${BLACK}i;
  let m = cbrt(Ri(MIX[3] * r + MIX[4] * g + MIX[5] * b, 9u) + ${IS_BIAS}i) - ${BLACK}i;
  if (u.c == 0u) { return Ri(7i * (l - m) + 440402i, 8u); }
  if (u.c == 1u) { return Ri(l + m + 20972i, 9u); }
  let s = cbrt(Ri(MIX[6] * r + MIX[7] * g + MIX[8] * b, 9u) + ${IS_BIAS}i) - ${BLACK}i;
  return Ri(2i * s - (l + m) + 1153434i, 9u);
}
@compute @workgroup_size(${GSC_WG}) fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nw: vec3u, @builtin(local_invocation_index) l: u32) {
  let i = flat(wg, nw, l);
  if (i >= (u.ye - u.ys) * u.w) { return; }
  let k = u.ys * u.w + i;
  outA[i] = value(rgb(k, false)); outB[i] = value(rgb(k, true));
}`,
  rows: GSC_HEAD +  `
@group(0) @binding(1) var<storage, read> PA: array<i32>;
@group(0) @binding(2) var<storage, read> PB: array<i32>;
@group(0) @binding(3) var<storage, read_write> Q: array<i32>;
@compute @workgroup_size(${GSC_WG}) fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nw: vec3u, @builtin(local_invocation_index) l: u32) {
  let i = flat(wg, nw, l);
  if (i >= (u.ye - u.ys) * u.w) { return; }
  let x = i32(i % u.w); let base = i - u32(x); let w = i32(u.w);
  let k0 = select(0i, 4i - x, x < 4i); let k1 = select(8i, 4i + w - 1i - x, x + 4i >= w);
  var m1 = 0i; var m2 = 0i; var s11 = vec2u(0u); var s22 = vec2u(0u); var s12 = vec2u(0u);
  for (var k = k0; k <= k1; k++) {
    let t = TAPS[k]; let o = base + u32(x + k - 4i); let p = PA[o]; let q = PB[o];
    m1 += t * p; m2 += t * q;
    s11 = add64(s11, mulS64(p * p, u32(t))); s22 = add64(s22, mulS64(q * q, u32(t))); s12 = add64(s12, mulS64(p * q, u32(t)));
  }
  Q[i] = Ri(m1, 16u); Q[u.plane + i] = Ri(m2, 16u);
  Q[2u * u.plane + i] = round64(s11, 16u); Q[3u * u.plane + i] = round64(s22, 16u); Q[4u * u.plane + i] = round64(s12, 16u);
}`,
  cells: GSC_HEAD +  `
@group(0) @binding(1) var<storage, read> PA: array<i32>;
@group(0) @binding(2) var<storage, read> PB: array<i32>;
@group(0) @binding(3) var<storage, read> Q: array<i32>;
@group(0) @binding(4) var<storage, read_write> out: array<u32>;
fn fourth(v: u32) -> vec2u { let q = shr64u(add64(mul64(v, v), vec2u(128u, 0u)), 8u).x; return mul64(q, q); }
@compute @workgroup_size(${GSC_WG}) fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nw: vec3u, @builtin(local_invocation_index) l: u32) {
  let i = flat(wg, nw, l);
  if (i >= u.count) { return; }
  let side = 1u << u.sh; let cx = i % u.cw; let cy = (u.y0 >> u.sh) + i / u.cw;
  var se = 0u; var sa = 0u; var sl = 0u; var fe = vec2u(0u); var fa = vec2u(0u); var fl = vec2u(0u);
  let h = i32(u.h);
  for (var y = cy * side; y < min(u.h, (cy + 1u) * side); y++) {
    for (var x = cx * side; x < min(u.w, (cx + 1u) * side); x++) {
      var m1 = 0i; var m2 = 0i; var s11 = vec2u(0u); var s22 = vec2u(0u); var s12 = vec2u(0u);
      for (var k = 0i; k < 9i; k++) {
        let yy = i32(y) + k - 4i;
        if (yy < 0i || yy >= h) { continue; }
        let t = TAPS[k]; let o = (u32(yy) - u.ys) * u.w + x;
        m1 += t * Q[o]; m2 += t * Q[u.plane + o];
        s11 = add64(s11, mulS64(Q[2u * u.plane + o], u32(t))); s22 = add64(s22, mulS64(Q[3u * u.plane + o], u32(t)));
        s12 = add64(s12, mulS64(Q[4u * u.plane + o], u32(t)));
      }
      let mu1 = Ri(m1, 16u); let mu2 = Ri(m2, 16u);
      let v1 = round64(s11, 16u) - mu1 * mu1; let v2 = round64(s22, 16u) - mu2 * mu2; let cov = round64(s12, 16u) - mu1 * mu2;
      let sv = v1 + v2; let lift = select(0i, -sv, sv < 0i);
      let numS = 2i * cov + 15099i + lift; let denS = u32(sv + lift + 15099i);
      let ratio = i32(min(65536u, udiv64by32(add64(mul64(u32(abs(numS)), 65536u), vec2u(denS >> 1u, 0u)), denS)));
      let r = select(ratio, -ratio, numS < 0i);
      let d = mu1 - mu2; let numM = 16777216i - d * d;
      let e = u32(clamp(65536i - round64(mulSS64(numM, r), 24u), 0i, 131071i));
      let o = (y - u.ys) * u.w + x;
      let num = u32(4096i + abs(PB[o] - mu2)); let den = u32(4096i + abs(PA[o] - mu1));
      let dd = i32((num * 65536u + (den >> 1u)) / den) - 65536i;
      let art = u32(clamp(dd, 0i, 131071i)); let lost = u32(max(0i, -dd));
      se += e; sa += art; sl += lost;
      fe = add64(fe, fourth(e)); fa = add64(fa, fourth(art)); fl = add64(fl, fourth(lost));
    }
  }
  let at = cy * u.cstride + cx; let n = u.n;
  out[at] = se; out[n + at] = sa; out[2u * n + at] = sl;
  out[3u * n + 2u * at] = fe.x; out[3u * n + 2u * at + 1u] = fe.y;
  out[5u * n + 2u * at] = fa.x; out[5u * n + 2u * at + 1u] = fa.y;
  out[7u * n + 2u * at] = fl.x; out[7u * n + 2u * at + 1u] = fl.y;
}`,
};

const gscCompiled = new WeakMap();
function gscPipelines(device) {
  let made = gscCompiled.get(device);
  if (!made) gscCompiled.set(device, made = Object.fromEntries(Object.entries(GSC_SHADERS).map(([name, code]) =>
    [name, device.createComputePipeline({layout: 'auto', compute: {module: device.createShaderModule({code}), entryPoint: 'main'}})])));
  return made;
}

export async function gpuS2Cells(device, {reference, decoded, width, height}) {
  const limit = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize);
  const scales = s2cScales(width, height), stride = Math.ceil(width / 8), rows = Math.ceil(height / 8);
  if (!scales.length || width * height * 4 > limit || 9 * stride * rows * 4 > limit) return null;
  const buffers = [], usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
  const buffer = (bytes, use = usage) => { const b = device.createBuffer({size: Math.max(16, Math.ceil(bytes / 16) * 16), usage: use}); buffers.push(b); return b; };
  device.pushErrorScope('out-of-memory'); device.pushErrorScope('validation');
  let remaining = 2;
  try {
    const pipelines = gscPipelines(device);
    const table = new Int32Array(GSC_HI + IS_CBRT_HI.length);
    table.set(S2C_LIN); table.set(IS_CBRT_LO, 256); table.set(IS_CBRT_HI, GSC_HI);
    const T = buffer(table.byteLength); device.queue.writeBuffer(T, 0, table);
    const upload = rgba => { const b = buffer(width * height * 4); device.queue.writeBuffer(b, 0, rgba.buffer, rgba.byteOffset, width * height * 4); return b; };
    let A = upload(reference), B = upload(decoded), mode = 1;
    const maxW = scales[0].w, bandRows = Math.min(GSC_BAND, scales[0].h) + 2 * GSC_HALO, plane = bandRows * maxW;
    const PA = buffer(plane * 4), PB = buffer(plane * 4), Q = buffer(5 * plane * 4);
    const run = (pass, name, threads, bound, params) => {
      const uv = new Uint32Array(16);
      for (const [j, key] of ['w', 'h', 'pw', 'ph', 'y0', 'y1', 'ys', 'ye', 'c', 'sh', 'cstride', 'n', 'mode', 'count', 'plane', 'cw'].entries()) uv[j] = params[key] ?? 0;
      const ub = buffer(64, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST); device.queue.writeBuffer(ub, 0, uv);
      const p = pipelines[name];
      pass.setPipeline(p);
      pass.setBindGroup(0, device.createBindGroup({layout: p.getBindGroupLayout(0), entries: [ub, ...bound].map((b, binding) => ({binding, resource: {buffer: b}}))}));
      const groups = Math.ceil(threads / GSC_WG);
      pass.dispatchWorkgroups(Math.min(groups, 65535), Math.ceil(groups / 65535));
    };
    const out = [], reads = [], done = [];
    for (const [s, {w, h}] of scales.entries()) {
      const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
      if (s) {
        const p = scales[s - 1], nextA = buffer(3 * w * h * 4), nextB = buffer(3 * w * h * 4);
        run(pass, 'down', w * h, [A, nextA, T], {w, h, pw: p.w, ph: p.h, mode});
        run(pass, 'down', w * h, [B, nextB, T], {w, h, pw: p.w, ph: p.h, mode});
        done.push(A, B); A = nextA; B = nextB; mode = 0;
      }
      const cells = s <= 3, sh = cells ? 3 - s : 0, cstride = cells ? stride : w, n = cells ? stride * rows : w * h, sums = [];
      const cw = cells ? Math.ceil(w / (1 << sh)) : w;
      for (let c = 0; c < 3; c++) {
        const active = [];
        for (let t = 0; t < 3; t++) for (const p of [1, 4]) {
          const k = c * scales.length * 6 + s * 6 + t + (p === 4 ? 3 : 0);
          if (SSIMULACRA2_WEIGHTS[k]) active.push({k, c, t, p});
        }
        if (!active.length) continue;
        const sumsBuffer = buffer(9 * n * 4);
        for (let y0 = 0; y0 < h; y0 += GSC_BAND) {
          const y1 = Math.min(h, y0 + GSC_BAND), ys = Math.max(0, y0 - GSC_HALO), ye = Math.min(h, y1 + GSC_HALO);
          const at = {w, h, y0, y1, ys, ye, c, sh, cstride, n, mode, plane};
          run(pass, 'xyb', (ye - ys) * w, [A, B, PA, PB, T], at);
          run(pass, 'rows', (ye - ys) * w, [PA, PB, Q], at);
          const count = ((y1 + (1 << sh) - 1 >> sh) - (y0 >> sh)) * cw;
          run(pass, 'cells', count, [PA, PB, Q, sumsBuffer], {...at, count, cw});
        }
        const read = buffer(9 * n * 4, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
        reads.push({read, from: sumsBuffer, n, active, bytes: 9 * n * 4, encoder});
        sums.push(...active);
      }
      pass.end();
      for (const r of reads) if (r.encoder === encoder) encoder.copyBufferToBuffer(r.from, 0, r.read, 0, r.bytes);
      device.queue.submit([encoder.finish()]);
      for (const b of done) b.destroy();
      done.length = 0;
      out.push({w, h, sums});
    }
    remaining--; const validation = await device.popErrorScope();
    remaining--; const memory = await device.popErrorScope();
    if (validation || memory) return null;
    for (const {read, n, active} of reads) {
      await read.mapAsync(GPUMapMode.READ);
      const all = new Uint32Array(read.getMappedRange().slice(0));
      read.unmap();
      for (const term of active) term.sum = term.p === 1 ? all.slice(term.t * n, (term.t + 1) * n) : all.slice(3 * n + term.t * 2 * n, 3 * n + (term.t + 1) * 2 * n);
    }
    return {scales: out, stride, rows};
  } finally {
    while (remaining-- > 0) await device.popErrorScope().catch(() => null);
    for (const b of buffers) b.destroy();
  }
}
