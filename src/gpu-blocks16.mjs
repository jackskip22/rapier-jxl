// SPDX-License-Identifier: MIT

export const B16_BOUNDS = Object.freeze({u2: 2 ** -48, u64: 2 ** -53, safety: 8, rel: 32 * 2 ** -48 + 8 * 2 ** -53, floor: 1e-30});
export const b16Sum = size => 3 * size * (8 * B16_BOUNDS.u2 + B16_BOUNDS.u64);
export const b16Tr = side => ((3 * 2 * side + 20) * B16_BOUNDS.u2 + (2 * side + 2) * B16_BOUNDS.u64) * 2 / (side * side);
const b16F = v => { const s = Math.fround(v).toString(); return /[.eE]/.test(s) ? s : s + '.0'; };

const B16K = {basis8: 0, basis16: 64, steps8: 320, steps16: 512, recon: 1280, log2: 5376, one: 9472, dead: 9475, norm: 9481, rc: 9484, detail: 9488, dcStep: 9489, lowM: 9492, mask: 9508, size: 9510};
const B16T = {order8: 0, order16: 64, high8: 320, high16: 384, size: 640};
const B16_OUT = 6;

const B16_PIXEL = `fn pixel(c: u32, i: u32) -> vec2f { if (c == 0u) { return plX[i]; } if (c == 1u) { return plY[i]; } return plB[i]; }
fn dsqrt(a: vec2f) -> vec2f { if (a.x <= 0.0) { return vec2f(0.0, 0.0); } let s = sqrt(a.x); let r = dsub(a, tp(s, s)); return fs(s, r.x / (2.0 * s)); }`;

const b16EnergyShader = ds =>  `
struct P { W: u32, stride: u32, by0: u32, blocks: u32, top: u32, groupsX: u32, plane: f32, pad: u32, q0: u32, q1: u32, q2: u32, q3: u32, one: f32 }
@group(0) @binding(0) var<uniform> p: P;
fn gcOne() -> f32 { return p.one; }
@group(0) @binding(1) var<storage, read> plX: array<vec2f>;
@group(0) @binding(2) var<storage, read> plY: array<vec2f>;
@group(0) @binding(3) var<storage, read> plB: array<vec2f>;
@group(0) @binding(4) var<storage, read> K: array<vec2f>;
@group(0) @binding(5) var<storage, read_write> out: array<f32>;
${ds}
${B16_PIXEL}
const REL = ${b16F(B16_BOUNDS.rel)};
const SAFE = ${b16F(B16_BOUNDS.safety)};
fn soft(e: vec2f) -> vec2f { return ddiv(e, dadd(vec2f(1.0, 0.0), dmul(K[${B16K.mask}u], e))); }
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) g: vec3u, @builtin(local_invocation_index) lid: u32) {
  let index = (g.y * p.groupsX + g.x) * 64u + lid;
  if (index >= p.blocks) { return; }
  let bx = index % p.stride; let by = p.by0 + index / p.stride; let W = p.W;
  var s = vec2f(0.0, 0.0); var size = 0.0;
  for (var y = 0u; y < 7u; y++) { for (var x = 0u; x < 7u; x++) {
    let i = (by * 8u + y - p.top) * W + bx * 8u + x;
    let dy1 = dsub(plY[i + 1u], plY[i]); let dy2 = dsub(plY[i + W], plY[i]); let dd = dsub(dsub(dadd(plY[i + W + 1u], plY[i]), plY[i + 1u]), plY[i + W]);
    let dx = dsub(plX[i + 1u], plX[i]); let db = dsub(plB[i + 1u], plB[i]);
    let eY = dsqrt(dadd(dadd(dmul(dy1, dy1), dmul(dy2, dy2)), dmul(vec2f(0.5, 0.0), dmul(dd, dd))));
    let eC = dsqrt(dadd(dmul(vec2f(4.0, 0.0), dmul(dx, dx)), dmul(vec2f(0.25, 0.0), dmul(db, db))));
    s = dadd(s, dadd(soft(eY), dmul(K[${B16K.mask}u + 1u], soft(eC))));
    size += eY.x + eC.x + abs(dy1.x) + abs(dy2.x) + abs(dd.x) + abs(dx.x) + abs(db.x);
  } }
  let hf = ddiv(s, vec2f(49.0, 0.0));
  out[index * 3u] = hf.x; out[index * 3u + 1u] = hf.y;
  out[index * 3u + 2u] = 8.6 * p.plane + SAFE * REL * 32.0 * size / 49.0 + 1e-30;
}`;

const b16Shader = ds =>  `
struct P { W: u32, stride: u32, rows: u32, cflW: u32, cellsX: u32, cy0: u32, top: u32, bandPx: u32, hasDead: u32, oCell: u32, oTile: u32, plane: f32, one: f32 }
@group(0) @binding(0) var<uniform> p: P;
fn gcOne() -> f32 { return p.one; }
@group(0) @binding(1) var<storage, read> plX: array<vec2f>;
@group(0) @binding(2) var<storage, read> plY: array<vec2f>;
@group(0) @binding(3) var<storage, read> plB: array<vec2f>;
@group(0) @binding(4) var<storage, read> K: array<vec2f>;
@group(0) @binding(5) var<storage, read> T: array<u32>;
@group(0) @binding(6) var<storage, read> blk: array<vec2f>;
@group(0) @binding(7) var<storage, read_write> out: array<f32>;
${ds}
${B16_PIXEL}
var<workgroup> px: array<vec2f, 256>;
// The transforms' row pass; while a channel is priced, its partial sums of d (0-127) and rate (128-255).
var<workgroup> tm: array<vec2f, 256>;
var<workgroup> y16: array<vec2f, 256>;
var<workgroup> y8: array<vec2f, 256>;
var<workgroup> c16: array<vec2f, 256>;
var<workgroup> c8: array<vec2f, 256>;
var<workgroup> pn: array<u32, 128>;
var<workgroup> plast: array<u32, 128>;
var<workgroup> pe: array<f32, 128>;
var<workgroup> pf: array<u32, 128>;
var<workgroup> mag: array<f32, 15>;
var<workgroup> accD: array<vec2f, 5>;
var<workgroup> accR: array<vec2f, 5>;
var<workgroup> accE: array<f32, 5>;
var<workgroup> accF: array<u32, 5>;

const U2 = ${b16F(B16_BOUNDS.u2)};
const REL = ${b16F(B16_BOUNDS.rel)};
const SAFE = ${b16F(B16_BOUNDS.safety)};
const TR8 = ${b16F(b16Tr(8))};
const TR16 = ${b16F(b16Tr(16))};

struct Q { d: vec2f, r: vec2f, e: f32, flag: u32, q: u32 }

// One coefficient as full() quantizes and prices it: c the channel, tr and luma the coefficients, bt and btY their
// bounds, fc the CfL factor, fine the block's field, high the position's dead-zone half.
fn level(c: u32, tr: vec2f, luma: vec2f, step: vec2f, high: u32, fc: vec2f, bt: f32, btY: f32, fine: vec2f) -> Q {
  var coefficient = tr;
  var bc = bt;
  if (c != 1u) { let s = dmul(fc, luma); coefficient = dsub(tr, s); bc = bt + abs(fc.x) * btY + 16.0 * U2 * (abs(tr.x) + abs(s.x)); }
  let v = dmul(ddiv(coefficient * 2048.0, step), fine);
  let a = dabs(v);
  let scale = 2048.0 * fine.x / step.x;
  let ba = SAFE * (bc * scale + REL * a.x) + 1e-30;
  var thr = vec2f(0.5, 0.0);
  if (p.hasDead == 1u) { thr = K[${B16K.dead}u + c * 2u + high]; }
  var flag = 0u;
  let below = dsub(a, thr).x;
  if (abs(below) <= ba) { flag = 1u; }
  var q = 0.0;
  if (below >= 0.0) { let r = dround(a, vec2f(0.5, 0.0), ba); q = r.x; if (r.y != 0.0) { flag = 1u; } }
  if (q >= 4096.0) { flag = 1u; q = 4095.0; }
  let qi = u32(q);
  var recon = vec2f(0.0, 0.0);
  if (qi == 1u) { recon = K[${B16K.one}u + c]; } else if (qi > 1u) { recon = K[${B16K.recon}u + qi]; }
  let unit = fine * 2048.0;
  let e = ddiv(dmul(dsub(a, recon), step), unit);
  var w = vec2f(1.0, 0.0);
  if (qi == 0u) { w = K[${B16K.detail}u]; }
  let s = step.x / unit.x;
  let de = ba * s + SAFE * REL * (abs(e.x) + (a.x + recon.x) * s);
  var r = vec2f(0.0, 0.0);
  if (qi != 0u) { r = dadd(K[${B16K.rc}u + 1u], dmul(K[${B16K.rc}u + 2u], K[${B16K.log2}u + qi])); }
  return Q(dmul(dmul(e, e), w), r, w.x * (2.0 * abs(e.x) * de + de * de), flag, qi);
}

@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) g: vec3u, @builtin(local_invocation_index) lid: u32) {
  let cell = g.x;
  let cx = (cell % p.cellsX) * 2u;
  let cy = (cell / p.cellsX + p.cy0) * 2u;
  if (cy >= p.rows) { return; }
  let fits16 = cx + 1u < p.stride && cy + 1u < p.rows;
  let ti = (cy >> 3u) * p.cflW + (cx >> 3u);
  if (lid < 5u) { accD[lid] = vec2f(0.0, 0.0); accR[lid] = vec2f(0.0, 0.0); accE[lid] = 0.0; accF[lid] = 0u; }
  for (var ci = 0u; ci < 3u; ci++) {
    let c = select(select(2u, 0u, ci == 1u), 1u, ci == 0u);
    workgroupBarrier();
    // The cell's pixels of channel c (zero outside the picture's blocks).
    for (var i = lid; i < 256u; i += 64u) {
      let x = cx * 8u + i % 16u; let y = cy * 8u + i / 16u;
      var v = vec2f(0.0, 0.0);
      if (x < p.stride * 8u && y < p.rows * 8u) { v = pixel(c, (y - p.top) * p.W + x); }
      px[i] = v;
    }
    workgroupBarrier();
    // Sum |p| of each 8x8 sub-block (16 threads each), and the cell's.
    {
      let s = lid / 16u; let t = lid % 16u; var m = 0.0;
      for (var j = 0u; j < 4u; j++) { let k = t * 4u + j; m += abs(px[((s >> 1u) * 8u + k / 8u) * 16u + (s & 1u) * 8u + k % 8u].x); }
      pe[lid] = m;
    }
    workgroupBarrier();
    if (lid < 4u) { var m = 0.0; for (var j = 0u; j < 16u; j++) { m += pe[lid * 16u + j]; } mag[c * 5u + lid] = m * 1.001; }
    workgroupBarrier();
    if (lid == 0u) { mag[c * 5u + 4u] = (mag[c * 5u] + mag[c * 5u + 1u] + mag[c * 5u + 2u] + mag[c * 5u + 3u]) * 1.001; }
    // DCT16, rows then columns (scaledDCT: layout u * 16 + v).
    for (var i = lid; i < 256u; i += 64u) {
      let y = i / 16u; let u = i % 16u; var s = vec2f(0.0, 0.0);
      for (var x = 0u; x < 16u; x++) { s = dadd(s, dmul(px[y * 16u + x], K[${B16K.basis16}u + u * 16u + x])); }
      tm[y * 16u + u] = s;
    }
    workgroupBarrier();
    for (var i = lid; i < 256u; i += 64u) {
      let u = i / 16u; let v = i % 16u; var s = vec2f(0.0, 0.0);
      for (var y = 0u; y < 16u; y++) { s = dadd(s, dmul(tm[y * 16u + u], K[${B16K.basis16}u + v * 16u + y])); }
      if (c == 1u) { y16[u * 16u + v] = s; } else { c16[u * 16u + v] = s; }
    }
    workgroupBarrier();
    // The four DCT8s (sub-block s at s * 64, layout u * 8 + v).
    for (var i = lid; i < 256u; i += 64u) {
      let s = i / 64u; let j = i % 64u; let y = j / 8u; let u = j % 8u; let o = (s >> 1u) * 128u + (s & 1u) * 8u; var a = vec2f(0.0, 0.0);
      for (var x = 0u; x < 8u; x++) { a = dadd(a, dmul(px[o + y * 16u + x], K[${B16K.basis8}u + u * 8u + x])); }
      tm[s * 64u + y * 8u + u] = a;
    }
    workgroupBarrier();
    for (var i = lid; i < 256u; i += 64u) {
      let s = i / 64u; let j = i % 64u; let u = j / 8u; let v = j % 8u; var a = vec2f(0.0, 0.0);
      for (var y = 0u; y < 8u; y++) { a = dadd(a, dmul(tm[s * 64u + y * 8u + u], K[${B16K.basis8}u + v * 8u + y])); }
      if (c == 1u) { y8[s * 64u + u * 8u + v] = a; } else { c8[s * 64u + u * 8u + v] = a; }
    }
    workgroupBarrier();
    var fc = vec2f(0.0, 0.0);
    if (c == 0u) { fc = blk[p.oTile + ti * 2u]; } else if (c == 2u) { fc = blk[p.oTile + ti * 2u + 1u]; }
    // DCT16: positions 4 to 255 in scan order, four a thread.
    {
      var d = vec2f(0.0, 0.0); var r = vec2f(0.0, 0.0); var n = 0u; var last = 0u; var e = 0.0; var f = 0u;
      if (fits16) {
        let fine = blk[(cy * p.stride + cx) * 2u];
        for (var j = 0u; j < 4u; j++) {
          let k = 4u + lid * 4u + j;
          if (k >= 256u) { break; }
          let pos = T[${B16T.order16}u + k];
          var tr = y16[pos]; if (c != 1u) { tr = c16[pos]; }
          let x = level(c, tr, y16[pos], K[${B16K.steps16}u + c * 256u + pos], T[${B16T.high16}u + pos], fc, TR16 * mag[c * 5u + 4u] + 2.0 * p.plane, TR16 * mag[5u + 4u] + 2.0 * p.plane, fine);
          d = dadd(d, x.d); r = dadd(r, x.r); e += x.e; f |= x.flag;
          if (x.q != 0u) { n += 1u; last = k + 1u; }
        }
      }
      tm[lid] = d; tm[128u + lid] = r; pn[lid] = n; plast[lid] = last; pe[lid] = e; pf[lid] = f;
    }
    // DCT8 s = lid / 16: positions 1 to 63, four a thread.
    {
      let s = lid / 16u; let t = lid % 16u; let bx = cx + (s & 1u); let by = cy + (s >> 1u);
      var d = vec2f(0.0, 0.0); var r = vec2f(0.0, 0.0); var n = 0u; var last = 0u; var e = 0.0; var f = 0u;
      if (bx < p.stride && by < p.rows) {
        let fine = blk[(by * p.stride + bx) * 2u];
        for (var j = 0u; j < 4u; j++) {
          let k = 1u + t * 4u + j;
          if (k >= 64u) { break; }
          let pos = T[${B16T.order8}u + k];
          var tr = y8[s * 64u + pos]; if (c != 1u) { tr = c8[s * 64u + pos]; }
          let x = level(c, tr, y8[s * 64u + pos], K[${B16K.steps8}u + c * 64u + pos], T[${B16T.high8}u + pos], fc, TR8 * mag[c * 5u + s] + 2.0 * p.plane, TR8 * mag[5u + s] + 2.0 * p.plane, fine);
          d = dadd(d, x.d); r = dadd(r, x.r); e += x.e; f |= x.flag;
          if (x.q != 0u) { n += 1u; last = k + 1u; }
        }
      }
      tm[64u + lid] = d; tm[192u + lid] = r; pn[64u + lid] = n; plast[64u + lid] = last; pe[64u + lid] = e; pf[64u + lid] = f;
    }
    workgroupBarrier();
    // Thread k < 4: DCT8 sub-block k; thread 4: the DCT16. D += norm d w h blockMW; R += rc0 + rc3 zeros.
    if (lid < 5u) {
      let first = select(64u + lid * 16u, 0u, lid == 4u); let count = select(16u, 64u, lid == 4u); let area = select(1u, 4u, lid == 4u);
      var d = vec2f(0.0, 0.0); var r = vec2f(0.0, 0.0); var n = 0u; var last = 0u; var e = 0.0; var f = 0u;
      for (var j = 0u; j < count; j++) { let at = first + j; d = dadd(d, tm[at]); r = dadd(r, tm[128u + at]); n += pn[at]; last = max(last, plast[at]); e += pe[at]; f |= pf[at]; }
      var zeros = 0u;
      if (n > 0u) { zeros = last - area - n; }
      var mw = vec2f(0.0, 0.0);
      if (lid == 4u) { mw = blk[p.oCell + (cy / 2u) * p.cellsX + cx / 2u]; } else { mw = blk[((cy + (lid >> 1u)) * p.stride + cx + (lid & 1u)) * 2u + 1u]; }
      let scale = dmul(K[${B16K.norm}u + c], mw) * f32(area * 64u);
      accD[lid] = dadd(accD[lid], dmul(d, scale));
      accR[lid] = dadd(accR[lid], dadd(r, dadd(K[${B16K.rc}u], dmul(K[${B16K.rc}u + 3u], vec2f(f32(zeros), 0.0)))));
      accE[lid] += SAFE * scale.x * e * 1.01;
      accF[lid] |= f;
    }
  }
  workgroupBarrier();
  if (lid < 5u) {
    let at = ((cell + p.cy0 * p.cellsX) * 5u + lid) * ${B16_OUT}u;
    var absent = !fits16;
    if (lid < 4u) { absent = cx + (lid & 1u) >= p.stride || cy + (lid >> 1u) >= p.rows; }
    let D = accD[lid]; let R = accR[lid];
    out[at] = D.x; out[at + 1u] = D.y; out[at + 2u] = R.x; out[at + 3u] = R.y;
    out[at + 4u] = accE[lid] + select(${b16F(b16Sum(64))}, ${b16F(b16Sum(256))}, lid == 4u) * abs(D.x) + ${b16F(B16_BOUNDS.floor)};
    out[at + 5u] = f32(select(accF[lid], 2u, absent));
  }
}`;

const B16_DOUBT = 2130706432;
const b16LevelsShader = (ds, N) =>  `
struct P { W: u32, stride: u32, rows: u32, cflW: u32, count: u32, top: u32, bandPx: u32, hasDead: u32, oTile: u32, groupsX: u32, plane: f32, pad1: u32, one: f32 }
@group(0) @binding(0) var<uniform> p: P;
fn gcOne() -> f32 { return p.one; }
@group(0) @binding(1) var<storage, read> plX: array<vec2f>;
@group(0) @binding(2) var<storage, read> plY: array<vec2f>;
@group(0) @binding(3) var<storage, read> plB: array<vec2f>;
@group(0) @binding(4) var<storage, read> K: array<vec2f>;
@group(0) @binding(5) var<storage, read> T: array<u32>;
@group(0) @binding(6) var<storage, read> blk: array<vec2f>;
@group(0) @binding(7) var<storage, read> at: array<u32>;
@group(0) @binding(8) var<storage, read_write> out: array<i32>;
${ds}
${B16_PIXEL}
const N = ${N}u;
const AREA = ${N === 16 ? 4 : 1}u;
const SLOT = ${3 * N * N + 3 * (N === 16 ? 4 : 1) + 1}u;
const U2 = ${b16F(B16_BOUNDS.u2)};
const REL = ${b16F(B16_BOUNDS.rel)};
const SAFE = ${b16F(B16_BOUNDS.safety)};
const TR = ${b16F(b16Tr(N))};
var<workgroup> px: array<vec2f, ${N * N}>;
var<workgroup> tm: array<vec2f, ${N * N}>;
var<workgroup> ty: array<vec2f, ${N * N}>;
var<workgroup> tc: array<vec2f, ${N * N}>;
var<workgroup> part: array<f32, 64>;
var<workgroup> mag: array<f32, 3>;
var<workgroup> doubt: atomic<u32>;

@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) g: vec3u, @builtin(local_invocation_index) lid: u32) {
  let index = g.y * p.groupsX + g.x;
  if (index >= p.count) { return; }
  let bx = at[index * 2u]; let by = at[index * 2u + 1u];
  let slot = index * SLOT;
  let ti = (by >> 3u) * p.cflW + (bx >> 3u);
  let fine = blk[(by * p.stride + bx) * 2u];
  let oBasis = select(${B16K.basis8}u, ${B16K.basis16}u, N == 16u);
  let oSteps = select(${B16K.steps8}u, ${B16K.steps16}u, N == 16u);
  let oOrder = select(${B16T.order8}u, ${B16T.order16}u, N == 16u);
  let oHigh = select(${B16T.high8}u, ${B16T.high16}u, N == 16u);
  if (lid == 0u) { atomicStore(&doubt, 0u); }
  for (var ci = 0u; ci < 3u; ci++) {
    let c = select(select(2u, 0u, ci == 1u), 1u, ci == 0u);
    workgroupBarrier();
    for (var i = lid; i < N * N; i += 64u) { px[i] = pixel(c, (by * 8u + i / N - p.top) * p.W + bx * 8u + i % N); }
    workgroupBarrier();
    var m = 0.0;
    for (var i = lid; i < N * N; i += 64u) { m += abs(px[i].x); }
    part[lid] = m;
    workgroupBarrier();
    if (lid == 0u) { var t = 0.0; for (var i = 0u; i < 64u; i++) { t += part[i]; } mag[c] = t * 1.001; }
    for (var i = lid; i < N * N; i += 64u) {
      let y = i / N; let u = i % N; var s = vec2f(0.0, 0.0);
      for (var x = 0u; x < N; x++) { s = dadd(s, dmul(px[y * N + x], K[oBasis + u * N + x])); }
      tm[y * N + u] = s;
    }
    workgroupBarrier();
    for (var i = lid; i < N * N; i += 64u) {
      let u = i / N; let v = i % N; var s = vec2f(0.0, 0.0);
      for (var y = 0u; y < N; y++) { s = dadd(s, dmul(tm[y * N + u], K[oBasis + v * N + y])); }
      if (c == 1u) { ty[u * N + v] = s; } else { tc[u * N + v] = s; }
    }
    workgroupBarrier();
    let bt = TR * mag[c] + 2.0 * p.plane; let btY = TR * mag[1] + 2.0 * p.plane;
    // DC: the raw coefficients' low frequencies, in levels of the channel's DC step.
    if (lid < AREA) {
      var v = vec2f(0.0, 0.0); var sum = 0.0; var weight = 1.0;
      if (N == 8u) { v = select(tc[0], ty[0], c == 1u); sum = abs(v.x); }
      else {
        weight = 0.0;
        for (var j = 0u; j < 4u; j++) {
          let k = select(select(17u, 16u, j == 2u), j, j < 2u);
          let mj = K[${B16K.lowM}u + lid * 4u + j]; let t = dmul(select(tc[k], ty[k], c == 1u), mj);
          v = dadd(v, t); sum += abs(t.x); weight += abs(mj.x);
        }
      }
      let step = K[${B16K.dcStep}u + c];
      let dcv = ddiv(v * 8.0, step);
      let e = SAFE * ((bt * weight + REL * sum) * 8.0 / step.x + REL * abs(dcv.x)) + 1e-30;
      let r = dround(dcv, vec2f(0.5, 0.0), e);
      var q = i32(r.x);
      if (r.y != 0.0 || abs(r.x) > 1e9) { q = ${B16_DOUBT}; atomicOr(&doubt, 1u); }
      out[slot + 3u * N * N + c * AREA + lid] = q;
    }
    var fc = vec2f(0.0, 0.0);
    if (c == 0u) { fc = blk[p.oTile + ti * 2u]; } else if (c == 2u) { fc = blk[p.oTile + ti * 2u + 1u]; }
    for (var k = lid; k < N * N; k += 64u) {
      let pos = T[oOrder + k];
      if (k < AREA) { out[slot + c * N * N + pos] = 0; continue; }
      var coefficient = ty[pos]; var bc = bt;
      if (c != 1u) { let s = dmul(fc, ty[pos]); coefficient = dsub(tc[pos], s); bc = bt + abs(fc.x) * btY + 16.0 * U2 * (abs(tc[pos].x) + abs(s.x)); }
      let step = K[oSteps + c * N * N + pos];
      let v = dmul(ddiv(coefficient * 2048.0, step), fine);
      let a = dabs(v);
      let ba = SAFE * (bc * 2048.0 * fine.x / step.x + REL * a.x) + 1e-30;
      var thr = vec2f(0.5, 0.0);
      if (p.hasDead == 1u) { thr = K[${B16K.dead}u + c * 2u + T[oHigh + pos]]; }
      let below = dsub(a, thr).x;
      var q = 0;
      var unsure = abs(below) <= ba;
      if (below >= 0.0) { let r = dround(a, vec2f(0.5, 0.0), ba); q = i32(r.x); if (r.y != 0.0 || r.x > 1e9) { unsure = true; } }
      if (v.x < 0.0) { q = -q; }
      if (unsure) { q = ${B16_DOUBT}; atomicOr(&doubt, 1u); }
      out[slot + c * N * N + pos] = q;
    }
  }
  workgroupBarrier();
  if (lid == 0u) { out[slot + SLOT - 1u] = i32(atomicLoad(&doubt)); }
}`;

const b16Split = (v, out, at) => { const hi = Math.fround(v); out[at] = hi; out[at + 1] = Math.fround(v - hi); };
const b16Splits = (values, out, at) => { for (let i = 0; i < values.length; i++) b16Split(values[i], out, at + 2 * i); };
function b16Basis(side, basis) { return basis(side).basis; }

export function b16Tables(input, search, scaledDCTBases, request = {}) {
  const K = new Float32Array(B16K.size * 2), T = new Uint32Array(B16T.size), t8 = input.transforms.get(0), t16 = input.transforms.get(4);
  b16Splits(b16Basis(8, scaledDCTBases), K, B16K.basis8 * 2);
  b16Splits(b16Basis(16, scaledDCTBases), K, B16K.basis16 * 2);
  for (let c = 0; c < 3; c++) { b16Splits(t8.steps[c], K, (B16K.steps8 + c * 64) * 2); b16Splits(t16.steps[c], K, (B16K.steps16 + c * 256) * 2); }
  b16Splits(input.recon, K, B16K.recon * 2);
  const log2 = input.log2.slice(); log2[0] = 0;
  b16Splits(log2, K, B16K.log2 * 2);
  b16Splits(input.one, K, B16K.one * 2);
  if (input.dead) b16Splits(input.dead, K, B16K.dead * 2);
  b16Splits(input.norm, K, B16K.norm * 2);
  b16Splits(search.rate ?? [4, 3, 2, 0.6], K, B16K.rc * 2);
  b16Split(search.detailWeight ?? 1.25, K, B16K.detail * 2);
  b16Splits(input.dcSteps, K, B16K.dcStep * 2);
  b16Split(0.08, K, B16K.mask * 2); b16Split(0.35, K, (B16K.mask + 1) * 2);
  if (request.lowFrequencies) {
    for (const [j, k] of [0, 1, 16, 17].entries()) {
      const e = new Float64Array(256); e[k] = 1;
      const dc = request.lowFrequencies(e, 2, 2);
      for (let i = 0; i < 4; i++) b16Split(dc[i], K, (B16K.lowM + i * 4 + j) * 2);
    }
  }
  T.set(t8.order, B16T.order8); T.set(t16.order, B16T.order16); T.set(t8.high, B16T.high8); T.set(t16.high, B16T.high16);
  return {K, T};
}

export function b16Blocks(input, weight, cellsX, cellRows) {
  const {stride, rows, fine, cfl} = input, oCell = stride * rows * 2, oTile = oCell + cellsX * cellRows, tiles = cfl.x.length;
  const blk = new Float32Array((oTile + tiles * 2) * 2);
  for (let b = 0; b < stride * rows; b++) { b16Split(fine[b], blk, b * 4); b16Split(weight[b], blk, b * 4 + 2); }
  for (let cy = 0; cy < cellRows; cy++) for (let cx = 0; cx < cellsX; cx++) {
    const bx = cx * 2, by = cy * 2;
    if (bx + 1 >= stride || by + 1 >= rows) continue;
    let sum = 0, max = 0;
    for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) { const w = weight[(by + y) * stride + bx + x]; sum += w; if (w > max) max = w; }
    b16Split(0.70 * (sum / 4) + 0.30 * max, blk, (oCell + cy * cellsX + cx) * 2);
  }
  for (let k = 0; k < tiles; k++) { b16Split(cfl.x[k] / 84, blk, (oTile + k * 2) * 2); b16Split(cfl.b[k] / 84, blk, (oTile + k * 2 + 1) * 2); }
  return {blk, oCell, oTile};
}

const b16Pipelines = new WeakMap();
function b16Pipeline(device, ds, name) {
  let set = b16Pipelines.get(device);
  if (!set) b16Pipelines.set(device, set = {});
  const code = () => name === 'energy' ? b16EnergyShader(ds) : name === 'costs' ? b16Shader(ds) : b16LevelsShader(ds, name === 'levels16' ? 16 : 8);
  return set[name] ||= device.createComputePipelineAsync({layout: 'auto', compute: {module: device.createShaderModule({code: code()}), entryPoint: 'main'}});
}

export function gpuBlocks16Pipelines(device, ds) { return Promise.all(['energy', 'costs', 'levels8', 'levels16'].map(name => b16Pipeline(device, ds, name))); }

export const gpuBlocks16Stats = {costs: 0, levels: 0, flagged: 0, doubtful: 0, bands: 0, energy: 0, costsMs: 0, levelsMs: 0};

export class B16Session {
  constructor(device, request, ds, core, weight) {
    const {input, search, scaledDCTBases} = request, {stride, rows} = input;
    Object.assign(this, {device, request, ds, core, stride, rows, W: stride * 8, H: rows * 8, cellsX: Math.ceil(stride / 2), cellRows: Math.ceil(rows / 2), made: []});
    this.planeBound = request.planeBound;
    const {K, T} = b16Tables(input, search, scaledDCTBases, request), {blk, oCell, oTile} = b16Blocks(input, weight ?? new Float64Array(stride * rows), this.cellsX, this.cellRows);
    Object.assign(this, {oCell, oTile, K: this.upload(K), T: this.upload(T), blk: this.upload(blk)});
    const budget = Math.min(64 << 20, device.limits.maxStorageBufferBindingSize);
    this.bandCells = Math.max(1, Math.min(this.cellRows, Math.floor(budget / (3 * this.W * 16 * 8))));
  }
  buffer(bytes, usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST) { const b = this.device.createBuffer({size: Math.max(16, Math.ceil(bytes / 16) * 16), usage}); this.made.push(b); return b; }
  upload(array) { const b = this.buffer(array.byteLength); this.device.queue.writeBuffer(b, 0, array); return b; }
  uniform(words) { const b = this.buffer(64, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST), d = new ArrayBuffer(64); new Uint32Array(d).set(words); new Float32Array(d)[12] = 1; return [b, d]; }
  band(encoder, c0, cells) {
    const top = c0 * 16, bandPx = Math.min(this.H - top, cells * 16), {W, request} = this, before = this.made.length;
    const made = this.core.encodePlanes(encoder, (bytes, usage) => this.buffer(bytes, usage), request.data, request.width, request.height, top, top + bandPx, request.options);
    gpuBlocks16Stats.bands++;
    const own = this.made.splice(before);
    return {planes: made.planes, top: top - made.row, bandPx, release: () => { for (const b of own) b.destroy(); }};
  }
  dispatch(encoder, pipeline, buffers, groupsX, groupsY = 1) {
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.device.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries: buffers.map((b, k) => ({binding: k, resource: {buffer: b}}))}));
    pass.dispatchWorkgroups(groupsX, groupsY);
    pass.end();
  }
  async readAll(encoder, list) {
    const rs = list.map(([source, bytes]) => { const r = this.buffer(bytes, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST); encoder.copyBufferToBuffer(source, 0, r, 0, bytes); return r; });
    this.device.queue.submit([encoder.finish()]);
    await Promise.all(rs.map(r => r.mapAsync(GPUMapMode.READ)));
    return rs.map(r => { const copy = r.getMappedRange().slice(0); r.unmap(); r.destroy(); return copy; });
  }
  async read(encoder, source, bytes) {
    const r = this.buffer(bytes, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    encoder.copyBufferToBuffer(source, 0, r, 0, bytes);
    this.device.queue.submit([encoder.finish()]);
    await r.mapAsync(GPUMapMode.READ);
    const copy = r.getMappedRange().slice(0);
    r.unmap(); r.destroy();
    return copy;
  }
  destroy() { for (const b of this.made) b.destroy(); this.made = []; }
}

async function b16Scoped(device, name, work) {
  device.pushErrorScope('validation'); device.pushErrorScope('out-of-memory');
  let scopes = 2;
  try {
    const result = await work();
    scopes--; const oom = await device.popErrorScope();
    scopes--; const invalid = await device.popErrorScope();
    if (oom || invalid) throw new Error(name + ': ' + (oom || invalid).message);
    return result;
  } finally { while (scopes-- > 0) await device.popErrorScope().catch(() => null); }
}

async function b16Mask(session) {
  const {device, ds, stride, rows, request} = session, pipeline = await b16Pipeline(device, ds, 'energy');
  const hf = new Float64Array(stride * rows);
  let bound = 0;
  for (let c0 = 0; c0 < session.cellRows; c0 += session.bandCells) {
    const cells = Math.min(session.bandCells, session.cellRows - c0), encoder = device.createCommandEncoder(), band = session.band(encoder, c0, cells);
    const by0 = c0 * 2, blocks = Math.min(rows - by0, cells * 2) * stride, groups = Math.ceil(blocks / 64), groupsX = Math.min(groups, 65535);
    const out = session.buffer(blocks * 12, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    const [u, d] = session.uniform([session.W, stride, by0, blocks, band.top, groupsX, 0, 0]);
    new Float32Array(d)[6] = session.planeBound; device.queue.writeBuffer(u, 0, d);
    session.dispatch(encoder, pipeline, [u, ...band.planes, session.K, out], groupsX, Math.ceil(groups / groupsX));
    const o = new Float32Array(await session.read(encoder, out, blocks * 12));
    band.release(); out.destroy();
    for (let i = 0; i < blocks; i++) { hf[by0 * stride + i] = o[i * 3] + o[i * 3 + 1]; if (o[i * 3 + 2] > bound) bound = o[i * 3 + 2]; }
  }
  return {weight: request.maskWeights(hf, stride, rows).weight, weightDoubt: 0.75 * bound + 1e-12};
}

export async function gpuBlocks16EnergyHook(device, ds, width, height, planeBound) {
  const pipeline = await b16Pipeline(device, ds, 'energy'), stride = Math.ceil(width / 8), rows = Math.ceil(height / 8), hf = new Float64Array(stride * rows);
  const K = new Float32Array(B16K.size * 2);
  b16Split(0.08, K, B16K.mask * 2); b16Split(0.35, K, (B16K.mask + 1) * 2);
  let bound = 0, done = 0;
  const each = new Float64Array(stride * rows);
  const make = (bytes, usage) => device.createBuffer({size: Math.max(16, Math.ceil(bytes / 16) * 16), usage});
  return {
    band(encoder, set, {y, from, to}) {
      const by0 = y / 8, by1 = to === height ? rows : (to - 64) / 8, blocks = (by1 - by0) * stride, groups = Math.ceil(blocks / 64), groupsX = Math.min(groups, 65535);
      const kb = make(K.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST), out = make(blocks * 12, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
      const read = make(blocks * 12, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST), u = make(64, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST), d = new ArrayBuffer(64);
      new Uint32Array(d).set([set.W, stride, by0, blocks, from, groupsX]); new Float32Array(d)[6] = planeBound; new Float32Array(d)[12] = 1;
      device.queue.writeBuffer(u, 0, d); device.queue.writeBuffer(kb, 0, K);
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, device.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries: [u, ...set.planes, kb, out].map((b, k) => ({binding: k, resource: {buffer: b}}))}));
      pass.dispatchWorkgroups(groupsX, Math.ceil(groups / groupsX));
      pass.end();
      encoder.copyBufferToBuffer(out, 0, read, 0, blocks * 12);
      return async () => {
        try {
          await read.mapAsync(GPUMapMode.READ);
          const o = new Float32Array(read.getMappedRange());
          for (let i = 0; i < blocks; i++) { hf[by0 * stride + i] = o[i * 3] + o[i * 3 + 1]; each[by0 * stride + i] = o[i * 3 + 2]; if (o[i * 3 + 2] > bound) bound = o[i * 3 + 2]; }
          done += blocks;
        } finally { for (const b of [kb, out, read, u]) b.destroy(); }
      };
    },
    result: () => done === stride * rows ? (gpuBlocks16Stats.energy++, {hf, bound, each}) : null,
  };
}

export async function gpuBlocks16Costs(device, request, ds, core) {
  const started = performance.now();
  return b16Scoped(device, 'gpuBlocks16Costs', async () => {
    let mask = {weight: request.weight, weightDoubt: request.weightDoubt || 0};
    if (!request.weight) { const first = new B16Session(device, request, ds, core); try { mask = await b16Mask(first); } finally { first.destroy(); } }
    const session = new B16Session(device, request, ds, core, mask.weight), {stride, rows, cellsX, cellRows} = session, {input} = request;
    try {
      const pipeline = await b16Pipeline(device, ds, 'costs'), outFloats = cellsX * cellRows * 5 * B16_OUT;
      const out = session.buffer(outFloats * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
      for (let c0 = 0; c0 < cellRows; c0 += session.bandCells) {
        const cells = Math.min(session.bandCells, cellRows - c0), encoder = device.createCommandEncoder(), band = session.band(encoder, c0, cells);
        const [u, d] = session.uniform([session.W, stride, rows, input.cfl.width, cellsX, c0, band.top, band.bandPx, input.dead ? 1 : 0, session.oCell, session.oTile, 0]);
        new Float32Array(d)[11] = session.planeBound; device.queue.writeBuffer(u, 0, d);
        session.dispatch(encoder, pipeline, [u, ...band.planes, session.K, session.T, session.blk, out], cellsX * cells);
        device.queue.submit([encoder.finish()]);
        band.release();
      }
      const o = new Float32Array(await session.read(device.createCommandEncoder(), out, outFloats * 4)), costs = Object.assign(new Map(), {certified: true});
      const cost = () => ({D: new Float64Array(stride * rows).fill(NaN), R: new Float64Array(stride * rows).fill(NaN), De: new Float64Array(stride * rows).fill(NaN), Re: new Float64Array(stride * rows).fill(NaN)});
      const c8 = cost(), c16 = cost();
      let flagged = 0;
      for (let cy = 0; cy < cellRows; cy++) for (let cx = 0; cx < cellsX; cx++) for (let k = 0; k < 5; k++) {
        const at = ((cy * cellsX + cx) * 5 + k) * B16_OUT, flag = o[at + 5];
        const bx = cx * 2 + (k < 4 ? k & 1 : 0), by = cy * 2 + (k < 4 ? k >> 1 : 0), b = by * stride + bx, into = k < 4 ? c8 : c16;
        const fits = k < 4 ? bx < stride && by < rows : bx + 1 < stride && by + 1 < rows;
        if (!fits) continue;
        const D = o[at] + o[at + 1], R = o[at + 2] + o[at + 3], e = o[at + 4];
        const valid = (flag === 0 || flag === 1) && D >= 0 && R >= 0 && e >= 0 && Number.isFinite(D) && Number.isFinite(R) && Number.isFinite(e);
        if (!valid || flag === 1) { into.D[b] = 0; into.R[b] = 0; into.De[b] = Infinity; into.Re[b] = 0; flagged++; continue; }
        into.D[b] = D; into.R[b] = R;
        into.De[b] = e + mask.weightDoubt * D;
        into.Re[b] = b16Sum(k < 4 ? 64 : 256) * R;
      }
      costs.set(0, c8); costs.set(4, c16);
      gpuBlocks16Stats.costs++; gpuBlocks16Stats.flagged += flagged; gpuBlocks16Stats.costsMs += performance.now() - started;
      return {costs, weight: mask.weight, weightDoubt: mask.weightDoubt, flagged};
    } finally { session.destroy(); }
  });
}

export async function gpuBlocks16Levels(device, request, ds, core) {
  const started = performance.now();
  return b16Scoped(device, 'gpuBlocks16Levels', async () => {
    const session = new B16Session(device, request, ds, core), {stride, rows} = session, {input} = request;
    try {
      const pipelines = await Promise.all([b16Pipeline(device, ds, 'levels8'), b16Pipeline(device, ds, 'levels16')]);
      const bands = [];
      for (const b of request.layout) if (b.id === 0 || b.id === 4) (bands[Math.floor((b.by >> 1) / session.bandCells)] ||= [[], []])[b.id === 4 ? 1 : 0].push(b);
      const exact = new Map();
      let doubtful = 0;
      for (let k = 0; k < bands.length; k++) {
        if (!bands[k]) continue;
        const c0 = k * session.bandCells, cells = Math.min(session.bandCells, session.cellRows - c0);
        const encoder = device.createCommandEncoder(), band = session.band(encoder, c0, cells), outs = [];
        for (const [kind, list] of bands[k].entries()) {
          if (!list.length) continue;
          const N = kind ? 16 : 8, area = kind ? 4 : 1, slot = 3 * N * N + 3 * area + 1, at = new Uint32Array(list.length * 2);
          list.forEach((b, i) => { at[i * 2] = b.bx; at[i * 2 + 1] = b.by; });
          const groupsX = Math.min(list.length, 65535), out = session.buffer(list.length * slot * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
          const [u, d] = session.uniform([session.W, stride, rows, input.cfl.width, list.length, band.top, band.bandPx, input.dead ? 1 : 0, session.oTile, groupsX, 0, 0]);
          new Float32Array(d)[10] = session.planeBound; device.queue.writeBuffer(u, 0, d);
          session.dispatch(encoder, pipelines[kind], [u, ...band.planes, session.K, session.T, session.blk, session.upload(at), out], groupsX, Math.ceil(list.length / groupsX));
          outs.push({out, list, N, area, slot});
        }
        const read = await session.readAll(encoder, outs.map(({out, list, slot}) => [out, list.length * slot * 4]));
        for (const [n, {out, list, N, area, slot}] of outs.entries()) {
          const all = new Int32Array(read[n]), size = N * N;
          out.destroy();
          list.forEach((b, i) => {
            const o = i * slot, uncertain = all[o + slot - 1] !== 0;
            if (uncertain) doubtful++;
            exact.set(b.id + ':' + b.bx + ':' + b.by, {coeffs: [0, 1, 2].map(c => all.subarray(o + c * size, o + (c + 1) * size)),
              dc: [0, 1, 2].map(c => all.subarray(o + 3 * size + c * area, o + 3 * size + (c + 1) * area)), uncertain});
          });
        }
        band.release();
      }
      gpuBlocks16Stats.levels++; gpuBlocks16Stats.doubtful += doubtful; gpuBlocks16Stats.levelsMs += performance.now() - started;
      return {exact, doubtful};
    } finally { session.destroy(); }
  });
}
