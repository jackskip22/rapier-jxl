// SPDX-License-Identifier: MIT

import {gpuTrees} from './gpu-trees.mjs';
import {fault} from './fault.mjs';
import {gpuDevice} from './gpu-device.mjs';
import {traced, tracing} from './stage-trace.mjs';
import {GC_BOUNDS, GC_DS, GC_CBRT, gcF, gcSplit, gpuCoreQualified, gpuCoreReadMs, gpuDeviceProbe, gpuBulkProbe, PROBE_BULK_BYTES} from './gpu-arithmetic.mjs';
import {s2CellSums} from './s2-cells.mjs';
export {GC_BOUNDS, gcQualificationCases, gcQualificationCheck, gpuCoreQualification, gpuCoreQualified} from './gpu-arithmetic.mjs';
import {gpuBlocks16Mask, gpuBlocks16EnergyHook} from './gpu-blocks16.mjs';
import {gpuBlocksCosts, gpuBlocksLevels, gpuBlocksPipelines, gpuBlocksLevelsPipelines} from './gpu-blocks.mjs';
import {captureBlockRequest} from './gpu-capture-blocks.mjs';
import {gpuCheck, gpuMap, gpuGroupsX, gpuDestroy, gpuAutoSet, gpuScoped, gpuWrite, gpuAlloc, gpuUpload, gpuUni, gpuStep} from './gpu-kit.mjs';
import {gpuRebuild, gpuRebuildPipelines} from './gpu-render.mjs';
import {gpuS2Sums} from './gpu-s2.mjs';
import {gpuS2Cells, gpuS2CellsPipelines} from './gpu-s2-cells.mjs';

const GC_GAB = [0.115169525, 0.061248592], GC_MARGIN = 8;

function gcTemplate(lib, data, width, height, quality, options) {
  const {complete, photoXYBSteps} = lib;
  const stride = Math.ceil(width / 8), rows = Math.ceil(height / 8), pw = Math.min(width, 24), ph = Math.min(height, 24);
  const probe = complete(photoXYBSteps(new Uint8Array(pw * ph * 4).fill(128), pw, ph, quality, {...options, noLevels: true}));
  let alpha = null;
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) { alpha = data; break; }
  const tileWidth = Math.ceil(stride / 8), tiles = tileWidth * Math.ceil(rows / 8);
  return {...probe, width, height, alpha, components: probe.components.map(c => ({...c, stride, rows, coeffs: new Int16Array(options.noLevels ? 0 : stride * rows * 64)})),
    nonZero: Array.from({length: 3}, () => new Uint8Array(options.noLevels ? 0 : stride * rows)),
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
  const {n, boost, s, w1, w2} = gcGabPlan(options), norm = 1 / (1 + 4 * w1 + 4 * w2);
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
    for (let i = 0; i < n; i++) {
      G(x, g); for (let k = 0; k < x.length; k++) x[k] += src[k] - g[k];
      if (!i && boost !== 1) for (let k = 0; k < x.length; k++) x[k] = src[k] + boost * (x[k] - src[k]);
    }
    for (let k = 0; k < x.length; k++) x[k] = src[k] + s * (x[k] - src[k]);
    return x;
  });
  return {planes, ox: x0 - wx0, oy: y0 - wy0, cw};
}

function gcBlockDCT(lib, win, bx, by, x0, y0, out) {
  const block = new Float64Array(192);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const at = (win.oy + by * 8 - y0 + y) * win.cw + win.ox + bx * 8 - x0 + x;
    block[y * 8 + x] = win.planes[0][at]; block[64 + y * 8 + x] = win.planes[1][at]; block[128 + y * 8 + x] = win.planes[2][at];
  }
  return lib.transformDCT8(block, out);
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
  const win = gcWindowPlanes(lib, data, width, height, bx0 * 8, by0 * 8, bw * 8, bh * 8, options);
  const all = [];
  let yy = 0, xy = 0, bySum = 0;
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    const sums = gcBlockDCT(lib, win, bx0 + bx, by0 + by, bx0 * 8, by0 * 8, new Float64Array(192));
    for (let k = 1; k < 64; k++) { yy += sums[64 + k] * sums[64 + k]; xy += sums[k] * sums[64 + k]; bySum += sums[128 + k] * sums[64 + k]; }
    all.push(sums);
  }
  const cflScale = options.cflScale ?? 1;
  const fx = image.cfl.x[index] = Math.max(-128, Math.min(127, Math.round(cflScale * 84 * xy / (yy + 1))));
  const fb = image.cfl.b[index] = Math.max(-128, Math.min(127, Math.round(cflScale * 84 * bySum / (yy + 1))));
  let n = 0;
  if (!options.noLevels) for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) gcQuantize(all[n++], image, thresholds, bx0 + bx, by0 + by, fx, fb);
}

function gcExactBlock(lib, data, width, height, image, thresholds, options, bx, by) {
  const win = gcWindowPlanes(lib, data, width, height, bx * 8, by * 8, 8, 8, options), index = (by >> 3) * image.cfl.width + (bx >> 3);
  gcQuantize(gcBlockDCT(lib, win, bx, by, bx * 8, by * 8, new Float64Array(192)), image, thresholds, bx, by, image.cfl.x[index], image.cfl.b[index]);
}

export function gcExactImage(lib, data, width, height, quality, options) {
  const image = gcTemplate(lib, data, width, height, quality, options), thresholds = gcThresholds(options.deadzone);
  const tilesX = image.cfl.width, tilesY = Math.ceil(image.components[0].rows / 8);
  for (let ty = 0; ty < tilesY; ty++) for (let tx = 0; tx < tilesX; tx++) gcExactTile(lib, data, width, height, image, thresholds, options, tx, ty);
  return image;
}

const gcBlockSums = (lib, data, width, height, options, bx, by) => gcBlockDCT(lib, gcWindowPlanes(lib, data, width, height, bx * 8, by * 8, 8, 8, options), bx, by, bx * 8, by * 8, new Float64Array(192));
export {gcTemplate, gcThresholds, gcExactTile, gcExactBlock, gcBlockSums};

const GC_WG = 128, GC_DCT_WG = 64, GC_CFL_WG = 64;
const GK = {mix: 0, bias: 9, root: 10, third: 11, w1: 12, w2: 13, norm: 14, strength: 15, cfl: 16, half: 17, basis: 18, share: 82, linear: 338, recip: 594, dead: 786, boost: 978, size: 979};
const B = GC_BOUNDS;

export function gcGabPlan(options) {
  const g = options?.gaborish;
  if (!g) return null;
  const n = g.iterations ?? 4, boost = g.boost ?? 1, s = g.strength ?? 1, w = g.weights;
  if (!Number.isInteger(n) || n < 2 || n > 4 || g.adapt || Array.isArray(s)) return null;
  if (w && !w.every(c => c && c[0] === w[0][0] && c[1] === w[0][1])) return null;
  const [w1, w2] = w ? w[0] : GC_GAB;
  return {n, boost, s, w1, w2};
}

function gcPasses(plan, run, t, xa, xb, K) {
  run('gab', [t, K, t, xa]);
  if (plan.boost !== 1) run('gabTail', [xa, K, t], 1);
  let cur = xa, other = xb;
  for (let i = 1; i < plan.n - 1; i++) { run('gab', [t, K, cur, other]); [cur, other] = [other, cur]; }
  if (plan.s !== 1) { run('gab', [t, K, cur, other]); run('gabTail', [t, K, other], 2); }
  else run('gabTail', [t, K, cur], 0);
}

export const GC_SHADER =  `
struct Params { W: u32, H: u32, width: u32, height: u32, stride: u32, rows: u32, groupsX: u32, c: u32, a: f32, b: f32, d: f32, one: f32 }
@group(0) @binding(0) var<uniform> P: Params;
fn gcOne() -> f32 { return P.one; }
fn gcIdx(wid: vec3u, lid: u32, wg: u32) -> u32 { return (wid.y * P.groupsX + wid.x) * wg + lid; }

@group(0) @binding(1) var<storage, read> xRgba: array<u32>;
@group(0) @binding(2) var<storage, read> cK: array<vec2f>;
@group(0) @binding(3) var<storage, read_write> xTx: array<vec2f>;
@group(0) @binding(4) var<storage, read_write> xTy: array<vec2f>;
@group(0) @binding(5) var<storage, read_write> xTb: array<vec2f>;

@group(0) @binding(1) var<storage, read> gT: array<vec2f>;
@group(0) @binding(3) var<storage, read> gX: array<vec2f>;
@group(0) @binding(4) var<storage, read_write> gNext: array<vec2f>;
@group(0) @binding(1) var<storage, read_write> gsDst: array<vec2f>;

@group(0) @binding(3) var<storage, read_write> dOut: array<vec2f>;

@group(0) @binding(2) var<storage, read> fCy: array<vec2f>;
@group(0) @binding(4) var<storage, read_write> fOut: array<i32>;
@group(0) @binding(5) var<storage, read_write> fDoubt: array<u32>;
@group(0) @binding(6) var<storage, read> fK: array<vec2f>;

@group(0) @binding(3) var<storage, read> qK: array<vec2f>;
@group(0) @binding(4) var<storage, read> qCfl: array<i32>;
@group(0) @binding(6) var<storage, read_write> qDoubt: array<atomic<u32>>;

${GC_DS}
${GC_CBRT}

// XYB of every padded pixel (edges repeated), into three planes.
@compute @workgroup_size(${GC_WG})
fn xyb(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_index) lid: u32) {
  let i = gcIdx(wid, lid, ${GC_WG}u);
  if (i >= P.W * P.H) { return; }
  let x = min(i % P.W, P.width - 1u); let y = min(i / P.W, P.height - 1u); let p = xRgba[y * P.width + x];
  let r = cK[${GK.linear}u + (p & 255u)]; let g = cK[${GK.linear}u + ((p >> 8u) & 255u)]; let b = cK[${GK.linear}u + ((p >> 16u) & 255u)];
  var l = vec2f(0.0); var m = vec2f(0.0); var s = vec2f(0.0);
  let third = cK[${GK.third}]; let root = cK[${GK.root}]; let z0 = u32(gcOne() < 0.0);
  for (var q = z0; q < 3u; q++) {
    let o = q * 3u;
    let cone = dadd(dadd(dadd(dmul(cK[${GK.mix}u + o], r), dmul(cK[${GK.mix}u + o + 1u], g)), dmul(cK[${GK.mix}u + o + 2u], b)), cK[${GK.bias}]);
    let v = dsub(dcbrt(cone, third), root);
    if (q == 0u) { l = v; } else if (q == 1u) { m = v; } else { s = v; }
  }
  xTx[i] = dmul(dsub(l, m), vec2f(127.5, 0.0)); let Y = dmul(dadd(l, m), vec2f(127.5, 0.0)); xTy[i] = Y; xTb[i] = dsub(dmul(s, vec2f(255.0, 0.0)), Y);
}

fn gabBlur(i: u32) -> vec2f {
  let px = i % P.W; let py = i / P.W;
  let u = select(py - 1u, 0u, py == 0u) * P.W; let m = py * P.W; let d = min(py + 1u, P.H - 1u) * P.W;
  let l = select(px - 1u, 0u, px == 0u); let r = min(px + 1u, P.W - 1u);
  let near = dadd(dadd(dadd(gX[u + px], gX[d + px]), gX[m + l]), gX[m + r]);
  let far = dadd(dadd(dadd(gX[u + l], gX[u + r]), gX[d + l]), gX[d + r]);
  return dmul(dadd(dadd(gX[m + px], dmul(cK[${GK.w1}], near)), dmul(cK[${GK.w2}], far)), cK[${GK.norm}]);
}

// One Gaborish-inverse pass: next = x + (t - G x), G the decoder's 3x3 smoothing with edges repeated.
@compute @workgroup_size(${GC_WG})
fn gab(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_index) lid: u32) {
  let i = gcIdx(wid, lid, ${GC_WG}u);
  if (i >= P.W * P.H) { return; }
  gNext[i] = dadd(gX[i], dsub(gT[i], gabBlur(i)));
}

// Mode 0 (gabLast): final pass at strength 1 written over t. Mode 1 (boost): first pass correction scaled in xa.
// Mode 2 (finish): final pass scaled by strength into t.
// The fourth pass at strength 1, written over t: each invocation reads only its own t[i], so the planes end in t, all
// three channels kept for a caller's band hook (GpuCore.image \`band\`), the same values as \`gab\`.
// The first step's correction scaled (the upload picture's \`boost\`): x = t + boost (x - t), in x.
// The inverse's last step where the strength is not 1: pre = t + strength (x - t), into t.
@compute @workgroup_size(${GC_WG})
fn gabTail(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_index) lid: u32) {
  let i = gcIdx(wid, lid, ${GC_WG}u);
  if (i >= P.W * P.H) { return; }
  if (P.c == 0u) { gsDst[i] = dadd(gX[i], dsub(gsDst[i], gabBlur(i))); }
  else if (P.c == 1u) { gsDst[i] = dadd(gX[i], dmul(cK[${GK.boost}], dsub(gsDst[i], gX[i]))); }
  else { gsDst[i] = dadd(gsDst[i], dmul(cK[${GK.strength}], dsub(gX[i], gsDst[i]))); }
}

var<workgroup> tile: array<vec2f, 64>;
var<workgroup> horizontal: array<vec2f, 64>;

// DCT8 of one channel, one workgroup per block (block-major out: block * 64 + v * 8 + u).
@compute @workgroup_size(${GC_DCT_WG})
fn dct(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_index) lid: u32) {
  let blocks = P.stride * P.rows; let rawBlk = wid.y * P.groupsX + wid.x;
  // Padded workgroups use valid reads and reach both barriers; only real blocks store a result.
  let blk = min(rawBlk, blocks - 1u); let v = lid / 8u; let u = lid % 8u;
  let x0 = (blk % P.stride) * 8u; let y0 = (blk / P.stride) * 8u;
  tile[lid] = gT[(y0 + v) * P.W + x0 + u];
  workgroupBarrier();
  var row = vec2f(0.0);
  for (var x = 0u; x < 8u; x++) { row = dadd(row, dmul(tile[v * 8u + x], cK[${GK.basis}u + u * 8u + x])); }
  horizontal[lid] = row;
  workgroupBarrier();
  var s = vec2f(0.0);
  for (var y = 0u; y < 8u; y++) { s = dadd(s, dmul(horizontal[y * 8u + u], cK[${GK.basis}u + v * 8u + y])); }
  if (rawBlk < blocks) { dOut[blk * 64u + lid] = s; }
}

var<workgroup> wyy: array<vec2f, 64>;
var<workgroup> wxy: array<vec2f, 64>;
var<workgroup> wby: array<vec2f, 64>;
var<workgroup> wa: array<vec4f, 64>;
var<workgroup> wb: array<f32, 64>;

// Each 64x64 tile's color correlation, one workgroup per tile and one invocation per block, the sums reduced in a
// fixed tree; a doubt flag where the factor's bound reaches a half step. P.a is the coefficients' bound B_C.
@compute @workgroup_size(${GC_CFL_WG})
fn cfl(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_index) lid: u32) {
  let tilesX = (P.stride + 7u) / 8u; let tiles = tilesX * ((P.rows + 7u) / 8u); let raw = wid.y * P.groupsX + wid.x; let tIdx = min(raw, tiles - 1u);
  let bx0 = (tIdx % tilesX) * 8u; let by0 = (tIdx / tilesX) * 8u; let bi = bx0 + lid % 8u; let bj = by0 + lid / 8u;
  var yy = vec2f(0.0); var xy = vec2f(0.0); var by = vec2f(0.0); var ax = 0.0; var ay = 0.0; var ab = 0.0; var axy = 0.0; var aby = 0.0;
  let z0 = u32(gcOne() < 0.0);
  if (bi < P.stride && bj < P.rows) {
    let base = (bj * P.stride + bi) * 64u;
    for (var k = 1u + z0; k < 64u; k++) {
      let X = gT[base + k]; let Y = fCy[base + k]; let Bv = gX[base + k];
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
  let sy = wyy[0]; let sa = wa[0] * 1.001; let saby = wb[0] * 1.001; let den = dadd(sy, vec2f(1.0, 0.0)); let A = fK[${GK.cfl}];
  let eyy = 2.0 * bc * sa.y + terms * bc * bc + ${gcF(B.sum)} * abs(sy.x) * 1.001 + ${gcF(B.floor)};
  var flag = 0u;
  for (var c = z0; c < 2u; c++) {
    let num = select(wby[0], wxy[0], c == 0u); let anum = select(saby, sa.w, c == 0u); let aother = select(sa.z, sa.x, c == 0u);
    let enm = bc * (aother + sa.y) + terms * bc * bc + ${gcF(B.sum)} * anum + ${gcF(B.floor)};
    let v = ddiv(dmul(A, num), den);
    let ev = (abs(A.x) * (enm + abs(num.x) * eyy / den.x) / den.x + ${gcF(B.rel)} * abs(v.x)) * 1.001 + ${gcF(B.floor)};
    let n = dround(vec2f(clamp(v.x, -1000.0, 1000.0), v.y), fK[${GK.half}], ev + ${gcF(B.frac)});
    if (n.y != 0.0 && abs(v.x) < 129.0) { flag = 1u; }
    fOut[tIdx * 2u + c] = clamp(i32(n.x), -128, 127);
  }
  fDoubt[tIdx] = flag;
}

// Quantization, two coefficients (k, k + 1) of one block and channel per invocation, packed as i16 pairs.
// Counts occupy three bytes of blockDoubt; bit 24 marks any rounding uncertainty. P.c is the channel, P.a is B_C.
@compute @workgroup_size(${GC_WG})
fn quant(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_index) lid: u32) {
  let i = gcIdx(wid, lid, ${GC_WG}u);
  let n64 = P.stride * P.rows * 64u; if (i * 2u >= n64) { return; }
  let blk = (i * 2u) / 64u; let k0 = (i * 2u) % 64u;
  let tIdx = ((blk / P.stride) / 8u) * ((P.stride + 7u) / 8u) + (blk % P.stride) / 8u;
  var share = vec2f(0.0);
  if (P.c == 0u) { share = qK[${GK.share}u + u32(qCfl[tIdx * 2u] + 128)]; } else if (P.c == 2u) { share = qK[${GK.share}u + u32(qCfl[tIdx * 2u + 1u] + 128)]; }
  var packed = 0u; var doubt = false; var nonZero = 0u;
  let z0 = u32(gcOne() < 0.0);
  for (var j = z0; j < 2u; j++) {
    let k = k0 + j; let R = qK[${GK.recip}u + P.c * 64u + k]; let th = qK[${GK.dead}u + P.c * 64u + k];
    let c0 = gT[blk * 64u + k]; var cv = c0; var ec = P.a;
    if (k > 0u && P.c != 1u) { let sy = dmul(share, fCy[blk * 64u + k]); cv = dsub(c0, sy); ec = P.a * (1.0 + abs(share.x)) + ${gcF(B.rel)} * (abs(c0.x) + abs(sy.x)); }
    let value = dmul(cv, R);
    let e = (ec * R.x + ${gcF(B.rel)} * abs(value.x)) * 1.001 + ${gcF(B.floor)};
    let dz = dsub(dabs(value), th);
    var level = 0;
    if (abs(dz.x) <= e) { doubt = true; }
    if (dz.x >= 0.0) {
      let n = dround(vec2f(clamp(value.x, -40000.0, 40000.0), value.y), qK[${GK.half}], e + ${gcF(B.frac)});
      if (n.y != 0.0) { doubt = true; }
      level = i32(n.x);
    }
    if (abs(level) > 32767) { doubt = true; }
    packed = packed | ((u32(level) & 65535u) << (16u * j));
    if (k > 0u && level != 0) { nonZero += 1u; }
  }
  fDoubt[(P.c * n64 + i * 2u) / 2u] = packed;
  // Each channel has at most 63 nonzero AC values, so additions cannot carry into another byte.
  atomicAdd(&qDoubt[blk], nonZero << (P.c * 8u));
  if (doubt) { atomicOr(&qDoubt[blk], 16777216u); }
}`;

export const GC_SHADERS = {core: GC_SHADER};
const GC_BASE_ENTRIES = [['xyb', GC_WG], ['gab', GC_WG], ['gabTail', GC_WG], ['dct', GC_DCT_WG], ['cfl', GC_CFL_WG]];

function gcConstants(lib, image, thresholds, options) {
  const K = new Float32Array(GK.size * 2), set = (at, v) => gcSplit(v, K, at * 2), {linear, mix, bias, rootBias} = lib.xyb;
  for (let k = 0; k < 9; k++) set(GK.mix + k, mix[k]);
  set(GK.bias, bias); set(GK.root, rootBias); set(GK.third, 1 / 3); set(GK.half, 0.5);
  const {w1, w2, boost} = gcGabPlan(options) ?? {w1: GC_GAB[0], w2: GC_GAB[1], boost: 1}, norm = 1 / (1 + 4 * w1 + 4 * w2);
  set(GK.w1, w1); set(GK.w2, w2); set(GK.norm, norm); set(GK.strength, options.gaborish?.strength ?? 1); set(GK.cfl, (options.cflScale ?? 1) * 84);
  set(GK.boost, boost);
  let S = 0;
  for (let u = 0; u < 8; u++) { let row = 0; for (let x = 0; x < 8; x++) { set(GK.basis + u * 8 + x, lib.dct8Basis[u * 8 + x]); row += Math.abs(lib.dct8Basis[u * 8 + x]); } S = Math.max(S, row); }
  for (let f = -128; f < 128; f++) set(GK.share + f + 128, f / 84);
  for (let i = 0; i < 256; i++) set(GK.linear + i, linear[i]);
  if (image) for (let c = 0; c < 3; c++) for (let k = 0; k < 64; k++) { set(GK.recip + c * 64 + k, 256 / image.components[c].quant[k]); set(GK.dead + c * 64 + k, thresholds[c][k]); }
  return {K, bound: S * S * (B.plane + 32 * B.op * B.planeMax)};
}

const GC_AUDIT = 8;
export function gcAuditBlocks(stride, rows, count = GC_AUDIT) {
  const blocks = stride * rows, out = new Set([0, blocks - 1]);
  for (let k = 1; out.size < Math.min(count, blocks); k++) out.add(Math.floor(blocks * ((k * 0.6180339887498949) % 1)));
  return [...out];
}
export class GpuCoreAuditError extends Error {}

function gcEncodePlanes(device, lib, pipelines, encoder, buffer, data, width, height, y0, y1, options) {
  const from = Math.max(0, y0 - GC_MARGIN), to = Math.min(height, y1 + GC_MARGIN);
  const W = Math.ceil(width / 8) * 8, H = to === height ? Math.ceil(height / 8) * 8 - from : Math.ceil((to - from) / 8) * 8, n = W * H;
  const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, uniUse = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
  const rgba = gpuWrite(device, buffer(width * (to - from) * 4, usage), new Uint8Array(data.buffer, data.byteOffset + from * width * 4, width * (to - from) * 4));
  const {K: constants} = gcConstants(lib, null, null, options), K = gpuWrite(device, buffer(constants.byteLength, usage), constants);
  const t = [buffer(n * 8, usage), buffer(n * 8, usage), buffer(n * 8, usage)], xa = buffer(n * 8, usage), xb = buffer(n * 8, usage);
  const pass = encoder.beginComputePass(), groupsX = gpuGroupsX(n, GC_WG);
  const run = (name, buffers, c = 0) => {
    const u = gpuWrite(device, buffer(48, uniUse), new Float32Array(new Uint32Array([W, H, width, to - from, W / 8, H / 8, groupsX, c, 0, 0, 0, 0x3f800000]).buffer));
    gpuStep(device, pass, pipelines[name], [u, ...buffers], n);
  };
  run('xyb', [rgba, K, ...t]);
  const plan = gcGabPlan(options);
  for (let c = 0; c < 3; c++) gcPasses(plan, run, t[c], xa, xb, K);
  pass.end();
  return {planes: t, row: y0 - from};
}

const GC_SHARED = new Set(['t0', 't1', 't2', 'xa', 'xb', 'coef0', 'coef1', 'coef2', 'cfl', 'tileDoubt', 'levels', 'blockDoubt']);
async function gcImageBand(device, lib, pipelines, checkAudit, data, width, height, quality, options, idle, pool, band, geometry, batch = null) {
  const image = gcTemplate(lib, data, width, height, quality, options), thresholds = gcThresholds(options.deadzone), noLevels = !!options.noLevels;
  const stride = Math.ceil(width / 8), rows = Math.ceil(height / 8), W = stride * 8, H = rows * 8, n = W * H, n64 = stride * rows * 64;
  const tilesX = image.cfl.width, tiles = tilesX * Math.ceil(rows / 8);
  const capRows = pool ? Math.ceil(Math.max(height, pool.rows) / 8) : rows, nCap = W * capRows * 8, n64Cap = stride * capRows * 64, tilesCap = tilesX * Math.ceil(capRows / 8);
  const made = batch ? batch.made : [], pooled = gpuAlloc(device, made, pool), own = gpuAlloc(device, made);
  const buffer = batch ? (bytes, use, role) => GC_SHARED.has(role) ? pooled(bytes, use, role) : own(bytes, use) : pooled;
  const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
  const record = encoder => {
      const rgba = gpuWrite(device, buffer(width * capRows * 32, usage, 'rgba'), new Uint8Array(data.buffer, data.byteOffset, width * height * 4));
      const {K: constants, bound} = gcConstants(lib, image, thresholds, options), K = gpuUpload(device, buffer, constants, usage, 'K');
      const t = [0, 1, 2].map(c => buffer(nCap * 8, usage, 't' + c)), xa = buffer(nCap * 8, usage, 'xa'), xb = buffer(nCap * 8, usage, 'xb'), coef = [0, 1, 2].map(c => buffer(n64Cap * 8, usage, 'coef' + c));
      const cfl = buffer(tilesCap * 8, usage, 'cfl'), tileDoubt = buffer(tilesCap * 4, usage, 'tileDoubt'), levels = noLevels ? null : buffer(n64Cap * 6, usage, 'levels'), blockDoubt = noLevels ? null : buffer(stride * capRows * 4, usage, 'blockDoubt');
      let uSeq = 0;
      const run = (pass, name, count, buffers, params = {}) => {
        const kernel = pipelines[name], gx = gpuGroupsX(count, kernel[1]);
        const u = gpuUni(device, buffer, [W, H, width, height, stride, rows, gx, params.c ?? 0], [[8, params.a ?? 0]], 11, 48, 'u' + (uSeq++));
        gpuStep(device, pass, kernel, [u, ...buffers], count);
      };
      if (pool && blockDoubt) encoder.clearBuffer(blockDoubt, 0, stride * rows * 4);
      const pass = encoder.beginComputePass();
      run(pass, 'xyb', n, [rgba, K, ...t]);
      const plan = gcGabPlan(options);
      for (let c = 0; c < 3; c++) {
        gcPasses(plan, (name, buffers, mode = 0) => run(pass, name, n, buffers, {c: mode}), t[c], xa, xb, K);
        run(pass, 'dct', n64, [t[c], K, coef[c]]);
      }
      run(pass, 'cfl', tiles * GC_CFL_WG, [...coef, cfl, tileDoubt, K], {a: bound});
      if (!noLevels) for (let c = 0; c < 3; c++) run(pass, 'quant', n64 / 2, [coef[c], coef[1], K, cfl, levels, blockDoubt], {c, a: bound});
      pass.end();
      const after = band?.(encoder, {planes: t, K, W, H, width, height, stride, rows}, geometry, made);
      const a8 = v => Math.ceil(v / 8) * 8;
      const audited = checkAudit === false ? [] : gcAuditBlocks(stride, rows), auditBytes = audited.length * 3 * 512;
      const smallBytes = tiles * 12 + (noLevels ? 0 : stride * rows * 4), levelsBytes = noLevels ? 0 : n64 * 6;
      const offAudit = 0, offSmall = a8(auditBytes), offLevels = a8(offSmall + smallBytes), totalRead = a8(offLevels + levelsBytes);
      const capSmall = tilesCap * 12 + (noLevels ? 0 : stride * capRows * 4), capLevels = noLevels ? 0 : n64Cap * 6;
      const capRead = a8(a8(GC_AUDIT * 3 * 512) + capSmall) + a8(capLevels);
      let readBuf, baseOff = 0;
      if (batch?.stageList) {
        baseOff = batch.stageBytes;
        batch.stageBytes += totalRead;
        const idx = batch.stageList.length;
        batch.stageList.push([baseOff, totalRead]);
        readBuf = {get buf() { return batch.readBuf; }, idx};
      } else {
        readBuf = buffer(capRead, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST, 'readAll');
      }
      const copyRead = (src, so, dstOff, sz) => {
        if (!sz) return;
        if (batch?.stageList) batch.copies.push([src, so, baseOff + dstOff, sz]);
        else encoder.copyBufferToBuffer(src, so, readBuf, dstOff, sz);
      };
      audited.forEach((b, k) => { for (let c = 0; c < 3; c++) copyRead(coef[c], b * 512, offAudit + (k * 3 + c) * 512, 512); });
      copyRead(cfl, 0, offSmall, tiles * 8);
      copyRead(tileDoubt, 0, offSmall + tiles * 8, tiles * 4);
      if (!noLevels) copyRead(blockDoubt, 0, offSmall + tiles * 12, stride * rows * 4);
      if (!noLevels) copyRead(levels, 0, offLevels, levelsBytes);
      return async () => {
      let mappedRange = null;
      try {
        if (batch?.stageList) {
          try { idle?.(); } catch {}
          await batch.mapped;
          mappedRange = batch.readBuf.getMappedRange(baseOff, totalRead);
        } else {
          const mapped = gpuMap(device, readBuf, 0, totalRead);
          try { idle?.(); } catch {}
          await mapped;
          mappedRange = readBuf.getMappedRange(0, totalRead);
        }
        await after?.();
        let auditWorst = 0;
        if (auditBytes) {
          const got = new Float32Array(mappedRange, offAudit, auditBytes / 4);
          audited.forEach((b, k) => {
            const sums = gcBlockSums(lib, data, width, height, options, b % stride, Math.floor(b / stride));
            for (let i = 0; i < 192; i++) {
              const at = (k * 192 + i) * 2, error = Math.abs(got[at] + got[at + 1] - sums[i]);
              auditWorst = Math.max(auditWorst, Number.isNaN(error) ? Infinity : error / bound);
            }
          });
          if (!(auditWorst <= 1)) throw new GpuCoreAuditError(`GpuCore audit: ${auditWorst} > 1`);
        }
        if (!noLevels) {
          const all = new Int16Array(mappedRange, offLevels, n64 * 3);
          for (let c = 0; c < 3; c++) image.components[c].coeffs.set(all.subarray(c * n64, (c + 1) * n64));
        }
        const cf = new Int32Array(mappedRange, offSmall, tiles * 2), td = new Uint32Array(mappedRange, offSmall + tiles * 8, tiles), bd = noLevels ? null : new Uint32Array(mappedRange, offSmall + tiles * 12, stride * rows);
        if (!noLevels) for (let b = 0; b < bd.length; b++) for (let c = 0; c < 3; c++) image.nonZero[c][b] = (bd[b] >>> (c * 8)) & 255;
        for (let k = 0; k < tiles; k++) { image.cfl.x[k] = cf[k * 2]; image.cfl.b[k] = cf[k * 2 + 1]; }
        let doubtfulTiles = 0, doubtfulBlocks = 0;
        const tileDone = new Uint8Array(tiles);
        for (let k = 0; k < tiles; k++) if (td[k]) { gcExactTile(lib, data, width, height, image, thresholds, options, k % tilesX, Math.floor(k / tilesX)); tileDone[k] = 1; doubtfulTiles++; }
        if (!noLevels) for (let b = 0; b < stride * rows; b++) if (bd[b] & 16777216) {
          const bx = b % stride, by = Math.floor(b / stride);
          if (tileDone[(by >> 3) * tilesX + (bx >> 3)]) continue;
          gcExactBlock(lib, data, width, height, image, thresholds, options, bx, by); doubtfulBlocks++;
        }
        return {image, doubtfulBlocks, doubtfulTiles, blocks: stride * rows, tiles, auditBlocks: audited.length, auditWorst};
      } finally {
        if (!batch?.stageList && mappedRange) readBuf.unmap();
      }
      };
  };
  if (batch) return record(batch.encoder);
  try {
    return await gpuScoped(device, 'GpuCore', async seal => {
      const encoder = device.createCommandEncoder(), finish = record(encoder);
      device.queue.submit([encoder.finish()]);
      seal();
      return finish();
    });
  } finally { gpuDestroy(made); }
}

const GC_BATCH_BYTES = 256 << 20;

async function gcEnsureKernels(device, pipelines, options) {
  if (!options?.noLevels && !pipelines.quant)
    Object.assign(pipelines, await gpuAutoSet(device, 'core', GC_SHADER, [['quant', GC_WG]]));
}

async function gcImage(device, lib, pipelines, checkAudit, data, width, height, quality, options, extra) {
  await gcEnsureKernels(device, pipelines, options);
  const {idle, band} = typeof extra === 'function' ? {idle: extra} : extra ?? {};
  if (width * height <= 2097152 || height <= 512) return gcImageBand(device, lib, pipelines, checkAudit, data, width, height, quality, options, idle, undefined, band, {y: 0, from: 0, to: height});
  const image = gcTemplate(lib, data, width, height, quality, options), stride = image.components[0].stride;
  let doubtfulBlocks = 0, doubtfulTiles = 0, blocks = 0, tiles = 0, auditBlocks = 0, auditWorst = 0;
  const pool = new Map();
  pool.rows = Math.min(height, 640);
  const merge = (part, {y, from, coreHeight}) => {
    const first = (y - from) / 8 * stride, count = Math.ceil(coreHeight / 8) * stride, at = y / 8 * stride;
    if (!options.noLevels) for (let c = 0; c < 3; c++) {
      image.components[c].coeffs.set(part.image.components[c].coeffs.subarray(first * 64, (first + count) * 64), at * 64);
      image.nonZero[c].set(part.image.nonZero[c].subarray(first, first + count), at);
    }
    const firstTile = (y - from) / 64 * image.cfl.width, tileCount = Math.ceil(coreHeight / 64) * image.cfl.width, atTile = y / 64 * image.cfl.width;
    for (const c of ['x', 'b']) image.cfl[c].set(part.image.cfl[c].subarray(firstTile, firstTile + tileCount), atTile);
    doubtfulBlocks += part.doubtfulBlocks; doubtfulTiles += part.doubtfulTiles; blocks += part.blocks; tiles += part.tiles;
    auditBlocks += part.auditBlocks ?? 0; auditWorst = Math.max(auditWorst, part.auditWorst ?? 0);
  };
  const geoms = [];
  for (let y = 0; y < height; y += 512) {
    const coreHeight = Math.min(512, height - y), from = Math.max(0, y - 64), to = Math.min(height, y + coreHeight + 64);
    geoms.push({y, from, to, coreHeight, bytes: width * (to - from) * 4 + Math.ceil(width / 8) * 8 * Math.ceil((to - from) / 8) * 8 * 6});
  }
  const groups = [];
  for (const g of geoms) {
    const last = groups.at(-1);
    if (last && last.bytes + g.bytes <= GC_BATCH_BYTES) { last.list.push(g); last.bytes += g.bytes; } else groups.push({list: [g], bytes: g.bytes});
  }
  try {
    for (const {list} of groups) {
      const made = [];
      try {
        await gpuScoped(device, 'GpuCore', async seal => {
          const encoder = device.createCommandEncoder(), batch = {encoder, made, stageList: [], stageBytes: 0, copies: [], readBuf: null, mapped: null}, finishes = [];
          for (const g of list) finishes.push(await gcImageBand(device, lib, pipelines, checkAudit, data.subarray(g.from * width * 4, g.to * width * 4), width, g.to - g.from, quality, options, g.y ? undefined : idle, pool, band, {y: g.y, from: g.from, to: g.to}, batch));
          batch.readBuf = gpuAlloc(device, made)(Math.max(16, batch.stageBytes), GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
          for (const [src, so, dstOff, sz] of batch.copies) encoder.copyBufferToBuffer(src, so, batch.readBuf, dstOff, sz);
          device.queue.submit([encoder.finish()]);
          seal();
          batch.mapped = gpuMap(device, batch.readBuf, 0, batch.stageBytes);
          try {
            for (let k = 0; k < list.length; k++) merge(await finishes[k](), list[k]);
          } finally {
            await batch.mapped.catch(() => {});
            try { batch.readBuf.unmap(); } catch {}
          }
        });
      } finally { gpuDestroy(made); }
    }
  } finally { for (const b of pool.values()) b.destroy(); }
  return {image, doubtfulBlocks, doubtfulTiles, blocks, tiles, auditBlocks, auditWorst};
}

export class GpuCore {
  static async create(device, lib) {
    const self = new GpuCore();
    self.device = device; self.lib = lib; self.pipelines = await gpuAutoSet(device, 'core', GC_SHADER, GC_BASE_ENTRIES);
    return self;
  }
  image(data, width, height, quality, options, extra) { return gcImage(this.device, this.lib, this.pipelines, this.audit, data, width, height, quality, options, extra); }
  encodePlanes(encoder, buffer, data, width, height, y0, y1, options) { return gcEncodePlanes(this.device, this.lib, this.pipelines, encoder, buffer, data, width, height, y0, y1, options); }
}

const gcCores = new WeakMap();
const gcSettled = new WeakMap();
const gcPhoneReady = new WeakMap();
const SLOW_READ_MS = 400;
const PROBE_DESKTOP_MS = 25, PROBE_SLOW_MS = 220;

async function verifyPhoneCells(device, probeMs) {
  await gpuS2CellsPipelines(device);
  const ref16 = new Uint8Array(16 * 16 * 4), dec16 = new Uint8Array(16 * 16 * 4);
  for (let i = 0; i < ref16.length; i++) {
    ref16[i] = (i & 3) === 3 ? 255 : (i * 29 + (i >> 4) * 53) & 255;
    dec16[i] = (i & 3) === 3 ? 255 : (ref16[i] ^ ((i * 7) & 31));
  }
  const t0 = performance.now();
  const got = await gpuS2Cells(device, {reference: ref16, decoded: dec16, width: 16, height: 16});
  const dt = performance.now() - t0;
  if (!got || dt > Math.max(260, probeMs * 3.5)) return false;
  const exp = s2CellSums({rgba: ref16}, {rgba: dec16}, 16, 16);
  if (got.scales.length !== exp.scales.length) return false;
  for (let s = 0; s < exp.scales.length; s++) {
    const gs = got.scales[s].sums, es = exp.scales[s].sums;
    if (gs.length !== es.length) return false;
    for (let k = 0; k < es.length; k++) {
      const a = gs[k].sum, b = es[k].sum;
      if (!a || a.length !== b.length) return false;
      for (let j = 0; j < b.length; j++) if (a[j] !== b[j]) return false;
    }
  }
  return true;
}

export function gpuCorePrewarmCells(device) {
  Promise.resolve().then(() => gpuS2CellsPipelines(device)).catch(() => {});
}

export async function gpuCoreDefaultReady(device, effort = 9) {
  const probed = await gpuDeviceProbe(device);
  if (!probed.ok) return {ok: false, phone: false, ready: Promise.resolve(false)};
  if (tracing()) traced('probe:readMs', probed.ms);
  if (!probed.synthetic && probed.ms > PROBE_SLOW_MS) {
    if (tracing()) traced('device:slow-probe', probed.ms);
    return {ok: false, phone: false, ready: Promise.resolve(false)};
  }
  if (!probed.synthetic && probed.ms > PROBE_DESKTOP_MS) {
    let perMB = 0;
    try { const bulk = await gpuBulkProbe(device); if (bulk.ok && !bulk.synthetic) perMB = Math.max(0, bulk.ms - probed.ms) / (PROBE_BULK_BYTES / 1048576); } catch {}
    return {ok: true, phone: true, ready: Promise.resolve(false), floorMs: probed.ms, perMB};
  }
  const ok = await gpuCoreReady(device, effort);
  if (!ok) return {ok: false, phone: false, ready: Promise.resolve(false)};
  const settled = gpuCoreSettled(device, effort).then(fine => fine !== false, () => false);
  return {ok: true, phone: false, ready: settled};
}
function gcReady(device) {
  gpuCheck(device);
  let ready = gcCores.get(device);
  const later = start => Promise.resolve().then(start);
  if (!ready) {
    const coreReady = Promise.all([later(() => gpuCoreQualified(device)), later(() => GpuCore.create(device, null))]);
    gcCores.set(device, ready = coreReady.then(([ok, core]) => ok ? core : null, () => {
      if (gcCores.get(device) === ready) gcCores.delete(device);
      return null;
    }));
  }
  return ready;
}
export async function gpuCoreReady(device, effort = 9) { void effort; return !!await gcReady(device); }
function gcStart(device, core) {
  if (gcSettled.has(device)) return;
  const later = start => Promise.resolve().then(start).catch(() => null);
  const base = [
    later(() => gcEnsureKernels(device, core.pipelines, {gaborish: {iterations: 2, boost: 1.5}, noLevels: true})),
    later(() => gpuRebuildPipelines(device)),
    later(() => gpuBlocksPipelines?.(device, GC_DS)),
    later(() => gpuBlocksLevelsPipelines?.(device, GC_DS, [[8, 8]])),
    later(() => gpuS2CellsPipelines(device)),
  ];
  gcSettled.set(device, {all: Promise.all(base).then(() => {})});
}
export function gpuCorePrewarm(device) {
  gcReady(device).then(core => { if (core) gcStart(device, core); }, () => {});
}
export async function gpuCoreSettled(device, effort = 9) {
  const core = await gcReady(device);
  if (!core) return;
  if (tracing()) traced('qualify:readMs', gpuCoreReadMs(device));
  if (gpuCoreReadMs(device) > SLOW_READ_MS) { if (tracing()) traced('device:slow-readback', 0); return false; }
  gcStart(device, core);
  const st = gcSettled.get(device);
  void effort;
  await st.all;
  return true;
}

const gcChains = new WeakMap();
export function gpuCoreImage(device, request, strict = false, signal) {
  if (signal) request = Object.assign(Object.defineProperties({}, Object.getOwnPropertyDescriptors(request)), {signal});
  if (request?.kind === 'ma-nodes') return gcAnswer(device, request, strict);
  const answer = (gcChains.get(device) ?? Promise.resolve()).then(() => signal?.aborted ? null : gcAnswer(device, request, strict));
  gcChains.set(device, answer.then(() => {}, () => {}));
  return answer;
}
async function gcAnswer(device, request, strict) {
  try {
    gpuCheck(device);
    if (request.kind === 'ma-nodes') return (typeof __RAPIER_JXL_TEN_DEVICE__ === 'undefined' || __RAPIER_JXL_TEN_DEVICE__ === true) ? await gpuTrees(device, request) : null;
    if (request.kind === 's2-cells') {
      if (strict) {
        const probed = await gpuDeviceProbe(device);
        if (!probed.ok) throw fault('JXL_WEBGPU', 'device probe failed');
      }
      if (request.signal?.aborted) return null;
      const sums = await gpuS2Cells(device, request);
      if (!sums && strict) throw fault('JXL_WEBGPU', 's2-cells unavailable');
      return sums;
    }
    if (strict) {
      const probed = await gpuDeviceProbe(device);
      if (!probed.ok) throw fault('JXL_WEBGPU', 'device probe failed');
    }
    const core = await gcReady(device, 7);
    if (request.signal?.aborted) return null;
    if (!core) throw fault('JXL_WEBGPU', 'device unqualified');
    if (request.lib) core.lib = request.lib;
    if (request.height === 1 && request.options?.gaborish) return null;
    if (request.kind === 'blocks16' || request.kind === 'blocks' || request.kind === 'blocks-levels' || request.kind === 'blocks16-levels') await gcEnsureKernels(device, core.pipelines, {...request.options, noLevels: true});
    if (request.kind === 'blocks16') {
      const asked = {...request, planeBound: B.plane}, mask = request.weight ? null : await gpuBlocks16Mask(device, asked, GC_DS, core);
      return await gpuBlocksCosts(device, {...asked, ...mask, ids: [4]}, GC_DS, core);
    }
    if (request.kind === 'blocks') return await gpuBlocksCosts(device, {...request, planeBound: B.plane}, GC_DS, core);
    if (request.kind === 'blocks-levels' || request.kind === 'blocks16-levels') return await gpuBlocksLevels(device, {...request, planeBound: B.plane}, GC_DS, core);
    if (request.kind === 'photo-block-costs' || request.kind === 'photo-block-levels') return await captureBlockRequest(strict ? 'required' : 'auto', request, request.signal);
    if (request.kind === 'photo-rebuild') {
      const pictures = await gpuRebuild(device, request.image, request);
      if (!pictures) return {cpu: true};
      const s2 = request.s2;
      if (s2 && !pictures.s2) pictures.s2 = await gpuS2Sums(device, s2.held, s2.tables, s2.reference, pictures.px ?? [pictures.rgba, pictures.native], s2.width, s2.height, request.signal);
      if (request.cells && !pictures.cells && pictures.px) pictures.cells = await gpuS2Cells(device, {...request.cells, decodedBuffer: pictures.px});
      if (pictures.band) pictures.band = await pictures.band;
      return pictures;
    }
    if (request.kind === 's2-cells') return await gpuS2Cells(device, request);
    if (request.kind === 'audit-failed') throw new GpuCoreAuditError('gpu-blocks16 audit');
    if (!gcGabPlan(request.options)) return null;
    const energy = request.energy ? await gpuBlocks16EnergyHook(device, GC_DS, request.width, request.height, B.plane) : null;
    const {image, auditBlocks, auditWorst} = await gcImage(device, core.lib, core.pipelines, undefined, request.data, request.width, request.height, request.quality, request.options, {idle: request.idle, band: energy?.band ?? request.band});
    if (energy) image.maskEnergy = energy.result();
    if (request.audit) image.gpuAudit = {blocks: auditBlocks, worst: auditWorst};
    return image;
  } catch (error) {
    if (error instanceof GpuCoreAuditError) gcCores.set(device, Promise.resolve(null));
    if (strict) throw error;
    return null;
  }
}

export const gpuCoreDevice = gpuDevice;
