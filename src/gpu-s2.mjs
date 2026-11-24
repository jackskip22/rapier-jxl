// SPDX-License-Identifier: MIT
import {GC_DS} from './gpu-arithmetic.mjs';
import {S2_GROUPS} from './gpu-s2-score.mjs';
import {gpuMap, gpuFloat as K, gpuDestroy, gpuComputeSet, gpuScoped, gpuWrite, gpuAlloc, gpuUpload, gpuUni, gpuBind, gpuStep} from './gpu-kit.mjs';


export const XFMA = `
fn away(r: f32) -> f32 { return bitcast<f32>(bitcast<u32>(r) + 1u); }
fn toward(r: f32) -> f32 { return bitcast<f32>(bitcast<u32>(r) - 1u); }
fn settle(r: f32, q: f32, t: f32) -> vec2f {
  let ar = abs(r);
  if (!(ar >= 1.0e-36 && ar <= 1.0e37)) { return vec2f(r, 1.0); }
  let sR = sign(gcO(q + t));
  if (sR == 0.0) { return vec2f(r, 0.0); }
  let outward = sR == sign(r); let bits = bitcast<u32>(ar);
  var h = bitcast<f32>(bits & 0x7f800000u) * 5.9604644775390625e-8;
  if (!outward && (bits & 0x007fffffu) == 0u) { h = h * 0.5; }
  if (abs(q) < 0.5 * h) { return vec2f(r, 0.0); }
  let s3 = sR * sign(gcO(gcO(q - sR * h) + t));
  if (s3 < 0.0) { return vec2f(r, 0.0); }
  let n = select(toward(r), away(r), outward);
  if (s3 > 0.0) { return vec2f(n, 0.0); }
  return vec2f(select(n, r, (bits & 1u) == 0u), 0.0);
}
fn xfma(a: f32, b: f32, c: f32) -> vec2f {
  // A product under TwoProd's exact range: alone (c zero), the binary32 product while normal; under a quarter of c's
  // lower spacing (bounded by the least normal where it may be flushed), c.
  let pr = gcO(a * b);
  if (abs(pr) < 1.0e-30 && a != 0.0 && b != 0.0) {
    if (c == 0.0 && abs(pr) >= 1.0e-37) { return vec2f(pr, 0.0); }
    // Below the normal range otherwise (.y 2): the exact result is at most 2^-126, which the device may not hold.
    if (c == 0.0 && abs(pr) < 1.1754943508222875e-38) { return vec2f(0.0, 2.0); }
    if (abs(c) >= 1.0e-28 && abs(c) <= 1.0e37 && max(abs(pr), 1.2e-38) <= gcO(abs(c) * 7.450580596923828e-9)) { return vec2f(c, 0.0); }
    return vec2f(pr + c, 1.0);
  }
  let p = tp(a, b); let s = ts(p.x, c);
  let asx = abs(s.x);
  if (asx >= 1.0e-36 && asx <= 1.0e37) {
    let rem = abs(s.y) + abs(p.y);
    let u = bitcast<f32>(bitcast<u32>(asx) & 0x7f800000u) * 1.4901161193847656e-8;
    if (rem < u) { return vec2f(s.x, 0.0); }
  }
  let t = ts(s.y, p.y); let q = ts(s.x, t.x);
  if (q.x == 0.0) { return vec2f(q.x, select(0.0, 1.0, q.y != 0.0 || t.y != 0.0)); }
  return settle(q.x, q.y, t.y);
}
// The binary32 square root, correctly rounded (.y 1: not certified).
fn xsqrt(v: f32) -> vec2f {
  var r = sqrt(v);
  for (var k = i32(gcOne() < 0.0); k < 3; k++) {
    let p = tp(r, r); let e = ts(v, -p.x); let rem = gcO(e.x + gcO(e.y - p.y));
    if (rem == 0.0) { return vec2f(r, 0.0); }
    let bits = bitcast<u32>(r);
    var h = bitcast<f32>(bits & 0x7f800000u) * 5.9604644775390625e-8;
    if (rem < 0.0 && (bits & 0x007fffffu) == 0u) { h = h * 0.5; }
    let twoRH = gcO(2.0 * r * select(-h, h, rem > 0.0));
    let d = ts(e.x, -twoRH); let g = gcO(d.x + gcO(d.y + gcO(e.y - gcO(p.y + h * h))));
    if (select((g > 0.0), (g < 0.0), (rem > 0.0))) { return vec2f(r, 0.0); }
    r = select(toward(r), away(r), rem > 0.0);
  }
  return vec2f(r, 1.0);
}
fn xdiv(a: f32, b: f32) -> vec2f {
  var q = gcO(a / b);
  let aq0 = abs(q); let ab0 = abs(b);
  if (!(aq0 >= 1.0e-36 && aq0 <= 1.0e37) || !(ab0 >= 1.0e-30 && ab0 <= 1.0e30)) { return vec2f(q, 1.0); }
  {
    let p0 = tp(q, b); let e0 = ts(a, -p0.x);
    let quarterUlpB = gcO((bitcast<f32>(bitcast<u32>(aq0) & 0x7f800000u) * 1.4901161193847656e-8) * ab0);
    if (abs(e0.x) + abs(e0.y) + abs(p0.y) < quarterUlpB) { return vec2f(q, 0.0); }
  }
  for (var k = i32(gcOne() < 0.0); k < 4; k++) {
    let p = tp(q, b); let e = ts(a, -p.x); let f = ts(e.y, -p.y); let g = ts(e.x, f.x);
    let ar = abs(q); let bits = bitcast<u32>(ar); let sR = sign(gcO(g.x + gcO(g.y + f.y))) * sign(b);
    if (sR == 0.0) { return vec2f(q, 0.0); }
    let outward = sR == sign(q);
    var h = bitcast<f32>(bits & 0x7f800000u) * 5.9604644775390625e-8;
    if (!outward && (bits & 0x007fffffu) == 0u) { h = h * 0.5; }
    let hb = gcO(h * abs(b));
    let mag = sign(g.x) * sign(b) * sR;
    let d = gcO(abs(g.x) - hb); let s3 = sign(gcO(d + mag * gcO(g.y + f.y)));
    if (s3 < 0.0) { return vec2f(q, 0.0); }
    let n = select(toward(q), away(q), outward);
    if (s3 == 0.0) { return vec2f(select(n, q, (bits & 1u) == 0u), 0.0); }
    q = n;
  }
  return vec2f(q, 1.0);
}`;

const WG = 64;
const VB = 64;
const haloFloats = (w, h) => (Math.ceil(h / VB) - 1) * 40 * w;

export const S2_SHADER = `${GC_DS}
${XFMA}
struct U { one: f32, w: u32, h: u32, n: u32, w2: u32, h2: u32, n2: u32, c: u32, slot: u32, rof: u32, dof: u32, tot: u32,
  oy0: u32, oy1: u32, gofs: u32, H: u32, mode: u32, acc: u32, ny0: u32, wy0: u32 }
@group(0) @binding(0) var<uniform> P: U;
@group(0) @binding(1) var<storage, read> I: array<u32>;
@group(0) @binding(2) var<storage, read_write> A: array<f32>;
@group(0) @binding(3) var<storage, read_write> B: array<f32>;
@group(0) @binding(4) var<storage, read_write> L: array<f32>;
@group(0) @binding(5) var<storage, read_write> N: array<f32>;
@group(0) @binding(6) var<storage, read_write> S: array<vec2f>;
@group(0) @binding(7) var<storage, read_write> F: array<atomic<u32>>;
fn gcOne() -> f32 { return P.one; }
fn bad() { atomicAdd(&F[0], 1u); }
// The meter's fused step as the CPU makes it: binary32 mul then add, each correctly rounded (gcO keeps the compiler from
// contracting them). A product or sum the device may have flushed (a subnormal, or zero from nonzero parts) is counted.
fn fm(a: f32, b: f32, c: f32) -> f32 {
  let p = gcO(a * b);
  if ((p == 0.0 && a != 0.0 && b != 0.0) || (p != 0.0 && abs(p) < 1.1754943508222875e-38)) { bad(); }
  let s = gcO(p + c);
  if ((s == 0.0 && p != -c) || (s != 0.0 && abs(s) < 1.1754943508222875e-38)) { bad(); }
  return s;
}
// A device that flushes a subnormal result is not the CPU: a nonzero value under binary32's least normal is counted.
fn chk(v: f32) -> f32 { if (v != 0.0 && abs(v) < 1.1754943508222875e-38) { bad(); } return v; }
// a / b exactly rounded; a zero numerator (identical pixels) is exactly 0.
fn qdiv(a: f32, b: f32) -> vec2f { if (a == 0.0) { return vec2f(0.0, 0.0); } return xdiv(a, b); }
fn G(i: u32) -> f32 { return bitcast<f32>(I[256u + i]); }
fn lut(v: u32) -> f32 { return bitcast<f32>(I[v]); }
fn idx(id: vec3u, nw: vec3u) -> u32 { return id.x + id.y * nw.x * ${WG}u; }

// Scale 0: the lookup table's linear samples (mode & 4: reference only into A; mode & 8: distorted only into B; else both).
@compute @workgroup_size(${WG})
fn lin0(@builtin(global_invocation_id) id: vec3u, @builtin(num_workgroups) nw: vec3u) {
  let i = idx(id, nw); if (i >= P.n) { return; }
  if ((P.mode & 8u) == 0u) { let r = I[P.rof + i]; for (var c = 0u; c < 3u; c++) { A[c * P.n + i] = lut((r >> (8u * c)) & 255u); } }
  if ((P.mode & 4u) == 0u) { let d = I[P.dof + i]; for (var c = 0u; c < 3u; c++) { B[c * P.n + i] = lut((d >> (8u * c)) & 255u); } }
}
// The next scale's planes (mode & 4: reference only into N[0..3*n2); mode & 8: distorted only into N[0..3*n2); else both).
@compute @workgroup_size(${WG})
fn down(@builtin(global_invocation_id) id: vec3u, @builtin(num_workgroups) nw: vec3u) {
  let j = idx(id, nw); if (j >= P.n2) { return; }
  let x = j % P.w2; let y = P.ny0 + j / P.w2;
  let r0 = (2u * y - P.wy0) * P.w; let r1 = (min(2u * y + 1u, P.H - 1u) - P.wy0) * P.w; let x0 = 2u * x; let x1 = min(x0 + 1u, P.w - 1u);
  if ((P.mode & 8u) == 0u) {
    for (var c = 0u; c < 3u; c++) {
      let o = c * P.n;
      N[c * P.n2 + j] = gcO(gcO(gcO(gcO(A[o + r0 + x0] + A[o + r0 + x1]) + A[o + r1 + x0]) + A[o + r1 + x1]) * 0.25);
    }
  }
  if ((P.mode & 4u) == 0u) {
    let baseN = select(3u * P.n2, 0u, (P.mode & 8u) != 0u);
    for (var c = 0u; c < 3u; c++) {
      let o = c * P.n;
      N[baseN + c * P.n2 + j] = gcO(gcO(gcO(gcO(B[o + r0 + x0] + B[o + r0 + x1]) + B[o + r1 + x0]) + B[o + r1 + x1]) * 0.25);
    }
  }
}
fn cbr(x: f32) -> f32 {
  let u = bitcast<u32>(x);
  var r = bitcast<f32>(select(0x54800000u - (u >> 23u) * 0x002aaaaau, 0u, u == 0u));
  let third = ${K(1 / 3)}; let x3 = gcO(third * x);
  for (var i = i32(gcOne() < 0.0); i < 3; i++) { let r2 = gcO(r * r); r = fm(-x3, gcO(r2 * r2), gcO(${K(4 / 3)} * r)); }
  var r2 = gcO(r * r);
  r = fm(third, fm(-x, gcO(r2 * r2), r), r);
  r2 = gcO(r * r);
  return fm(r2, x, ${K(-0.15595419704914093)});
}
fn pv(x: f32) -> f32 { return select(x, 0.0, x <= 0.0); }
fn xyb(r: f32, g: f32, b: f32) -> vec3f {
  let bias = ${K('.0037930732552754493')};
  var l = 0.0; var m = 0.0; var s = 0.0;
  for (var q = u32(gcOne() < 0.0); q < 3u; q++) {
    let w0 = select(select(${K('.24342268924547819')}, ${K('.23')}, q == 1u), ${K('.30')}, q == 0u);
    let w1 = select(select(${K('.20476744424496821')}, ${K('.692')}, q == 1u), ${K('.622')}, q == 0u);
    let w2 = select(${K('.5518098665095536')}, ${K('.078')}, q < 2u);
    let v = cbr(pv(fm(w0, r, fm(w1, g, fm(w2, b, bias)))));
    if (q == 0u) { l = v; } else if (q == 1u) { m = v; } else { s = v; }
  }
  let x = gcO(0.5 * gcO(l - m)); let y = gcO(0.5 * gcO(l + m));
  return vec3f(gcO(gcO(x * 14.0) + ${K('.42')}), gcO(y + ${K('.01')}), gcO(gcO(s - y) + ${K('.55')}));
}
// XYB in place (mode & 4: reference into B[rof..rof+3n); mode & 8: distorted B in place; else both A and B in place).
@compute @workgroup_size(${WG})
fn positive(@builtin(global_invocation_id) id: vec3u, @builtin(num_workgroups) nw: vec3u) {
  let i = idx(id, nw); if (i >= P.n) { return; }
  for (var side = u32(gcOne() < 0.0); side < 2u; side++) {
    if (side == 0u && (P.mode & 8u) != 0u) { continue; }
    if (side == 1u && (P.mode & 4u) != 0u) { continue; }
    let r = select(B[i], A[i], side == 0u);
    let g = select(B[P.n + i], A[P.n + i], side == 0u);
    let b = select(B[2u * P.n + i], A[2u * P.n + i], side == 0u);
    let v = xyb(r, g, b);
    if (side == 0u && (P.mode & 4u) == 0u) { A[i] = v.x; A[P.n + i] = v.y; A[2u * P.n + i] = v.z; }
    else { let base = select(0u, P.rof, side == 0u); B[base + i] = v.x; B[base + P.n + i] = v.y; B[base + 2u * P.n + i] = v.z; }
  }
}
fn tap(k: u32) -> f32 { return G(k); }
fn refAt(i: u32) -> f32 { return A[P.rof + P.c * P.n + i]; }
fn input(k: u32, y: u32, x: i32) -> f32 {
  if (x < 0 || x >= i32(P.w)) { return 0.0; }
  let i = y * P.w + u32(x); let a = refAt(i); let d = gcO(a - B[P.c * P.n + i]);
  switch k { case 1u: { return d; } case 3u: { return gcO(d * d); } default: { return gcO(gcO(a - 0.5) * d); } }
}
fn refx(y: u32, x: i32) -> f32 { if (x < 0 || x >= i32(P.w)) { return 0.0; } return refAt(y * P.w + u32(x)); }
@compute @workgroup_size(${WG})
fn hblur(@builtin(global_invocation_id) id: vec3u, @builtin(num_workgroups) nw: vec3u) {
  let refOnly = (P.mode & 4u) != 0u; let distOnly = (P.mode & 8u) != 0u;
  let planes = select(select(4u, 1u, refOnly), 3u, distOnly);
  let t = idx(id, nw); if (t >= P.n * planes) { return; }
  let q = t / P.n;
  let k = select(select(q, q + 1u, q >= 2u), select(1u, q + 2u, q >= 1u), distOnly);
  let p = t % P.n; let y = p / P.w; let x = i32(p % P.w); let row = y * P.w;
  if (k == 0u) {
    let a = refx(y, x); var s1 = 0.0; var s2 = 0.0;
    let g0 = tap(0u); let g1 = tap(1u); let g2 = tap(2u); let g3 = tap(3u);
    let l4 = gcO(refx(y, x - 4) - a); let r4 = gcO(refx(y, x + 4) - a); s1 = gcO(s1 + gcO(g0 * gcO(l4 + r4))); s2 = gcO(s2 + gcO(g0 * gcO(gcO(l4 * l4) + gcO(r4 * r4))));
    let l3 = gcO(refx(y, x - 3) - a); let r3 = gcO(refx(y, x + 3) - a); s1 = gcO(s1 + gcO(g1 * gcO(l3 + r3))); s2 = gcO(s2 + gcO(g1 * gcO(gcO(l3 * l3) + gcO(r3 * r3))));
    let l2 = gcO(refx(y, x - 2) - a); let r2 = gcO(refx(y, x + 2) - a); s1 = gcO(s1 + gcO(g2 * gcO(l2 + r2))); s2 = gcO(s2 + gcO(g2 * gcO(gcO(l2 * l2) + gcO(r2 * r2))));
    let l1 = gcO(refx(y, x - 1) - a); let r1 = gcO(refx(y, x + 1) - a); s1 = gcO(s1 + gcO(g3 * gcO(l1 + r1))); s2 = gcO(s2 + gcO(g3 * gcO(gcO(l1 * l1) + gcO(r1 * r1))));
    let v = gcO(s2 - gcO(s1 * s1));
    L[row + u32(x)] = chk(gcO(a + s1)); L[2u * P.n + row + u32(x)] = chk(select(v, 0.0, v <= 0.0));
  } else {
    var s = gcO(tap(0u) * gcO(input(k, y, x - 4) + input(k, y, x + 4)));
    s = gcO(s + gcO(tap(1u) * gcO(input(k, y, x - 3) + input(k, y, x + 3))));
    s = gcO(s + gcO(tap(2u) * gcO(input(k, y, x - 2) + input(k, y, x + 2))));
    s = gcO(s + gcO(tap(3u) * gcO(input(k, y, x - 1) + input(k, y, x + 1))));
    L[k * P.n + row + u32(x)] = chk(gcO(s + gcO(tap(4u) * input(k, y, x))));
  }
}
fn hrow(j: u32, r: u32, p: u32) -> u32 { return 5u * P.n + ((j * 8u + r) * 5u + p) * P.w; }
@compute @workgroup_size(${WG})
fn halo(@builtin(global_invocation_id) id: vec3u, @builtin(num_workgroups) nw: vec3u) {
  let nb = (P.oy1 - P.oy0 + ${VB - 1}u) / ${VB}u - 1u;
  let t = idx(id, nw); if (t >= nb * 40u * P.w) { return; }
  let x = t % P.w; let q = t / P.w; let p = q % 5u; let r = (q / 5u) % 8u; let j = q / 40u;
  if (((P.mode & 4u) != 0u && (p != 0u && p != 2u)) || ((P.mode & 8u) != 0u && (p == 0u || p == 2u))) { return; }
  let src = P.oy0 + (j + 1u) * ${VB}u + r - 4u;
  if (src < P.h) { L[hrow(j, r, p) + x] = L[p * P.n + src * P.w + x]; }
}
fn vrow(p: u32, r: i32, y0: i32, y1: i32, band: u32, x: u32) -> f32 {
  if (r < 0 || r >= i32(P.h)) { return 0.0; }
  if (r < y0 && band > 0u) { return L[hrow(band - 1u, u32(r - y0 + 4), p) + x]; }
  if (r >= y1 && y1 < i32(P.oy1)) { return L[hrow(band, u32(r - y1 + 4), p) + x]; }
  return L[p * P.n + u32(r) * P.w + x];
}
// Scalar 9-tap vertical FIR: zero private arrays, zero dynamic indexing, zero Mali TLS register spilling.
@compute @workgroup_size(${WG})
fn vblur(@builtin(global_invocation_id) id: vec3u, @builtin(num_workgroups) nw: vec3u) {
  let refOnly = (P.mode & 4u) != 0u; let distOnly = (P.mode & 8u) != 0u;
  let planes = select(select(4u, 1u, refOnly), 3u, distOnly);
  let bands = (P.oy1 - P.oy0 + ${VB - 1}u) / ${VB}u;
  let t = idx(id, nw); if (t >= P.w * planes * bands) { return; }
  let x = t % P.w; let q = (t / P.w) % planes;
  let k = select(select(q, q + 1u, q >= 2u), select(1u, q + 2u, q >= 1u), distOnly);
  let band = t / (P.w * planes);
  let y0 = i32(P.oy0 + band * ${VB}u); let y1 = min(i32(P.oy1), y0 + ${VB});
  let g0 = tap(0u); let g1 = tap(1u); let g2 = tap(2u); let g3 = tap(3u); let g4 = tap(4u);
  var u1 = vrow(k, y0 - 4, y0, y1, band, x); var u2 = vrow(k, y0 - 3, y0, y1, band, x);
  var u3 = vrow(k, y0 - 2, y0, y1, band, x); var u4 = vrow(k, y0 - 1, y0, y1, band, x);
  var u5 = vrow(k, y0, y0, y1, band, x);     var u6 = vrow(k, y0 + 1, y0, y1, band, x);
  var u7 = vrow(k, y0 + 2, y0, y1, band, x); var u8 = vrow(k, y0 + 3, y0, y1, band, x);
  if (k == 0u) {
    let outM = select(0u, P.dof, refOnly); let outV = select(2u * P.n, P.dof + P.n, refOnly);
    var v1 = vrow(2u, y0 - 4, y0, y1, band, x); var v2 = vrow(2u, y0 - 3, y0, y1, band, x);
    var v3 = vrow(2u, y0 - 2, y0, y1, band, x); var v4 = vrow(2u, y0 - 1, y0, y1, band, x);
    var v5 = vrow(2u, y0, y0, y1, band, x);     var v6 = vrow(2u, y0 + 1, y0, y1, band, x);
    var v7 = vrow(2u, y0 + 2, y0, y1, band, x); var v8 = vrow(2u, y0 + 3, y0, y1, band, x);
    for (var y = y0; y < y1; y++) {
      let u0 = u1; u1 = u2; u2 = u3; u3 = u4; u4 = u5; u5 = u6; u6 = u7; u7 = u8; u8 = vrow(k, y + 4, y0, y1, band, x);
      let v0 = v1; v1 = v2; v2 = v3; v3 = v4; v4 = v5; v5 = v6; v6 = v7; v7 = v8; v8 = vrow(2u, y + 4, y0, y1, band, x);
      var sp = gcO(g0 * gcO(v0 + v8));
      sp = gcO(sp + gcO(g1 * gcO(v1 + v7))); sp = gcO(sp + gcO(g2 * gcO(v2 + v6))); sp = gcO(sp + gcO(g3 * gcO(v3 + v5)));
      sp = gcO(sp + gcO(g4 * v4));
      let b = u4; var s1 = 0.0; var s2 = 0.0;
      let l4 = gcO(u0 - b); let r4 = gcO(u8 - b); s1 = gcO(s1 + gcO(g0 * gcO(l4 + r4))); s2 = gcO(s2 + gcO(g0 * gcO(gcO(l4 * l4) + gcO(r4 * r4))));
      let l3 = gcO(u1 - b); let r3 = gcO(u7 - b); s1 = gcO(s1 + gcO(g1 * gcO(l3 + r3))); s2 = gcO(s2 + gcO(g1 * gcO(gcO(l3 * l3) + gcO(r3 * r3))));
      let l2 = gcO(u2 - b); let r2 = gcO(u6 - b); s1 = gcO(s1 + gcO(g2 * gcO(l2 + r2))); s2 = gcO(s2 + gcO(g2 * gcO(gcO(l2 * l2) + gcO(r2 * r2))));
      let l1 = gcO(u3 - b); let r1 = gcO(u5 - b); s1 = gcO(s1 + gcO(g3 * gcO(l1 + r1))); s2 = gcO(s2 + gcO(g3 * gcO(gcO(l1 * l1) + gcO(r1 * r1))));
      var d = gcO(s2 - gcO(s1 * s1)); d = select(d, 0.0, d <= 0.0);
      let tv = gcO(sp + d); let at = u32(y) * P.w + x;
      if (refOnly) { N[outM + at] = chk(gcO(b + s1)); N[outV + at] = chk(select(tv, 0.0, tv <= 0.0)); }
      else { L[outM + at] = chk(gcO(b + s1)); L[outV + at] = chk(select(tv, 0.0, tv <= 0.0)); }
    }
  } else {
    let base = k * P.n + x;
    for (var y = y0; y < y1; y++) {
      let u0 = u1; u1 = u2; u2 = u3; u3 = u4; u4 = u5; u5 = u6; u6 = u7; u7 = u8; u8 = vrow(k, y + 4, y0, y1, band, x);
      var s = gcO(g0 * gcO(u0 + u8));
      s = gcO(s + gcO(g1 * gcO(u1 + u7))); s = gcO(s + gcO(g2 * gcO(u2 + u6))); s = gcO(s + gcO(g3 * gcO(u3 + u5)));
      L[base + u32(y) * P.w] = chk(gcO(s + gcO(g4 * u4)));
    }
  }
}
var<workgroup> R: array<vec2f, ${WG * 6}>;
// row_sums' six terms per pixel in double-single, each thread's share added in order, then the workgroup's.
@compute @workgroup_size(${WG})
fn sums(@builtin(local_invocation_id) lid: vec3u, @builtin(workgroup_id) wid: vec3u) {
  var acc = array<vec2f, 6>(vec2f(0.0), vec2f(0.0), vec2f(0.0), vec2f(0.0), vec2f(0.0), vec2f(0.0));
  let small = ${K('.0009')}; let z0 = u32(gcOne() < 0.0);
  let g = wid.x * ${WG}u + lid.x; let lo = P.gofs + P.oy0 * P.w; let hi = P.gofs + P.oy1 * P.w; let keep = P.acc + (P.c * ${S2_GROUPS * WG}u + g) * 6u;
  if ((P.mode & 1u) == 0u) { for (var k = 0u; k < 6u; k++) { acc[k] = S[keep + k]; } }
  for (var gi = lo + (g + ${S2_GROUPS * WG}u - lo % ${S2_GROUPS * WG}u) % ${S2_GROUPS * WG}u; gi < hi; gi += ${S2_GROUPS * WG}u) {
    let i = gi - P.gofs;
    let cachedRef = (P.mode & 8u) != 0u;
    let m1 = select(L[i], N[P.dof + i], cachedRef); let delta = L[P.n + i];
    let v11 = select(L[2u * P.n + i], N[P.dof + P.n + i], cachedRef);
    let gdd = L[3u * P.n + i]; let gxd = L[4u * P.n + i];
    let q1 = A[P.rof + P.c * P.n + i]; let d = gcO(q1 - B[P.c * P.n + i]);
    // row_sums: libjxl's 1 - SSIM and edge ratio through var(D) and cov(X, D), each division exactly rounded.
    let dd = gcO(delta * delta); let vd0 = gcO(gdd - dd); let vd = select(vd0, 0.0, vd0 <= 0.0);
    let cov = gcO(gxd - gcO(gcO(m1 - 0.5) * delta)); let nn = gcO(gcO(2.0 * gcO(v11 - cov)) + small);
    let q = qdiv(gcO(vd + gcO(dd * nn)), gcO(vd + nn)); if (q.y != 0.0 || chk(q.x) != q.x) { bad(); }
    let e = vec2f(select(q.x, 0.0, q.x <= 0.0), 0.0);
    let r1 = gcO(q1 - m1); let r2 = gcO(r1 - gcO(d - delta)); let ar = abs(r1);
    let ed = qdiv(gcO(abs(r2) - ar), gcO(1.0 + ar)); if (ed.y != 0.0 || chk(ed.x) != ed.x) { bad(); }
    let art = vec2f(select(ed.x, 0.0, ed.x <= 0.0), 0.0); let det = vec2f(select(-ed.x, 0.0, ed.x >= 0.0), 0.0);
    let e2 = dmul(e, e); let a2 = dmul(art, art); let l2 = dmul(det, det);
    acc[0] = dadd(acc[0], e); acc[1] = dadd(acc[1], dmul(e2, e2));
    acc[2] = dadd(acc[2], art); acc[3] = dadd(acc[3], dmul(a2, a2));
    acc[4] = dadd(acc[4], det); acc[5] = dadd(acc[5], dmul(l2, l2));
  }
  if ((P.mode & 2u) == 0u) { for (var k = 0u; k < 6u; k++) { S[keep + k] = acc[k]; } return; }
  for (var k = 0u; k < 6u; k++) { R[k * ${WG}u + lid.x] = acc[k]; }
  workgroupBarrier();
  for (var half = ${WG / 2}u; half > 0u; half >>= 1u) {
    if (lid.x < half) { for (var k = z0; k < 6u; k++) { R[k * ${WG}u + lid.x] = dadd(R[k * ${WG}u + lid.x], R[k * ${WG}u + lid.x + half]); } }
    workgroupBarrier();
  }
  if (lid.x < 6u) { S[(P.slot * 6u + lid.x) * ${S2_GROUPS}u + wid.x] = R[lid.x * ${WG}u]; }
}
// One slot's six totals from its workgroups' partial sums: 16 a thread in order, then by halves, into S from P.tot.
@compute @workgroup_size(${WG})
fn total(@builtin(local_invocation_id) lid: vec3u, @builtin(workgroup_id) wid: vec3u) {
  let slot = P.slot + wid.x; let z0 = u32(gcOne() < 0.0);
  for (var k = z0; k < 6u; k++) {
    var acc = vec2f(0.0);
    for (var j = z0; j < ${S2_GROUPS / WG}u; j++) { acc = dadd(acc, S[(slot * 6u + k) * ${S2_GROUPS}u + lid.x * ${S2_GROUPS / WG}u + j]); }
    R[k * ${WG}u + lid.x] = acc;
  }
  workgroupBarrier();
  for (var half = ${WG / 2}u; half > 0u; half >>= 1u) {
    if (lid.x < half) { for (var k = z0; k < 6u; k++) { R[k * ${WG}u + lid.x] = dadd(R[k * ${WG}u + lid.x], R[k * ${WG}u + lid.x + half]); } }
    workgroupBarrier();
  }
  if (lid.x < 6u) { S[P.tot + slot * 6u + lid.x] = R[lid.x * ${WG}u]; }
}`;


const SCALES = 6;
export function s2Sizes(width, height) {
  const out = [];
  let w = width, h = height;
  for (let s = 0; s < SCALES; s++) {
    if (w < 8 || h < 8) break;
    if (s) { w = (w + 1) >> 1; h = (h + 1) >> 1; }
    out.push({w, h});
  }
  return out;
}

const pipelines = device => gpuComputeSet(device, 's2', S2_SHADER, 'urssssss',
  ['lin0', 'down', 'positive', 'hblur', 'halo', 'vblur', 'sums', 'total']);
export const gpuS2Pipelines = device => pipelines(device);

const windowBytes = (w, out, hW, first, next) => {
  const n = w * hW;
  return [first ? (512 + 2 * n) * 4 : 0, 3 * n * 4, (5 * n + haloFloats(w, out)) * 4, next ? 6 * Math.ceil(out / 2) * next.w * 4 : 0];
};

function s2Bands({maxStorageBufferBindingSize: bind, maxBufferSize: most}, width, height) {
  const n = width * height, sizes = s2Sizes(width, height), limit = Math.min(bind, most);
  if ((5 * n + haloFloats(width, height)) * 4 <= bind && n * 12 + 2048 <= bind) return false;
  if (n * 4 > most) return null;
  const bands = [];
  for (const [s, {w, h}] of sizes.entries()) {
    const fits = out => windowBytes(w, out, Math.min(h, out + 8), !s, sizes[s + 1]).every(b => b <= limit);
    let rows = h;
    if (!fits(h)) {
      let lo = 1, hi = h >> 1;
      if (!fits(2)) return null;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (fits(2 * mid)) lo = mid; else hi = mid - 1; }
      rows = 2 * lo;
    }
    const list = [];
    for (let y = 0; y < h; y += rows) list.push([y, Math.min(h, y + rows)]);
    bands.push(list);
  }
  return bands;
}

function residentState(device, set, held, tables, reference, width, height, outputs, bands) {
  if (held.state) return held.state;
  const n = width * height, sizes = s2Sizes(width, height), n1 = sizes[1] ? sizes[1].w * sizes[1].h : 1, made = [], buf = gpuAlloc(device, made);
  const st = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
  const bindLimit = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize);
  const totalM = sizes.reduce((acc, {w, h}) => acc + w * h, 0);
  const cacheRef = !bands && 6 * totalM * 4 <= bindLimit;
  const slots = outputs * sizes.length * 3, tot = slots * 6 * S2_GROUPS, sBytes = slots * 6 * 8, acc = tot + slots * 6;
  let words = [512 + (1 + outputs) * n, 3 * n, 5 * n + haloFloats(width, height), cacheRef ? Math.max(6 * totalM, 3 * n1) : 6 * n1];
  if (bands) {
    words = [0, 0, 0, 0];
    bands.forEach((list, s) => { for (const [y0, y1] of list) windowBytes(sizes[s].w, y1 - y0, Math.min(sizes[s].h, y1 + 4) - Math.max(0, y0 - 4), !s, sizes[s + 1]).forEach((b, k) => { words[k] = Math.max(words[k], b / 4); }); });
  }
  try {
    const I = buf(words[0] * 4), A = buf(words[1] * 4), B = buf((cacheRef ? Math.max(3 * totalM, 3 * n) : words[1]) * 4);
    const RA = cacheRef ? buf(3 * totalM * 4) : null, RL = cacheRef ? buf(6 * totalM * 4) : null;
    const L = buf(words[2] * 4), N = buf((cacheRef ? 3 * n1 : words[3]) * 4), S = buf((acc + (bands ? 3 * S2_GROUPS * WG * 6 : 0)) * 8), F = buf(16);
    const R = buf(sBytes + 16, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    gpuWrite(device, I, tables);
    const named = {I, A, B, N, ...(cacheRef && {RA, RL})}, refBytes = new Uint8Array(reference.buffer, reference.byteOffset, n * 4);
    if (bands) {
      named.ref = gpuUpload(device, buf, refBytes, st);
      for (let o = 0; o < outputs; o++) named['out' + o] = buf(n * 4);
      for (let t = 0; t < 2; t++) for (let p = 0; p < 6; p++) named['P' + t + p] = buf(n1 * 4);
    } else gpuWrite(device, I, refBytes, 512 * 4);
    const uniform = (f, bA = A, bB = B, bN = N) => gpuBind(device, set.group, [gpuUni(device, buf, [0, f.w, f.h, f.n, f.w2, f.h2, f.n2, f.c, f.slot, f.rof, f.dof, tot, f.oy0, f.oy1, f.gofs, f.H, f.mode, acc, f.ny0, f.wy0], null, 0, 80), I, bA, bB, L, bN, S, F]);
    const refPlan = [];
    if (cacheRef) {
      let off3 = 0, offRL = 0;
      for (let s = 0; s < sizes.length; s++) {
        const {w, h} = sizes[s], m = w * h, next = sizes[s + 1], w2 = next?.w ?? 0, n2 = next ? w2 * next.h : 0;
        const baseF = {w, h, n: m, w2, h2: next?.h ?? 0, n2, rof: 512, dof: 0, oy0: 0, oy1: h, gofs: 0, H: h, mode: 3 | 4, ny0: 0, wy0: 0, c: 0, slot: 0};
        if (s) refPlan.push({copy: [['N', 0, 'A', 0, 3 * m * 4]]});
        if (!s) refPlan.push([set.lin0, uniform(baseF), m]);
        if (next) refPlan.push([set.down, uniform(baseF), n2]);
        refPlan.push([set.positive, uniform({...baseF, rof: off3}, A, RA, N), m]);
        for (let c = 0; c < 3; c++) {
          const fRef = {...baseF, rof: off3, dof: offRL + c * 2 * m, c};
          refPlan.push([set.hblur, uniform(fRef, RA, B, RL), m]);
          if (h > VB) refPlan.push([set.halo, uniform(fRef, RA, B, RL), haloFloats(w, h)]);
          refPlan.push([set.vblur, uniform(fRef, RA, B, RL), w * Math.ceil(h / VB)]);
        }
        off3 += 3 * m; offRL += 6 * m;
      }
    }
    const plan = [];
    for (let o = 0; o < outputs; o++) {
      const steps = [];
      let off3 = 0, offRL = 0;
      for (let s = 0; s < sizes.length; s++) {
        const {w, h} = sizes[s], next = sizes[s + 1], w2 = next?.w ?? 0, list = bands ? bands[s] : [[0, h]];
        if (cacheRef) {
          const m = w * h, n2 = next ? w2 * next.h : 0;
          const f = {w, h, n: m, w2, h2: next?.h ?? 0, n2, rof: off3, dof: 512 + (1 + o) * n, oy0: 0, oy1: h, gofs: 0, H: h, mode: 3 | 8, ny0: 0, wy0: 0, c: 0, slot: 0};
          if (s) steps.push({copy: [['N', 0, 'B', 0, 3 * m * 4]]});
          if (!s) steps.push([set.lin0, uniform(f, RA, B, N), m]);
          if (next) steps.push([set.down, uniform(f, RA, B, N), n2]);
          steps.push([set.positive, uniform(f, RA, B, N), m]);
          for (let c = 0; c < 3; c++) {
            const fc = {...f, dof: offRL + c * 2 * m, c, slot: (o * sizes.length + s) * 3 + c};
            const u = uniform(fc, RA, B, RL);
            steps.push([set.hblur, u, m * 3]);
            if (h > VB) steps.push([set.halo, u, haloFloats(w, h)]);
            steps.push([set.vblur, u, w * 3 * Math.ceil(h / VB)], [set.sums, u, -1]);
          }
          off3 += 3 * m; offRL += 6 * m;
          continue;
        }
        for (const [b, [y0, y1]] of list.entries()) {
          const top = bands ? Math.max(0, y0 - 4) : 0, hW = (bands ? Math.min(h, y1 + 4) : h) - top, m = w * hW, out = y1 - y0;
          const rowsN = next ? Math.min(next.h, Math.ceil(y1 / 2)) - y0 / 2 : 0;
          const f = {w, h: hW, n: m, w2, h2: rowsN, n2: w2 * rowsN, rof: 0, dof: 512 + (bands ? m : (1 + o) * n), oy0: y0 - top, oy1: y1 - top,
            gofs: top * w, H: h, mode: (b ? 0 : 1) | (b === list.length - 1 ? 2 : 0), ny0: y0 / 2, wy0: top, c: 0, slot: 0};
          const u0 = uniform({...f, rof: 512});
          if (!bands) { if (s) steps.push({copy: [['N', 0, 'A', 0, 3 * m * 4], ['N', 3 * m * 4, 'B', 0, 3 * m * 4]]}); }
          else if (!s) steps.push({copy: [['ref', top * w * 4, 'I', 512 * 4, m * 4], ['out' + o, top * w * 4, 'I', (512 + m) * 4, m * 4]]});
          else steps.push({copy: [0, 1, 2, 3, 4, 5].map(p => ['P' + (s & 1) + p, top * w * 4, p < 3 ? 'A' : 'B', (p % 3) * m * 4, m * 4])});
          if (!s) steps.push([set.lin0, u0, m]);
          if (next) steps.push([set.down, u0, w2 * rowsN]);
          steps.push([set.positive, u0, m]);
          for (let c = 0; c < 3; c++) {
            const u = uniform({...f, rof: 0, c, slot: (o * sizes.length + s) * 3 + c});
            steps.push([set.hblur, u, m * 4]);
            if (out > VB) steps.push([set.halo, u, haloFloats(w, out)]);
            steps.push([set.vblur, u, w * 4 * Math.ceil(out / VB)], [set.sums, u, -1]);
          }
          if (bands && next) steps.push({copy: [0, 1, 2, 3, 4, 5].map(p => ['N', p * w2 * rowsN * 4, 'P' + ((s + 1) & 1) + p, y0 / 2 * w2 * 4, w2 * rowsN * 4])});
        }
      }
      steps.push([set.total, uniform({w: 0, h: 0, n: 0, w2: 0, h2: 0, n2: 0, c: 0, slot: o * sizes.length * 3, rof: 0, dof: 0, oy0: 0, oy1: 0, gofs: 0, H: 0, mode: 0, ny0: 0, wy0: 0}), -sizes.length * 3]);
      plan.push(steps);
    }
    return held.state = {n, outputs, sizes, I, N, A, B, S, F, R, sBytes, tot, refPlan, refReady: !cacheRef, plan, named, banded: !!bands, release() { gpuDestroy(made); held.state = null; }};
  } catch (error) { gpuDestroy(made); throw error; }
}

export async function gpuS2Prepare(device, held, tables, reference, width, height, outputs = 2, signal) {
  if (width < 8 || height < 8) return null;
  const bands = s2Bands(device.limits, width, height);
  if (bands === null) return null;
  const kernels = await pipelines(device);
  return signal?.aborted ? null : residentState(device, kernels, held, tables, reference, width, height, outputs, bands);
}

export function gpuS2Record(device, encoder, state, outputs, dst = state.R, dstOffset = 0) {
  const {I, S, F, sBytes, tot, refPlan, plan, n, outputs: nOut, named, banded} = state;
  gpuWrite(device, F, new Uint32Array(4));
  const gpuOut = !Array.isArray(outputs);
  if (gpuOut) { if (!banded) encoder.copyBufferToBuffer(outputs, 0, I, (512 + n) * 4, nOut * n * 4); }
  else outputs.forEach((rgba, o) => gpuWrite(device, banded ? named['out' + o] : I, new Uint8Array(rgba.buffer, rgba.byteOffset, n * 4), banded ? 0 : (512 + (1 + o) * n) * 4));
  let pass = null;
  const runSteps = list => {
    for (const step of list) {
      if (step.copy) {
        if (pass) { pass.end(); pass = null; }
        for (const [a, at, b, bt, bytes] of step.copy) {
          const own = gpuOut && a.startsWith('out');
          encoder.copyBufferToBuffer(own ? outputs : named[a], own ? at + +a.slice(3) * n * 4 : at, named[b], bt, bytes);
        }
        continue;
      }
      const [kernel, group, count] = step;
      pass ??= encoder.beginComputePass();
      if (count < 0) gpuStep(device, pass, kernel, group, count === -1 ? S2_GROUPS : -count, 1);
      else gpuStep(device, pass, kernel, group, count);
    }
  };
  if (!state.refReady) { runSteps(refPlan); state.refReady = true; }
  for (const steps of plan) runSteps(steps);
  pass?.end();
  encoder.copyBufferToBuffer(S, tot * 8, dst, dstOffset, sBytes);
  encoder.copyBufferToBuffer(F, 0, dst, dstOffset + sBytes, 16);
}

export function gpuS2Decode(state, bytes, byteOffset = 0) {
  const {sBytes, sizes, outputs: nOut} = state;
  const parts = new Float32Array(bytes, byteOffset, sBytes / 4), flagged = new Uint32Array(bytes, byteOffset + sBytes, 1)[0];
  const sums = Array.from({length: nOut}, (_, o) => sizes.map((_, s) => [0, 1, 2].map(c => {
    const out = new Float64Array(6), slot = (o * sizes.length + s) * 3 + c;
    for (let k = 0; k < 6; k++) out[k] = parts[(slot * 6 + k) * 2] + parts[(slot * 6 + k) * 2 + 1];
    return out;
  })));
  return {sums, sizes, flagged};
}

export async function gpuS2Sums(device, held, tables, reference, outputs, width, height, signal) {
  let state = null;
  try {
    return await gpuScoped(device, 's2', async seal => {
      state = await gpuS2Prepare(device, held, tables, reference, width, height, 2, signal);
      if (!state) return null;
      const {R} = state, encoder = device.createCommandEncoder();
      gpuS2Record(device, encoder, state, outputs, R, 0);
      device.queue.submit([encoder.finish()]);
      seal();
      await gpuMap(device, R);
      const bytes = R.getMappedRange().slice(0); R.unmap();
      return gpuS2Decode(state, bytes, 0);
    }, true, () => { state?.release(); return null; });
  } catch { state?.release(); return null; }
}
