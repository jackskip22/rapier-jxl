// SPDX-License-Identifier: MIT
import {traced, tracing} from './stage-trace.mjs';
import {fault} from './fault.mjs';
import {GC_DS} from './gpu-arithmetic.mjs';
import {XFMA, gpuS2Prepare, gpuS2Record, gpuS2Decode, gpuS2Pipelines} from './gpu-s2.mjs';
import {gpuMap, gpuSplits as split, gpuDestroy, gpuModule, gpuComputeSet, gpuScoped, gpuWrite, gpuAlloc, gpuStep, gpuRead, gpuHeld} from './gpu-kit.mjs';
import {TRANSFORMS, basis, basisT, llfDivisors} from './vardct-bases.mjs';
import {scaledBasis, restorePlanes} from './vardct-inverse.mjs';
const prefSeen = new WeakMap();

const OP = 4e-14, F64 = 1.2e-16, REP = 2 ** -47;
const SPECIAL = id => id === 1 || id === 2 || id === 3 || id >= 12 && id <= 17;
const BW = 20;
const P_COEF = [-5.135152395e-4, 5.287254571e-3, 3.903842876e-1, 1.474205315, 7.352629620e-1];
const Q_COEF = [1.004519624e-2, 3.036675394e-1, 1.340816930, 9.258482155e-1, 2.424867759e-2];
const f = v => { const s = Math.fround(v).toString(); return /[.eE]/.test(s) ? s : s + '.0'; };

const EPF_WINDOW = [[0, -2], [-1, -1], [0, -1], [1, -1], [-2, 0], [-1, 0], [0, 0], [1, 0], [2, 0], [-1, 1], [0, 1], [1, 1], [0, 2]];

const REBUILD_SHADER = `${GC_DS}
${XFMA}
struct U {
  width: u32, height: u32, xsize: u32, w3: u32, one: f32, w5: u32, w6: u32, w7: u32,
  w8: u32, w9: u32, w10: u32, w11: u32, w12: u32, w13: u32, w14: u32, w15: u32,
  w16: u32, w17: u32, w18: u32, w19: u32, w20: u32, w21: u32, w22: u32, w23: u32,
  w24: u32, w25: u32, w26: u32, w27: u32
}
@group(0) @binding(0) var<uniform> P: U;
fn gcOne() -> f32 { return P.one; }
fn pf(v: u32) -> f32 { return bitcast<f32>(v); }

@group(0) @binding(1) var<storage, read> M: array<u32>;
@group(0) @binding(2) var<storage, read_write> C: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> outp: array<u32>;
@group(0) @binding(4) var<storage, read_write> rCnt: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read_write> rLst: array<u32>;
@group(0) @binding(6) var<storage, read_write> R0: array<vec4f>;

@group(0) @binding(1) var<storage, read> src: array<f32>;
@group(0) @binding(2) var<storage, read> aux: array<f32>;
@group(0) @binding(4) var<storage, read> table: array<u32>;
@group(0) @binding(5) var<storage, read_write> cnt: array<atomic<u32>>;
@group(0) @binding(6) var<storage, read_write> lst: array<u32>;
@group(0) @binding(7) var<storage, read_write> px: array<u32>;

// Whether the CPU's binary64 value, within B of v, stores as v.x.
fn sure(v: vec2f, B: f32, any: bool) -> bool {
  if (!any) { return true; }
  let a = abs(v.x); let bits = bitcast<u32>(a);
  if (a < 1e-30) { return false; }
  var ulp = bitcast<f32>(bits & 0x7f800000u) * ${f(2 ** -23)};
  if ((bits & 0x007fffffu) == 0u) { ulp = ulp * 0.5; }
  return abs(v.y) + B < 0.5 * ulp;
}

fn flag(t: u32, v: u32) { let k = atomicAdd(&rCnt[0], 1u); if (k < P.w7) { rLst[2u * k] = t; rLst[2u * k + 1u] = v; } }
fn ints(g: u32) -> i32 {
  let i = g - P.w20;
  if (P.w9 != 0u) {
    let w = bitcast<i32>(M[P.w8 + (i >> 1u)]);
    return select((w << 16) >> 16, w >> 16, (i & 1u) != 0u);
  }
  return bitcast<i32>(M[P.w8 + i]);
}
fn blk(i: u32) -> u32 { return M[P.w10 + i - P.w21 * ${BW}u]; }
fn fac(i: u32) -> f32 { return bitcast<f32>(M[P.w11 + i - P.w21 * 6u]); }
fn qtab(i: u32) -> f32 { return bitcast<f32>(M[P.w12 + i]); }
fn tabs(i: u32) -> f32 { return bitcast<f32>(M[P.w13 + i]); }
fn grp(i: u32) -> u32 { return M[P.w14 + i]; }
fn maps(i: u32) -> i32 { return bitcast<i32>(M[P.w15 + i]); }
fn lf(i: u32) -> f32 { return bitcast<f32>(M[P.w16 + i]); }
fn consts(i: u32) -> f32 { return bitcast<f32>(M[P.w17 + i]); }
fn cells(i: u32) -> u32 { return M[P.w18 + i - P.w22 * P.xsize]; }
fn ds(at: u32) -> vec2f { return vec2f(tabs(at), tabs(at + 1u)); }
fn cs(k: u32) -> vec2f { return vec2f(consts(2u * k), consts(2u * k + 1u)); }

// A coefficient's dequantized value and its bound, as rebuildPicture's dequant computes it in binary64.
fn dq(b: u32, c: u32, i: u32) -> vec4f {
  let o = b * ${BW}u; let q = ints(blk(o + c) + i);
  if (q == 0) { return vec4f(0.0); }
  let x = vec2f(f32(q), 0.0); var v: vec2f;
  if (q >= -1 && q <= 1) { v = dmul(x, cs(c)); } else { v = dsub(x, ddiv(cs(3u), x)); }
  let size = blk(o + 6u) * blk(o + 7u);
  v = dmul(v, vec2f(qtab(blk(o + 8u) + c * size + i), 0.0));
  v = dmul(v, vec2f(fac(b * 6u + 2u * c), fac(b * 6u + 2u * c + 1u)));
  let m = abs(v.x);
  return vec4f(v, m * ${f(12 * OP + 4 * REP)}, m);
}

@compute @workgroup_size(64)
fn coefficients(@builtin(global_invocation_id) id: vec3u) {
  let e = id.x + id.y * 65535u * 64u; if (e >= P.w3) { return; }
  // The block holding e: blocks lie in the arena in order, each its X, Y and B coefficients in turn.
  let eg = e + P.w20; var lo = P.w21;
  if (P.w19 != 0u) { lo = eg / 192u; }
  else { var hi = P.w21 + P.w5; while (hi - lo > 1u) { let mid = (lo + hi) / 2u; if (blk(mid * ${BW}u) <= eg) { lo = mid; } else { hi = mid; } } }
  let b = lo; let o = b * ${BW}u; let size = blk(o + 6u) * blk(o + 7u); let c = (eg - blk(o)) / size; let i = (eg - blk(o)) % size;
  var r = vec4f(0.0); var y = vec4f(0.0);
  let passes = select(2u, 1u, c == 1u);
  for (var p = u32(gcOne() < 0.0); p < passes; p++) {
    let ch = select(1u, c, p == 0u);
    let d = dq(b, ch, i);
    if (p == 0u) { r = d; } else { y = d; }
  }
  if (c != 1u && y.w != 0.0) {
    let wide = blk(o + 11u); let u = i % wide; let v = i / wide; let tr = blk(o + 10u) != 0u;
    let g = blk(o + 9u) * 5u; let gw = grp(g + 2u); let gbx = grp(g + 3u); let gby = grp(g + 4u);
    let bx = blk(o + 4u); let by = blk(o + 5u);
    let tu = select((bx * 8u + u) / 64u - (gbx >> 3u), (by * 8u + u) / 64u - (gby >> 3u), tr);
    let tv = select((by * 8u + v) / 64u - (gby >> 3u), (bx * 8u + v) / 64u - (gbx >> 3u), tr);
    let ci = select(tv * gw + tu, tu * gw + tv, tr);
    let map = maps(grp(g + select(1u, 0u, c == 0u)) + ci);
    let corr = dadd(cs(select(5u, 4u, c == 0u)), dmul(vec2f(f32(map), 0.0), cs(6u)));
    let t = dmul(corr, y.xy); let ac = abs(corr.x);
    let s = dadd(r.xy, t);
    r = vec4f(s, r.z + ac * y.z + (abs(t.x) + abs(s.x)) * ${f(4 * OP)} + ac * y.w * ${f(4 * OP + REP)}, abs(s.x));
  }
  C[e] = r;
}

// The LF positions of a block of bw x bh cells: the LF image's means, their scaled DCT, divided (rebuildPicture's llf).
@compute @workgroup_size(64)
fn lowFrequencies(@builtin(global_invocation_id) id: vec3u) {
  let t = id.x + id.y * 65535u * 64u; if (t >= P.w5 * 3u * 1024u) { return; }
  let b = P.w21 + t / 3072u; let c = (t / 1024u) % 3u; let k = t % 1024u; let o = b * ${BW}u;
  let bw = blk(o + 12u); let bh = blk(o + 13u); let area = bw * bh; if (k >= area || ((blk(o + 3u) & 0x100u) != 0u)) { return; }
  let bx = blk(o + 4u); let by = blk(o + 5u); let plane = c * P.xsize * P.w23;
  let W = max(bw, bh); let canon = blk(o + 11u); let pos = (k / W) * canon + k % W; let at = blk(o + c) + pos;
  let ly = by - P.w22;
  if (area == 1u) { C[at - P.w20] = vec4f(lf(plane + ly * P.xsize + bx), 0.0, 0.0, abs(lf(plane + ly * P.xsize + bx))); return; }
  let tall = bh >= bw; var kk: u32; var v: u32;
  if (tall) { kk = k / bh; v = k % bh; } else { v = k / bw; kk = k % bw; }
  let bt = blk(o + 14u); let bb = blk(o + 15u);
  var low = vec2f(0.0); var S = 0.0;
  for (var y = 0u; y < bh; y++) {
    var row = vec2f(0.0); var rs = 0.0;
    for (var x = 0u; x < bw; x++) {
      let m = vec2f(lf(plane + (ly + y) * P.xsize + bx + x), 0.0); let p = dmul(m, ds(bt + 2u * (x * bw + kk)));
      row = dadd(row, p); rs += abs(p.x);
    }
    let q = dmul(row, ds(bb + 2u * (v * bh + y))); low = dadd(low, q); S += rs * abs(tabs(bb + 2u * (v * bh + y)));
  }
  let invD = ds(blk(o + 16u) + 2u * k); let r = dmul(low, invD); let ad = abs(invD.x);
  C[at - P.w20] = vec4f(r, (S * ad) * ${f(1.01)} * (f32(2u * area + 8u) * ${f(OP + F64)} + ${f(3 * REP)}), abs(r.x));
}

// Separable 1D horizontal inverse DCT pass over padded block rows, followed by vertical 1D pass in samples.
@compute @workgroup_size(64)
fn samplesRow(@builtin(global_invocation_id) id: vec3u) {
  let w8 = P.xsize * 8u; let h8 = P.w23 * 8u; let n8 = w8 * h8;
  let t = id.x + id.y * 65535u * 64u; if (t >= 3u * n8) { return; }
  let c = t / n8; let s = t % n8; let gx = s % w8; let gy = P.w22 * 8u + s / w8;
  let b = cells((gy >> 3u) * P.xsize + (gx >> 3u)); let o = b * ${BW}u;
  if ((blk(o + 3u) & 0x100u) != 0u) { R0[t] = vec4f(0.0); return; }
  let w = blk(o + 6u); let h = blk(o + 7u); let x = gx - blk(o + 4u) * 8u; let v = gy - blk(o + 5u) * 8u;
  let tall = h >= w; let cb = blk(o + c) - P.w20; let tw = blk(o + 17u);
  var acc = vec2f(0.0); var S = 0.0; var E = 0.0; var terms = 0u;
  for (var u = 0u; u < w; u++) {
    let k = C[cb + select(v * w + u, u * h + v, tall)];
    if (k.w == 0.0 && k.x == 0.0) { continue; }
    let bw = ds(tw + 2u * (u * w + x)); let p = dmul(k.xy, bw); let aw = abs(bw.x);
    acc = dadd(acc, p); S += k.w * aw; E += k.z * aw; terms++;
  }
  if (terms == 0u) { R0[t] = vec4f(0.0); return; }
  let Er = (E + S * (f32(2u * terms + 2u) * ${f(OP)} + f32(w + 12u) * ${f(F64)} + ${f(2 * REP)})) * ${f(1.01)};
  R0[t] = vec4f(acc, Er, abs(acc.x));
}

// One sample of one plane: vertical 1D inverse transform from R0, certified against the binary32 store.
@compute @workgroup_size(64)
fn samples(@builtin(global_invocation_id) id: vec3u) {
  let t = id.x + id.y * 65535u * 64u; let n = P.width * P.w25; if (t >= 3u * n) { return; }
  let c = t / n; let s = t % n; let pxIdx = s % P.width; let py = P.w24 + s / P.width; let tg = c * P.width * P.height + py * P.width + pxIdx;
  let b = cells((py >> 3u) * P.xsize + (pxIdx >> 3u)); let o = b * ${BW}u;
  if ((blk(o + 3u) & 0x100u) != 0u) { outp[t] = 0u; if (P.w26 == 0u) { flag(tg, 0xffffffffu); } return; }
  let w = blk(o + 6u); let h = blk(o + 7u); let y = py - blk(o + 5u) * 8u; let th = blk(o + 18u);
  let w8 = P.xsize * 8u; let rBase = c * w8 * (P.w23 * 8u) + pxIdx; let gy0 = (blk(o + 5u) - P.w22) * 8u;
  var acc = vec2f(0.0); var S = 0.0; var E = 0.0; var terms = 0u;
  for (var v = 0u; v < h; v++) {
    let q = R0[rBase + (gy0 + v) * w8];
    if (q.w == 0.0 && q.x == 0.0 && q.z == 0.0) { continue; }
    let bh = ds(th + 2u * (v * h + y)); let p = dmul(q.xy, bh); let ah = abs(bh.x);
    acc = dadd(acc, p); S += q.w * ah; E += q.z * ah; terms++;
  }
  let B = E * ${f(1.01)} + S * ${f(1.01)} * (f32(2u * terms + 4u) * ${f(OP)} + f32(w + h + 24u) * ${f(F64)} + ${f(2 * REP)});
  let valBits = bitcast<u32>(acc.x); outp[t] = valBits;
  if (!sure(acc, B, S != 0.0 || E != 0.0)) { flag(tg, valBits); }
}

// Stages two to five on the device, over planes it holds: Gaborish (clamped edges), the edge-preserving filter's step
// one (mirrored edges), XYB to linear sRGB with the package's RGBA8 (the rebuild kernels' xyb and srgb8 table) and the
// native RGBA8 (photo-output.mjs nativeRGBA's certified table and dither). Each sample is computed in double-single from
// binary32 planes the CPU's own, binary32 steps exactly (a qualified device rounds binary32 as IEEE does), with a bound
// on its distance from the CPU's binary64 value; one that could round otherwise is listed with the inputs the CPU needs.
fn at(c: u32, x: u32, y: u32) -> f32 { return src[c * P.width * P.w19 + (y - P.w18) * P.width + x]; }
fn mir(v: i32, n: i32) -> u32 { if (v < 0) { return u32(-v - 1); } if (v >= n) { return u32(2 * n - v - 1); } return u32(v); }
fn slot(stride: u32) -> u32 { let k = atomicAdd(&cnt[P.w16], 1u); return select(0xffffffffu, P.w17 + k * stride, k < P.w3); }

@compute @workgroup_size(64)
fn gaborish(@builtin(global_invocation_id) id: vec3u) {
  let t = id.x + id.y * 65535u * 64u; let n = P.width * (P.w21 - P.w20); if (t >= 3u * n) { return; }
  let c = t / n; let s = t % n; let x = s % P.width; let y = P.w20 + s / P.width;
  let l = select(x - 1u, 0u, x == 0u); let r = min(x + 1u, P.width - 1u); let u = select(y - 1u, 0u, y == 0u); let d = min(y + 1u, P.height - 1u);
  let q0 = at(c, x, y); let q1 = at(c, l, y); let q2 = at(c, r, y); let q3 = at(c, x, u); let q4 = at(c, x, d);
  let q5 = at(c, l, u); let q6 = at(c, r, u); let q7 = at(c, l, d); let q8 = at(c, r, d);
  let s12 = ts(q1, q2); let s34 = ts(q3, q4); let sides = dadd(s12, s34);
  let d12 = ts(q5, q6); let d34 = ts(q7, q8); let diags = dadd(d12, d34);
  let side = vec2f(pf(P.w5), pf(P.w6)); let diag = vec2f(pf(P.w7), pf(P.w8)); let normal = vec2f(pf(P.w9), pf(P.w10));
  let v = dmul(normal, dadd(dadd(vec2f(q0, 0.0), dmul(side, sides)), dmul(diag, diags)));
  let sSides = select(abs(q1) + abs(q2) + abs(q3) + abs(q4), 0.0, s12.x == -s34.x && s12.y == -s34.y);
  let sDiags = select(abs(q5) + abs(q6) + abs(q7) + abs(q8), 0.0, d12.x == -d34.x && d12.y == -d34.y);
  let S = abs(normal.x) * (abs(q0) + abs(side.x) * sSides + abs(diag.x) * sDiags);
  let bits = bitcast<u32>(v.x); outp[t] = bits;
  if (!sure(v, S * ${f(1.01 * (14 * OP + 20 * F64 + 4 * REP))}, S != 0.0)) {
    let k = slot(11u);
    if (k != 0xffffffffu) {
      lst[k] = c * P.width * P.height + y * P.width + x; lst[k + 1u] = bits;
      lst[k + 2u] = bitcast<u32>(q0); lst[k + 3u] = bitcast<u32>(q1); lst[k + 4u] = bitcast<u32>(q2);
      lst[k + 5u] = bitcast<u32>(q3); lst[k + 6u] = bitcast<u32>(q4); lst[k + 7u] = bitcast<u32>(q5);
      lst[k + 8u] = bitcast<u32>(q6); lst[k + 9u] = bitcast<u32>(q7); lst[k + 10u] = bitcast<u32>(q8);
    }
  }
}

fn epfAt(c: u32, x: i32, y: i32) -> f32 { return at(c, mir(x, i32(P.width)), mir(y, i32(P.height))); }
fn sad(c: u32, x: i32, y: i32, dx: i32, dy: i32) -> vec2f {
  var s = vec2f(0.0);
  for (var k = i32(gcOne() < 0.0); k < 5; k++) {
    let ox = select(select(0, -1, k == 1), 1, k == 3); let oy = select(select(0, -1, k == 0), 1, k == 4);
    s = dadd(s, dabs(ts(epfAt(c, x + ox, y + oy), -epfAt(c, x + dx + ox, y + dy + oy))));
  }
  return s;
}

@compute @workgroup_size(64)
fn epf1(@builtin(global_invocation_id) id: vec3u) {
  let t = id.x + id.y * 65535u * 64u; let n = P.width * (P.w21 - P.w20); if (t >= n) { return; }
  let x = t % P.width; let y = P.w20 + t / P.width; let sg = aux[(y >> 3u) * P.xsize + (x >> 3u)];
  let z0 = u32(gcOne() < 0.0);
  if (sg < 0.3) { for (var c = z0; c < 3u; c++) { outp[c * n + t] = bitcast<u32>(at(c, x, y)); } return; }
  let border = (x & 7u) == 0u || (x & 7u) == 7u || (y & 7u) == 0u || (y & 7u) == 7u;
  var factor = ddiv(vec2f(${f(-1.9330952441687866)}, ${f(-1.9330952441687866 - Math.fround(-1.9330952441687866))}), vec2f(sg, 0.0));
  if (border) { factor = dmul(factor, vec2f(pf(P.w11), pf(P.w12))); }
  let af = abs(factor.x);
  var ws = vec2f(1.0, 0.0);
  var v0 = vec2f(at(0u, x, y), 0.0); var v1 = vec2f(at(1u, x, y), 0.0); var v2 = vec2f(at(2u, x, y), 0.0);
  var ews = 0.0; var e0 = 0.0; var e1 = 0.0; var e2 = 0.0;
  var a0 = abs(v0.x); var a1 = abs(v1.x); var a2 = abs(v2.x);
  for (var k = i32(z0); k < 4; k++) {
    let dx = select(select(0, -1, k == 1), 1, k == 2); let dy = select(select(0, -1, k == 0), 1, k == 3);
    var dot = vec2f(0.0);
    for (var c = z0; c < 3u; c++) {
      let w = select(select(3.5, 5.0, c == 1u), 40.0, c == 0u);
      dot = dadd(dot, dmul(vec2f(w, 0.0), sad(c, i32(x), i32(y), dx, dy)));
    }
    let arg = dadd(vec2f(1.0, 0.0), dmul(dot, factor));
    let earg0 = abs(dot.x) * af * ${f(1.05 * (24 * OP + 30 * F64 + 4 * REP))} + ${f(4 * OP)};
    // A weight clipped with room to spare is zero on the CPU too: exactly, with no error to carry.
    let earg = select(earg0, 0.0, arg.x + earg0 < 0.0);
    var wt = arg; if (arg.x < 0.0) { wt = vec2f(0.0); }
    let nx = mir(i32(x) + dx, i32(P.width)); let ny = mir(i32(y) + dy, i32(P.height)); let aw = abs(wt.x);
    ws = dadd(ws, wt); ews += earg;
    let p0 = at(0u, nx, ny); v0 = dadd(v0, dmul(vec2f(p0, 0.0), wt)); e0 += abs(p0) * earg; a0 += abs(p0) * aw;
    let p1 = at(1u, nx, ny); v1 = dadd(v1, dmul(vec2f(p1, 0.0), wt)); e1 += abs(p1) * earg; a1 += abs(p1) * aw;
    let p2 = at(2u, nx, ny); v2 = dadd(v2, dmul(vec2f(p2, 0.0), wt)); e2 += abs(p2) * earg; a2 += abs(p2) * aw;
  }
  let w = abs(ws.x); let k8 = ${f(1.05 * (16 * OP + 20 * F64))}; let ewsT = ews + w * k8;
  var ok = true; var rb0 = 0u; var rb1 = 0u; var rb2 = 0u;
  for (var c = z0; c < 3u; c++) {
    let vc = select(select(v2, v1, c == 1u), v0, c == 0u);
    let ec = select(select(e2, e1, c == 1u), e0, c == 0u);
    let ac = select(select(a2, a1, c == 1u), a0, c == 0u);
    let r = ddiv(vc, ws); let rb = bitcast<u32>(r.x); outp[c * n + t] = rb;
    if (c == 0u) { rb0 = rb; } else if (c == 1u) { rb1 = rb; } else { rb2 = rb; }
    ok = ok && sure(r, ((ec + ac * k8) + abs(r.x) * ewsT) / w * 1.05 + abs(r.x) * ${f(4 * OP + 4 * F64)}, ac != 0.0);
  }
  if (!ok) {
    let k = slot(${6 + 3 * EPF_WINDOW.length}u);
    if (k != 0xffffffffu) {
      lst[k] = y * P.width + x; lst[k + 1u] = bitcast<u32>(sg); lst[k + 2u] = select(0u, 1u, border);
      lst[k + 3u] = rb0; lst[k + 4u] = rb1; lst[k + 5u] = rb2;
      const OX = array<i32, 13>(0, -1, 0, 1, -2, -1, 0, 1, 2, -1, 0, 1, 0);
      const OY = array<i32, 13>(-2, -1, -1, -1, 0, 0, 0, 0, 0, 1, 1, 1, 2);
      for (var j = z0; j < 13u; j++) { for (var c = z0; c < 3u; c++) { lst[k + 6u + 3u * j + c] = bitcast<u32>(epfAt(c, i32(x) + OX[j], i32(y) + OY[j])); } }
    }
  }
}

fn level(w: u32) -> u32 {
  if (w > 0x7f800000u) { return 0u; }
  let i = w >> 16u; let k = (table[i >> 2u] >> ((i & 3u) * 8u)) & 255u;
  return k + select(0u, 1u, w >= table[8192u + k + 1u]);
}

// aux: root (3), bias (3), m (9), as the kernels' xyb reads them.
@compute @workgroup_size(64)
fn color(@builtin(global_invocation_id) id: vec3u) {
  let t = id.x + id.y * 65535u * 64u; let n = P.width * (P.w21 - P.w20); if (t >= n) { return; }
  let x = gcO(src[t]); let y = gcO(src[n + t]); let b = gcO(src[2u * n + t]);
  let l = gcO(gcO(y + x) - aux[0]); let q = gcO(gcO(y - x) - aux[1]); let s = gcO(b - aux[2]);
  var a = vec2f(0.0); var d = vec2f(0.0); var c = vec2f(0.0);
  let z0 = u32(gcOne() < 0.0);
  for (var j = z0; j < 3u; j++) {
    let u = select(select(s, q, j == 1u), l, j == 0u);
    let w = xfma(gcO(u * u), u, aux[3u + j]);
    if (j == 0u) { a = w; } else if (j == 1u) { d = w; } else { c = w; }
  }
  var bad = a.y + d.y + c.y; var word = 0xff000000u;
  for (var k = z0; k < 3u; k++) {
    let inner = xfma(aux[7u + 3u * k], d.x, gcO(aux[6u + 3u * k] * a.x));
    let v = xfma(aux[8u + 3u * k], c.x, inner.x);
    bad += inner.y + v.y; outp[k * n + t] = bitcast<u32>(v.x); word |= level(bitcast<u32>(v.x)) << (8u * k);
  }
  px[t] = word;
  if (bad != 0.0) { let k = slot(4u); if (k != 0xffffffffu) { lst[k] = P.w20 * P.width + t; lst[k + 1u] = bitcast<u32>(x); lst[k + 2u] = bitcast<u32>(y); lst[k + 3u] = bitcast<u32>(b); } }
}

// The native byte (photo-output.mjs encodedByte): the transfer's knots in aux from P.w14 (V, R, S as double-single
// pairs), the dither in aux[0..1024), and the exact rational polynomial fallback when a knot interval straddles a half step.
fn byteOf(s: f32, d: f32) -> u32 { return u32(round(clamp(gcO(gcO(s * 255.0) + d), 0.0, 255.0))); }
const PC = array<f32, 5>(${P_COEF.map(f).join(', ')});
const QC = array<f32, 5>(${Q_COEF.map(f).join(', ')});

@compute @workgroup_size(64)
fn native(@builtin(global_invocation_id) id: vec3u) {
  let t = id.x + id.y * 65535u * 64u; let n = P.width * (P.w21 - P.w20); if (t >= n) { return; }
  let col = t % P.width; let row = P.w20 + t / P.width; var word = 0xff000000u;
  let z0 = u32(gcOne() < 0.0);
  for (var c = z0; c < 3u; c++) {
    let v = src[c * n + t]; let d = aux[((row + 13u * c) & 31u) * 32u + ((col + select(select(0u, 23u, c == 1u), 14u, c == 2u)) & 31u)];
    var byte = 0u; var known = true; let low = pf(P.w15);
    if (!(v > low) || v >= 1.0) {
      byte = byteOf(select(select(gcO(v * ${f(12.92)}), 0.0, !(v > 0.0)), 1.0, v >= 1.0), d);
    } else {
      let k = P.w14 + 6u * ((bitcast<u32>(v) - P.w15) >> 13u);
      let tr = dadd(vec2f(aux[k + 2u], aux[k + 3u]), dmul(dsub(vec2f(v, 0.0), vec2f(aux[k], aux[k + 1u])), vec2f(aux[k + 4u], aux[k + 5u])));
      let u = dadd(dmul(vec2f(255.0, 0.0), tr), vec2f(d, 0.0)); let ux = u.x + u.y; let m = ${f(2 ** -12 + 2 ** -16)};
      let lo = u32(floor(clamp(ux - m, 0.0, 255.0) + 0.5)); let hi = u32(floor(clamp(ux + m, 0.0, 255.0) + 0.5));
      byte = lo; known = lo == hi;
      if (!known) {
        let sq = xsqrt(v); let r = sq.x;
        var pv = PC[4]; var qv = QC[4]; var pbad = sq.y;
        for (var j = z0; j < 4u; j++) {
          let idx = 3u - j;
          let pn = xfma(pv, r, PC[idx]); pv = pn.x; pbad += pn.y;
          let qn = xfma(qv, r, QC[idx]); qv = qn.x; pbad += qn.y;
        }
        let res = xdiv(pv, qv);
        if (pbad + res.y == 0.0) {
          byte = byteOf(res.x, d); known = true;
        }
      }
    }
    word |= byte << (8u * c);
    if (!known) { let k = slot(3u); if (k != 0xffffffffu) { lst[k] = (P.w20 * P.width + t) * 3u + c; lst[k + 1u] = bitcast<u32>(v); lst[k + 2u] = bitcast<u32>(d); } }
  }
  px[n + t] = word;
}

// The CPU's samples where the device listed one: [index, value bits] into outp, or [pixel, mask, bytes] into px.
@compute @workgroup_size(64)
fn scatter(@builtin(global_invocation_id) id: vec3u) {
  let t = id.x + id.y * 65535u * 64u; if (t >= P.w13) { return; }
  if (P.w16 == 0u) { outp[table[2u * t] - P.w22] = table[2u * t + 1u]; }
  else { let i = table[3u * t] - P.w22; px[i] = (px[i] & ~table[3u * t + 1u]) | table[3u * t + 2u]; }
}`;

const ENTRIES = ['gaborish', 'epf1', 'color', 'native', 'scatter'];

function rebuildBands(blocks, parts, width, height, xsize, ysize, total, narrow, most, maxBuffer) {
  if (12 * width * height > maxBuffer) return false;
  const groupRows = Math.ceil(height / 256), first = new Int32Array(groupRows + 1);
  let row = 0;
  for (let k = 0; k < blocks.length; k++) {
    const b = blocks[k], r = b.y >> 5;
    if (r < row - 1 || (b.y + b.bh - 1) >> 5 !== r || r >= groupRows) return false;
    while (row <= r) first[row++] = k;
  }
  while (row <= groupRows) first[row++] = blocks.length;
  const small = [], words = k => parts[k].length;
  let at = 0;
  for (const k of [4, 5, 6, 7, 9]) { small[k] = at; at += words(k); }
  const coefAt = k => k < blocks.length ? blocks[k].coefficients[0] : total;
  const band = (r0, r1) => {
    const k0 = first[r0], k1 = first[r1], cy0 = r0 * 32, rc = Math.min(ysize, r1 * 32) - cy0, py0 = r0 * 256, wh = Math.min(height, r1 * 256) - py0;
    const ibase = coefAt(k0), cnt = coefAt(k1) - ibase;
    return {k0, nb: k1 - k0, ibase, cnt, intsWords: narrow ? Math.ceil(cnt / 2) : cnt, cy0, rc, py0, wh};
  };
  const window = list => {
    const top = key => Math.max(...list.map(b => b[key]));
    const ints = at, blk = ints + top('intsWords'), fac = blk + top('nb') * BW, lf = fac + top('nb') * 6, cells = lf + 3 * xsize * top('rc');
    return {layout: {ints, blk, fac, lf, cells}, most: {C: top('cnt') * 16, R0: 3 * xsize * top('rc') * 64 * 16, O: 3 * width * top('wh') * 4, M: cells + xsize * top('rc')}};
  };
  const fits = list => { const {most: m} = window(list); return Math.max(m.C, m.R0, m.O, m.M * 4) <= most; };
  const list = [];
  for (let r0 = 0; r0 < groupRows;) {
    let r1 = r0 + 1;
    if (!fits([...list, band(r0, r1)])) return false;
    while (r1 < groupRows && fits([...list, band(r0, r1 + 1)])) r1++;
    list.push(band(r0, r1)); r0 = r1;
  }
  const tall = Math.min(height, Math.floor(most / (12 * width)) - 4);
  if (tall < 1) return false;
  const rows = [];
  for (let y = 0; y < height; y += tall) rows.push([y, Math.min(height, y + tall)]);
  return {render: {list, ...window(list)}, rows: {list: rows, most: tall}, small};
}

function scatterRuns(entries, words, span) {
  if (span === Infinity) return [[0, entries]];
  const m = entries.length / words, order = Array.from({length: m}, (_, k) => k).sort((a, b) => entries[a * words] - entries[b * words]), runs = [];
  for (let j = 0; j < m;) {
    const base = Math.floor(entries[order[j] * words] / span) * span;
    let k = j; while (k < m && entries[order[k] * words] < base + span) k++;
    const out = new Uint32Array((k - j) * words);
    for (let q = j; q < k; q++) out.set(entries.subarray(order[q] * words, order[q] * words + words), (q - j) * words);
    runs.push([base, out]); j = k;
  }
  return runs;
}

const pipelineSet = device => {
  const mod = gpuModule(device, 'rebuild', REBUILD_SHADER);
  return Promise.all([
    gpuComputeSet(device, 'render', mod, 'ursssss', ['coefficients', 'lowFrequencies', 'samplesRow', 'samples']),
    gpuComputeSet(device, 'restore', mod, 'urrsrsss', ENTRIES),
  ]).then(([r, o]) => ({...r, ...o}));
};
export const gpuRebuildPipelines = device => Promise.all([pipelineSet(device), gpuS2Pipelines(device)]);

const auxes = new WeakMap(), auxOf = (dither, fast) => {
  let aux = auxes.get(fast);
  if (!aux) {
    const K = fast.V.length; aux = new Float32Array(1024 + 6 * K); aux.set(dither);
    for (let k = 0; k < K; k++) split([fast.V[k], fast.R[k], fast.S[k]], aux, 1024 + 6 * k);
    auxes.set(fast, aux);
  }
  return aux;
};
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer), asF = w => { u32[0] = w; return f32[0]; }, asU = v => { f32[0] = v; return u32[0]; };

const GAB_AT = [[1, 1], [0, 1], [2, 1], [1, 0], [1, 2], [0, 0], [2, 0], [0, 2], [2, 2]];
function gaborishSettle(kernels, list, gaborish) {
  const m = list.length / 11, w = 3 * m, planes = [0, 1, 2].map(() => new Float32Array(3 * w)), pairs = [];
  for (let k = 0; k < m; k++) GAB_AT.forEach(([dx, dy], j) => { planes[0][dy * w + 3 * k + dx] = asF(list[11 * k + 2 + j]); });
  const out = restorePlanes(kernels, planes, w, 3, {gaborish, epf: {iters: 0}}, null)[0];
  for (let k = 0; k < m; k++) {
    const bits = asU(out[w + 3 * k + 1]);
    if (bits !== list[11 * k + 1]) pairs.push(list[11 * k], bits);
  }
  return new Uint32Array(pairs);
}
function epfSettle(kernels, list, stride, width, n, epf) {
  const m = list.length / stride, w = 16 * m + 8, bw = 2 * m + 1, planes = [0, 1, 2].map(() => new Float32Array(24 * w)), sigma = new Float32Array(3 * bw), at = [];
  for (let k = 0; k < m; k++) {
    const e = k * stride, i = list[e], x = 16 * k + 8 + (i % width & 7), y = 8 + ((i / width | 0) & 7), s = asF(list[e + 1]);
    for (let by = 0; by < 3; by++) sigma[by * bw + 2 * k] = sigma[by * bw + 2 * k + 1] = s;
    at.push(y * w + x);
    EPF_WINDOW.forEach(([dx, dy], j) => { for (let c = 0; c < 3; c++) planes[c][(y + dy) * w + x + dx] = asF(list[e + 6 + 3 * j + c]); });
  }
  const out = restorePlanes(kernels, planes, w, 24, {gaborish: null, epf}, sigma), pairs = [];
  for (let k = 0; k < m; k++) for (let c = 0; c < 3; c++) {
    const bits = asU(out[c][at[k]]);
    if (bits !== list[k * stride + 3 + c]) pairs.push(c * n + list[k * stride], bits);
  }
  return new Uint32Array(pairs);
}


export async function gpuRebuild(device, image, lib) {
  const [set, s2State] = await Promise.all([
    pipelineSet(device),
    lib.held && lib.s2 ? gpuS2Prepare(device, lib.s2.held, lib.s2.tables, lib.s2.reference, lib.s2.width, lib.s2.height, 2, lib.signal) : null,
  ]);
  const whole = image.lazyStrategy ? image.lazyStrategy.materialize() : image;
  const tIn = tracing() ? performance.now() : 0;
  const {rebuild, kernels, constants, native} = lib, {inputs} = rebuild(whole, {inputs: true});
  if (tIn) traced('rebuild:inputs', performance.now() - tIn);
  const {width, height, xsize, ysize, arena, tables, lf, groups, global, bias, numerator, blocks, filter, sigma} = inputs, n = width * height;
  const gab = filter.gaborish === true ? [0.115169525, 0.061248592] : filter.gaborish ? filter.gaborish[0] : null;
  if (inputs.ycbcr || image.alpha || width < 3 || height < 3 || (filter.epf.iters ?? 0) > 1 || filter.gaborish && filter.gaborish !== true &&
    !filter.gaborish.every(([sd, dg]) => sd === gab[0] && dg === gab[1])) { traced('rebuild-left:inputs', 0); return null; }
  const bindMax = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize);
  const cap = Math.min(Math.max(4096, n >> 6), Math.floor(bindMax / 260));
  const held = lib.held && (!lib.held.device || lib.held.device === device) ? lib.held : null;
  const made = [], alloc = gpuAlloc(device, made), [kept, upKept, once] = gpuHeld(device, held, alloc);
  const dispatch = (target, kernel, buffers, count) => gpuStep(device, target, kernel, buffers, count);
  const read = async (source, bytes, name, offset = 0) => (await gpuRead(device, alloc, [[source, offset, bytes]], undefined, name, kept))[0];
  const tPack = tracing() ? performance.now() : 0;
  try {
    return await gpuScoped(device, 'gpu-render', async () => {
      const narrow = arena.BYTES_PER_ELEMENT === 2 ? 1 : 0, arenaWords = new Int32Array(arena.buffer, arena.byteOffset, Math.ceil(arena.byteLength / 4));
      const qList = [], qAt = new Map();
      let qTotal = 0;
      for (const [t, m] of tables) {
        qAt.set(t, qTotal);
        const len = m[0].length, q = new Float32Array(len * 3);
        q.set(m[0]); q.set(m[1], len); q.set(m[2], len * 2);
        qList.push(q); qTotal += q.length;
      }
      const qtab = new Float32Array(qTotal); { let at = 0; for (const q of qList) { qtab.set(q, at); at += q.length; } }
      const lfAll = new Float32Array(3 * xsize * ysize); lf.forEach((p, c) => lfAll.set(p.subarray(0, xsize * ysize), c * xsize * ysize));
      let layout = held?.layout, sameLayout = !!(layout && layout.xsize === xsize && layout.ysize === ysize && layout.len === blocks.length && layout.arenaWordsLen === arenaWords.length);
      if (sameLayout) {
        for (let k = 0; k < blocks.length; k++) {
          const b = blocks[k], o = k * BW;
          if (layout.blk[o + 3] !== (b.id | (SPECIAL(b.id) ? 0x100 : 0)) || layout.blk[o + 4] !== b.x || layout.blk[o + 5] !== b.y) { sameLayout = false; break; }
        }
      }
      let blk, cells, tabs, plainGrid;
      if (sameLayout) ({blk, cells, tabs, plainGrid} = layout);
      else {
        const tabList = [], tabAt = new Map(), table = (key, make) => {
          if (!tabAt.has(key)) { let at = 0; for (const t of tabList) at += t.length * 2; tabList.push(make()); tabAt.set(key, at); }
          return tabAt.get(key);
        };
        blk = new Uint32Array(blocks.length * BW); cells = new Uint32Array(xsize * ysize); plainGrid = blocks.length === xsize * ysize ? 1 : 0;
        for (let k = 0; k < blocks.length; k++) {
          const b = blocks[k], o = k * BW, shape = TRANSFORMS[b.id], w = shape.width, h = shape.height, W = Math.max(b.bw, b.bh), H = Math.min(b.bw, b.bh), spec = SPECIAL(b.id);
          if (b.id !== 0) plainGrid = 0;
          blk[o] = b.coefficients[0]; blk[o + 1] = b.coefficients[1]; blk[o + 2] = b.coefficients[2];
          blk[o + 3] = b.id | (spec ? 0x100 : 0); blk[o + 4] = b.x; blk[o + 5] = b.y; blk[o + 6] = w; blk[o + 7] = h;
          blk[o + 8] = qAt.get(shape.table); blk[o + 9] = b.lfGroup; blk[o + 10] = !spec && h >= w ? 1 : 0; blk[o + 11] = Math.max(w, h);
          blk[o + 12] = b.bw; blk[o + 13] = b.bh;
          blk[o + 14] = b.area > 1 ? table('T' + b.bw, () => basisT(b.bw)) : 0;
          blk[o + 15] = b.area > 1 ? table('B' + b.bh, () => basis(b.bh)) : 0;
          blk[o + 16] = b.area > 1 ? table('DI' + W + 'x' + H, () => Float64Array.from(llfDivisors(W, H), v => 1 / v)) : 0;
          blk[o + 17] = table('S' + w, () => scaledBasis(w));
          blk[o + 18] = table('S' + h, () => scaledBasis(h));
          for (let y = 0; y < b.bh; y++) cells.fill(k, (b.y + y) * xsize + b.x, (b.y + y) * xsize + b.x + b.bw);
        }
        tabs = new Float32Array(tabList.reduce((s, t) => s + t.length * 2, 0));
        let at = 0; for (const t of tabList) { split(t, tabs, at); at += t.length * 2; }
      }
      const uniformMult = !image.quantFields ? blocks[0]?.multiplier ?? 32 : null;
      const sameFac = !!(sameLayout && uniformMult !== null && layout.uniformMult === uniformMult && layout.globalScale === global.globalScale);
      let fac;
      if (sameFac) fac = layout.fac;
      else {
        fac = new Float32Array(blocks.length * 6);
        for (let k = 0; k < blocks.length; k++) {
          const factor = 65536 / (global.globalScale * blocks[k].multiplier), hi = Math.fround(factor), lo = Math.fround(factor - hi), o = k * 6;
          fac[o] = fac[o + 2] = fac[o + 4] = hi; fac[o + 1] = fac[o + 3] = fac[o + 5] = lo;
        }
      }
      const sameCfl = !!(sameLayout && image.cfl && layout.cfl === image.cfl && layout.corrFactor === global.correlation.factor);
      let grp, maps, consts;
      if (sameCfl) ({grp, maps, consts} = layout);
      else {
        grp = new Uint32Array(groups.length * 5); maps = new Int32Array(groups.reduce((s, g) => s + g.xFromY.length + g.bFromY.length, 0));
        let mapAt = 0;
        groups.forEach((g, k) => { grp.set([mapAt, mapAt + g.xFromY.length, g.width, g.bx, g.by], k * 5); maps.set(g.xFromY, mapAt); maps.set(g.bFromY, mapAt + g.xFromY.length); mapAt += g.xFromY.length + g.bFromY.length; });
        consts = split([bias[0], bias[1], bias[2], numerator, global.correlation.baseX, global.correlation.baseB, 1 / global.correlation.factor]);
      }
      const parts = [arenaWords, new Uint32Array(0), blk, fac, qtab, tabs, grp, maps, lfAll, consts, cells];
      const offsets = [], words = parts.reduce((s, p) => (offsets.push(s), s + p.length), 0), MB = kept('MB', words * 4);
      const mbFresh = layout?.mb !== MB;
      for (let k = 0; k < parts.length; k++) {
        const p = parts[k];
        if (!p.length) continue;
        if (!mbFresh && sameLayout && (k === 2 || k === 5 || k === 10)) continue;
        if (!mbFresh && sameFac && k === 3) continue;
        if (!mbFresh && sameCfl && (k === 6 || k === 7 || k === 9)) continue;
        gpuWrite(device, MB, p, offsets[k] * 4);
      }
      if (held) held.layout = {xsize, ysize, len: blocks.length, arenaWordsLen: arenaWords.length, blk, cells, tabs, plainGrid, fac, uniformMult, globalScale: global.globalScale, cfl: image.cfl, corrFactor: global.correlation.factor, grp, maps, consts, mb: MB};

      const specialBlocks = [];
      for (let k = 0; k < blocks.length; k++) if (SPECIAL(blocks[k].id)) specialBlocks.push(k);
      const r0Bytes = 3 * xsize * ysize * 64 * 16;
      const uni = new ArrayBuffer(112), u32Uni = new Uint32Array(uni);
      u32Uni.set([width, height, xsize, blocks.reduce((s, b) => s + b.area * 192, 0), 0, blocks.length, 0, cap, ...offsets]);
      u32Uni[9] = narrow; u32Uni[19] = plainGrid; u32Uni[23] = ysize; u32Uni[25] = height; u32Uni[26] = specialBlocks.length ? 1 : 0;
      new Float32Array(uni)[4] = 1;
      const bands = Math.max(u32Uni[3] * 16, r0Bytes, 3 * n * 4, words * 4) <= bindMax ? null : rebuildBands(blocks, parts, width, height, xsize, ysize, u32Uni[3], narrow, bindMax, device.limits.maxBufferSize);
      if (bands === false) { traced('rebuild-left:band', 0); return null; }
      const P0 = kept('P0', 3 * n * 4), P1 = gab ? kept('P1', 3 * n * 4) : P0, P2 = filter.epf.iters === 1 ? kept('P2', 3 * n * 4) : P1, P3 = kept('P3', 3 * n * 4);
      const PX = kept('PX', 2 * n * 4), CNT = kept('CNT', 32);
      const STRIDE2 = 6 + 3 * EPF_WINDOW.length;
      const LBASE0 = 0, LBASE1 = cap * 2, LBASE2 = LBASE1 + cap * 11, LBASE3 = LBASE2 + cap * STRIDE2, LBASE4 = LBASE3 + cap * 4;
      const LST = kept('LST', (LBASE4 + cap * 3) * 4);
      const uniUse = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
      const ub = upKept('UB', new Uint8Array(uni), uniUse);
      const render = bands ? null : [ub, MB, kept('C', u32Uni[3] * 16), P0, CNT, LST, kept('R0', r0Bytes)];
      const restoreUniform = (name, extra = {}) => {
        const u = new ArrayBuffer(112), U = new Uint32Array(u), F = new Float32Array(u);
        U.set([width, height, Math.ceil(width / 8), cap]); F[4] = 1;
        if (gab) split([gab[0], gab[1], 1 / (1 + 4 * gab[0] + 4 * gab[1])], F, 5);
        split([filter.epf.borderSadMul ?? 2 / 3], F, 11);
        U.set([extra.count ?? 0, extra.knots ?? 0, extra.low ?? 0, extra.stage ?? 0, extra.lbase ?? 0, extra.wy0 ?? 0, extra.wh ?? height, extra.oy0 ?? 0, extra.oy1 ?? height, extra.base ?? 0], 13);
        return upKept(name, new Uint8Array(u), uniUse);
      };
      const none = kept('N0', 16), spare = kept('N1', 16);
      const srgb8 = once('S8', () => { const tAt = kernels.srgb8Table(); return new Uint32Array(kernels.buffer.slice(tAt, tAt + 33796)); });
      const kColor = once('KC', () => Float32Array.from([...constants.root, ...constants.bias, ...constants.m]));
      const {dither, fast} = native.nativeTables(), kNative = once('AX', () => auxOf(dither, fast));
      const sgBuf = filter.epf.iters === 1 ? upKept('SG', sigma) : none;
      const ur1 = gab ? restoreUniform('UR1', {stage: 1, lbase: LBASE1}) : null;
      const ur2 = filter.epf.iters === 1 ? restoreUniform('UR2', {stage: 2, lbase: LBASE2}) : null;
      const ur3 = restoreUniform('UR3', {stage: 3, lbase: LBASE3});
      const ur4 = restoreUniform('UR4', {stage: 4, lbase: LBASE4, knots: 1024, low: fast.low});

      const LBASES = [LBASE0, LBASE1, LBASE2, LBASE3, LBASE4], STRIDES = [2, 11, STRIDE2, 4, 3];
      const seen = prefSeen.get(device) ?? prefSeen.set(device, [0, 0, 0, 0, 0]).get(device);
      const PREF = [512, 2816, 5760, 256, 192].map((p, s) => Math.max(Math.ceil(p * Math.max(1, n / 393216) / 64) * 64, Math.ceil(Math.min(seen[s], cap) * 1.25 * STRIDES[s] / 64) * 64)).map((p, s) => Math.min(p, cap * STRIDES[s]));
      const wantBand = !!(held && lib.keep && lib.band), wantFull = !(held && lib.keep);
      const bandY0 = wantBand ? lib.band[0] : 0, bandBytes = wantBand ? (lib.band[1] - bandY0) * width * 4 : 0;
      const offPrefs = [];
      let rbTotal = 32;
      for (let s = 0; s < 5; s++) { offPrefs.push(rbTotal); rbTotal += PREF[s] * 4; }
      const a8 = v => Math.ceil(v / 8) * 8, pxBytes = wantBand ? bandBytes * 2 : wantFull ? 2 * n * 4 : 0, s2Bytes = s2State ? s2State.sBytes + 16 : 0;
      const offPx = a8(rbTotal), offS2 = a8(offPx + pxBytes);
      rbTotal = offS2 + s2Bytes;
      const RB = kept('RBS', rbTotal, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
      const stages = [[set.gaborish, [ur1, P0, none, P1, none, CNT, LST, PX], 3 * n, gab], [set.epf1, [ur2, P1, sgBuf, P2, none, CNT, LST, PX], n, filter.epf.iters === 1],
        [set.color, [ur3, P2, kColor, P3, srgb8, CNT, LST, PX], n, true], [set.native, [ur4, P3, kNative, spare, none, CNT, LST, PX], n, true]];
      let recordBands = null;
      if (bands) {
        const {render: rb, rows, small} = bands, C = kept('CW', rb.most.C), R0W = kept('R0W', rb.most.R0), O = kept('P0W', rb.most.O), MW = kept('MW', rb.most.M * 4);
        const SW = kept('SW', 3 * width * (rows.most + 4) * 4), DW = kept('DW', 3 * width * rows.most * 4), PW = kept('PXW', 2 * width * rows.most * 4);
        const bandRender = rb.list.map((b, j) => {
          const u = new Uint32Array(uni.slice(0)), L = rb.layout;
          u[3] = b.cnt; u[5] = b.nb;
          u[8] = L.ints; u[10] = L.blk; u[11] = L.fac; u[12] = small[4]; u[13] = small[5]; u[14] = small[6]; u[15] = small[7]; u[16] = L.lf; u[17] = small[9]; u[18] = L.cells;
          u.set([b.ibase, b.k0, b.cy0, b.rc, b.py0, b.wh], 20);
          return [upKept('UB' + j, new Uint8Array(u.buffer), uniUse), MW, C, O, CNT, LST, R0W];
        });
        const io = [[P0, P1, 1], [P1, P2, 2], [P2, P3, 0], [P3, null, 0]];
        const bandRestore = stages.map(([, buffers], k) => rows.list.map(([y0, y1], j) => {
          const h = io[k][2], wy0 = Math.max(0, y0 - h), wh = Math.min(height, y1 + h) - wy0;
          const u = restoreUniform('UR' + (k + 1) + '-' + j, {stage: k + 1, lbase: [LBASE1, LBASE2, LBASE3, LBASE4][k], ...(k === 3 ? {knots: 1024, low: fast.low} : {}), wy0, wh, oy0: y0, oy1: y1});
          return {wy0, wh, y0, y1, buffers: [u, SW, buffers[2], k === 3 ? spare : DW, buffers[4], CNT, LST, PW]};
        }));
        recordBands = (e, from) => {
          const copy = (a, at, b, bt, words) => { if (words) e.copyBufferToBuffer(a, at * 4, b, bt * 4, words * 4); };
          if (!from) {
            for (const [k, at] of [[4, small[4]], [5, small[5]], [6, small[6]], [7, small[7]], [9, small[9]]]) copy(MB, offsets[k], MW, at, parts[k].length);
            rb.list.forEach((b, j) => {
              const L = rb.layout;
              copy(MB, offsets[0] + (narrow ? b.ibase / 2 : b.ibase), MW, L.ints, b.intsWords);
              copy(MB, offsets[2] + b.k0 * BW, MW, L.blk, b.nb * BW); copy(MB, offsets[3] + b.k0 * 6, MW, L.fac, b.nb * 6);
              for (let c = 0; c < 3; c++) copy(MB, offsets[8] + c * xsize * ysize + b.cy0 * xsize, MW, L.lf + c * xsize * b.rc, xsize * b.rc);
              copy(MB, offsets[10] + b.cy0 * xsize, MW, L.cells, xsize * b.rc);
              dispatch(e, set.coefficients, bandRender[j], b.cnt); dispatch(e, set.lowFrequencies, bandRender[j], b.nb * 3072);
              dispatch(e, set.samplesRow, bandRender[j], 3 * xsize * b.rc * 64); dispatch(e, set.samples, bandRender[j], 3 * width * b.wh);
              for (let c = 0; c < 3; c++) copy(O, c * width * b.wh, P0, c * n + b.py0 * width, width * b.wh);
            });
          }
          stages.forEach(([kernel, , count, on], k) => {
            if (!on || from > k + 1) return;
            const [src, dst] = io[k];
            for (const {wy0, wh, y0, y1, buffers} of bandRestore[k]) {
              const m = width * (y1 - y0);
              for (let c = 0; c < 3; c++) copy(src, c * n + wy0 * width, SW, c * width * wh, width * wh);
              dispatch(e, kernel, buffers, count / n * m);
              if (dst) for (let c = 0; c < 3; c++) copy(DW, c * m, dst, c * n + y0 * width, m);
              if (k === 2) copy(PW, 0, PX, y0 * width, m);
              if (k === 3) copy(PW, m, PX, n + y0 * width, m);
            }
          });
        };
      }
      const pendingScatters = [];
      let scatterSeq = 0;
      const scatter = (into, pairs, words = 2) => {
        if (!pairs.length) return false;
        pendingScatters.push([into, pairs instanceof Uint32Array ? pairs : Uint32Array.from(pairs), words]);
        return true;
      };
      const flushScatters = target => {
        if (!pendingScatters.length) return;
        for (const [into, arr, words] of pendingScatters.splice(0)) {
          for (const [base, list] of scatterRuns(arr, words, bands ? Math.floor(bindMax / 256) * 64 : Infinity)) {
            const slot = scatterSeq++, corrections = upKept('CR' + slot, list), count = list.length / words;
            const view = bands ? {buffer: into, offset: base * 4, size: Math.min(into.size - base * 4, Math.floor(bindMax / 256) * 256)} : into;
            dispatch(target, set.scatter, [restoreUniform('URS' + slot, {count, base, stage: words === 2 ? 0 : 1}), none, none, words === 2 ? view : spare, corrections, CNT, LST, words === 2 ? PX : view], count);
          }
        }
      };
      let preSpecial = null;
      if (specialBlocks.length) {
        const {rendered} = rebuild(whole, {rendered: true, only: new Set(specialBlocks)}), pairs = [];
        for (const k of specialBlocks) {
          const b = blocks[k], x0 = b.x * 8, y0 = b.y * 8, xs = Math.min(b.bw * 8, width - x0), ys = Math.min(b.bh * 8, height - y0);
          for (let c = 0; c < 3; c++) for (let dy = 0; dy < ys; dy++) for (let dx = 0; dx < xs; dx++) {
            const idx = (y0 + dy) * width + x0 + dx;
            pairs.push(c * n + idx, asU(rendered[c][idx]));
          }
        }
        preSpecial = new Uint32Array(pairs);
      }
      let mapped = false;
      const release = () => { if (mapped) { mapped = false; RB.unmap(); } };
      const run = async (from, tail = true) => {
        release();
        scatterSeq = 0;
        gpuWrite(device, CNT, new Uint32Array(8));
        const e = device.createCommandEncoder();
        if (bands) {
          flushScatters(e);
          if (!from && preSpecial?.length) {
            recordBands(e, 0);
          } else recordBands(e, from);
        } else {
          const pass = e.beginComputePass();
          flushScatters(pass);
          if (!from) {
            dispatch(pass, set.coefficients, render, u32Uni[3]); dispatch(pass, set.lowFrequencies, render, blocks.length * 3072);
            dispatch(pass, set.samplesRow, render, 3 * xsize * ysize * 64); dispatch(pass, set.samples, render, 3 * n);
            if (preSpecial?.length) { scatter(P0, preSpecial); flushScatters(pass); }
          }
          stages.forEach(([kernel, buffers, count, on], k) => { if (on && from <= k + 1) dispatch(pass, kernel, buffers, count); });
          pass.end();
        }
        if (bands && !from && preSpecial?.length) {
          scatter(P0, preSpecial); flushScatters(e); recordBands(e, 1);
        }
        if (tail && s2State) gpuS2Record(device, e, s2State, PX, RB, offS2);
        e.copyBufferToBuffer(CNT, 0, RB, 0, 20);
        for (let s = 0; s < 5; s++) e.copyBufferToBuffer(LST, LBASES[s] * 4, RB, offPrefs[s], PREF[s] * 4);
        if (tail && wantBand) { e.copyBufferToBuffer(PX, bandY0 * width * 4, RB, offPx, bandBytes); e.copyBufferToBuffer(PX, (n + bandY0 * width) * 4, RB, offPx + bandBytes, bandBytes); }
        else if (tail && wantFull) e.copyBufferToBuffer(PX, 0, RB, offPx, 2 * n * 4);
        device.queue.submit([e.finish()]); lib.onSubmit?.();
        const tWait = tracing() ? performance.now() : 0;
        await gpuMap(device, RB, 0, rbTotal);
        if (tWait) traced('rebuild:wait', performance.now() - tWait);
        mapped = true; return RB.getMappedRange(0, offPx);
      };
      const settle = [list => {
        const only = new Set(), diff = [];
        for (let k = 0; k < list.length; k += 2) { const i = list[k] % n; only.add(cells[((i / width | 0) >> 3) * xsize + ((i % width) >> 3)]); }
        const {rendered} = rebuild(whole, {rendered: true, only});
        for (let k = 0; k < list.length; k += 2) { const t = list[k], u = asU(rendered[t / n | 0][t % n]); if (u !== list[k + 1]) diff.push(t, u); }
        return scatter(P0, diff);
      }, list => scatter(P1, gaborishSettle(kernels, list, filter.gaborish)), list => scatter(P2, epfSettle(kernels, list, STRIDE2, width, n, filter.epf)), list => {
        const m = list.length / 4;
        const [x, y, b, o] = kernels.reserve([m * 4, m * 4, m * 4, m * 4]), X = new Float32Array(kernels.buffer, x, m), Y = new Float32Array(kernels.buffer, y, m), Bp = new Float32Array(kernels.buffer, b, m);
        for (let k = 0; k < m; k++) { X[k] = asF(list[4 * k + 1]); Y[k] = asF(list[4 * k + 2]); Bp[k] = asF(list[4 * k + 3]); }
        const rgba8 = new Uint8Array(kernels.buffer, o, m * 4); kernels.xyb(m, X, Y, Bp, constants, rgba8);
        const words = [];
        for (let k = 0; k < m; k++) words.push(list[4 * k], 0x00ffffff, rgba8[4 * k] | rgba8[4 * k + 1] << 8 | rgba8[4 * k + 2] << 16);
        scatter(PX, words, 3);
        kernels.xyb(m, X, Y, Bp, constants);
        const pairs = [];
        for (let k = 0; k < m; k++) pairs.push(list[4 * k], asU(X[k]), n + list[4 * k], asU(Y[k]), 2 * n + list[4 * k], asU(Bp[k]));
        return scatter(P3, pairs);
      }, list => {
        const byPixel = new Map(), words = [];
        for (let k = 0; k < list.length; k += 3) {
          const t = list[k] / 3 | 0, c = list[k] % 3, byte = native.nativeByte(asF(list[k + 1]), asF(list[k + 2]));
          const w = byPixel.get(t) ?? [0, 0]; w[0] |= 255 << (8 * c); w[1] |= byte << (8 * c); byPixel.set(t, w);
        }
        for (const [t, [mask, value]] of byPixel) words.push(n + t, mask, value);
        return scatter(PX, words, 3);
      }];
      if (tPack) traced('rebuild:pack', performance.now() - tPack);
      try {
      let snap = await run(0, true);
      for (let s = 0; s < 3; s++) {
        const c = new Uint32Array(snap, 0, 5)[s], words = c * STRIDES[s];
        if (c > seen[s]) seen[s] = c;
        if (c > cap) { traced('rebuild-left:settle-cap', 0); return null; }
        if (!c) continue;
        const list = words <= PREF[s] ? new Uint32Array(snap, offPrefs[s], words) : new Uint32Array(await read(LST, words * 4, 'R lists', LBASES[s] * 4));
        const tSettle = tracing() ? performance.now() : 0, changed = settle[s](list);
        if (tSettle) traced('rebuild:settle-' + s, performance.now() - tSettle);
        if (changed) snap = await run(s + 1, true);
      }
      for (const s of [3, 4]) {
        const c = new Uint32Array(snap, 0, 5)[s], words = c * STRIDES[s];
        if (c > seen[s]) seen[s] = c;
        if (c > cap) { traced('rebuild-left:settle-cap', 0); return null; }
        if (!c) continue;
        const list = words <= PREF[s] ? new Uint32Array(snap, offPrefs[s], words) : new Uint32Array(await read(LST, words * 4, 'R lists', LBASES[s] * 4));
        const tSettle = tracing() ? performance.now() : 0, changed = settle[s](list);
        if (tSettle) traced('rebuild:settle-' + s, performance.now() - tSettle);
        if (changed) snap = await run(s + 1, true);
      }
      const readAll = async () => { const out = new Uint8Array(await read(PX, 2 * n * 4, 'R')); return {rgba: out.subarray(0, 4 * n), native: out.subarray(4 * n)}; };
      const s2 = s2State ? {s2: gpuS2Decode(s2State, RB.getMappedRange(offS2, s2Bytes), 0)} : {};
      const pxMap = pxBytes ? RB.getMappedRange(offPx, pxBytes) : null, out = (at, bytes) => new Uint8Array(pxMap.slice(at, at + bytes));
      return held && lib.keep ? {px: PX, band: wantBand ? {rgba: out(0, bandBytes), native: out(bandBytes, bandBytes)} : null, readAll, ...s2}
        : {rgba: out(0, 4 * n), native: out(4 * n, 4 * n), ...s2};
      } finally { release(); }
    }, true, err => { held?.release(); throw fault('JXL_WEBGPU', 'gpu-render: ' + err.message); });
  } finally { gpuDestroy(made); }
}
