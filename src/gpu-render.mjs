// SPDX-License-Identifier: MIT
import {GC_DS} from './gpu-arithmetic.mjs';
import {XFMA, gpuS2Prepare, gpuS2Record, gpuS2Decode} from './gpu-s2.mjs';
import {gpuComputeSet, gpuBuffers} from './gpu-kit.mjs';
import {TRANSFORMS, basis, basisT, llfDivisors} from './vardct-bases.mjs';
import {scaledBasis, restorePlanes} from './vardct-inverse.mjs';

const OP = 4e-14, F64 = 1.2e-16, REP = 2 ** -47;
const SPECIAL = id => id === 1 || id === 2 || id === 3 || id >= 12 && id <= 17;
const BW = 20;
const P_COEF = [-5.135152395e-4, 5.287254571e-3, 3.903842876e-1, 1.474205315, 7.352629620e-1];
const Q_COEF = [1.004519624e-2, 3.036675394e-1, 1.340816930, 9.258482155e-1, 2.424867759e-2];
const f = v => { const s = Math.fround(v).toString(); return /[.eE]/.test(s) ? s : s + '.0'; };

const RENDER_SHADER = `${GC_DS}
struct U { width: u32, height: u32, xsize: u32, count: u32, blocks: u32, one: f32, factor: f32, cap: u32,
  ints: u32, owner: u32, blk: u32, fac: u32, qtab: u32, tabs: u32, grp: u32, maps: u32, lf: u32, consts: u32, cells: u32, pad2: u32 }
@group(0) @binding(0) var<uniform> P: U;
@group(0) @binding(1) var<storage, read> M: array<u32>;
@group(0) @binding(2) var<storage, read_write> C: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> outp: array<u32>;
@group(0) @binding(4) var<storage, read_write> cnt: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read_write> lst: array<u32>;
fn flag(t: u32, v: u32) { let k = atomicAdd(&cnt[0], 1u); if (k < P.cap) { lst[2u * k] = t; lst[2u * k + 1u] = v; } }
fn ints(i: u32) -> i32 {
  if (P.owner != 0u) {
    let w = bitcast<i32>(M[P.ints + (i >> 1u)]);
    return select((w << 16) >> 16, w >> 16, (i & 1u) != 0u);
  }
  return bitcast<i32>(M[P.ints + i]);
}
fn blk(i: u32) -> u32 { return M[P.blk + i]; }
fn fac(i: u32) -> f32 { return bitcast<f32>(M[P.fac + i]); }
fn qtab(i: u32) -> f32 { return bitcast<f32>(M[P.qtab + i]); }
fn tabs(i: u32) -> f32 { return bitcast<f32>(M[P.tabs + i]); }
fn grp(i: u32) -> u32 { return M[P.grp + i]; }
fn maps(i: u32) -> i32 { return bitcast<i32>(M[P.maps + i]); }
fn lf(i: u32) -> f32 { return bitcast<f32>(M[P.lf + i]); }
fn consts(i: u32) -> f32 { return bitcast<f32>(M[P.consts + i]); }
fn cells(i: u32) -> u32 { return M[P.cells + i]; }
fn gcOne() -> f32 { return P.one; }
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
  let e = id.x + id.y * 65535u * 64u; if (e >= P.count) { return; }
  // The block holding e: blocks lie in the arena in order, each its X, Y and B coefficients in turn.
  var lo = 0u;
  if (P.pad2 != 0u) { lo = e / 192u; }
  else { var hi = P.blocks; while (hi - lo > 1u) { let mid = (lo + hi) / 2u; if (blk(mid * ${BW}u) <= e) { lo = mid; } else { hi = mid; } } }
  let b = lo; let o = b * ${BW}u; let size = blk(o + 6u) * blk(o + 7u); let c = (e - blk(o)) / size; let i = (e - blk(o)) % size;
  var r = dq(b, c, i);
  if (c != 1u) {
    let y = dq(b, 1u, i);
    if (y.w != 0.0) {
      let wide = blk(o + 11u); let u = i % wide; let v = i / wide; let tr = blk(o + 10u) != 0u;
      let g = blk(o + 9u) * 5u; let gw = grp(g + 2u); let gbx = grp(g + 3u); let gby = grp(g + 4u);
      let bx = blk(o + 4u); let by = blk(o + 5u);
      let tu = select((bx * 8u + u) / 64u - (gbx >> 3u), (by * 8u + u) / 64u - (gby >> 3u), tr);
      let tv = select((by * 8u + v) / 64u - (gby >> 3u), (bx * 8u + v) / 64u - (gbx >> 3u), tr);
      let ci = select(tv * gw + tu, tu * gw + tv, tr);
      let map = maps(grp(g + select(1u, 0u, c == 0u)) + ci);
      let corr = dadd(cs(select(5u, 4u, c == 0u)), ddiv(vec2f(f32(map), 0.0), vec2f(P.factor, 0.0)));
      let t = dmul(corr, y.xy); let ac = abs(corr.x);
      let s = dadd(r.xy, t);
      r = vec4f(s, r.z + ac * y.z + (abs(t.x) + abs(s.x)) * ${f(4 * OP)} + ac * y.w * ${f(4 * OP + REP)}, abs(s.x));
    }
  }
  C[e] = r;
}
// The LF positions of a block of bw x bh cells: the LF image's means, their scaled DCT, divided (rebuildPicture's llf).
@compute @workgroup_size(64)
fn lowFrequencies(@builtin(global_invocation_id) id: vec3u) {
  let t = id.x + id.y * 65535u * 64u; if (t >= P.blocks * 3u * 1024u) { return; }
  let b = t / 3072u; let c = (t / 1024u) % 3u; let k = t % 1024u; let o = b * ${BW}u;
  let bw = blk(o + 12u); let bh = blk(o + 13u); let area = bw * bh; if (k >= area || ((blk(o + 3u) & 0x100u) != 0u)) { return; }
  let bx = blk(o + 4u); let by = blk(o + 5u); let plane = c * P.xsize * ((P.height + 7u) / 8u);
  let W = max(bw, bh); let canon = blk(o + 11u); let pos = (k / W) * canon + k % W; let at = blk(o + c) + pos;
  if (area == 1u) { C[at] = vec4f(lf(plane + by * P.xsize + bx), 0.0, 0.0, abs(lf(plane + by * P.xsize + bx))); return; }
  let tall = bh >= bw; var kk: u32; var v: u32;
  if (tall) { kk = k / bh; v = k % bh; } else { v = k / bw; kk = k % bw; }
  let bt = blk(o + 14u); let bb = blk(o + 15u);
  var low = vec2f(0.0); var S = 0.0;
  for (var y = 0u; y < bh; y++) {
    var row = vec2f(0.0); var rs = 0.0;
    for (var x = 0u; x < bw; x++) {
      let m = vec2f(lf(plane + (by + y) * P.xsize + bx + x), 0.0); let p = dmul(m, ds(bt + 2u * (x * bw + kk)));
      row = dadd(row, p); rs += abs(p.x);
    }
    let q = dmul(row, ds(bb + 2u * (v * bh + y))); low = dadd(low, q); S += rs * abs(tabs(bb + 2u * (v * bh + y)));
  }
  let d = ds(blk(o + 16u) + 2u * k); let r = ddiv(low, d); let ad = abs(d.x);
  C[at] = vec4f(r, (S / ad) * ${f(1.01)} * (f32(2u * area + 8u) * ${f(OP + F64)} + ${f(3 * REP)}), abs(r.x));
}
// One sample of one plane: the block's inverse transform at that position, certified against the binary32 store.
@compute @workgroup_size(64)
fn samples(@builtin(global_invocation_id) id: vec3u) {
  let t = id.x + id.y * 65535u * 64u; let n = P.width * P.height; if (t >= 3u * n) { return; }
  let c = t / n; let s = t % n; let px = s % P.width; let py = s / P.width;
  let b = cells((py >> 3u) * P.xsize + (px >> 3u)); let o = b * ${BW}u;
  if ((blk(o + 3u) & 0x100u) != 0u) { outp[t] = 0u; flag(t, 0xffffffffu); return; }
  let w = blk(o + 6u); let h = blk(o + 7u); let x = px - blk(o + 4u) * 8u; let y = py - blk(o + 5u) * 8u; let tall = h >= w;
  let cb = blk(o + c); let tw = blk(o + 17u); let th = blk(o + 18u);
  var acc = vec2f(0.0); var S = 0.0; var E = 0.0; var terms = 0u;
  for (var v = 0u; v < h; v++) {
    let bh = ds(th + 2u * (v * h + y)); let ah = abs(bh.x);
    for (var u = 0u; u < w; u++) {
      let k = C[cb + select(v * w + u, u * h + v, tall)];
      if (k.w == 0.0 && k.x == 0.0) { continue; }
      let bw = ds(tw + 2u * (u * w + x)); let p = dmul(dmul(k.xy, bw), bh); let aw = abs(bw.x);
      acc = dadd(acc, p); S += k.w * aw * ah; E += k.z * aw * ah; terms++;
    }
  }
  let B = E * ${f(1.01)} + S * ${f(1.01)} * (f32(3u * terms + 4u) * ${f(OP)} + f32(w + h + 24u) * ${f(F64)} + ${f(4 * REP)});
  let hi = acc.x; let valBits = bitcast<u32>(hi); outp[t] = valBits;
  if (S == 0.0) { return; }
  let a = abs(hi); let bits = bitcast<u32>(a);
  if (a < 1e-30) { flag(t, valBits); return; }
  var ulp = bitcast<f32>(bits & 0x7f800000u) * ${f(2 ** -23)};
  if ((bits & 0x007fffffu) == 0u) { ulp = ulp * 0.5; }
  if (!(abs(acc.y) + B < 0.5 * ulp)) { flag(t, valBits); }
}`;



const EPF_WINDOW = [[0, -2], [-1, -1], [0, -1], [1, -1], [-2, 0], [-1, 0], [0, 0], [1, 0], [2, 0], [-1, 1], [0, 1], [1, 1], [0, 2]];
const RESTORE_SHADER = `${GC_DS}
${XFMA}
struct R { width: u32, height: u32, sw: u32, cap: u32, one: f32, side: f32, sideLo: f32, diag: f32, diagLo: f32, normal: f32, normalLo: f32,
  border: f32, borderLo: f32, count: u32, knots: u32, low: u32, stage: u32, lbase: u32, pad0: u32, pad1: u32 }
@group(0) @binding(0) var<uniform> P: R;
@group(0) @binding(1) var<storage, read> src: array<f32>;
@group(0) @binding(2) var<storage, read> aux: array<f32>;
@group(0) @binding(3) var<storage, read_write> dst: array<u32>;
@group(0) @binding(4) var<storage, read> table: array<u32>;
@group(0) @binding(5) var<storage, read_write> cnt: array<atomic<u32>>;
@group(0) @binding(6) var<storage, read_write> lst: array<u32>;
@group(0) @binding(7) var<storage, read_write> px: array<u32>;
fn gcOne() -> f32 { return P.one; }
fn at(c: u32, x: u32, y: u32) -> f32 { return src[c * P.width * P.height + y * P.width + x]; }
fn mir(v: i32, n: i32) -> u32 { if (v < 0) { return u32(-v - 1); } if (v >= n) { return u32(2 * n - v - 1); } return u32(v); }
fn slot(stride: u32) -> u32 { let k = atomicAdd(&cnt[P.stage], 1u); return select(0xffffffffu, P.lbase + k * stride, k < P.cap); }
// Whether the CPU's binary64 value, within B of v, stores as v.x.
fn sure(v: vec2f, B: f32, any: bool) -> bool {
  if (!any) { return true; }
  let a = abs(v.x); let bits = bitcast<u32>(a);
  if (a < 1e-30) { return false; }
  var ulp = bitcast<f32>(bits & 0x7f800000u) * ${f(2 ** -23)};
  if ((bits & 0x007fffffu) == 0u) { ulp = ulp * 0.5; }
  return abs(v.y) + B < 0.5 * ulp;
}
@compute @workgroup_size(64)
fn gaborish(@builtin(global_invocation_id) id: vec3u) {
  let t = id.x + id.y * 65535u * 64u; let n = P.width * P.height; if (t >= 3u * n) { return; }
  let c = t / n; let s = t % n; let x = s % P.width; let y = s / P.width;
  let l = select(x - 1u, 0u, x == 0u); let r = min(x + 1u, P.width - 1u); let u = select(y - 1u, 0u, y == 0u); let d = min(y + 1u, P.height - 1u);
  let q = array<f32, 9>(at(c, x, y), at(c, l, y), at(c, r, y), at(c, x, u), at(c, x, d), at(c, l, u), at(c, r, u), at(c, l, d), at(c, r, d));
  let s12 = ts(q[1], q[2]); let s34 = ts(q[3], q[4]); let sides = dadd(s12, s34);
  let d12 = ts(q[5], q[6]); let d34 = ts(q[7], q[8]); let diags = dadd(d12, d34);
  let v = dmul(vec2f(P.normal, P.normalLo), dadd(dadd(vec2f(q[0], 0.0), dmul(vec2f(P.side, P.sideLo), sides)), dmul(vec2f(P.diag, P.diagLo), diags)));
  let sSides = select(abs(q[1]) + abs(q[2]) + abs(q[3]) + abs(q[4]), 0.0, s12.x == -s34.x && s12.y == -s34.y);
  let sDiags = select(abs(q[5]) + abs(q[6]) + abs(q[7]) + abs(q[8]), 0.0, d12.x == -d34.x && d12.y == -d34.y);
  let S = abs(P.normal) * (abs(q[0]) + abs(P.side) * sSides + abs(P.diag) * sDiags);
  let bits = bitcast<u32>(v.x); dst[t] = bits;
  if (!sure(v, S * ${f(1.01 * (14 * OP + 20 * F64 + 4 * REP))}, S != 0.0)) {
    let k = slot(11u); if (k != 0xffffffffu) { lst[k] = t; lst[k + 1u] = bits; for (var j = 0u; j < 9u; j++) { lst[k + 2u + j] = bitcast<u32>(q[j]); } }
  }
}
fn epfAt(c: u32, x: i32, y: i32) -> f32 { return at(c, mir(x, i32(P.width)), mir(y, i32(P.height))); }
fn sad(c: u32, x: i32, y: i32, dx: i32, dy: i32) -> vec2f {
  var s = vec2f(0.0);
  for (var k = 0; k < 5; k++) {
    let ox = select(select(0, -1, k == 1), 1, k == 3); let oy = select(select(0, -1, k == 0), 1, k == 4);
    s = dadd(s, dabs(ts(epfAt(c, x + ox, y + oy), -epfAt(c, x + dx + ox, y + dy + oy))));
  }
  return s;
}
@compute @workgroup_size(64)
fn epf1(@builtin(global_invocation_id) id: vec3u) {
  let t = id.x + id.y * 65535u * 64u; let n = P.width * P.height; if (t >= n) { return; }
  let x = t % P.width; let y = t / P.width; let sg = aux[(y >> 3u) * P.sw + (x >> 3u)];
  if (sg < 0.3) { for (var c = 0u; c < 3u; c++) { dst[c * n + t] = bitcast<u32>(at(c, x, y)); } return; }
  let border = (x & 7u) == 0u || (x & 7u) == 7u || (y & 7u) == 0u || (y & 7u) == 7u;
  var factor = ddiv(vec2f(${f(-1.9330952441687866)}, ${f(-1.9330952441687866 - Math.fround(-1.9330952441687866))}), vec2f(sg, 0.0));
  if (border) { factor = dmul(factor, vec2f(P.border, P.borderLo)); }
  let af = abs(factor.x);
  var ws = vec2f(1.0, 0.0); var v = array<vec2f, 3>(vec2f(at(0u, x, y), 0.0), vec2f(at(1u, x, y), 0.0), vec2f(at(2u, x, y), 0.0));
  var ews = 0.0; var e = array<f32, 3>(0.0, 0.0, 0.0); var a = array<f32, 3>(abs(v[0].x), abs(v[1].x), abs(v[2].x));
  for (var k = 0; k < 4; k++) {
    let dx = select(select(0, -1, k == 1), 1, k == 2); let dy = select(select(0, -1, k == 0), 1, k == 3);
    let dot = dadd(dadd(dmul(vec2f(40.0, 0.0), sad(0u, i32(x), i32(y), dx, dy)), dmul(vec2f(5.0, 0.0), sad(1u, i32(x), i32(y), dx, dy))), dmul(vec2f(3.5, 0.0), sad(2u, i32(x), i32(y), dx, dy)));
    let arg = dadd(vec2f(1.0, 0.0), dmul(dot, factor));
    let earg0 = abs(dot.x) * af * ${f(1.05 * (24 * OP + 30 * F64 + 4 * REP))} + ${f(4 * OP)};
    // A weight clipped with room to spare is zero on the CPU too: exactly, with no error to carry.
    let earg = select(earg0, 0.0, arg.x + earg0 < 0.0);
    var wt = arg; if (arg.x < 0.0) { wt = vec2f(0.0); }
    let nx = mir(i32(x) + dx, i32(P.width)); let ny = mir(i32(y) + dy, i32(P.height)); let aw = abs(wt.x);
    ws = dadd(ws, wt); ews += earg;
    for (var c = 0u; c < 3u; c++) { let p = at(c, nx, ny); v[c] = dadd(v[c], dmul(vec2f(p, 0.0), wt)); e[c] += abs(p) * earg; a[c] += abs(p) * aw; }
  }
  let w = abs(ws.x); let k8 = ${f(1.05 * (16 * OP + 20 * F64))}; let ewsT = ews + w * k8;
  var ok = true; var rbits = array<u32, 3>(0u, 0u, 0u);
  for (var c = 0u; c < 3u; c++) {
    let r = ddiv(v[c], ws); let rb = bitcast<u32>(r.x); rbits[c] = rb; dst[c * n + t] = rb;
    ok = ok && sure(r, ((e[c] + a[c] * k8) + abs(r.x) * ewsT) / w * 1.05 + abs(r.x) * ${f(4 * OP + 4 * F64)}, a[c] != 0.0);
  }
  if (!ok) {
    let k = slot(${6 + 3 * EPF_WINDOW.length}u);
    if (k != 0xffffffffu) {
      lst[k] = t; lst[k + 1u] = bitcast<u32>(sg); lst[k + 2u] = select(0u, 1u, border);
      lst[k + 3u] = rbits[0]; lst[k + 4u] = rbits[1]; lst[k + 5u] = rbits[2];
      const OX = array<i32, 13>(0, -1, 0, 1, -2, -1, 0, 1, 2, -1, 0, 1, 0);
      const OY = array<i32, 13>(-2, -1, -1, -1, 0, 0, 0, 0, 0, 1, 1, 1, 2);
      for (var j = 0u; j < 13u; j++) { for (var c = 0u; c < 3u; c++) { lst[k + 6u + 3u * j + c] = bitcast<u32>(epfAt(c, i32(x) + OX[j], i32(y) + OY[j])); } }
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
  let t = id.x + id.y * 65535u * 64u; let n = P.width * P.height; if (t >= n) { return; }
  let x = gcO(src[t]); let y = gcO(src[n + t]); let b = gcO(src[2u * n + t]);
  let l = gcO(gcO(y + x) - aux[0]); let q = gcO(gcO(y - x) - aux[1]); let s = gcO(b - aux[2]);
  let a = xfma(gcO(l * l), l, aux[3]);
  let d = xfma(gcO(q * q), q, aux[4]);
  let c = xfma(gcO(s * s), s, aux[5]);
  var bad = a.y + d.y + c.y; var word = 0xff000000u;
  for (var k = 0u; k < 3u; k++) {
    let inner = xfma(aux[7u + 3u * k], d.x, gcO(aux[6u + 3u * k] * a.x));
    let v = xfma(aux[8u + 3u * k], c.x, inner.x);
    bad += inner.y + v.y; dst[k * n + t] = bitcast<u32>(v.x); word |= level(bitcast<u32>(v.x)) << (8u * k);
  }
  px[t] = word;
  if (bad != 0.0) { let k = slot(4u); if (k != 0xffffffffu) { lst[k] = t; lst[k + 1u] = bitcast<u32>(x); lst[k + 2u] = bitcast<u32>(y); lst[k + 3u] = bitcast<u32>(b); } }
}
// The native byte (photo-output.mjs encodedByte): the transfer's knots in aux from P.knots (V, R, S as double-single
// pairs), the dither in aux[0..1024), and the exact rational polynomial fallback when a knot interval straddles a half step.
fn byteOf(s: f32, d: f32) -> u32 { return u32(round(clamp(gcO(gcO(s * 255.0) + d), 0.0, 255.0))); }
@compute @workgroup_size(64)
fn native(@builtin(global_invocation_id) id: vec3u) {
  let t = id.x + id.y * 65535u * 64u; let n = P.width * P.height; if (t >= n) { return; }
  let col = t % P.width; let row = t / P.width; var word = 0xff000000u;
  for (var c = 0u; c < 3u; c++) {
    let v = src[c * n + t]; let d = aux[((row + 13u * c) & 31u) * 32u + ((col + select(select(0u, 23u, c == 1u), 14u, c == 2u)) & 31u)];
    var byte = 0u; var known = true; let low = bitcast<f32>(P.low);
    if (!(v > low) || v >= 1.0) {
      byte = byteOf(select(select(gcO(v * ${f(12.92)}), 0.0, !(v > 0.0)), 1.0, v >= 1.0), d);
    } else {
      let k = P.knots + 6u * ((bitcast<u32>(v) - bitcast<u32>(low)) >> 13u);
      let tr = dadd(vec2f(aux[k + 2u], aux[k + 3u]), dmul(dsub(vec2f(v, 0.0), vec2f(aux[k], aux[k + 1u])), vec2f(aux[k + 4u], aux[k + 5u])));
      let u = dadd(dmul(vec2f(255.0, 0.0), tr), vec2f(d, 0.0)); let ux = u.x + u.y; let m = ${f(2 ** -12 + 2 ** -16)};
      let lo = u32(floor(clamp(ux - m, 0.0, 255.0) + 0.5)); let hi = u32(floor(clamp(ux + m, 0.0, 255.0) + 0.5));
      byte = lo; known = lo == hi;
      if (!known) {
        let sq = xsqrt(v); let r = sq.x;
        let p3 = xfma(${f(P_COEF[4])}, r, ${f(P_COEF[3])}); let p2 = xfma(p3.x, r, ${f(P_COEF[2])}); let p1 = xfma(p2.x, r, ${f(P_COEF[1])}); let p0 = xfma(p1.x, r, ${f(P_COEF[0])});
        let q3 = xfma(${f(Q_COEF[4])}, r, ${f(Q_COEF[3])}); let q2 = xfma(q3.x, r, ${f(Q_COEF[2])}); let q1 = xfma(q2.x, r, ${f(Q_COEF[1])}); let q0 = xfma(q1.x, r, ${f(Q_COEF[0])});
        let res = xdiv(p0.x, q0.x);
        if (sq.y + p3.y + p2.y + p1.y + p0.y + q3.y + q2.y + q1.y + q0.y + res.y == 0.0) {
          byte = byteOf(res.x, d); known = true;
        }
      }
    }
    word |= byte << (8u * c);
    if (!known) { let k = slot(3u); if (k != 0xffffffffu) { lst[k] = t * 3u + c; lst[k + 1u] = bitcast<u32>(v); lst[k + 2u] = bitcast<u32>(d); } }
  }
  px[n + t] = word;
}
// The CPU's samples where the device listed one: [index, value bits] into dst, or [pixel, mask, bytes] into px.
@compute @workgroup_size(64)
fn scatter(@builtin(global_invocation_id) id: vec3u) {
  let t = id.x + id.y * 65535u * 64u; if (t >= P.count) { return; }
  dst[table[2u * t]] = table[2u * t + 1u];
}
@compute @workgroup_size(64)
fn scatterPx(@builtin(global_invocation_id) id: vec3u) {
  let t = id.x + id.y * 65535u * 64u; if (t >= P.count) { return; }
  let i = table[3u * t]; px[i] = (px[i] & ~table[3u * t + 1u]) | table[3u * t + 2u];
}`;
const ENTRIES = ['gaborish', 'epf1', 'color', 'native', 'scatter', 'scatterPx'];
const pipelineSet = device => Promise.all([
  gpuComputeSet(device, 'render', RENDER_SHADER, ['uniform', 'read-only-storage', 'storage', 'storage', 'storage', 'storage'], ['coefficients', 'lowFrequencies', 'samples']),
  gpuComputeSet(device, 'restore', RESTORE_SHADER, ['uniform', 'read-only-storage', 'read-only-storage', 'storage', 'read-only-storage', 'storage', 'storage', 'storage'], ENTRIES),
]).then(([r, o]) => ({...r, ...o, render: r.group, restore: o.group}));
const auxes = new WeakMap(), auxOf = (dither, fast) => {
  let aux = auxes.get(fast);
  if (!aux) {
    const K = fast.V.length; aux = new Float32Array(1024 + 6 * K); aux.set(dither);
    for (let k = 0; k < K; k++) split([fast.V[k], fast.R[k], fast.S[k]], aux.subarray(1024 + 6 * k, 1030 + 6 * k));
    auxes.set(fast, aux);
  }
  return aux;
};
const split = (values, out = new Float32Array(values.length * 2)) => { values.forEach((v, i) => { const hi = Math.fround(v); out[2 * i] = hi; out[2 * i + 1] = Math.fround(v - hi); }); return out; };
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
    lib.held && lib.s2 ? gpuS2Prepare(device, lib.s2.held, lib.s2.tables, lib.s2.reference, lib.s2.width, lib.s2.height) : null,
  ]);
  const {rebuild, kernels, constants, native} = lib, {inputs} = rebuild(image, {inputs: true});
  const {width, height, xsize, ysize, arena, tables, lf, groups, global, bias, numerator, blocks, filter, sigma} = inputs, n = width * height;
  const gab = filter.gaborish === true ? [0.115169525, 0.061248592] : filter.gaborish ? filter.gaborish[0] : null;
  if (inputs.ycbcr || image.alpha || width < 3 || height < 3 || (filter.epf.iters ?? 0) > 1 || filter.gaborish && filter.gaborish !== true &&
    !filter.gaborish.every(([sd, dg]) => sd === gab[0] && dg === gab[1])) return null;
  const cap = Math.max(4096, n >> 6), made = [];
  const held = lib.held && (!lib.held.device || lib.held.device === device) ? lib.held : null;
  const {kept, upKept, once, read: readAt, dispatch: run, bind} = gpuBuffers(device, held, made);
  const dispatch = (encoder, pipeline, group, buffers, count) => run(encoder, pipeline, bind(group, buffers), count);
  const read = async (source, bytes, name, offset = 0) => (await readAt([[source, offset, bytes]], name))[0];
  device.pushErrorScope('validation'); device.pushErrorScope('out-of-memory');
  let scopes = 2;
  try {
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
    if (sameLayout) {
      ({blk, cells, tabs, plainGrid} = layout);
    } else {
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
        blk[o + 16] = b.area > 1 ? table('D' + W + 'x' + H, () => llfDivisors(W, H)) : 0;
        blk[o + 17] = table('S' + w, () => scaledBasis(w));
        blk[o + 18] = table('S' + h, () => scaledBasis(h));
        for (let y = 0; y < b.bh; y++) cells.fill(k, (b.y + y) * xsize + b.x, (b.y + y) * xsize + b.x + b.bw);
      }
      tabs = new Float32Array(tabList.reduce((s, t) => s + t.length * 2, 0));
      let at = 0; for (const t of tabList) { split(t, tabs.subarray(at, at + t.length * 2)); at += t.length * 2; }
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
    const sameCfl = !!(sameLayout && image.cfl && layout.cfl === image.cfl);
    let grp, maps, consts;
    if (sameCfl) {
      grp = layout.grp; maps = layout.maps; consts = layout.consts;
    } else {
      grp = new Uint32Array(groups.length * 5); maps = new Int32Array(groups.reduce((s, g) => s + g.xFromY.length + g.bFromY.length, 0));
      let mapAt = 0;
      groups.forEach((g, k) => { grp.set([mapAt, mapAt + g.xFromY.length, g.width, g.bx, g.by], k * 5); maps.set(g.xFromY, mapAt); maps.set(g.bFromY, mapAt + g.xFromY.length); mapAt += g.xFromY.length + g.bFromY.length; });
      consts = split([bias[0], bias[1], bias[2], numerator, global.correlation.baseX, global.correlation.baseB]);
    }
    const parts = [arenaWords, new Uint32Array(0), blk, fac, qtab, tabs, grp, maps, lfAll, consts, cells];
    const offsets = [], words = parts.reduce((s, p) => (offsets.push(s), s + p.length), 0), MB = kept('MB', words * 4);
    const mbFresh = layout?.mb !== MB;
    for (let k = 0; k < parts.length; k++) {
      const p = parts[k];
      if (!p.length) continue;
      if (!mbFresh && sameLayout && (k === 2 || k === 5 || k === 9 || k === 10)) continue;
      if (!mbFresh && sameFac && k === 3) continue;
      if (!mbFresh && sameCfl && (k === 6 || k === 7)) continue;
      device.queue.writeBuffer(MB, offsets[k] * 4, p.buffer, p.byteOffset, p.byteLength);
    }
    if (held) held.layout = {xsize, ysize, len: blocks.length, arenaWordsLen: arenaWords.length, blk, cells, tabs, plainGrid, fac, uniformMult, globalScale: global.globalScale, cfl: image.cfl, grp, maps, consts, mb: MB};

    const uni = new ArrayBuffer(80), u32Uni = new Uint32Array(uni);
    u32Uni.set([width, height, xsize, blocks.reduce((s, b) => s + b.area * 192, 0), blocks.length, 0, 0, cap, ...offsets]);
    u32Uni[9] = narrow; u32Uni[19] = plainGrid;
    new Float32Array(uni)[5] = 1; new Float32Array(uni)[6] = global.correlation.factor;
    const P0 = kept('P0', 3 * n * 4), P1 = gab ? kept('P1', 3 * n * 4) : P0, P2 = filter.epf.iters === 1 ? kept('P2', 3 * n * 4) : P1, P3 = kept('P3', 3 * n * 4);
    const PX = kept('PX', 2 * n * 4), CNT = kept('CNT', 32);
    const STRIDE2 = 6 + 3 * EPF_WINDOW.length;
    const LBASE0 = 0, LBASE1 = cap * 2, LBASE2 = LBASE1 + cap * 11, LBASE3 = LBASE2 + cap * STRIDE2, LBASE4 = LBASE3 + cap * 4;
    const LST = kept('LST', (LBASE4 + cap * 3) * 4);
    const ub = upKept('UB', new Uint8Array(uni), GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    const render = [ub, MB, kept('C', blocks.reduce((s, b) => s + b.area * 192, 0) * 16), P0, CNT, LST];
    const restoreUniform = (name, extra = {}) => {
      const u = new ArrayBuffer(80), U = new Uint32Array(u), F = new Float32Array(u), hl = v => [Math.fround(v), Math.fround(v - Math.fround(v))];
      U.set([width, height, Math.ceil(width / 8), cap]); F[4] = 1;
      if (gab) F.set([...hl(gab[0]), ...hl(gab[1]), ...hl(1 / (1 + 4 * gab[0] + 4 * gab[1]))], 5);
      F.set(hl(filter.epf.borderSadMul ?? 2 / 3), 11);
      U[13] = extra.count ?? 0; U[14] = extra.knots ?? 0; U[15] = extra.low ?? 0; U[16] = extra.stage ?? 0; U[17] = extra.lbase ?? 0;
      return upKept(name, new Uint8Array(u), GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
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

    const PREF = [512, 2816, 5760, 256, 192], LBASES = [LBASE0, LBASE1, LBASE2, LBASE3, LBASE4], STRIDES = [2, 11, STRIDE2, 4, 3];
    const wantBand = !!(held && lib.keep && lib.band), wantFull = !(held && lib.keep);
    const bandY0 = wantBand ? lib.band[0] : 0, bandBytes = wantBand ? (lib.band[1] - bandY0) * width * 4 : 0;
    const offPrefs = [];
    let rbTotal = 32;
    for (let s = 0; s < 5; s++) { offPrefs.push(rbTotal); rbTotal += PREF[s] * 4; }
    const offPx = rbTotal; rbTotal += wantBand ? bandBytes * 2 : wantFull ? 2 * n * 4 : 0;
    const offS2 = rbTotal; rbTotal += s2State ? s2State.sBytes + 16 : 0;
    const RB = kept('RBS', rbTotal, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    const stages = [[set.gaborish, [ur1, P0, none, P1, none, CNT, LST, PX], 3 * n, gab], [set.epf1, [ur2, P1, sgBuf, P2, none, CNT, LST, PX], n, filter.epf.iters === 1],
      [set.color, [ur3, P2, kColor, P3, srgb8, CNT, LST, PX], n, true], [set.native, [ur4, P3, kNative, spare, none, CNT, LST, PX], n, true]];
    const run = async (from, tail = true) => {
      device.queue.writeBuffer(CNT, 0, new Uint32Array(8));
      const e = device.createCommandEncoder(), pass = e.beginComputePass(), go = (pipeline, group, buffers, count) => {
        const all = Math.ceil(count / 64), gx = Math.min(all, 65535);
        pass.setPipeline(pipeline); pass.setBindGroup(0, bind(group, buffers)); pass.dispatchWorkgroups(gx, Math.ceil(all / gx));
      };
      if (!from) { go(set.coefficients, set.render, render, u32Uni[3]); go(set.lowFrequencies, set.render, render, blocks.length * 3072); go(set.samples, set.render, render, 3 * n); }
      stages.forEach(([pipeline, buffers, count, on], k) => { if (on && from <= k + 1) go(pipeline, set.restore, buffers, count); });
      pass.end();
      if (tail && s2State) gpuS2Record(device, e, s2State, PX, RB, offS2);
      e.copyBufferToBuffer(CNT, 0, RB, 0, 20);
      for (let s = 0; s < 5; s++) e.copyBufferToBuffer(LST, LBASES[s] * 4, RB, offPrefs[s], PREF[s] * 4);
      if (tail && wantBand) { e.copyBufferToBuffer(PX, bandY0 * width * 4, RB, offPx, bandBytes); e.copyBufferToBuffer(PX, (n + bandY0 * width) * 4, RB, offPx + bandBytes, bandBytes); }
      else if (tail && wantFull) e.copyBufferToBuffer(PX, 0, RB, offPx, 2 * n * 4);
      device.queue.submit([e.finish()]); lib.onSubmit?.();
      await RB.mapAsync(GPUMapMode.READ, 0, rbTotal);
      const snap = RB.getMappedRange(0, rbTotal).slice(0); RB.unmap(); return snap;
    };
    const scatter = (into, pairs, words = 2) => {
      if (!pairs.length) return false;
      const corrections = upKept('CR', pairs instanceof Uint32Array ? pairs : Uint32Array.from(pairs)), e = device.createCommandEncoder(), count = pairs.length / words;
      dispatch(e, words === 2 ? set.scatter : set.scatterPx, set.restore, [restoreUniform('URS', {count}), none, none, words === 2 ? into : spare, corrections, CNT, LST, words === 2 ? PX : into], count);
      device.queue.submit([e.finish()]);
      return true;
    };
    const settle = [list => {
      const only = new Set(), diff = [];
      for (let k = 0; k < list.length; k += 2) { const i = list[k] % n; only.add(cells[((i / width | 0) >> 3) * xsize + ((i % width) >> 3)]); }
      const {rendered} = rebuild(image, {rendered: true, only});
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
    let snap = await run(0), again = false;
    for (let s = 0; s < 5; s++) {
      const c = new Uint32Array(snap, 0, 5)[s], words = c * STRIDES[s];
      if (c > cap) return null;
      if (!c) continue;
      const list = words <= PREF[s] ? new Uint32Array(snap, offPrefs[s], words) : new Uint32Array(await read(LST, words * 4, 'R lists', LBASES[s] * 4));
      if (settle[s](list)) { snap = await run(s + 1, false); again = true; }
    }
    if (again) snap = await run(5);
    const readAll = async () => { const out = new Uint8Array(await read(PX, 2 * n * 4, 'R')); return {rgba: out.subarray(0, 4 * n), native: out.subarray(4 * n)}; };
    const s2 = s2State ? {s2: gpuS2Decode(s2State, snap, offS2)} : {};
    const answer = held && lib.keep ? {px: PX, band: wantBand ? {rgba: new Uint8Array(snap, offPx, bandBytes), native: new Uint8Array(snap, offPx + bandBytes, bandBytes)} : null, readAll, ...s2}
      : {rgba: new Uint8Array(snap, offPx, 4 * n), native: new Uint8Array(snap, offPx + 4 * n, 4 * n), ...s2};
    scopes--; const memory = await device.popErrorScope();
    scopes--; const invalid = await device.popErrorScope();
    if (memory || invalid) { held?.release(); throw new Error('gpu-render: ' + (memory || invalid).message); }
    return answer;
  } finally {
    while (scopes-- > 0) await device.popErrorScope().catch(() => null);
    for (const b of made) b.destroy();
  }
}
