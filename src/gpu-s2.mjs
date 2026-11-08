// SPDX-License-Identifier: MIT
import {GC_DS} from './gpu-arithmetic.mjs';
import {S2_GROUPS} from './gpu-s2-score.mjs';
import {gpuComputeSet, gpuBuffers} from './gpu-kit.mjs';

const K = v => { const t = String(Math.fround(v)); return /[.e]/.test(t) ? t : t + '.0'; };

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
  let p = tp(a, b); let s = ts(p.x, c); let t = ts(s.y, p.y); let q = ts(s.x, t.x);
  if (q.x == 0.0) { return vec2f(q.x, select(0.0, 1.0, q.y != 0.0 || t.y != 0.0)); }
  return settle(q.x, q.y, t.y);
}
// The binary32 square root, correctly rounded (.y 1: not certified).
fn xsqrt(v: f32) -> vec2f {
  var r = sqrt(v);
  for (var k = 0; k < 3; k++) {
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
  if (!(abs(q) >= 1.0e-36 && abs(q) <= 1.0e37) || !(abs(b) >= 1.0e-30 && abs(b) <= 1.0e30)) { return vec2f(q, 1.0); }
  for (var k = 0; k < 4; k++) {
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

export const S2_SHADER = `${GC_DS}
${XFMA}
struct U { one: f32, w: u32, h: u32, n: u32, w2: u32, h2: u32, n2: u32, c: u32, slot: u32, rof: u32, dof: u32, tot: u32 }
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
fn fm(a: f32, b: f32, c: f32) -> f32 { let r = xfma(a, b, c); if (r.y != 0.0) { bad(); } return r.x; }
// A value whose exact binary32 is at most T = 2^-125 a side but which the device holds as 0 is "lost" (.y 1): flat runs
// make the Gaussian's third component (its pole near 0) cancel exactly and decay through subnormals. Each use of one
// is certified by bracketing: the CPU's result lies between the device's results for the lost value at -T and +T
// (binary32 rounding is monotone), so where they agree it is that value. Anything else is counted (bad).
const T = 2.350988701644575e-38;
fn fmT(a: f32, b: f32, bt: bool, c: f32, ct: bool) -> vec2f {
  if (bt && ct) { bad(); return vec2f(c, 0.0); }
  if (bt) {
    // a r + c: within c +- K, K = |a| T at least T.
    if (c == 0.0 && abs(a) <= 0.5) { return vec2f(0.0, 1.0); }
    let k = gcO(max(abs(a), 1.0) * T); let lo = gcO(c - k); let hi = gcO(c + k);
    if (lo != hi || abs(c) < 1.0e-30) { bad(); }
    return vec2f(lo, 0.0);
  }
  if (ct) {
    if (a == 0.0 || b == 0.0) { return vec2f(0.0, 1.0); }
    let lo = xfma(a, b, -T); let hi = xfma(a, b, T);
    if (lo.y != 0.0 || hi.y != 0.0 || lo.x != hi.x) { bad(); }
    return vec2f(lo.x, 0.0);
  }
  let r = xfma(a, b, c);
  if (r.y == 2.0) { return vec2f(0.0, 1.0); }
  if (r.y != 0.0) { bad(); }
  return vec2f(r.x, 0.0);
}
// x + y, one binary32 addition, either possibly lost.
fn addT(x: f32, xt: bool, y: f32, yt: bool) -> vec2f {
  if (xt && yt) { bad(); return vec2f(0.0, 0.0); }
  if (!xt && !yt) { return vec2f(gcO(x + y), 0.0); }
  let v = select(x, y, xt);
  if (v == 0.0) { return vec2f(0.0, 1.0); }
  let lo = gcO(v - T); let hi = gcO(v + T);
  if (lo != hi || abs(v) < 1.0e-30) { bad(); }
  return vec2f(lo, 0.0);
}
fn G(i: u32) -> f32 { return bitcast<f32>(I[256u + i]); }
fn lut(v: u32) -> f32 { return bitcast<f32>(I[v]); }
fn idx(id: vec3u, nw: vec3u) -> u32 { return id.x + id.y * nw.x * ${WG}u; }

// Scale 0: the lookup table's linear samples of both RGBA8 pictures (ssimulacra2-simd.c sample, kind 0).
@compute @workgroup_size(${WG})
fn lin0(@builtin(global_invocation_id) id: vec3u, @builtin(num_workgroups) nw: vec3u) {
  let i = idx(id, nw); if (i >= P.n) { return; }
  let r = I[P.rof + i]; let d = I[P.dof + i];
  for (var c = 0u; c < 3u; c++) { A[c * P.n + i] = lut((r >> (8u * c)) & 255u); B[c * P.n + i] = lut((d >> (8u * c)) & 255u); }
}
// The next scale's planes of both sides (s2_metric_down): four taps, each addition rounded, edges repeated.
@compute @workgroup_size(${WG})
fn down(@builtin(global_invocation_id) id: vec3u, @builtin(num_workgroups) nw: vec3u) {
  let j = idx(id, nw); if (j >= P.n2) { return; }
  let x = j % P.w2; let y = j / P.w2;
  let r0 = 2u * y * P.w; let r1 = min(2u * y + 1u, P.h - 1u) * P.w; let x0 = 2u * x; let x1 = min(x0 + 1u, P.w - 1u);
  for (var c = 0u; c < 3u; c++) {
    let o = c * P.n;
    N[c * P.n2 + j] = gcO(gcO(gcO(gcO(A[o + r0 + x0] + A[o + r0 + x1]) + A[o + r1 + x0]) + A[o + r1 + x1]) * 0.25);
    N[(3u + c) * P.n2 + j] = gcO(gcO(gcO(gcO(B[o + r0 + x0] + B[o + r0 + x1]) + B[o + r1 + x0]) + B[o + r1 + x1]) * 0.25);
  }
}
fn cbr(x: f32) -> f32 {
  let u = bitcast<u32>(x);
  var r = bitcast<f32>(select(0x54800000u - (u >> 23u) * 0x002aaaaau, 0u, u == 0u));
  let third = ${K(1 / 3)}; let x3 = gcO(third * x);
  for (var i = 0; i < 3; i++) { let r2 = gcO(r * r); r = fm(-x3, gcO(r2 * r2), gcO(${K(4 / 3)} * r)); }
  var r2 = gcO(r * r);
  r = fm(third, fm(-x, gcO(r2 * r2), r), r);
  r2 = gcO(r * r);
  return fm(r2, x, ${K(-0.15595419704914093)});
}
fn pv(x: f32) -> f32 { return select(x, 0.0, x <= 0.0); }
fn xyb(r: f32, g: f32, b: f32) -> vec3f {
  let bias = ${K('.0037930732552754493')};
  let l = cbr(pv(fm(${K('.30')}, r, fm(${K('.622')}, g, fm(${K('.078')}, b, bias)))));
  let m = cbr(pv(fm(${K('.23')}, r, fm(${K('.692')}, g, fm(${K('.078')}, b, bias)))));
  let x = gcO(0.5 * gcO(l - m)); let y = gcO(0.5 * gcO(l + m));
  let s = cbr(pv(fm(${K('.24342268924547819')}, r, fm(${K('.20476744424496821')}, g, fm(${K('.5518098665095536')}, b, bias)))));
  return vec3f(gcO(gcO(x * 14.0) + ${K('.42')}), gcO(y + ${K('.01')}), gcO(gcO(s - y) + ${K('.55')}));
}
// Both sides' XYB in place of their linear planes (positive).
@compute @workgroup_size(${WG})
fn positive(@builtin(global_invocation_id) id: vec3u, @builtin(num_workgroups) nw: vec3u) {
  let i = idx(id, nw); if (i >= P.n) { return; }
  let a = xyb(A[i], A[P.n + i], A[2u * P.n + i]); A[i] = a.x; A[P.n + i] = a.y; A[2u * P.n + i] = a.z;
  let b = xyb(B[i], B[P.n + i], B[2u * P.n + i]); B[i] = b.x; B[P.n + i] = b.y; B[2u * P.n + i] = b.z;
}
// The five lines of channel c: mu1 (a), mu2 (b), sigma11 (a a), sigma22 (b b), sigma12 (a b).
fn line(k: u32, at: u32) -> f32 {
  let a = A[P.c * P.n + at]; let b = B[P.c * P.n + at];
  switch k { case 0u: { return a; } case 1u: { return b; } case 2u: { return gcO(a * a); } case 3u: { return gcO(b * b); } default: { return gcO(a * b); } }
}
fn cf(i: u32, j: u32) -> f32 { return G(6u + i * 12u + j); }
// One row of one line, blur_lane's arithmetic: a scalar head and tail, the four-step block between.
@compute @workgroup_size(${WG})
fn hblur(@builtin(global_invocation_id) id: vec3u, @builtin(num_workgroups) nw: vec3u) {
  let t = idx(id, nw); if (t >= P.h * 5u) { return; }
  let y = t / 5u; let k = t % 5u; let row = y * P.w; let count = i32(P.w); let out = k * P.n + row;
  // Each state value with its lost mark (fmT).
  var pv1 = array<vec2f, 3>(vec2f(0.0), vec2f(0.0), vec2f(0.0)); var pv2 = pv1; var nx = pv1;
  var n = -4;
  var stop = min(count, 8);
  for (var phase = 0; phase < 2; phase++) {
  for (; n < stop; n++) {
    let s = gcO(select(0.0, line(k, row + u32(max(n - 6, 0))), n - 6 >= 0) + select(0.0, line(k, row + u32(n + 4)), n + 4 < count));
    for (var i = 0u; i < 3u; i++) { let c = addT(-pv2[i].x, pv2[i].y != 0.0, gcO(s * cf(i, 0u)), false); nx[i] = fmT(cf(i, 4u), pv1[i].x, pv1[i].y != 0.0, c.x, c.y != 0.0); }
    if (n >= 0) { L[out + u32(n)] = sum3(nx[0], nx[1], nx[2]); }
    for (var i = 0u; i < 3u; i++) { pv2[i] = pv1[i]; pv1[i] = nx[i]; }
  }
  if (phase == 1) { break; }
  var sm = array<f32, 4>(0.0, 0.0, 0.0, 0.0); var nb = array<vec2f, 12>();
  for (; n < count - 7; n += 4) {
    for (var l = 0u; l < 4u; l++) { sm[l] = gcO(line(k, row + u32(n) + l - 6u) + line(k, row + u32(n) + l + 4u)); }
    for (var i = 0u; i < 3u; i++) {
      for (var l = 0u; l < 4u; l++) {
        var v = gcO(sm[0] * cf(i, l));
        for (var j = 1u; j < 4u; j++) { if (l >= j) { v = fm(cf(i, l - j), sm[j], v); } else { v = gcO(gcO(0.0 * sm[j]) + v); } }
        let inner = fmT(cf(i, 8u + l), pv2[i].x, pv2[i].y != 0.0, v, false);
        nb[i * 4u + l] = fmT(cf(i, 4u + l), pv1[i].x, pv1[i].y != 0.0, inner.x, inner.y != 0.0);
      }
    }
    for (var l = 0u; l < 4u; l++) { L[out + u32(n) + l] = sum3(nb[l], nb[4u + l], nb[8u + l]); }
    for (var i = 0u; i < 3u; i++) { pv2[i] = nb[i * 4u + 2u]; pv1[i] = nb[i * 4u + 3u]; }
  }
  stop = count;
  }
}
// The output a + (b + c); a lost output is counted.
fn sum3(a: vec2f, b: vec2f, c: vec2f) -> f32 {
  let inner = addT(b.x, b.y != 0.0, c.x, c.y != 0.0); let o = addT(a.x, a.y != 0.0, inner.x, inner.y != 0.0);
  if (o.y != 0.0) { bad(); }
  return o.x;
}
// One column of one line, in place (vertical_column): the rows it still reads are kept in a ring.
@compute @workgroup_size(${WG})
fn vblur(@builtin(global_invocation_id) id: vec3u, @builtin(num_workgroups) nw: vec3u) {
  let t = idx(id, nw); if (t >= P.w * 5u) { return; }
  let x = t % P.w; let k = t / P.w; let base = k * P.n + x; let h = i32(P.h);
  var ring: array<f32, 16>; var s = array<f32, 6>(0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
  let g0 = G(0u); let g1 = G(1u); let g2 = G(2u); let d0 = -G(3u); let d1 = -G(4u); let d2 = -G(5u);
  for (var y = -4; y < h; y++) {
    let left = y - 6; let right = y + 4;
    if (right < h) { ring[u32(right) & 15u] = L[base + u32(right) * P.w]; }
    let sum = gcO(select(0.0, ring[u32(max(left, 0)) & 15u], left >= 0) + select(0.0, ring[u32(max(right, 0)) & 15u], right < h));
    let o1 = fm(g0, sum, fm(d0, s[0], -s[1]));
    let o3 = fm(g1, sum, fm(d1, s[2], -s[3]));
    let o5 = fm(g2, sum, fm(d2, s[4], -s[5]));
    if (y >= 0) { L[base + u32(y) * P.w] = gcO(o1 + gcO(o3 + o5)); }
    s[1] = s[0]; s[0] = o1; s[3] = s[2]; s[2] = o3; s[5] = s[4]; s[4] = o5;
  }
}
var<workgroup> R: array<vec2f, ${WG * 6}>;
// row_sums' six terms per pixel in double-single, each thread's share added in order, then the workgroup's.
@compute @workgroup_size(${WG})
fn sums(@builtin(local_invocation_id) lid: vec3u, @builtin(workgroup_id) wid: vec3u) {
  var acc = array<vec2f, 6>(vec2f(0.0), vec2f(0.0), vec2f(0.0), vec2f(0.0), vec2f(0.0), vec2f(0.0));
  let one = vec2f(1.0, 0.0); let small = ${K('.0009')};
  for (var i = wid.x * ${WG}u + lid.x; i < P.n; i += ${S2_GROUPS * WG}u) {
    let m1 = L[i]; let m2 = L[P.n + i]; let v11 = L[2u * P.n + i]; let v22 = L[3u * P.n + i]; let v12 = L[4u * P.n + i];
    let q1 = A[P.c * P.n + i]; let q2 = B[P.c * P.n + i];
    let delta = gcO(m1 - m2);
    let num_m = gcO(1.0 - gcO(delta * delta));
    let num_s = gcO(gcO(2.0 * gcO(v12 - gcO(m1 * m2))) + small);
    let den_s = gcO(gcO(gcO(v11 - gcO(m1 * m1)) + gcO(v22 - gcO(m2 * m2))) + small);
    let ratio = xdiv(gcO(num_m * num_s), den_s); if (ratio.y != 0.0) { bad(); }
    let raw = ts(1.0, -ratio.x);
    let e = select(raw, vec2f(0.0), raw.x <= 0.0);
    let d = dadd(ddiv(ts(1.0, abs(gcO(q2 - m2))), ts(1.0, abs(gcO(q1 - m1)))), vec2f(-1.0, 0.0));
    let art = select(d, vec2f(0.0), d.x <= 0.0); let det = select(-d, vec2f(0.0), d.x >= 0.0);
    let e2 = dmul(e, e); let a2 = dmul(art, art); let l2 = dmul(det, det);
    acc[0] = dadd(acc[0], e); acc[1] = dadd(acc[1], dmul(e2, e2));
    acc[2] = dadd(acc[2], art); acc[3] = dadd(acc[3], dmul(a2, a2));
    acc[4] = dadd(acc[4], det); acc[5] = dadd(acc[5], dmul(l2, l2));
  }
  for (var k = 0u; k < 6u; k++) { R[k * ${WG}u + lid.x] = acc[k]; }
  workgroupBarrier();
  for (var half = ${WG / 2}u; half > 0u; half >>= 1u) {
    if (lid.x < half) { for (var k = 0u; k < 6u; k++) { R[k * ${WG}u + lid.x] = dadd(R[k * ${WG}u + lid.x], R[k * ${WG}u + lid.x + half]); } }
    workgroupBarrier();
  }
  if (lid.x < 6u) { S[(P.slot * 6u + lid.x) * ${S2_GROUPS}u + wid.x] = R[lid.x * ${WG}u]; }
}
// One slot's six totals from its workgroups' partial sums: 16 a thread in order, then by halves, into S from P.tot.
@compute @workgroup_size(${WG})
fn total(@builtin(local_invocation_id) lid: vec3u, @builtin(workgroup_id) wid: vec3u) {
  let slot = P.slot + wid.x;
  for (var k = 0u; k < 6u; k++) {
    var acc = vec2f(0.0);
    for (var j = 0u; j < ${S2_GROUPS / WG}u; j++) { acc = dadd(acc, S[(slot * 6u + k) * ${S2_GROUPS}u + lid.x * ${S2_GROUPS / WG}u + j]); }
    R[k * ${WG}u + lid.x] = acc;
  }
  workgroupBarrier();
  for (var half = ${WG / 2}u; half > 0u; half >>= 1u) {
    if (lid.x < half) { for (var k = 0u; k < 6u; k++) { R[k * ${WG}u + lid.x] = dadd(R[k * ${WG}u + lid.x], R[k * ${WG}u + lid.x + half]); } }
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

const pipelines = device => gpuComputeSet(device, 's2', S2_SHADER, ['uniform', 'read-only-storage', 'storage', 'storage', 'storage', 'storage', 'storage', 'storage'],
  ['lin0', 'down', 'positive', 'hblur', 'vblur', 'sums', 'total']);

function residentState(device, set, held, tables, reference, width, height, outputs) {
  if (held.state) return held.state;
  const n = width * height, sizes = s2Sizes(width, height), n1 = sizes[1] ? sizes[1].w * sizes[1].h : 1, made = [], {buf, bind} = gpuBuffers(device, null, made);
  const slots = outputs * sizes.length * 3, tot = slots * 6 * S2_GROUPS, sBytes = slots * 6 * 8;
  const I = buf((512 + (1 + outputs) * n) * 4), A = buf(3 * n * 4), B = buf(3 * n * 4), L = buf(5 * n * 4), N = buf(6 * n1 * 4), S = buf((tot + slots * 6) * 8), F = buf(16);
  const R = buf(sBytes + 16, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
  device.queue.writeBuffer(I, 0, tables);
  device.queue.writeBuffer(I, 512 * 4, reference.buffer, reference.byteOffset, n * 4);
  const group = u => bind(set.group, [u, I, A, B, L, N, S, F]);
  const uniform = values => {
    const b = buf(48, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST), u = new Uint32Array(12);
    u.set(values, 1); new Float32Array(u.buffer)[0] = 1; device.queue.writeBuffer(b, 0, u); return group(b);
  };
  const plan = [];
  for (let o = 0; o < outputs; o++) {
    const steps = [];
    for (let s = 0; s < sizes.length; s++) {
      const {w, h} = sizes[s], m = w * h, next = sizes[s + 1], w2 = next?.w ?? 0, h2 = next?.h ?? 0;
      const at = (c, slot) => uniform([w, h, m, w2, h2, w2 * h2, c, slot, 512, 512 + (1 + o) * n, tot]), u0 = at(0, 0);
      if (s) steps.push({copy: 3 * m * 4});
      else steps.push([set.lin0, u0, m]);
      if (next) steps.push([set.down, u0, w2 * h2]);
      steps.push([set.positive, u0, m]);
      for (let c = 0; c < 3; c++) {
        const u = at(c, (o * sizes.length + s) * 3 + c);
        steps.push([set.hblur, u, h * 5], [set.vblur, u, w * 5], [set.sums, u, -1]);
      }
    }
    steps.push([set.total, uniform([0, 0, 0, 0, 0, 0, 0, o * sizes.length * 3, 0, 0, tot]), -sizes.length * 3]);
    plan.push(steps);
  }
  return held.state = {n, sizes, I, N, A, B, S, F, R, sBytes, tot, plan, release() { for (const b of made) b.destroy(); made.length = 0; held.state = null; }};
}

export async function gpuS2Prepare(device, held, tables, reference, width, height) {
  const n = width * height;
  if (width < 8 || height < 8 || n * 20 > device.limits.maxStorageBufferBindingSize || n * 12 + 2048 > device.limits.maxStorageBufferBindingSize) return null;
  const set = await pipelines(device);
  return residentState(device, set, held, tables, reference, width, height, 2);
}

export function gpuS2Record(device, encoder, state, outputs, dst = state.R, dstOffset = 0) {
  const {I, N, A, B, S, F, sBytes, tot, plan, n} = state;
  device.queue.writeBuffer(F, 0, new Uint32Array(4));
  if (!Array.isArray(outputs)) encoder.copyBufferToBuffer(outputs, 0, I, (512 + n) * 4, 2 * n * 4);
  else outputs.forEach((rgba, o) => device.queue.writeBuffer(I, (512 + (1 + o) * n) * 4, rgba.buffer, rgba.byteOffset, n * 4));
  let pass = null;
  for (const steps of plan) for (const step of steps) {
    if (step.copy) {
      if (pass) { pass.end(); pass = null; }
      encoder.copyBufferToBuffer(N, 0, A, 0, step.copy); encoder.copyBufferToBuffer(N, step.copy, B, 0, step.copy);
      continue;
    }
    const [pipeline, group, count] = step;
    pass ??= encoder.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0, group);
    if (count < 0) pass.dispatchWorkgroups(count === -1 ? S2_GROUPS : -count);
    else { const all = Math.ceil(count / 64), gx = Math.min(all, 65535); pass.dispatchWorkgroups(gx, Math.ceil(all / gx)); }
  }
  pass?.end();
  encoder.copyBufferToBuffer(S, tot * 8, dst, dstOffset, sBytes);
  encoder.copyBufferToBuffer(F, 0, dst, dstOffset + sBytes, 16);
}

export function gpuS2Decode(state, bytes, byteOffset = 0) {
  const {sBytes, sizes} = state;
  const parts = new Float32Array(bytes, byteOffset, sBytes / 4), flagged = new Uint32Array(bytes, byteOffset + sBytes, 1)[0];
  const sums = [0, 1].map(o => sizes.map((_, s) => [0, 1, 2].map(c => {
    const out = new Float64Array(6), slot = (o * sizes.length + s) * 3 + c;
    for (let k = 0; k < 6; k++) out[k] = parts[(slot * 6 + k) * 2] + parts[(slot * 6 + k) * 2 + 1];
    return out;
  })));
  return {sums, sizes, flagged};
}

export async function gpuS2Sums(device, held, tables, reference, outputs, width, height) {
  let state = null, failed = false;
  device.pushErrorScope('validation'); device.pushErrorScope('out-of-memory');
  try {
    state = await gpuS2Prepare(device, held, tables, reference, width, height);
    if (!state) return null;
    const {R} = state, encoder = device.createCommandEncoder();
    gpuS2Record(device, encoder, state, outputs, R, 0);
    device.queue.submit([encoder.finish()]);
    await R.mapAsync(GPUMapMode.READ);
    const bytes = R.getMappedRange().slice(0); R.unmap();
    return gpuS2Decode(state, bytes, 0);
  } catch { failed = true; return null; }
  finally {
    const oom = await device.popErrorScope(), invalid = await device.popErrorScope();
    if (oom || invalid || failed) state?.release();
    if (oom || invalid) return null;
  }
}
