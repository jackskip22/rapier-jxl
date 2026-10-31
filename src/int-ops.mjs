// SPDX-License-Identifier: MIT
export const inRange = (v, lo, hi, what) => { if (!(v >= lo && v <= hi)) throw new RangeError(`int-ops: ${what} ${v} outside [${lo}, ${hi}]`); return v; };

export const R = (s, k) => (s + (1 << (k - 1))) >> k;
export const Rn = (s, k) => Math.floor((s + 2 ** (k - 1)) / 2 ** k);
export const Rb = (s, k) => (s + (1n << BigInt(k - 1))) >> BigInt(k);
export const rSplit = (H, L, t, k) => (H + (L >> t) + (1 << (k - t - 1))) >> (k - t);

export function mul64(a, b) {
  const al = a & 0xffff, ah = a >>> 16, bl = b & 0xffff, bh = b >>> 16;
  const ll = al * bl, lh = al * bh, hl = ah * bl, hh = ah * bh;
  const mid = (lh + hl) >>> 0, c1 = mid < lh ? 1 : 0;
  const lo = (ll + (mid & 0xffff) * 65536) >>> 0, c2 = lo < ll ? 1 : 0;
  return [lo, (hh + (mid >>> 16) + c1 * 65536 + c2) >>> 0];
}
export const add64 = ([al, ah], [bl, bh]) => { const lo = (al + bl) >>> 0; return [lo, (ah + bh + (lo < al ? 1 : 0)) >>> 0]; };
export const neg64 = ([lo, hi]) => { const l = (~lo + 1) >>> 0; return [l, (~hi + (l === 0 ? 1 : 0)) >>> 0]; };
export const mulS64 = (a, b) => { const p = mul64(Math.abs(a) >>> 0, b >>> 0); return a < 0 ? neg64(p) : p; };
export const mulSS64 = (a, b) => { const p = mul64(Math.abs(a) >>> 0, Math.abs(b) >>> 0); return (a < 0) !== (b < 0) ? neg64(p) : p; };
export function shr64u([lo, hi], k) {
  if (k === 0) return [lo, hi];
  if (k < 32) return [((lo >>> k) | (hi << (32 - k))) >>> 0, hi >>> k];
  if (k === 32) return [hi, 0];
  return [hi >>> (k - 32), 0];
}
export function shr64s([lo, hi], k) {
  const h = hi | 0, sign = (h >> 31) >>> 0;
  if (k === 0) return [lo, hi];
  if (k < 32) return [((lo >>> k) | (hi << (32 - k))) >>> 0, (h >> k) >>> 0];
  if (k === 32) return [hi, sign];
  return [(h >> (k - 32)) >>> 0, sign];
}
export const toBig = ([lo, hi]) => (BigInt(hi) << 32n) | BigInt(lo);
export const toBigS = ([lo, hi]) => (BigInt(hi | 0) << 32n) | BigInt(lo);
export const fromBig = v => { const u = BigInt.asUintN(64, v); return [Number(u & 0xffffffffn), Number(u >> 32n)]; };
export function isqrt(n) { let r = Math.min(65535, Math.floor(Math.sqrt(n))); while (r * r > n) r--; while (r < 65535 && (r + 1) * (r + 1) <= n) r++; return r; }
export const udiv = (a, b) => { inRange(b, 1, 2 ** 53, 'divisor'); inRange(a, 0, 2 ** 53, 'dividend'); return Math.floor(a / b); };
export const floorDivB = (p, q) => { const d = p / q; return p % q !== 0n && (p < 0n) !== (q < 0n) ? d - 1n : d; };
export const roundDivB = (p, q) => floorDivB(2n * p + q, 2n * q);

export const INT_WGSL =  `
fn mul64(a: u32, b: u32) -> vec2u {
  let al = a & 0xffffu; let ah = a >> 16u; let bl = b & 0xffffu; let bh = b >> 16u;
  let ll = al * bl; let lh = al * bh; let hl = ah * bl; let hh = ah * bh;
  let mid = lh + hl; let c1 = select(0u, 1u, mid < lh);
  let lo = ll + (mid << 16u); let c2 = select(0u, 1u, lo < ll);
  return vec2u(lo, hh + (mid >> 16u) + (c1 << 16u) + c2);
}
fn add64(a: vec2u, b: vec2u) -> vec2u { let lo = a.x + b.x; return vec2u(lo, a.y + b.y + select(0u, 1u, lo < a.x)); }
fn neg64(a: vec2u) -> vec2u { let lo = ~a.x + 1u; return vec2u(lo, ~a.y + select(0u, 1u, lo == 0u)); }
fn mulS64(a: i32, b: u32) -> vec2u { let p = mul64(u32(abs(a)), b); return select(p, neg64(p), a < 0); }
fn mulSS64(a: i32, b: i32) -> vec2u { let p = mul64(u32(abs(a)), u32(abs(b))); return select(p, neg64(p), (a < 0) != (b < 0)); }
fn shr64u(a: vec2u, k: u32) -> vec2u {
  if (k == 0u) { return a; }
  if (k < 32u) { return vec2u((a.x >> k) | (a.y << (32u - k)), a.y >> k); }
  if (k == 32u) { return vec2u(a.y, 0u); }
  return vec2u(a.y >> (k - 32u), 0u);
}
fn shr64s(a: vec2u, k: u32) -> vec2u {
  let h = bitcast<i32>(a.y); let sign = bitcast<u32>(h >> 31u);
  if (k == 0u) { return a; }
  if (k < 32u) { return vec2u((a.x >> k) | (a.y << (32u - k)), bitcast<u32>(h >> k)); }
  if (k == 32u) { return vec2u(a.y, sign); }
  return vec2u(bitcast<u32>(h >> (k - 32u)), sign);
}
fn isqrt(n: u32) -> u32 {
  var r = min(u32(sqrt(f32(n))), 65535u);
  loop { if (r * r > n) { r = r - 1u; continue; } break; }
  loop { let s = r + 1u; if (s <= 65535u && s * s <= n) { r = s; continue; } break; }
  return r;
}`;
