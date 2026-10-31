// SPDX-License-Identifier: MIT

import {gpuBlocks16Costs, gpuBlocks16Levels, gpuBlocks16Pipelines, gpuBlocks16EnergyHook} from './gpu-blocks16.mjs';
import {gpuBlocksCosts, gpuBlocksLevels} from './gpu-blocks.mjs';

const GC_GAB = [0.115169525, 0.061248592], GC_MARGIN = 8;

function gcTemplate(lib, data, width, height, quality, options) {
  const {complete, photoXYBSteps} = lib;
  const stride = Math.ceil(width / 8), rows = Math.ceil(height / 8);
  const probe = complete(photoXYBSteps(new Uint8Array(256).fill(128), 8, 8, quality, options));
  let alpha = null;
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) { alpha = data; break; }
  const tileWidth = Math.ceil(stride / 8), tiles = tileWidth * Math.ceil(rows / 8);
  return {...probe, width, height, alpha, components: probe.components.map(c => ({...c, stride, rows, coeffs: new Int16Array(stride * rows * 64)})),
    nonZero: Array.from({length: 3}, () => new Uint8Array(stride * rows)),
    cfl: {width: tileWidth, x: new Int8Array(tiles), b: new Int8Array(tiles)}};
}

const gcThresholds = dead => [0, 1, 2].map(c => Float64Array.from({length: 64}, (_, k) => k ? dead[c * 2 + ((k & 7) >= 4 || (k >> 3) >= 4 ? 1 : 0)] : 0.5));

function gcWindowPlanes(lib, data, width, height, x0, y0, w, h, options) {
  const {complete, photoXYBSteps} = lib;
  const W = Math.ceil(width / 8) * 8, H = Math.ceil(height / 8) * 8;
  const wx0 = Math.max(0, x0 - GC_MARGIN), wy0 = Math.max(0, y0 - GC_MARGIN), wx1 = Math.min(W, x0 + w + GC_MARGIN), wy1 = Math.min(H, y0 + h + GC_MARGIN);
  const cw = wx1 - wx0, ch = wy1 - wy0, crop = new Uint8Array(cw * ch * 4);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const from = (Math.min(height - 1, wy0 + y) * width + Math.min(width - 1, wx0 + x)) * 4, to = (y * cw + x) * 4;
    crop[to] = data[from]; crop[to + 1] = data[from + 1]; crop[to + 2] = data[from + 2]; crop[to + 3] = 255;
  }
  const t = complete(photoXYBSteps(crop, cw, ch, 90, {...options, gaborish: null, fieldScale: null, keepPlanes: true, keepValues: false, planesOnly: true})).planes;
  const gab = options.gaborish, norm = 1 / (1 + 4 * GC_GAB[0] + 4 * GC_GAB[1]), [w1, w2] = GC_GAB, s = gab.strength ?? 1;
  const G = (p, out) => {
    for (let y = 0; y < ch; y++) {
      const u = Math.max(0, y - 1) * cw, m = y * cw, d = Math.min(ch - 1, y + 1) * cw;
      for (let x = 0; x < cw; x++) {
        const l = Math.max(0, x - 1), r = Math.min(cw - 1, x + 1);
        out[m + x] = (p[m + x] + w1 * (p[u + x] + p[d + x] + p[m + l] + p[m + r]) + w2 * (p[u + l] + p[u + r] + p[d + l] + p[d + r])) * norm;
      }
    }
  };
  const planes = t.map(tc => {
    const src = tc.length === cw * ch ? tc : tc.subarray(0, cw * ch), x = Float64Array.from(src), g = new Float64Array(src.length);
    for (let i = 0; i < 4; i++) { G(x, g); for (let k = 0; k < x.length; k++) x[k] += src[k] - g[k]; }
    for (let k = 0; k < x.length; k++) x[k] = src[k] + s * (x[k] - src[k]);
    return x;
  });
  return {planes, ox: x0 - wx0, oy: y0 - wy0, cw};
}

function gcBlockDCT(lib, win, bx, by, x0, y0, out, intermediate) {
  const block = new Float64Array(192);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const at = (win.oy + by * 8 - y0 + y) * win.cw + win.ox + bx * 8 - x0 + x;
    block[y * 8 + x] = win.planes[0][at]; block[64 + y * 8 + x] = win.planes[1][at]; block[128 + y * 8 + x] = win.planes[2][at];
  }
  return lib.transformDCT8(block, intermediate, out);
}

function gcQuantize(sums, image, thresholds, bx, by, fx, fb) {
  const offset = (by * image.components[0].stride + bx) * 64;
  for (let c = 0; c < 3; c++) {
    const quant = image.components[c].quant, out = image.components[c].coeffs, from = c * 64, th = thresholds[c];
    const share = c === 1 ? 0 : (c === 0 ? fx : fb) / 84;
    const v0 = sums[from] * 256 / quant[0];
    out[offset] = Math.abs(v0) < 0.5 ? 0 : Math.round(v0);
    let nonZero = 0;
    for (let k = 1; k < 64; k++) {
      const coefficient = sums[from + k] - (c !== 1 ? share * sums[64 + k] : 0);
      const value = coefficient * 256 / quant[k] * 1;
      out[offset + k] = Math.abs(value) < th[k] ? 0 : Math.round(value);
      if (out[offset + k]) nonZero++;
    }
    image.nonZero[c][offset / 64] = nonZero;
  }
}

function gcExactTile(lib, data, width, height, image, thresholds, options, tx, ty) {
  const stride = image.components[0].stride, rows = image.components[0].rows, bx0 = tx * 8, by0 = ty * 8;
  const bw = Math.min(8, stride - bx0), bh = Math.min(8, rows - by0), index = ty * image.cfl.width + tx;
  const win = gcWindowPlanes(lib, data, width, height, bx0 * 8, by0 * 8, bw * 8, bh * 8, options), intermediate = new Float64Array(64);
  const all = [];
  let yy = 0, xy = 0, bySum = 0;
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    const sums = gcBlockDCT(lib, win, bx0 + bx, by0 + by, bx0 * 8, by0 * 8, new Float64Array(192), intermediate);
    for (let k = 1; k < 64; k++) { yy += sums[64 + k] * sums[64 + k]; xy += sums[k] * sums[64 + k]; bySum += sums[128 + k] * sums[64 + k]; }
    all.push(sums);
  }
  const cflScale = options.cflScale ?? 1;
  const fx = image.cfl.x[index] = Math.max(-128, Math.min(127, Math.round(cflScale * 84 * xy / (yy + 1))));
  const fb = image.cfl.b[index] = Math.max(-128, Math.min(127, Math.round(cflScale * 84 * bySum / (yy + 1))));
  let n = 0;
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) gcQuantize(all[n++], image, thresholds, bx0 + bx, by0 + by, fx, fb);
}

function gcExactBlock(lib, data, width, height, image, thresholds, options, bx, by) {
  const win = gcWindowPlanes(lib, data, width, height, bx * 8, by * 8, 8, 8, options), index = (by >> 3) * image.cfl.width + (bx >> 3);
  gcQuantize(gcBlockDCT(lib, win, bx, by, bx * 8, by * 8, new Float64Array(192), new Float64Array(64)), image, thresholds, bx, by, image.cfl.x[index], image.cfl.b[index]);
}

export function gcExactImage(lib, data, width, height, quality, options) {
  const image = gcTemplate(lib, data, width, height, quality, options), thresholds = gcThresholds(options.deadzone);
  const tilesX = image.cfl.width, tilesY = Math.ceil(image.components[0].rows / 8);
  for (let ty = 0; ty < tilesY; ty++) for (let tx = 0; tx < tilesX; tx++) gcExactTile(lib, data, width, height, image, thresholds, options, tx, ty);
  return image;
}

const gcBlockSums = (lib, data, width, height, options, bx, by) => gcBlockDCT(lib, gcWindowPlanes(lib, data, width, height, bx * 8, by * 8, 8, 8, options), bx, by, bx * 8, by * 8, new Float64Array(192), new Float64Array(64));
export {gcTemplate, gcThresholds, gcExactTile, gcExactBlock, gcBlockSums};

export const GC_BOUNDS = Object.freeze({op: 4e-14, plane: 2e-8, planeMax: 1300, sum: 1e-11, rel: 1e-12, frac: 2.4e-7, floor: 1e-30});
const GC_WG = 128, GC_DCT_WG = 64, GC_CFL_WG = 64;
const gcF = v => { const s = Math.fround(v).toString(); return /[.eE]/.test(s) ? s : s + '.0'; };
const gcSplit = (v, out, at) => { const hi = Math.fround(v); out[at] = hi; out[at + 1] = Math.fround(v - hi); };
const GK = {mix: 0, bias: 9, root: 10, third: 11, w1: 12, w2: 13, norm: 14, strength: 15, cfl: 16, half: 17, basis: 18, share: 82, linear: 338, recip: 594, dead: 786, size: 978};
const GC_DS = `
fn gcO(x: f32) -> f32 { return x * gcOne(); }
fn ts(a0: f32, b0: f32) -> vec2f { let a = gcO(a0); let b = gcO(b0); let s = gcO(a + b); let v = gcO(s - a); let w = gcO(s - v); return vec2f(s, gcO(gcO(a - w) + gcO(b - v))); }
fn fs(a0: f32, b0: f32) -> vec2f { let a = gcO(a0); let b = gcO(b0); let s = gcO(a + b); return vec2f(s, gcO(b - gcO(s - a))); }
fn sp(a: f32) -> vec2f { let h = bitcast<f32>((bitcast<u32>(a) + 0x800u) & 0xfffff000u); return vec2f(h, gcO(a - h)); }
fn tp(a0: f32, b0: f32) -> vec2f {
  let a = gcO(a0); let b = gcO(b0); let p = gcO(a * b); let x = sp(a); let y = sp(b);
  return vec2f(p, gcO(gcO(gcO(gcO(gcO(x.x * y.x) - p) + gcO(x.x * y.y)) + gcO(x.y * y.x)) + gcO(x.y * y.y)));
}
fn dadd(a: vec2f, b: vec2f) -> vec2f { let s = ts(a.x, b.x); let t = ts(a.y, b.y); let v = fs(s.x, gcO(s.y + t.x)); return fs(v.x, gcO(t.y + v.y)); }
fn dsub(a: vec2f, b: vec2f) -> vec2f { return dadd(a, -b); }
fn dmul(a: vec2f, b: vec2f) -> vec2f { let c = tp(a.x, b.x); return fs(c.x, gcO(c.y + gcO(gcO(a.x * b.y) + gcO(a.y * b.x)))); }
fn ddiv(a: vec2f, b: vec2f) -> vec2f {
  let q1 = gcO(a.x / b.x); let r1 = dsub(a, dmul(b, vec2f(q1, 0.0))); let q2 = gcO(r1.x / b.x); let r2 = dsub(r1, dmul(b, vec2f(q2, 0.0)));
  return dadd(fs(q1, q2), vec2f(gcO(r2.x / b.x), 0.0));
}
fn dabs(a: vec2f) -> vec2f { return select(a, -a, a.x < 0.0); }
// Round half up (Math.round): the level, and 1 where the fraction lies within e of the half step.
fn dround(v: vec2f, half: vec2f, e: f32) -> vec2f {
  let w = dadd(v, half); var n = floor(w.x); var f = gcO(gcO(w.x - n) + w.y);
  if (f < 0.0) { n -= 1.0; f = gcO(f + 1.0); } else if (f >= 1.0) { n += 1.0; f = gcO(f - 1.0); }
  return vec2f(n, select(0.0, 1.0, f <= e || f >= 1.0 - e));
}`;
const GC_CBRT = `
fn dcbrt(v: vec2f, third: vec2f) -> vec2f {
  var r = exp2(log2(v.x) / 3.0); r = (2.0 * r + v.x / (r * r)) / 3.0; r = (2.0 * r + v.x / (r * r)) / 3.0;
  var d = vec2f(r, 0.0);
  for (var i = 0u; i < 2u; i++) { d = dadd(d, dmul(dsub(ddiv(v, dmul(d, d)), d), third)); }
  return d;
}`;
const GC_HEAD = `struct Params { W: u32, H: u32, width: u32, height: u32, stride: u32, rows: u32, groupsX: u32, c: u32, a: f32, b: f32, d: f32, one: f32 }
@group(0) @binding(0) var<uniform> P: Params;
fn gcOne() -> f32 { return P.one; }`;
const gcKernel = (bindings, body, extra = '', workgroup = GC_WG) => `${GC_HEAD}
${bindings.map(([name, access, type], k) => `@group(0) @binding(${k + 1}) var<storage, ${access}> ${name}: ${type};`).join('\n')}
${GC_DS}
${extra}
@compute @workgroup_size(${workgroup})
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_index) lid: u32) {
  let i = (wid.y * P.groupsX + wid.x) * ${workgroup}u + lid;
  ${body}
}`;
const V = 'array<vec2f>', U = 'array<u32>', B = GC_BOUNDS;
export const GC_SHADERS = {
  xyb: gcKernel([['rgba', 'read', U], ['K', 'read', V], ['tx', 'read_write', V], ['ty', 'read_write', V], ['tb', 'read_write', V]], `
    if (i >= P.W * P.H) { return; }
    let x = min(i % P.W, P.width - 1u); let y = min(i / P.W, P.height - 1u); let p = rgba[y * P.width + x];
    let r = K[${GK.linear}u + (p & 255u)]; let g = K[${GK.linear}u + ((p >> 8u) & 255u)]; let b = K[${GK.linear}u + ((p >> 16u) & 255u)];
    let l = dsub(dcbrt(cone(0u, r, g, b), K[${GK.third}]), K[${GK.root}]);
    let m = dsub(dcbrt(cone(3u, r, g, b), K[${GK.third}]), K[${GK.root}]);
    let s = dsub(dcbrt(cone(6u, r, g, b), K[${GK.third}]), K[${GK.root}]);
    tx[i] = dmul(dsub(l, m), vec2f(127.5, 0.0)); let Y = dmul(dadd(l, m), vec2f(127.5, 0.0)); ty[i] = Y; tb[i] = dsub(dmul(s, vec2f(255.0, 0.0)), Y);`,
    `${GC_CBRT}
fn cone(o: u32, r: vec2f, g: vec2f, b: vec2f) -> vec2f { return dadd(dadd(dadd(dmul(K[${GK.mix}u + o], r), dmul(K[${GK.mix}u + o + 1u], g)), dmul(K[${GK.mix}u + o + 2u], b)), K[${GK.bias}]); }`),
  gab: gcKernel([['t', 'read', V], ['x', 'read', V], ['next', 'read_write', V], ['K', 'read', V]], `
    if (i >= P.W * P.H) { return; }
    let px = i % P.W; let py = i / P.W;
    let u = select(py - 1u, 0u, py == 0u) * P.W; let m = py * P.W; let d = min(py + 1u, P.H - 1u) * P.W;
    let l = select(px - 1u, 0u, px == 0u); let r = min(px + 1u, P.W - 1u);
    let near = dadd(dadd(dadd(x[u + px], x[d + px]), x[m + l]), x[m + r]); let far = dadd(dadd(dadd(x[u + l], x[u + r]), x[d + l]), x[d + r]);
    let g = dmul(dadd(dadd(x[m + px], dmul(K[${GK.w1}], near)), dmul(K[${GK.w2}], far)), K[${GK.norm}]);
    next[i] = dadd(x[i], dsub(t[i], g));`),
  gabLast: gcKernel([['t', 'read_write', V], ['x', 'read', V], ['K', 'read', V]], `
    if (i >= P.W * P.H) { return; }
    let px = i % P.W; let py = i / P.W;
    let u = select(py - 1u, 0u, py == 0u) * P.W; let m = py * P.W; let d = min(py + 1u, P.H - 1u) * P.W;
    let l = select(px - 1u, 0u, px == 0u); let r = min(px + 1u, P.W - 1u);
    let near = dadd(dadd(dadd(x[u + px], x[d + px]), x[m + l]), x[m + r]); let far = dadd(dadd(dadd(x[u + l], x[u + r]), x[d + l]), x[d + r]);
    let g = dmul(dadd(dadd(x[m + px], dmul(K[${GK.w1}], near)), dmul(K[${GK.w2}], far)), K[${GK.norm}]);
    t[i] = dadd(x[i], dsub(t[i], g));`),
  finish: gcKernel([['t', 'read_write', V], ['x', 'read', V], ['K', 'read', V]], `if (i >= P.W * P.H) { return; } t[i] = dadd(t[i], dmul(K[${GK.strength}], dsub(x[i], t[i])));`),
  dct: gcKernel([['pre', 'read', V], ['K', 'read', V], ['out', 'read_write', V]], `
    let blocks = P.stride * P.rows; let rawBlk = wid.y * P.groupsX + wid.x;
    // Padded workgroups use valid reads and reach both barriers; only real blocks store a result.
    let blk = min(rawBlk, blocks - 1u); let v = lid / 8u; let u = lid % 8u;
    let x0 = (blk % P.stride) * 8u; let y0 = (blk / P.stride) * 8u;
    tile[lid] = pre[(y0 + v) * P.W + x0 + u];
    workgroupBarrier();
    var row = vec2f(0.0);
    for (var x = 0u; x < 8u; x++) { row = dadd(row, dmul(tile[v * 8u + x], K[${GK.basis}u + u * 8u + x])); }
    horizontal[lid] = row;
    workgroupBarrier();
    var s = vec2f(0.0);
    for (var y = 0u; y < 8u; y++) { s = dadd(s, dmul(horizontal[y * 8u + u], K[${GK.basis}u + v * 8u + y])); }
    if (rawBlk < blocks) { out[blk * 64u + lid] = s; }`,
    `var<workgroup> tile: array<vec2f, 64>;\nvar<workgroup> horizontal: array<vec2f, 64>;`, GC_DCT_WG),
  cfl: gcKernel([['cx', 'read', V], ['cy', 'read', V], ['cb', 'read', V], ['out', 'read_write', 'array<i32>'], ['doubt', 'read_write', U], ['K', 'read', V]], `
    let tilesX = (P.stride + 7u) / 8u; let tiles = tilesX * ((P.rows + 7u) / 8u); let raw = wid.y * P.groupsX + wid.x; let tile = min(raw, tiles - 1u);
    let bx0 = (tile % tilesX) * 8u; let by0 = (tile / tilesX) * 8u; let bi = bx0 + lid % 8u; let bj = by0 + lid / 8u;
    var yy = vec2f(0.0); var xy = vec2f(0.0); var by = vec2f(0.0); var ax = 0.0; var ay = 0.0; var ab = 0.0; var axy = 0.0; var aby = 0.0;
    if (bi < P.stride && bj < P.rows) {
      let base = (bj * P.stride + bi) * 64u;
      for (var k = 1u; k < 64u; k++) {
        let X = cx[base + k]; let Y = cy[base + k]; let Bv = cb[base + k];
        yy = dadd(yy, dmul(Y, Y)); xy = dadd(xy, dmul(X, Y)); by = dadd(by, dmul(Bv, Y));
        ax += abs(X.x); ay += abs(Y.x); ab += abs(Bv.x); axy += abs(X.x * Y.x); aby += abs(Bv.x * Y.x);
      }
    }
    wyy[lid] = yy; wxy[lid] = xy; wby[lid] = by; wa[lid] = vec4f(ax, ay, ab, axy); wb[lid] = aby;
    workgroupBarrier();
    for (var half = 32u; half > 0u; half >>= 1u) {
      if (lid < half) {
        wyy[lid] = dadd(wyy[lid], wyy[lid + half]); wxy[lid] = dadd(wxy[lid], wxy[lid + half]); wby[lid] = dadd(wby[lid], wby[lid + half]);
        wa[lid] += wa[lid + half]; wb[lid] += wb[lid + half];
      }
      workgroupBarrier();
    }
    if (lid != 0u || raw >= tiles) { return; }
    let bc = P.a; let terms = f32(min(8u, P.stride - bx0) * min(8u, P.rows - by0) * 63u);
    let sy = wyy[0]; let sa = wa[0] * 1.001; let saby = wb[0] * 1.001; let den = dadd(sy, vec2f(1.0, 0.0)); let A = K[${GK.cfl}];
    let eyy = 2.0 * bc * sa.y + terms * bc * bc + ${gcF(B.sum)} * abs(sy.x) * 1.001 + ${gcF(B.floor)};
    var flag = 0u;
    for (var c = 0u; c < 2u; c++) {
      let num = select(wby[0], wxy[0], c == 0u); let anum = select(saby, sa.w, c == 0u); let aother = select(sa.z, sa.x, c == 0u);
      let enm = bc * (aother + sa.y) + terms * bc * bc + ${gcF(B.sum)} * anum + ${gcF(B.floor)};
      let v = ddiv(dmul(A, num), den);
      let ev = (abs(A.x) * (enm + abs(num.x) * eyy / den.x) / den.x + ${gcF(B.rel)} * abs(v.x)) * 1.001 + ${gcF(B.floor)};
      let n = dround(vec2f(clamp(v.x, -1000.0, 1000.0), v.y), K[${GK.half}], ev + ${gcF(B.frac)});
      if (n.y != 0.0 && abs(v.x) < 129.0) { flag = 1u; }
      out[tile * 2u + c] = clamp(i32(n.x), -128, 127);
    }
    doubt[tile] = flag;`,
    `var<workgroup> wyy: array<vec2f, 64>;\nvar<workgroup> wxy: array<vec2f, 64>;\nvar<workgroup> wby: array<vec2f, 64>;\nvar<workgroup> wa: array<vec4f, 64>;\nvar<workgroup> wb: array<f32, 64>;`, GC_CFL_WG),
  quant: gcKernel([['co', 'read', V], ['cy', 'read', V], ['K', 'read', V], ['cfl', 'read', 'array<i32>'], ['levels', 'read_write', U], ['blockDoubt', 'read_write', 'array<atomic<u32>>']], `
    let n64 = P.stride * P.rows * 64u; if (i * 2u >= n64) { return; }
    let blk = (i * 2u) / 64u; let k0 = (i * 2u) % 64u;
    let tile = ((blk / P.stride) / 8u) * ((P.stride + 7u) / 8u) + (blk % P.stride) / 8u;
    var share = vec2f(0.0);
    if (P.c == 0u) { share = K[${GK.share}u + u32(cfl[tile * 2u] + 128)]; } else if (P.c == 2u) { share = K[${GK.share}u + u32(cfl[tile * 2u + 1u] + 128)]; }
    var packed = 0u; var doubt = false; var nonZero = 0u;
    for (var j = 0u; j < 2u; j++) {
      let k = k0 + j; let R = K[${GK.recip}u + P.c * 64u + k]; let th = K[${GK.dead}u + P.c * 64u + k];
      let c0 = co[blk * 64u + k]; var cv = c0; var ec = P.a;
      if (k > 0u && P.c != 1u) { let sy = dmul(share, cy[blk * 64u + k]); cv = dsub(c0, sy); ec = P.a * (1.0 + abs(share.x)) + ${gcF(B.rel)} * (abs(c0.x) + abs(sy.x)); }
      let value = dmul(cv, R);
      let e = (ec * R.x + ${gcF(B.rel)} * abs(value.x)) * 1.001 + ${gcF(B.floor)};
      let dz = dsub(dabs(value), th);
      var level = 0;
      if (abs(dz.x) <= e) { doubt = true; }
      if (dz.x >= 0.0) {
        let n = dround(vec2f(clamp(value.x, -40000.0, 40000.0), value.y), K[${GK.half}], e + ${gcF(B.frac)});
        if (n.y != 0.0) { doubt = true; }
        level = i32(n.x);
      }
      if (abs(level) > 32767) { doubt = true; }
      packed = packed | ((u32(level) & 65535u) << (16u * j));
      if (k > 0u && level != 0) { nonZero += 1u; }
    }
    levels[(P.c * n64 + i * 2u) / 2u] = packed;
    // Each channel has at most 63 nonzero AC values, so additions cannot carry into another byte.
    atomicAdd(&blockDoubt[blk], nonZero << (P.c * 8u));
    if (doubt) { atomicOr(&blockDoubt[blk], 16777216u); }`),
};

function gcConstants(lib, image, thresholds, options) {
  const K = new Float32Array(GK.size * 2), set = (at, v) => gcSplit(v, K, at * 2), {linear, mix, bias, rootBias} = lib.xyb;
  for (let k = 0; k < 9; k++) set(GK.mix + k, mix[k]);
  set(GK.bias, bias); set(GK.root, rootBias); set(GK.third, 1 / 3); set(GK.half, 0.5);
  const [w1, w2] = GC_GAB, norm = 1 / (1 + 4 * w1 + 4 * w2);
  set(GK.w1, w1); set(GK.w2, w2); set(GK.norm, norm); set(GK.strength, options.gaborish?.strength ?? 1); set(GK.cfl, (options.cflScale ?? 1) * 84);
  let S = 0;
  for (let u = 0; u < 8; u++) { let row = 0; for (let x = 0; x < 8; x++) { set(GK.basis + u * 8 + x, lib.dct8Basis[u * 8 + x]); row += Math.abs(lib.dct8Basis[u * 8 + x]); } S = Math.max(S, row); }
  for (let f = -128; f < 128; f++) set(GK.share + f + 128, f / 84);
  for (let i = 0; i < 256; i++) set(GK.linear + i, linear[i]);
  if (image) for (let c = 0; c < 3; c++) for (let k = 0; k < 64; k++) { set(GK.recip + c * 64 + k, 256 / image.components[c].quant[k]); set(GK.dead + c * 64 + k, thresholds[c][k]); }
  return {K, bound: S * S * (B.plane + 32 * B.op * B.planeMax)};
}

const GC_QUALIFY = (ds = GC_DS) => `${ds}
${GC_CBRT}
@group(0) @binding(0) var<storage, read> inp: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> out: array<vec4f>;
@group(0) @binding(2) var<uniform> U: vec4f;
fn gcOne() -> f32 { return U.x; }
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x; if (i >= arrayLength(&inp)) { return; }
  let q = inp[i]; let a = q.xy; let b = q.zw;
  out[i * 3u] = vec4f(ts(a.x, b.x), tp(a.x, b.x)); out[i * 3u + 1u] = vec4f(dadd(a, b), dmul(a, b));
  out[i * 3u + 2u] = vec4f(ddiv(a, b), dcbrt(dabs(a), vec2f(${gcF(1 / 3)}, ${gcF(1 / 3 - Math.fround(1 / 3))})));
}`;

export function gcQualificationCases(count = 65536) {
  let seed = 0x9e3779b9;
  const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
  const value = (e0, span) => (next() < 0.5 ? -1 : 1) * (1 + next()) * 2 ** Math.floor(e0 + next() * span);
  const cases = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const e = Math.floor(next() * 53) - 40, A = value(e, 10), Bv = value(e, 10);
    gcSplit(A, cases, i * 4); gcSplit(Bv, cases, i * 4 + 2);
    if (i % 4 === 3) { cases[i * 4 + 1] = 0; cases[i * 4 + 3] = 0; }
  }
  return cases;
}
export function gcQualificationCheck(cases, out) {
  const tol = GC_BOUNDS.op, failures = {twoSum: 0, twoProd: 0, add: 0, mul: 0, div: 0, cbrt: 0};
  for (let i = 0; i < cases.length / 4; i++) {
    const [ah, al, bh, bl] = cases.subarray(i * 4, i * 4 + 4), A = ah + al, Bv = bh + bl, o = out.subarray(i * 12, i * 12 + 12);
    if (o[0] !== Math.fround(ah + bh) || o[0] + o[1] !== ah + bh) failures.twoSum++;
    if (o[2] !== Math.fround(ah * bh) || o[2] + o[3] !== ah * bh) failures.twoProd++;
    const near = (hi, lo, ref, scale) => Math.abs(hi + lo - ref) <= tol * scale + 1e-30;
    if (!near(o[4], o[5], A + Bv, Math.abs(A + Bv))) failures.add++;
    if (!near(o[6], o[7], A * Bv, 2 * Math.abs(A * Bv))) failures.mul++;
    if (!near(o[8], o[9], A / Bv, 4 * Math.abs(A / Bv))) failures.div++;
    if (!near(o[10], o[11], Math.cbrt(Math.abs(A)), 4 * Math.cbrt(Math.abs(A)))) failures.cbrt++;
  }
  return failures;
}

const gcQualifications = new WeakMap();
export async function gpuCoreQualification(device, ds = GC_DS) {
  const cases = gcQualificationCases(), made = [];
  const buffer = (size, usage) => { const b = device.createBuffer({size, usage}); made.push(b); return b; };
  device.pushErrorScope('validation');
  let scoped = true;
  try {
    const pipeline = await device.createComputePipelineAsync({layout: 'auto', compute: {module: device.createShaderModule({code: GC_QUALIFY(ds)}), entryPoint: 'main'}});
    const inp = buffer(cases.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST), out = buffer(cases.byteLength * 3, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    const read = buffer(cases.byteLength * 3, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    const one = buffer(16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    device.queue.writeBuffer(inp, 0, cases); device.queue.writeBuffer(one, 0, new Float32Array([1, 0, 0, 0]));
    const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, device.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries: [inp, out, one].map((b, k) => ({binding: k, resource: {buffer: b}}))}));
    pass.dispatchWorkgroups(Math.ceil(cases.length / 4 / 64)); pass.end();
    encoder.copyBufferToBuffer(out, 0, read, 0, cases.byteLength * 3);
    device.queue.submit([encoder.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    scoped = false;
    const invalid = await device.popErrorScope();
    if (invalid) throw new Error('GpuCore qualification: ' + invalid.message);
    const failures = gcQualificationCheck(cases, new Float32Array(read.getMappedRange()));
    read.unmap();
    return {ok: Object.values(failures).every(n => n === 0), cases: cases.length / 4, failures};
  } finally {
    for (const b of made) b.destroy();
    if (scoped) await device.popErrorScope().catch(() => null);
  }
}
export function gpuCoreQualified(device) {
  let q = gcQualifications.get(device);
  if (!q) gcQualifications.set(device, q = gpuCoreQualification(device).then(r => r.ok, () => false));
  return q;
}

const GC_AUDIT = 8;
export function gcAuditBlocks(stride, rows, count = GC_AUDIT) {
  const blocks = stride * rows, out = new Set([0, blocks - 1]);
  for (let k = 1; out.size < Math.min(count, blocks); k++) out.add(Math.floor(blocks * ((k * 0.6180339887498949) % 1)));
  return [...out];
}
export class GpuCoreAuditError extends Error {}

export class GpuCore {
  static async create(device, lib) {
    const self = new GpuCore();
    self.device = device; self.lib = lib;
    const names = Object.keys(GC_SHADERS);
    const made = await Promise.all(names.map(name => device.createComputePipelineAsync({layout: 'auto', compute: {module: device.createShaderModule({code: GC_SHADERS[name]}), entryPoint: 'main'}})));
    self.pipelines = Object.fromEntries(names.map((name, k) => [name, made[k]]));
    return self;
  }

  async image(data, width, height, quality, options, extra) {
    const {idle, band} = typeof extra === 'function' ? {idle: extra} : extra ?? {};
    if (width * height <= 2097152 || height <= 512) return this.imageBand(data, width, height, quality, options, idle, undefined, band, {y: 0, from: 0, to: height});
    const image = gcTemplate(this.lib, data, width, height, quality, options), stride = image.components[0].stride;
    let doubtfulBlocks = 0, doubtfulTiles = 0, blocks = 0, tiles = 0, auditBlocks = 0, auditWorst = 0;
    const pool = new Map();
    pool.rows = Math.min(height, 640);
    try {
      for (let y = 0; y < height; y += 512) {
        const coreHeight = Math.min(512, height - y), from = Math.max(0, y - 64), to = Math.min(height, y + coreHeight + 64);
        const part = await this.imageBand(data.subarray(from * width * 4, to * width * 4), width, to - from, quality, options, y ? undefined : idle, pool, band, {y, from, to});
        const first = (y - from) / 8 * stride, count = Math.ceil(coreHeight / 8) * stride, at = y / 8 * stride;
        for (let c = 0; c < 3; c++) {
          image.components[c].coeffs.set(part.image.components[c].coeffs.subarray(first * 64, (first + count) * 64), at * 64);
          image.nonZero[c].set(part.image.nonZero[c].subarray(first, first + count), at);
        }
        const firstTile = (y - from) / 64 * image.cfl.width, tileCount = Math.ceil(coreHeight / 64) * image.cfl.width, atTile = y / 64 * image.cfl.width;
        for (const c of ['x', 'b']) image.cfl[c].set(part.image.cfl[c].subarray(firstTile, firstTile + tileCount), atTile);
        doubtfulBlocks += part.doubtfulBlocks; doubtfulTiles += part.doubtfulTiles; blocks += part.blocks; tiles += part.tiles;
        auditBlocks += part.auditBlocks ?? 0; auditWorst = Math.max(auditWorst, part.auditWorst ?? 0);
      }
    } finally { for (const b of pool.values()) b.destroy(); }
    return {image, doubtfulBlocks, doubtfulTiles, blocks, tiles, auditBlocks, auditWorst};
  }

  encodePlanes(encoder, buffer, data, width, height, y0, y1, options) {
    const {device, lib} = this, from = Math.max(0, y0 - GC_MARGIN), to = Math.min(height, y1 + GC_MARGIN);
    const W = Math.ceil(width / 8) * 8, H = to === height ? Math.ceil(height / 8) * 8 - from : Math.ceil((to - from) / 8) * 8, n = W * H;
    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, rgba = buffer(width * (to - from) * 4, usage);
    device.queue.writeBuffer(rgba, 0, data.buffer, data.byteOffset + from * width * 4, width * (to - from) * 4);
    const {K: constants} = gcConstants(lib, null, null, options), K = buffer(constants.byteLength, usage);
    device.queue.writeBuffer(K, 0, constants);
    const t = [buffer(n * 8, usage), buffer(n * 8, usage), buffer(n * 8, usage)], xa = buffer(n * 8, usage), xb = [buffer(n * 8, usage), buffer(n * 8, usage), buffer(n * 8, usage)];
    const pass = encoder.beginComputePass(), run = (name, buffers) => {
      const groups = Math.ceil(n / GC_WG), groupsX = Math.min(groups, 65535), u = buffer(48, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
      device.queue.writeBuffer(u, 0, new Uint32Array([W, H, width, to - from, W / 8, H / 8, groupsX, 0, 0, 0, 0, 0x3f800000]));
      const p = this.pipelines[name];
      pass.setPipeline(p);
      pass.setBindGroup(0, device.createBindGroup({layout: p.getBindGroupLayout(0), entries: [u, ...buffers].map((b, k) => ({binding: k, resource: {buffer: b}}))}));
      pass.dispatchWorkgroups(groupsX, Math.ceil(groups / groupsX));
    };
    run('xyb', [rgba, K, ...t]);
    const strength = options.gaborish?.strength ?? 1;
    for (let c = 0; c < 3; c++) {
      run('gab', [t[c], t[c], xa, K]); run('gab', [t[c], xa, xb[c], K]); run('gab', [t[c], xb[c], xa, K]); run('gab', [t[c], xa, xb[c], K]);
      if (strength !== 1) run('finish', [t[c], xb[c], K]);
    }
    pass.end();
    return {planes: strength !== 1 ? t : xb, row: y0 - from};
  }

  async planes(data, width, height, options, band, rows = 512) {
    const {device} = this, pool = new Map();
    const buffer = (bytes, usage) => {
      const size = Math.max(16, Math.ceil(bytes / 16) * 16), key = usage + ':' + (pool.uses = (pool.uses ?? 0) + 1);
      const kept = pool.get(key);
      if (kept && kept.size >= size) return kept;
      kept?.destroy(); const b = device.createBuffer({size, usage}); pool.set(key, b); return b;
    };
    try {
      for (let y = 0; y < height; y += rows) {
        pool.uses = 0;
        device.pushErrorScope('validation');
        const encoder = device.createCommandEncoder(), y1 = Math.min(height, y + rows), {planes, row} = this.encodePlanes(encoder, buffer, data, width, height, y, y1, options);
        const after = band(encoder, {planes, K: null}, {y, from: y - row, to: y1});
        device.queue.submit([encoder.finish()]);
        await after?.();
        const invalid = await device.popErrorScope();
        if (invalid) throw new Error('GpuCore planes: ' + invalid.message);
      }
    } finally { for (const b of pool.values()) b.destroy(); }
  }

  async imageBand(data, width, height, quality, options, idle, pool, band, geometry) {
    const {device, lib} = this, image = gcTemplate(lib, data, width, height, quality, options), thresholds = gcThresholds(options.deadzone), noLevels = !!options.noLevels;
    const stride = Math.ceil(width / 8), rows = Math.ceil(height / 8), W = stride * 8, H = rows * 8, n = W * H, n64 = stride * rows * 64;
    const tilesX = image.cfl.width, tiles = tilesX * Math.ceil(rows / 8);
    const capRows = pool ? Math.ceil(Math.max(height, pool.rows) / 8) : rows, nCap = W * capRows * 8, n64Cap = stride * capRows * 64, tilesCap = tilesX * Math.ceil(capRows / 8);
    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC, made = [];
    const buffer = (bytes, u = usage, role) => {
      const size = Math.max(16, Math.ceil(bytes / 16) * 16), kept = pool && role && pool.get(role);
      if (kept && kept.size >= size && kept.usage === u) return kept;
      const b = device.createBuffer({size, usage: u});
      if (pool && role) { kept?.destroy(); pool.set(role, b); } else made.push(b);
      return b;
    };
    device.pushErrorScope('validation'); device.pushErrorScope('out-of-memory');
    let scopes = 2;
    try {
      const rgba = buffer(width * capRows * 32, usage, 'rgba'); device.queue.writeBuffer(rgba, 0, data.buffer, data.byteOffset, width * height * 4);
      const {K: constants, bound} = gcConstants(lib, image, thresholds, options), K = buffer(constants.byteLength, usage, 'K'); device.queue.writeBuffer(K, 0, constants);
      const t = [0, 1, 2].map(c => buffer(nCap * 8, usage, 't' + c)), xa = buffer(nCap * 8, usage, 'xa'), xb = buffer(nCap * 8, usage, 'xb'), coef = [0, 1, 2].map(c => buffer(n64Cap * 8, usage, 'coef' + c));
      const cfl = buffer(tilesCap * 8, usage, 'cfl'), tileDoubt = buffer(tilesCap * 4, usage, 'tileDoubt'), levels = noLevels ? null : buffer(n64Cap * 6, usage, 'levels'), blockDoubt = buffer(stride * capRows * 4, usage, 'blockDoubt');
      const uniforms = [], run = (pass, name, count, buffers, params = {}) => {
        const groups = Math.ceil(count / (name === 'dct' ? GC_DCT_WG : name === 'cfl' ? GC_CFL_WG : GC_WG)), groupsX = Math.min(groups, 65535), groupsY = Math.ceil(groups / groupsX);
        const u = buffer(48, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, 'u' + uniforms.length), d = new ArrayBuffer(48), uv = new Uint32Array(d), fv = new Float32Array(d);
        uv.set([W, H, width, height, stride, rows, groupsX, params.c ?? 0]); fv[8] = params.a ?? 0; fv[11] = 1;
        device.queue.writeBuffer(u, 0, d); uniforms.push(u);
        const p = this.pipelines[name];
        pass.setPipeline(p);
        pass.setBindGroup(0, device.createBindGroup({layout: p.getBindGroupLayout(0), entries: [u, ...buffers].map((b, k) => ({binding: k, resource: {buffer: b}}))}));
        pass.dispatchWorkgroups(groupsX, groupsY);
      };
      const encoder = device.createCommandEncoder();
      if (pool) encoder.clearBuffer(blockDoubt, 0, stride * rows * 4);
      const pass = encoder.beginComputePass();
      run(pass, 'xyb', n, [rgba, K, ...t]);
      const strength = options.gaborish?.strength ?? 1;
      for (let c = 0; c < 3; c++) {
        run(pass, 'gab', n, [t[c], t[c], xa, K]);
        run(pass, 'gab', n, [t[c], xa, xb, K]);
        run(pass, 'gab', n, [t[c], xb, xa, K]);
        if (strength !== 1) { run(pass, 'gab', n, [t[c], xa, xb, K]); run(pass, 'finish', n, [t[c], xb, K]); }
        else run(pass, 'gabLast', n, [t[c], xa, K]);
        run(pass, 'dct', n64, [t[c], K, coef[c]]);
      }
      run(pass, 'cfl', tiles * GC_CFL_WG, [...coef, cfl, tileDoubt, K], {a: bound});
      if (!noLevels) for (let c = 0; c < 3; c++) run(pass, 'quant', n64 / 2, [coef[c], coef[1], K, cfl, levels, blockDoubt], {c, a: bound});
      pass.end();
      const after = band?.(encoder, {planes: t, K, W, H, width, height, stride, rows}, geometry);
      const readLevels = noLevels ? null : buffer(n64Cap * 6, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST, 'readLevels'), readSmall = buffer(tilesCap * 12 + stride * capRows * 4, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST, 'readSmall');
      if (!noLevels) encoder.copyBufferToBuffer(levels, 0, readLevels, 0, n64 * 6);
      encoder.copyBufferToBuffer(cfl, 0, readSmall, 0, tiles * 8);
      encoder.copyBufferToBuffer(tileDoubt, 0, readSmall, tiles * 8, tiles * 4);
      encoder.copyBufferToBuffer(blockDoubt, 0, readSmall, tiles * 12, stride * rows * 4);
      const audited = this.audit === false ? [] : gcAuditBlocks(stride, rows), auditBytes = audited.length * 3 * 512;
      const readAudit = audited.length ? buffer(GC_AUDIT * 3 * 512, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST, 'readAudit') : null;
      audited.forEach((b, k) => { for (let c = 0; c < 3; c++) encoder.copyBufferToBuffer(coef[c], b * 512, readAudit, (k * 3 + c) * 512, 512); });
      device.queue.submit([encoder.finish()]);
      const smallBytes = tiles * 12 + stride * rows * 4, mapped = Promise.all([readLevels?.mapAsync(GPUMapMode.READ, 0, n64 * 6), readSmall.mapAsync(GPUMapMode.READ, 0, smallBytes), readAudit?.mapAsync(GPUMapMode.READ, 0, auditBytes)]);
      try { idle?.(); } catch {}
      await mapped;
      await after?.();
      scopes--; const oom = await device.popErrorScope();
      scopes--; const invalid = await device.popErrorScope();
      if (oom || invalid) throw new Error('GpuCore: ' + (oom || invalid).message);
      let auditWorst = 0;
      if (readAudit) {
        const got = new Float32Array(readAudit.getMappedRange(0, auditBytes));
        audited.forEach((b, k) => {
          const sums = gcBlockSums(lib, data, width, height, options, b % stride, Math.floor(b / stride));
          for (let i = 0; i < 192; i++) {
            const at = (k * 192 + i) * 2, error = Math.abs(got[at] + got[at + 1] - sums[i]);
            auditWorst = Math.max(auditWorst, Number.isNaN(error) ? Infinity : error / bound);
          }
        });
        readAudit.unmap();
        if (!(auditWorst <= 1)) throw new GpuCoreAuditError(`GpuCore audit: a coefficient is ${auditWorst} times its bound`);
      }
      if (!noLevels) {
        const all = new Int16Array(readLevels.getMappedRange(0, n64 * 6));
        for (let c = 0; c < 3; c++) image.components[c].coeffs.set(all.subarray(c * n64, (c + 1) * n64));
      }
      const small = readSmall.getMappedRange(0, smallBytes), cf = new Int32Array(small, 0, tiles * 2), td = new Uint32Array(small, tiles * 8, tiles), bd = new Uint32Array(small, tiles * 12, stride * rows);
      for (let b = 0; b < bd.length; b++) for (let c = 0; c < 3; c++) image.nonZero[c][b] = (bd[b] >>> (c * 8)) & 255;
      for (let k = 0; k < tiles; k++) { image.cfl.x[k] = cf[k * 2]; image.cfl.b[k] = cf[k * 2 + 1]; }
      let doubtfulTiles = 0, doubtfulBlocks = 0;
      const tileDone = new Uint8Array(tiles);
      for (let k = 0; k < tiles; k++) if (td[k]) { gcExactTile(lib, data, width, height, image, thresholds, options, k % tilesX, Math.floor(k / tilesX)); tileDone[k] = 1; doubtfulTiles++; }
      if (!noLevels) for (let b = 0; b < stride * rows; b++) if (bd[b] & 16777216) {
        const bx = b % stride, by = Math.floor(b / stride);
        if (tileDone[(by >> 3) * tilesX + (bx >> 3)]) continue;
        gcExactBlock(lib, data, width, height, image, thresholds, options, bx, by); doubtfulBlocks++;
      }
      readLevels?.unmap(); readSmall.unmap();
      return {image, doubtfulBlocks, doubtfulTiles, blocks: stride * rows, tiles, auditBlocks: audited.length, auditWorst};
    } finally {
      for (const b of made) b.destroy();
      while (scopes-- > 0) await device.popErrorScope().catch(() => null);
    }
  }
}

const gcCores = new WeakMap();
function gcReady(device) {
  let ready = gcCores.get(device);
  const later = start => Promise.resolve().then(start);
  if (!ready) gcCores.set(device, ready = Promise.all([later(() => gpuCoreQualified(device)), later(() => GpuCore.create(device, null)), later(() => gpuBlocks16Pipelines(device, GC_DS)).catch(() => null)]).then(([ok, core]) => ok ? core : null, () => null));
  return ready;
}
export async function gpuCoreReady(device) { return !!await gcReady(device); }

const gcChains = new WeakMap();
export function gpuCoreImage(device, request, strict = false) {
  const answer = (gcChains.get(device) ?? Promise.resolve()).then(() => gcAnswer(device, request, strict));
  gcChains.set(device, answer.then(() => {}, () => {}));
  return answer;
}
async function gcAnswer(device, request, strict) {
  try {
    const core = await gcReady(device);
    if (!core) throw new Error('the device did not qualify (double-single arithmetic or its pipelines)');
    if (request.lib) core.lib = request.lib;
    if (request.kind === 'blocks16') return await gpuBlocks16Costs(device, {...request, planeBound: B.plane}, GC_DS, core);
    if (request.kind === 'blocks') return await gpuBlocksCosts(device, {...request, planeBound: B.plane}, GC_DS, core);
    if (request.kind === 'blocks-levels') return await gpuBlocksLevels(device, {...request, planeBound: B.plane}, GC_DS, core);
    if (request.kind === 's2-native') return await (await import('./gpu-ssimulacra2-native.mjs')).gpuS2Native(device, request);
    if (request.kind === 'audit-failed') throw new GpuCoreAuditError('gpu-blocks16 audit: a cost past its bound');
    if (request.kind === 'blocks16-levels') return await gpuBlocks16Levels(device, {...request, planeBound: B.plane}, GC_DS, core);
    const energy = request.energy ? await gpuBlocks16EnergyHook(device, GC_DS, request.width, request.height, B.plane) : null;
    const {image} = await core.image(request.data, request.width, request.height, request.quality, request.options, {idle: request.idle, band: energy?.band ?? request.band});
    if (energy) image.maskEnergy = energy.result();
    return image;
  } catch (error) {
    if (error instanceof GpuCoreAuditError) gcCores.set(device, Promise.resolve(null));
    if (strict) throw error;
    return null;
  }
}

let gcDevice;
export function gpuCoreDevice() {
  if (gcDevice) return gcDevice;
  const pending = (async () => {
    const adapter = await globalThis.navigator?.gpu?.requestAdapter({powerPreference: 'high-performance'});
    if (!adapter || adapter.info.isFallbackAdapter) return null;
    const device = await adapter.requestDevice({requiredLimits: {maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize, maxBufferSize: adapter.limits.maxBufferSize}});
    device.lost.then(() => { if (gcDevice === pending) gcDevice = undefined; });
    return device;
  })().catch(() => null).then(device => {
    if (!device && gcDevice === pending) gcDevice = undefined;
    return device;
  });
  return gcDevice = pending;
}
