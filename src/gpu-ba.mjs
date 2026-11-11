// SPDX-License-Identifier: MIT
import {GC_DS} from './gpu-arithmetic.mjs';
import {XFMA} from './gpu-s2.mjs';
import {gpuComputeSet, gpuBuffers} from './gpu-kit.mjs';
import {exactExp} from './exact-math.mjs';
import {F64_WGSL, f64Const as D} from './gpu-f64.mjs';

const F = Math.fround, K = v => { const t = String(F(v)); return /[.e]/.test(t) ? t : t + '.0'; };
const BA_GAUSSIAN = Float32Array.from([1.2, 7.15593339443, 3.22489901262, 1.56416327805, 2.7].flatMap(value => {
  const sigma = F(value), radius = Math.trunc(F(2.25 * sigma)), scale = -1 / (2 * sigma * sigma);
  const kernel = Array.from({length: radius * 2 + 1}, (_, i) => F(exactExp(scale * (i - radius) * (i - radius))));
  const inverse = F(1 / kernel.reduce((sum, value) => F(sum + value), 0));
  return [...kernel, ...kernel.slice(0, radius + 1).map(value => F(value * inverse))];
}));
const BLUR = [[2, 0], [16, 8], [7, 58], [3, 81], [6, 92]];

const MALTA = [[9, 1.10039032555, 71.7800275169, 1], [8, 173.5, 5.0, 1], [7, 18.7237414387, 4498534.45232, 0],
  [6, 6923.99476109, 8051.15833247, 0], [4, 37.0819870399, 130262059.556, 0], [3, 8246.75321353, 1009002.70582, 0]];
const MC = MALTA.flatMap(([, weight, norm, high]) => { const g = high ? .39905817637 : .611612573796;
  return [F(g * Math.sqrt(.5 * weight) / 8.5 * norm), F(g * Math.sqrt(F(.33) * weight) / 8.5 * norm), F(norm)]; });
const BIAS = F(F(6.19424080439) * F(12.61050594197)), GLOBAL = F(1 / (F(17.83) * .79079917404));
const BA_SHADER = `${GC_DS}
${XFMA}
${F64_WGSL}
struct U { w: u32, h: u32, one: f32, kind: u32, radius: u32, koff: u32, src: u32, dst: u32, tmp: u32, c: u32, pad0: u32, pad1: u32 }
@group(0) @binding(0) var<uniform> P: U;
@group(0) @binding(1) var<storage, read_write> pl: array<f32>;
@group(0) @binding(2) var<storage, read> G: array<f32>;
@group(0) @binding(3) var<storage, read_write> flags: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> q: array<f32>;
fn gcOne() -> f32 { return P.one; }
fn n() -> u32 { return P.w * P.h; }
fn mul(a: f32, b: f32) -> f32 { return gcO(a * b); }
fn add(a: f32, b: f32) -> f32 { return gcO(a + b); }
fn sub(a: f32, b: f32) -> f32 { return gcO(a - b); }
fn mfma(a: f32, b: f32, c: f32) -> f32 { let r = xfma(a, b, c); if (r.y != 0.0) { atomicAdd(&flags[0], 1u); } return r.x; }
fn div(a: f32, b: f32) -> f32 { let r = xdiv(a, b); if (r.y != 0.0) { atomicAdd(&flags[0], 1u); } return r.x; }
fn root(a: f32) -> f32 { let r = xsqrt(a); if (r.y != 0.0) { atomicAdd(&flags[0], 1u); } return r.x; }
fn done64() { if (f64Bad) { atomicAdd(&flags[0], 1u); } }
fn D(f: f32) -> vec2u { return f64fromF32(f); }
fn mirror(i0: i32, m: i32) -> i32 { var i = i0; loop { if (i >= 0 && i < m) { break; } i = select(2 * m - 1 - i, -i - 1, i < 0); } return i; }
fn at(p: u32, i: u32) -> f32 { return pl[p * n() + i]; }
// five_sample over plane p along the line from (base, step), count samples, at x.
fn five(p: u32, base: u32, step: u32, count: i32, x: i32) -> f32 {
  let s = P.koff + 5u;
  var out = mul(at(p, base + u32(x) * step), G[s + 2u]);
  for (var d = 1; d <= 2; d++) {
    let pair = add(at(p, base + u32(mirror(x - d, count)) * step), at(p, base + u32(mirror(x + d, count)) * step));
    out = mfma(pair, G[s + 2u - u32(d)], out);
  }
  return out;
}
fn wide(p: u32, base: u32, step: u32, count: i32, x: i32) -> f32 {
  let r = i32(P.radius); let k = P.koff; let s = P.koff + 2u * P.radius + 1u;
  if (x < r || x >= count - r) {
    var sum = 0.0; var weight = 0.0;
    for (var d = -r; d <= r; d++) { if (x + d >= 0 && x + d < count) {
      sum = add(sum, mul(at(p, base + u32(x + d) * step), G[k + u32(d + r)])); weight = add(weight, G[k + u32(d + r)]);
    } }
    return mul(sum, div(1.0, weight));
  }
  let start = base + u32(x - r) * step;
  var g = array<f32, 4>(0.0, 0.0, 0.0, 0.0);
  for (var d = 0; d < r; d++) {
    let term = mul(add(at(p, start + u32(d) * step), at(p, start + u32(2 * r - d) * step)), G[s + u32(d)]);
    if (d < 4) { g[d] = term; } else { g[d % 4] = add(g[d % 4], term); }
  }
  var out = mul(at(p, base + u32(x) * step), G[s + u32(r)]);
  for (var i = 0; i < 4 && i < r; i++) { out = add(out, g[i]); }
  return out;
}
@compute @workgroup_size(64)
fn blurH(@builtin(global_invocation_id) id: vec3u) {
  let t = id.x + id.y * 65535u * 64u; if (t >= n()) { return; }
  let x = i32(t % P.w); let y = t / P.w;
  var v = 0.0;
  if (P.kind == 0u) { v = five(P.src, y * P.w, 1u, i32(P.w), x); } else { v = wide(P.src, y * P.w, 1u, i32(P.w), x); }
  pl[P.tmp * n() + t] = v;
}
@compute @workgroup_size(64)
fn blurV(@builtin(global_invocation_id) id: vec3u) {
  let t = id.x + id.y * 65535u * 64u; if (t >= n()) { return; }
  let x = t % P.w; let y = i32(t / P.w); let w = i32(P.w); let h = i32(P.h);
  var v = 0.0;
  if (P.kind != 0u) { v = wide(P.tmp, x, P.w, h, y); }
  else if (w >= 10 && i32(x) < (w / 8) * 8) { v = five(P.tmp, x, P.w, h, y); }
  else {
    // The scalar 25-tap tail, from the input itself.
    let s = P.koff + 5u; var sum = 0.0;
    for (var yy = -2; yy <= 2; yy++) { for (var xx = -2; xx <= 2; xx++) {
      let term = mul(at(P.src, u32(mirror(y + yy, h)) * P.w + u32(mirror(i32(x) + xx, w))), G[s + 2u - u32(abs(xx))]);
      let weight = G[s + 2u - u32(abs(yy))];
      if (w < 10) { sum = add(sum, mul(term, weight)); } else { sum = mfma(term, weight, sum); }
    } }
    v = sum;
  }
  pl[P.dst * n() + t] = v;
}
fn mixc(c: u32, r: f32, g: f32, b: f32) -> f32 {
  if (c == 0u) { return mfma(${K(.29956550340058319)}, r, mfma(${K(.63373087833825936)}, g, mfma(${K(.077705617820981968)}, b, ${K(1.7557483643287353)}))); }
  if (c == 1u) { return mfma(${K(.22158691104574774)}, r, mfma(${K(.69391388044116142)}, g, mfma(${K(.0987313588422)}, b, ${K(1.7557483643287353)}))); }
  return mfma(${K(.02)}, r, mfma(${K(.02)}, g, mfma(${K(.20480129041026129)}, b, ${K(12.226454707163354)})));
}
fn logApprox(value: f32) -> f32 {
  var u = bitcast<u32>(value);
  let e = bitcast<i32>(u - 0x3f2aaaabu) >> 23u;
  u = u - (bitcast<u32>(e) << 23u);
  let x = sub(bitcast<f32>(u), 1.0);
  var num = mfma(${K(.74245873327820566)}, x, ${K(1.4287160470083755)});
  var den = mfma(${K(.17409343003366853)}, x, ${K(1.0096718572241148)});
  num = mfma(num, x, ${K(-1.8503833400518310e-6)});
  den = mfma(den, x, ${K(.99032814277590719)});
  return add(div(num, den), f32(e));
}
fn gammaValue(v: f32) -> f32 { return mfma(${K(F(19.245013259874995) * F(.6931471805599453))}, logApprox(add(max(0.0, v), ${K(9.9710635769299145)})), ${K(-23.16046239805755)}); }
@compute @workgroup_size(64)
fn dynamics(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x + id.y * 65535u * 64u; if (i >= n()) { return; }
  let l0 = mul(at(0u, i), 80.0); let l1 = mul(at(1u, i), 80.0); let l2 = mul(at(2u, i), 80.0);
  let r0 = mul(at(12u, i), 80.0); let r1 = mul(at(13u, i), 80.0); let r2 = mul(at(14u, i), 80.0);
  var a = array<f32, 3>(0.0, 0.0, 0.0);
  for (var c = 0u; c < 3u; c++) {
    var floor0 = ${K(1.7557483643287353)}; if (c == 2u) { floor0 = ${K(12.226454707163354)}; }
    let v = max(max(mixc(c, l0, l1, l2), floor0), ${K(1e-4)});
    let gain = max(div(gammaValue(v), v), ${K(1e-4)});
    a[c] = max(mul(mixc(c, r0, r1, r2), gain), floor0);
  }
  pl[3u * n() + i] = sub(a[0], a[1]); pl[4u * n() + i] = add(a[0], a[1]); pl[5u * n() + i] = a[2];
}
fn removeRange(w: f32, x: f32) -> f32 { if (x > w) { return sub(x, w); } if (x < -w) { return add(x, w); } return 0.0; }
fn amplifyRange(w: f32, x: f32) -> f32 { if (x > w) { return add(x, w); } if (x < -w) { return sub(x, w); } return add(x, x); }
fn clampRange(x: f32, l: f32) -> f32 {
  if (x >= l) { return mfma(sub(x, l), ${K(.724216145665)}, l); }
  if (x < -l) { return mfma(add(x, l), ${K(.724216145665)}, -l); }
  return x;
}
// The per-sample steps between the blurs, by P.kind: 1 mf -= lf (channel P.c); 2 the lf scales; 3 after the third
// blur, channel P.c; 4 the uhf[0] scale; 5 after the fourth blur, channel P.c.
@compute @workgroup_size(64)
fn bandStep(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x + id.y * 65535u * 64u; if (i >= n()) { return; }
  let N = n(); let c = P.c;
  if (P.kind == 1u) { pl[(3u + c) * N + i] = sub(pl[(3u + c) * N + i], pl[c * N + i]); }
  else if (P.kind == 2u) {
    let y = pl[N + i];
    pl[i] = mul(pl[i], ${K(33.832837186260)}); pl[N + i] = mul(y, ${K(14.458268100570)});
    pl[2u * N + i] = mul(mfma(${K(-.362267051518)}, y, pl[2u * N + i]), ${K(49.87984651440)});
  } else if (P.kind == 3u) {
    var lowAt = 11u; if (c < 2u) { lowAt = 6u + c; }
    let low = pl[lowAt * N + i];
    if (c < 2u) { pl[(8u + c) * N + i] = sub(pl[(3u + c) * N + i], low); }
    var m = low; if (c == 0u) { m = removeRange(${K(.29)}, low); } else if (c == 1u) { m = amplifyRange(${K(.1)}, low); }
    pl[(3u + c) * N + i] = m;
  } else if (P.kind == 4u) {
    let y = pl[9u * N + i];
    let scale = mfma(div(46.0, mfma(y, y, 46.0)), ${K(1.0 - .653020556257)}, ${K(.653020556257)});
    pl[8u * N + i] = mul(pl[8u * N + i], scale);
  } else {
    let low = pl[(6u + c) * N + i];
    if (c == 0u) { pl[8u * N + i] = removeRange(${K(.04)}, sub(pl[8u * N + i], low)); pl[6u * N + i] = removeRange(1.5, low); }
    else {
      let v = clampRange(low, ${K(28.4691806922)});
      pl[9u * N + i] = mul(clampRange(sub(pl[9u * N + i], v), ${K(5.19175294647)}), ${K(2.69313763794)});
      pl[7u * N + i] = amplifyRange(${K(.132)}, mul(v, ${K(2.155)}));
    }
  }
}
// Malta: per sample the kernel's difference (binary64 corrections), then each line's sum of nine (hf) or five (lf) taps
// of it, squared and accumulated in the kernel's order.
const MLF = array<i32, 160>(-4,0,-2,0,0,0,2,0,4,0,0,-4,0,-2,0,0,0,2,0,4,-3,-3,-2,-2,0,0,2,2,3,3,3,-3,2,-2,0,0,-2,2,-3,3,1,-4,1,-2,0,0,-1,2,-1,4,-1,-4,-1,-2,0,0,1,2,1,4,-4,-1,-2,-1,0,0,2,1,4,1,-4,1,-2,1,0,0,2,-1,4,-1,-2,-3,-1,-2,0,0,1,2,2,3,2,-3,1,-2,0,0,-1,2,-2,3,-3,-2,-2,-1,0,0,2,1,3,2,3,-2,2,-1,0,0,-2,1,-3,2,-4,2,-2,1,0,0,2,-1,4,-2,-4,-2,-2,-1,0,0,2,1,4,2,-2,-4,-1,-2,0,0,1,2,2,4,2,-4,1,-2,0,0,-1,2,-2,4);
const MHF = array<i32, 288>(-4,0,-3,0,-2,0,-1,0,0,0,1,0,2,0,3,0,4,0,0,-4,0,-3,0,-2,0,-1,0,0,0,1,0,2,0,3,0,4,-3,-3,-2,-2,-1,-1,0,0,1,1,2,2,3,3,0,0,0,0,3,-3,2,-2,1,-1,0,0,-1,1,-2,2,-3,3,0,0,0,0,1,-4,1,-3,1,-2,0,-1,0,0,0,1,-1,2,-1,3,-1,4,-1,-4,-1,-3,-1,-2,0,-1,0,0,0,1,1,2,1,3,1,4,-4,-1,-3,-1,-2,-1,-1,0,0,0,1,0,2,1,3,1,4,1,-4,1,-3,1,-2,1,-1,0,0,0,1,0,2,-1,3,-1,4,-1,-2,-3,-1,-2,-1,-1,0,0,1,1,1,2,2,3,0,0,0,0,2,-3,1,-2,1,-1,0,0,-1,1,-1,2,-2,3,0,0,0,0,-3,-2,-2,-1,-1,-1,0,0,1,1,2,1,3,2,0,0,0,0,3,-2,2,-1,1,-1,0,0,-1,1,-2,1,-3,2,0,0,0,0,-4,1,-3,1,-2,1,-1,0,0,0,1,0,2,-1,3,-1,4,-1,-4,-1,-3,-1,-2,-1,-1,0,0,0,1,0,2,1,3,1,4,1,-1,-4,-1,-3,-1,-2,0,-1,0,0,0,1,1,2,1,3,1,4,1,-4,1,-3,1,-2,0,-1,0,0,0,1,-1,2,-1,3,-1,4);
const MC = array<f32, 18>(${MC.map(K)});
@compute @workgroup_size(64)
fn maltaDiff(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x + id.y * 65535u * 64u; if (i >= n()) { return; }
  let N = n(); let planes = array<u32, 6>(${MALTA.map(m => m[0] + 'u')});
  for (var k = 0u; k < 6u; k++) {
    let a = pl[(15u + planes[k]) * N + i]; let b = pl[planes[k] * N + i];
    let den = add(MC[3u * k + 2u], mul(0.5, add(abs(a), abs(b)))); let scale = div(MC[3u * k + 1u], den);
    var d = mul(div(MC[3u * k], den), sub(a, b));
    let lo = f64mul(${D(.55)}, D(abs(a))); let hi = f64mul(${D(1.05)}, D(abs(a))); let B = D(b);
    if (a < 0.0) {
      if (f64gt(B, f64neg(lo))) { d = f64toF32(f64sub(D(d), f64mul(D(scale), f64add(B, lo)))); }
      else if (f64lt(B, f64neg(hi))) { d = f64toF32(f64add(D(d), f64mul(D(scale), f64sub(D(-b), hi)))); }
    } else {
      if (f64lt(B, lo)) { d = f64toF32(f64add(D(d), f64mul(D(scale), f64sub(lo, B)))); }
      else if (f64gt(B, hi)) { d = f64toF32(f64sub(D(d), f64mul(D(scale), f64sub(B, hi)))); }
    }
    pl[(25u + k) * N + i] = d;
  }
  done64();
}
fn tap(p: u32, x: i32, y: i32, dx: i32, dy: i32) -> f32 {
  let xx = x + dx; let yy = y + dy;
  if (xx < 0 || yy < 0 || xx >= i32(P.w) || yy >= i32(P.h)) { return 0.0; }
  return pl[p * n() + u32(yy) * P.w + u32(xx)];
}
fn maltaLF(p: u32, x: i32, y: i32) -> f32 {
  var v = 0.0;
  for (var k = 0; k < 16; k++) {
    var t: array<f32, 5>;
    for (var j = 0; j < 5; j++) { t[j] = tap(p, x, y, MLF[10 * k + 2 * j], MLF[10 * k + 2 * j + 1]); }
    let s = add(add(t[0], t[1]), add(t[2], add(t[3], t[4])));
    if (k == 0) { v = mul(s, s); } else { v = mfma(s, s, v); }
  }
  return v;
}
fn maltaHF(p: u32, x: i32, y: i32) -> f32 {
  var v = 0.0;
  for (var k = 0; k < 16; k++) {
    var t: array<f32, 9>;
    for (var j = 0; j < 9; j++) { t[j] = tap(p, x, y, MHF[18 * k + 2 * j], MHF[18 * k + 2 * j + 1]); }
    var s: f32;
    if (((3852u >> u32(k)) & 1u) != 0u) { s = add(add(t[0], t[1]), add(t[2], add(add(t[3], t[4]), add(t[5], t[6])))); }
    else { s = add(add(add(add(t[0], t[1]), add(t[2], t[3])), add(add(t[4], t[5]), add(t[6], t[7]))), t[8]); }
    if (k == 0) { v = mul(s, s); } else { v = mfma(s, s, v); }
  }
  return v;
}
// ac and dc before the masks: Malta's energies, the hf asymmetry, the mf and lf differences.
@compute @workgroup_size(64)
fn maltaSum(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x + id.y * 65535u * 64u; if (i >= n()) { return; }
  let N = n(); let x = i32(i % P.w); let y = i32(i / P.w);
  let acs = array<f32, 3>(add(add(maltaHF(26u, x, y), maltaLF(28u, x, y)), maltaLF(30u, x, y)),
    add(add(maltaHF(25u, x, y), maltaLF(27u, x, y)), maltaLF(29u, x, y)), 0.0);
  let MW = array<f32, 3>(2150.0, ${K(10.6195433239)}, ${K(16.2176043152)});
  let DW = array<f32, 3>(${K(29.2353797994)}, ${K(.844626970982)}, ${K(.703646627719)});
  let HW = array<f32, 2>(${K(F(400) * .8)}, ${K(F(1.50815703118) * .8)});
  for (var c = 0u; c < 3u; c++) {
    var acc = acs[c];
    if (c < 2u) {
      let a = pl[(21u + c) * N + i]; let b = pl[(6u + c) * N + i]; let d = sub(a, b);
      let lo = mul(0.4, abs(a)); let hi = abs(a); var asym = 0.0;
      if (a < 0.0) { if (b > -lo) { asym = add(b, lo); } else if (b < -hi) { asym = sub(-b, hi); } }
      else { if (b < lo) { asym = sub(lo, b); } else if (b > hi) { asym = sub(b, hi); } }
      acc = mfma(HW[c], mul(asym, asym), mfma(mul(d, d), HW[c], acc));
    }
    let mid = sub(pl[(18u + c) * N + i], pl[(3u + c) * N + i]); let low = sub(pl[(15u + c) * N + i], pl[c * N + i]);
    pl[(31u + c) * N + i] = mfma(mul(mid, mid), MW[c], acc); pl[(34u + c) * N + i] = mul(mul(low, low), DW[c]);
  }
}
// mask_input's per-sample step for the bands at plane P.src (0 the distorted, 15 the reference), into plane 39.
@compute @workgroup_size(64)
fn maskIn(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x + id.y * 65535u * 64u; if (i >= n()) { return; }
  let N = n(); let b = P.src;
  let x = mul(add(pl[(b + 8u) * N + i], pl[(b + 6u) * N + i]), 2.5); let y = mfma(pl[(b + 9u) * N + i], 0.4, mul(pl[(b + 7u) * N + i], 0.4));
  let m = root(mfma(x, x, mul(y, y)));
  pl[39u * N + i] = sub(root(mfma(${K(6.19424080439)}, abs(m), ${K(BIAS)})), ${K(Math.sqrt(BIAS))});
}
fn visit(x: i32, y: i32, e: ptr<function, vec3f>) {
  if (x < 0 || y < 0 || x >= i32(P.w) || y >= i32(P.h)) { return; }
  let v = pl[37u * n() + u32(y) * P.w + u32(x)];
  if (v < (*e).z) { if (v < (*e).x) { *e = vec3f(v, (*e).x, (*e).y); } else if (v < (*e).y) { *e = vec3f((*e).x, v, (*e).y); } else { (*e).z = v; } }
}
fn maskWeight(v: f32, dc: bool) -> f32 {
  var mult = ${D(2.5485944793)}; var scale = ${D(.451936922203)}; var off = ${D(.829591754942)};
  if (dc) { mult = ${D(.505054525019)}; scale = ${D(3.87449418804)}; off = ${D(.20025578522)}; }
  let r = f64mul(${D(GLOBAL)}, f64add(${D(1)}, f64div(mult, f64fma(scale, D(v), off))));
  return f64toF32(f64mul(r, r));
}
// The rest of ba_metric_diff: the masks' difference, erosion, the weights, the map (plane 40).
@compute @workgroup_size(64)
fn diffEnd(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x + id.y * 65535u * 64u; if (i >= n()) { return; }
  let N = n(); let x = i32(i % P.w); let y = i32(i / P.w);
  let delta = sub(pl[37u * N + i], pl[38u * N + i]); let ac1 = mfma(mul(10.0, delta), delta, pl[32u * N + i]);
  let l = pl[37u * N + i]; var e = vec3f(l, mul(2.0, l), mul(2.0, l));
  visit(x - 3, y, &e); visit(x - 3, y - 3, &e); visit(x - 3, y + 3, &e); visit(x + 3, y, &e);
  visit(x + 3, y - 3, &e); visit(x + 3, y + 3, &e); visit(x, y - 3, &e); visit(x, y + 3, &e);
  let m = mfma(0.25, e.z, mfma(0.45, e.x, mul(0.3, e.y)));
  let wm = maskWeight(m, false); let wd = maskWeight(m, true);
  let high = mfma(pl[33u * N + i], wm, mfma(pl[31u * N + i], wm, mul(ac1, wm)));
  let low = mfma(pl[36u * N + i], wd, mfma(pl[34u * N + i], wd, mul(pl[35u * N + i], wd)));
  pl[40u * N + i] = root(add(low, high));
  done64();
}
// ba_metric_down: the input planes 12-14 into the half scale's (q).
@compute @workgroup_size(64)
fn downScale(@builtin(global_invocation_id) id: vec3u) {
  let ww = (P.w + 1u) / 2u; let hh = (P.h + 1u) / 2u; let nn = ww * hh;
  let t = id.x + id.y * 65535u * 64u; if (t >= 3u * nn) { return; }
  let c = t / nn; let j = t % nn; let X = j % ww; let Y = j / ww; var s = 0.0;
  for (var y = 2u * Y; y < min(2u * Y + 2u, P.h); y++) { for (var x = 2u * X; x < min(2u * X + 2u, P.w); x++) {
    s = add(s, mul(0.25, pl[(12u + c) * n() + y * P.w + x]));
  } }
  if ((P.w & 1u) == 1u && X == ww - 1u) { s = mul(s, 2.0); }
  if ((P.h & 1u) == 1u && Y == hh - 1u) { s = mul(s, 2.0); }
  q[(12u + c) * nn + j] = s;
}
// ba_metric_mix: the map (plane 40) with the half scale's (q plane 40).
@compute @workgroup_size(64)
fn mixScales(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x + id.y * 65535u * 64u; if (i >= n()) { return; }
  let ww = (P.w + 1u) / 2u; let nn = ww * ((P.h + 1u) / 2u);
  let m = f64toF32(f64mul(D(pl[40u * n() + i]), ${D(.85)}));
  pl[40u * n() + i] = add(m, mul(0.5, q[40u * nn + (i / P.w / 2u) * ww + (i % P.w) / 2u]));
  done64();
}
`;

const ENTRIES = ['blurH', 'blurV', 'dynamics', 'bandStep', 'maltaDiff', 'maltaSum', 'maskIn', 'diffEnd', 'downScale', 'mixScales'];
const shaderSet = device => gpuComputeSet(device, 'butteraugli', BA_SHADER, ['uniform', 'storage', 'read-only-storage', 'storage', 'storage'], ENTRIES);
function scale(device, set, tools, e, w, h, planes, G, FL) {
  const {buf, dispatch, bind} = tools, n = w * h, PL = buf(planes * n * 4), none = buf(16);
  const s = {w, h, n, PL, other: null};
  s.go = (entry, fields, count = n) => {
    const u = new ArrayBuffer(48), U = new Uint32Array(u); U.set([w, h, 0, ...fields]); new Float32Array(u)[2] = 1;
    const ub = buf(48, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST); device.queue.writeBuffer(ub, 0, u);
    dispatch(e, set[entry], bind(set.group, [ub, PL, G, FL, s.other?.PL ?? none]), count);
  };
  const blur = (src, kind, dst) => { const [radius, koff] = BLUR[kind]; s.go('blurH', [kind, radius, koff, src, dst, 10, 0]); s.go('blurV', [kind, radius, koff, src, dst, 10, 0]); };
  const step = (kind, c = 0) => s.go('bandStep', [kind, 0, 0, 0, 0, 0, c]);
  s.bands = () => {
    for (let c = 0; c < 3; c++) blur(12 + c, 0, c);
    s.go('dynamics', [0, 0, 0, 0, 0, 0, 0]);
    for (let c = 0; c < 3; c++) { blur(3 + c, 1, c); step(1, c); }
    step(2);
    for (let c = 0; c < 3; c++) { blur(3 + c, 2, c < 2 ? 6 + c : 11); step(3, c); }
    step(4);
    for (let c = 0; c < 2; c++) { blur(8 + c, 3, 6 + c); step(5, c); }
  };
  let held = null;
  s.copy = (from, to, count, source = PL) => {
    if (source !== PL) return e.copyBufferToBuffer(source, from * n * 4, PL, to * n * 4, count * n * 4);
    held ??= buf(10 * n * 4); e.copyBufferToBuffer(PL, from * n * 4, held, 0, count * n * 4); e.copyBufferToBuffer(held, 0, PL, to * n * 4, count * n * 4);
  };
  s.diff = () => {
    s.go('maltaDiff', [0, 0, 0, 0, 0, 0, 0]); s.go('maltaSum', [0, 0, 0, 0, 0, 0, 0]);
    s.go('maskIn', [0, 0, 0, 15, 0, 0, 0]); blur(39, 4, 37);
    s.go('maskIn', [0, 0, 0, 0, 0, 0, 0]); blur(39, 4, 38);
    s.go('diffEnd', [0, 0, 0, 0, 0, 0, 0]);
  };
  s.down = () => s.go('downScale', [0, 0, 0, 0, 0, 0, 0], 3 * s.other.n);
  return s;
}
async function run(device, record) {
  const set = await shaderSet(device), made = [], tools = gpuBuffers(device, null, made);
  try {
    const G = tools.buf(BA_GAUSSIAN.byteLength), FL = tools.buf(16);
    device.queue.writeBuffer(G, 0, BA_GAUSSIAN); device.queue.writeBuffer(FL, 0, new Uint32Array(4));
    const e = device.createCommandEncoder(), at = (w, h, planes) => scale(device, set, tools, e, w, h, planes, G, FL);
    const reads = record(at, tools.buf);
    device.queue.submit([e.finish()]);
    const got = await tools.read([...reads, [FL, 0, 4]]);
    return {got: got.slice(0, -1).map(b => new Float32Array(b)), flagged: new Uint32Array(got.at(-1))[0]};
  } finally { for (const b of made) b.destroy(); }
}

export async function gpuBaMap(device, ref, dist, w, h, {half = (w + 1) >> 1 >= 8 && (h + 1) >> 1 >= 8} = {}) {
  const r = await run(device, (at, buf) => {
    const full = at(w, h, 41), n = full.n, hw = (w + 1) >> 1, hh = (h + 1) >> 1, IN = buf(6 * n * 4);
    device.queue.writeBuffer(IN, 0, ref.buffer, ref.byteOffset, 3 * n * 4);
    device.queue.writeBuffer(IN, 3 * n * 4, dist.buffer, dist.byteOffset, 3 * n * 4);
    const low = half ? at(hw, hh, 41) : null;
    if (low) { full.other = low; low.other = full; }
    full.copy(0, 12, 3, IN); full.bands(); full.copy(0, 15, 10);
    if (low) { full.down(); low.bands(); low.copy(0, 15, 10); }
    full.copy(3, 12, 3, IN); full.bands(); full.diff();
    if (low) { full.down(); low.bands(); low.diff(); full.go('mixScales', [0, 0, 0, 0, 0, 0, 0]); }
    return [[full.PL, 40 * n * 4, n * 4]];
  });
  return {map: r.got[0], flagged: r.flagged};
}

export async function gpuBaWindow(device, ref, dist, w, h, limit = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize)) {
  const fits = cols => 41 * 4 * h * cols <= limit;
  if (fits(w)) return gpuBaMap(device, ref, dist, w, h);
  let k = Math.floor((limit / (41 * 4 * h) - 160) / 256);
  if (k < 1) return {map: null, flagged: 1};
  const n = w * h, map = new Float32Array(n); let flagged = 0;
  for (let x = 0; x < w; x += 256 * k) {
    const left = Math.max(0, x - 80), right = Math.min(w, x + 256 * k + 80), cw = right - left, m = cw * h;
    const cut = planes => { const o = new Float32Array(3 * m); for (let c = 0; c < 3; c++) for (let r = 0; r < h; r++) o.set(planes.subarray(c * n + r * w + left, c * n + r * w + right), c * m + r * cw); return o; };
    const part = await gpuBaMap(device, cut(ref), cut(dist), cw, h);
    flagged += part.flagged;
    for (let r = 0; r < h; r++) map.set(part.map.subarray(r * cw + x - left, r * cw + Math.min(w, x + 256 * k) - left), r * w + x);
  }
  return {map, flagged};
}
