// SPDX-License-Identifier: MIT
export const F64_WGSL = `
var<private> f64Bad: bool;
fn u64add(a: vec2u, b: vec2u) -> vec2u { let lo = a.x + b.x; return vec2u(lo, a.y + b.y + select(0u, 1u, lo < a.x)); }
fn u64sub(a: vec2u, b: vec2u) -> vec2u { return vec2u(a.x - b.x, a.y - b.y - select(0u, 1u, a.x < b.x)); }
fn u64lt(a: vec2u, b: vec2u) -> bool { return a.y < b.y || (a.y == b.y && a.x < b.x); }
fn u64shl(a: vec2u, s: u32) -> vec2u {
  if (s == 0u) { return a; } if (s >= 64u) { return vec2u(0u); }
  if (s >= 32u) { return vec2u(0u, a.x << (s - 32u)); }
  return vec2u(a.x << s, (a.y << s) | (a.x >> (32u - s)));
}
// a >> s with the bits shifted out ORed into bit 0 (sticky).
fn u64shrs(a: vec2u, s: u32) -> vec2u {
  if (s == 0u) { return a; }
  if (s >= 64u) { return vec2u(select(0u, 1u, a.x != 0u || a.y != 0u), 0u); }
  var r: vec2u; var lost: bool;
  if (s >= 32u) { let t = s - 32u; r = vec2u(select(a.y >> t, 0u, t >= 32u), 0u); lost = a.x != 0u || (t > 0u && (a.y & ((1u << t) - 1u)) != 0u); }
  else { r = vec2u((a.x >> s) | (a.y << (32u - s)), a.y >> s); lost = (a.x & ((1u << s) - 1u)) != 0u; }
  return vec2u(r.x | select(0u, 1u, lost), r.y);
}
fn u32mul(a: u32, b: u32) -> vec2u {
  let al = a & 0xffffu; let ah = a >> 16u; let bl = b & 0xffffu; let bh = b >> 16u;
  let ll = al * bl; let lh = al * bh; let hl = ah * bl; let hh = ah * bh;
  let mid = lh + hl; let midCarry = select(0u, 0x10000u, mid < lh);
  let lo = ll + (mid << 16u); let carry = select(0u, 1u, lo < ll);
  return vec2u(lo, hh + (mid >> 16u) + midCarry + carry);
}
fn clz64(a: vec2u) -> u32 { if (a.y != 0u) { return countLeadingZeros(a.y); } return 32u + countLeadingZeros(a.x); }
fn f64sign(a: vec2u) -> u32 { return a.y >> 31u; }
fn f64exp(a: vec2u) -> u32 { return (a.y >> 20u) & 0x7ffu; }
// The significand with its implicit bit (53 bits), for a normal value.
fn f64sig(a: vec2u) -> vec2u { return vec2u(a.x, (a.y & 0xfffffu) | 0x100000u); }
fn f64isZero(a: vec2u) -> bool { return a.x == 0u && (a.y & 0x7fffffffu) == 0u; }
fn f64check(a: vec2u) { let e = f64exp(a); if ((e == 0u && !f64isZero(a)) || e == 0x7ffu) { f64Bad = true; } }
// Round a 56-bit significand (53 bits, then guard, round and sticky) at exponent e, ties to even, and pack.
fn f64pack(s: u32, e0: i32, m0: vec2u) -> vec2u {
  var m = m0; var e = e0;
  let rem = m.x & 7u; let odd = (m.x >> 3u) & 1u;
  if (rem > 4u || (rem == 4u && odd == 1u)) { m = u64add(m, vec2u(8u, 0u)); }
  if ((m.y & 0x1000000u) != 0u) { m = u64shrs(m, 1u); e = e + 1; }
  if (e <= 0 || e >= 2047) { f64Bad = true; return vec2u(0u, s << 31u); }
  let q = vec2u((m.x >> 3u) | (m.y << 29u), m.y >> 3u);
  return vec2u(q.x, (s << 31u) | (u32(e) << 20u) | (q.y & 0xfffffu));
}
fn f64neg(a: vec2u) -> vec2u { return vec2u(a.x, a.y ^ 0x80000000u); }
fn f64fromF32(f: f32) -> vec2u {
  let b = bitcast<u32>(f); let e = (b >> 23u) & 0xffu;
  if ((b & 0x7fffffffu) == 0u) { return vec2u(0u, b & 0x80000000u); }
  if (e == 0u || e == 255u) { f64Bad = true; return vec2u(0u); }
  let m = b & 0x7fffffu;
  return vec2u(m << 29u, (b & 0x80000000u) | ((e + 896u) << 20u) | (m >> 3u));
}
fn f64add(a: vec2u, b: vec2u) -> vec2u {
  f64check(a); f64check(b);
  if (f64isZero(a)) { if (f64isZero(b)) { return vec2u(0u, a.y & b.y & 0x80000000u); } return b; }
  if (f64isZero(b)) { return a; }
  var x = a; var y = b;
  if (f64exp(x) < f64exp(y) || (f64exp(x) == f64exp(y) && u64lt(f64sig(x), f64sig(y)))) { x = b; y = a; }
  var e = i32(f64exp(x)); let d = u32(e - i32(f64exp(y)));
  let mx = u64shl(f64sig(x), 3u); let my = u64shrs(u64shl(f64sig(y), 3u), d);
  let s = f64sign(x);
  var m: vec2u;
  if (f64sign(x) == f64sign(y)) {
    m = u64add(mx, my);
    if ((m.y & 0x1000000u) != 0u) { m = u64shrs(m, 1u); e = e + 1; }
  } else {
    m = u64sub(mx, my);
    if (m.x == 0u && m.y == 0u) { return vec2u(0u); }
    let shift = clz64(m) - 8u;
    m = u64shl(m, shift); e = e - i32(shift);
  }
  return f64pack(s, e, m);
}
fn f64sub(a: vec2u, b: vec2u) -> vec2u { return f64add(a, f64neg(b)); }
// The 106-bit product of two 53-bit significands: four words, low first.
fn sigMul(a: vec2u, b: vec2u) -> vec4u {
  let p00 = u32mul(a.x, b.x); let p01 = u32mul(a.x, b.y); let p10 = u32mul(a.y, b.x); let p11 = u32mul(a.y, b.y);
  var w1 = u64add(vec2u(p00.y, 0u), vec2u(p01.x, 0u)); w1 = u64add(w1, vec2u(p10.x, 0u));
  var w2 = u64add(vec2u(w1.y, 0u), vec2u(p01.y, 0u)); w2 = u64add(w2, vec2u(p10.y, 0u)); w2 = u64add(w2, vec2u(p11.x, 0u));
  return vec4u(p00.x, w1.x, w2.x, p11.y + w2.y);
}
// A 128-bit value's 56 bits from bit top down (the rest ORed into bit 0).
fn take56(p: vec4u, top: u32) -> vec2u { if (top < 55u) { return shl128(p, 55u - top).xy; } return shr128s(p, top - 55u).xy; }
fn f64mul(a: vec2u, b: vec2u) -> vec2u {
  f64check(a); f64check(b);
  let s = f64sign(a) ^ f64sign(b);
  if (f64isZero(a) || f64isZero(b)) { return vec2u(0u, s << 31u); }
  let p = sigMul(f64sig(a), f64sig(b));
  var e = i32(f64exp(a)) + i32(f64exp(b)) - 1023;
  if ((p.w & 0x200u) != 0u) { e = e + 1; return f64pack(s, e, take56(p, 105u)); }
  return f64pack(s, e, take56(p, 104u));
}
fn f64div(a: vec2u, b: vec2u) -> vec2u {
  f64check(a); f64check(b);
  let s = f64sign(a) ^ f64sign(b);
  if (f64isZero(b)) { f64Bad = true; return vec2u(0u); }
  if (f64isZero(a)) { return vec2u(0u, s << 31u); }
  var r = f64sig(a); let d = f64sig(b);
  var e = i32(f64exp(a)) - i32(f64exp(b)) + 1023;
  if (u64lt(r, d)) { r = u64shl(r, 1u); e = e - 1; }
  // 56 quotient bits: the first is 1 (r >= d).
  var q = vec2u(0u);
  for (var i = 0u; i < 56u; i++) {
    q = u64shl(q, 1u);
    if (!u64lt(r, d)) { r = u64sub(r, d); q = vec2u(q.x | 1u, q.y); }
    r = u64shl(r, 1u);
  }
  q = vec2u(q.x | select(0u, 1u, r.x != 0u || r.y != 0u), q.y);
  return f64pack(s, e, q);
}
// a * b + c, one rounding.
fn f64fma(a: vec2u, b: vec2u, c: vec2u) -> vec2u {
  f64check(a); f64check(b); f64check(c);
  let sp = f64sign(a) ^ f64sign(b);
  if (f64isZero(a) || f64isZero(b)) { return f64add(vec2u(0u, sp << 31u), c); }
  let p0 = sigMul(f64sig(a), f64sig(b));
  // The product's bits from 105 move to 125; bit k is then worth 2^(k + ea + eb - 2170). c's leading bit lands at kc.
  let eab = i32(f64exp(a)) + i32(f64exp(b));
  if (f64isZero(c)) {
    if ((p0.w & 0x200u) != 0u) { return f64pack(sp, eab - 1022, take56(p0, 105u)); }
    return f64pack(sp, eab - 1023, take56(p0, 104u));
  }
  let sc = f64sign(c); let kc = i32(f64exp(c)) - eab + 1147;
  let cs = vec4u(f64sig(c), 0u, 0u);
  var P = shl128(p0, 20u); var C: vec4u; var up = 0;
  if (kc > 125) { up = kc - 125; P = shr128s(P, u32(up)); C = shl128(cs, 73u); }
  else if (kc >= 52) { C = shl128(cs, u32(kc - 52)); } else { C = shr128s(cs, u32(52 - kc)); }
  var m: vec4u; var s = sp;
  if (sp == sc) { m = add128(P, C); }
  else if (lt128(P, C)) { m = sub128(C, P); s = sc; } else { m = sub128(P, C); }
  if (m.x == 0u && m.y == 0u && m.z == 0u && m.w == 0u) { return vec2u(0u); }
  let lead = 127u - clz128(m);
  return f64pack(s, i32(lead) + eab - 2170 + up + 1023, take56(m, lead));
}
fn shl128(a: vec4u, s: u32) -> vec4u {
  var r = a; var k = s;
  loop { if (k < 32u) { break; } r = vec4u(0u, r.x, r.y, r.z); k = k - 32u; }
  if (k == 0u) { return r; }
  return vec4u(r.x << k, (r.y << k) | (r.x >> (32u - k)), (r.z << k) | (r.y >> (32u - k)), (r.w << k) | (r.z >> (32u - k)));
}
fn shr128s(a: vec4u, s: u32) -> vec4u {
  var r = a; var k = s; var lost = false;
  if (k >= 128u) { return vec4u(select(0u, 1u, a.x != 0u || a.y != 0u || a.z != 0u || a.w != 0u), 0u, 0u, 0u); }
  loop { if (k < 32u) { break; } lost = lost || r.x != 0u; r = vec4u(r.y, r.z, r.w, 0u); k = k - 32u; }
  if (k > 0u) {
    lost = lost || (r.x & ((1u << k) - 1u)) != 0u;
    r = vec4u((r.x >> k) | (r.y << (32u - k)), (r.y >> k) | (r.z << (32u - k)), (r.z >> k) | (r.w << (32u - k)), r.w >> k);
  }
  return vec4u(r.x | select(0u, 1u, lost), r.y, r.z, r.w);
}
fn add128(a: vec4u, b: vec4u) -> vec4u {
  let x = a.x + b.x; let c0 = select(0u, 1u, x < a.x);
  let y0 = a.y + b.y; let y = y0 + c0; let c1 = select(0u, 1u, y0 < a.y || y < y0);
  let z0 = a.z + b.z; let z = z0 + c1; let c2 = select(0u, 1u, z0 < a.z || z < z0);
  return vec4u(x, y, z, a.w + b.w + c2);
}
fn sub128(a: vec4u, b: vec4u) -> vec4u {
  let x = a.x - b.x; let c0 = select(0u, 1u, a.x < b.x);
  let y0 = a.y - b.y; let y = y0 - c0; let c1 = select(0u, 1u, a.y < b.y || y0 < c0);
  let z0 = a.z - b.z; let z = z0 - c1; let c2 = select(0u, 1u, a.z < b.z || z0 < c1);
  return vec4u(x, y, z, a.w - b.w - c2);
}
fn lt128(a: vec4u, b: vec4u) -> bool {
  if (a.w != b.w) { return a.w < b.w; } if (a.z != b.z) { return a.z < b.z; } if (a.y != b.y) { return a.y < b.y; } return a.x < b.x;
}
fn clz128(a: vec4u) -> u32 {
  if (a.w != 0u) { return countLeadingZeros(a.w); } if (a.z != 0u) { return 32u + countLeadingZeros(a.z); }
  if (a.y != 0u) { return 64u + countLeadingZeros(a.y); } return 96u + countLeadingZeros(a.x);
}
// A double rounded to binary32, ties to even (normal results; else f64Bad).
fn f64toF32(a: vec2u) -> f32 {
  f64check(a);
  if (f64isZero(a)) { return bitcast<f32>(a.y & 0x80000000u); }
  let e = i32(f64exp(a)) - 1023 + 127;
  // 24 bits of significand: drop 29 low bits with round and sticky.
  let sig = f64sig(a);
  var m = (sig.y << 3u) | (sig.x >> 29u);
  let rest = sig.x & 0x1fffffffu; let half = 0x10000000u;
  var ee = e;
  if (rest > half || (rest == half && (m & 1u) == 1u)) { m = m + 1u; if (m == 0x1000000u) { m = 0x800000u; ee = ee + 1; } }
  if (ee <= 0 || ee >= 255) { f64Bad = true; return 0.0; }
  return bitcast<f32>((f64sign(a) << 31u) | (u32(ee) << 23u) | (m & 0x7fffffu));
}
fn f64gt(a: vec2u, b: vec2u) -> bool { return f64lt(b, a); }
fn f64lt(a: vec2u, b: vec2u) -> bool {
  let za = f64isZero(a); let zb = f64isZero(b);
  if (za && zb) { return false; }
  let sa = f64sign(a); let sb = f64sign(b);
  if (za) { return sb == 0u; } if (zb) { return sa == 1u; }
  if (sa != sb) { return sa == 1u; }
  let mag = u64lt(vec2u(a.x, a.y & 0x7fffffffu), vec2u(b.x, b.y & 0x7fffffffu));
  let same = a.x == b.x && (a.y & 0x7fffffffu) == (b.y & 0x7fffffffu);
  if (same) { return false; }
  return select(!mag, mag, sa == 0u);
}`;
export const f64Const = v => { const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, v, true); return `vec2u(${b.getUint32(0, true)}u, ${b.getUint32(4, true)}u)`; };
