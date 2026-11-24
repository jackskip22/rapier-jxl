// SPDX-License-Identifier: MIT
import {gpuWait, gpuCached, gpuDestroy, gpuScoped, gpuUpload, gpuUni, gpuStep, gpuRead} from './gpu-kit.mjs';
import {GC_DS, GC_DS_BASE} from './gpu-arithmetic.mjs';
import {B16_BOUNDS, b16Open, b16Sum, b16F as bkF, b16Split as bkSplit, b16Splits as bkSplits} from './gpu-blocks16.mjs';
import {maskDoubtOver} from './photo-mask.mjs';

const bTr = (w, h) => ((3 * (w + h) + 20) * B16_BOUNDS.u2 + (w + h + 2) * B16_BOUNDS.u64) * 2 / (w * h);

const BK_OUT = 6;
const BK_DOUBT = 2130706432;

const K_ONE = 0, K_DEAD = 3, K_NORM = 9, K_RC = 12, K_DETAIL = 16, K_DC_INV = 17, K_SMALL = 20;
const K_RECON = 20, K_LOG2 = 4116, K_COSTS_BASIS = 8212;

const bkShader = ds =>  `
struct P {
  W: u32, stride: u32, rows: u32, cflW: u32,
  count: u32, originsX: u32, by0: u32, top: u32,
  hasDead: u32, oTile: u32, groupsX: u32, oOut: u32,
  oZone: u32, wb: u32, hb: u32, z0: u32,
  one: f32, plane: f32, tr: f32, sumB: f32,
}
@group(0) @binding(0) var<uniform> p: P;
fn gcOne() -> f32 { return p.one; }
@group(0) @binding(1) var<storage, read> plX: array<vec2f>;
@group(0) @binding(2) var<storage, read> plY: array<vec2f>;
@group(0) @binding(3) var<storage, read> plB: array<vec2f>;
@group(0) @binding(4) var<storage, read> K: array<vec2f>;
@group(0) @binding(5) var<storage, read> T: array<u32>;
@group(0) @binding(6) var<storage, read> blk: array<vec2f>;
@group(0) @binding(7) var<storage, read_write> co: array<vec2f>;
@group(0) @binding(8) var<storage, read_write> outC: array<f32>;
@group(0) @binding(8) var<storage, read_write> outL: array<i32>;
${ds === GC_DS ? GC_DS_BASE : ds}
fn pixel(c: u32, i: u32) -> vec2f { if (c == 0u) { return plX[i]; } if (c == 1u) { return plY[i]; } return plB[i]; }
const U2 = ${bkF(B16_BOUNDS.u2)};
const REL = ${bkF(B16_BOUNDS.rel)};
const SAFE = ${bkF(B16_BOUNDS.safety)};
var<workgroup> tm: array<vec2f, 1024>;
var<workgroup> pe: array<f32, 64>;
var<workgroup> mag: array<f32, 3>;
var<workgroup> pd: array<vec2f, 64>;
var<workgroup> pr: array<vec2f, 64>;
var<workgroup> pn: array<u32, 64>;
var<workgroup> plast: array<u32, 64>;
var<workgroup> pf: array<u32, 64>;
var<workgroup> accD: vec2f;
var<workgroup> accR: vec2f;
var<workgroup> accE: f32;
var<workgroup> accF: u32;
var<workgroup> doubt: atomic<u32>;

// The costs of one shape (w x h pixels), one workgroup of 64 a block at origins every bw, bh blocks. Each channel (Y
// first): the rows into tm, the columns into co (the CPU's layout: tall and square blocks u h + v, wide ones
// v w + u), then each position past the block's DC, in scan order, as full() quantizes and prices it (gpu-blocks16.mjs
// level), a contiguous run of the scan a thread.
fn dctChannel(c: u32, bx: u32, by: u32, oBasis: u32, o: u32, lid: u32) {
  let WB = p.wb; let HB = p.hb; let SIZE = WB * HB; let oBH = oBasis + WB * WB;
  workgroupBarrier();
  var m = 0.0;
  for (var i = lid; i < SIZE; i += 64u) {
    let y = i / WB; let u = i % WB; let row = (by * 8u + y - p.top) * p.W + bx * 8u;
    var s = vec2f(0.0, 0.0);
    for (var x = 0u; x < WB; x++) { s = dadd(s, dmul(pixel(c, row + x), K[oBasis + u * WB + x])); }
    tm[y * WB + u] = s;
    m += abs(pixel(c, row + u).x);
  }
  pe[lid] = m;
  workgroupBarrier();
  for (var step = 32u; step > 0u; step >>= 1u) {
    if (lid < step) { pe[lid] += pe[lid + step]; }
    workgroupBarrier();
  }
  if (lid == 0u) { mag[c] = pe[0] * 1.001; }
  let tall = HB >= WB;
  for (var i = lid; i < SIZE; i += 64u) {
    let u = i % WB; let v = i / WB; var s = vec2f(0.0, 0.0);
    for (var y = 0u; y < HB; y++) { s = dadd(s, dmul(tm[y * WB + u], K[oBH + v * HB + y])); }
    co[o + select(v * WB + u, u * HB + v, tall)] = s;
  }
  storageBarrier();
  workgroupBarrier();
}

struct Q { d: vec2f, rl: vec2f, e: f32, flag: u32, q: u32 }

fn costLevel(c: u32, tr: vec2f, luma: vec2f, invStep: vec2f, stepUnit: vec2f, high: u32, fc: vec2f, bt: f32, btY: f32, fine: vec2f, invFine: vec2f) -> Q {
  var coefficient = tr;
  var bc = bt;
  if (c != 1u) { let s = dmul(fc, luma); coefficient = dsub(tr, s); bc = bt + abs(fc.x) * btY + 16.0 * U2 * (abs(tr.x) + abs(s.x)); }
  let v = dmul(dmul(coefficient, invStep), fine);
  let a = dabs(v);
  let scale = invStep.x * fine.x;
  let ba = SAFE * (bc * scale + REL * a.x) + 1e-30;
  var thr = vec2f(0.5, 0.0);
  if (p.hasDead == 1u) { thr = K[${K_DEAD}u + c * 2u + high]; }
  var flag = 0u;
  let below = dsub(a, thr).x;
  if (abs(below) <= ba) { flag = 1u; }
  var q = 0.0;
  if (below >= 0.0) { let r = dround(a, vec2f(0.5, 0.0), ba); q = r.x; if (r.y != 0.0) { flag = 1u; } }
  if (q >= 4096.0) { flag = 1u; q = 4095.0; }
  let qi = u32(q);
  var recon = vec2f(0.0, 0.0);
  if (qi == 1u) { recon = K[${K_ONE}u + c]; } else if (qi > 1u) { recon = K[${K_RECON}u + qi]; }
  let e = dmul(dmul(dsub(a, recon), stepUnit), invFine);
  var wq = vec2f(1.0, 0.0);
  if (qi == 0u) { wq = K[${K_DETAIL}u]; }
  let s = stepUnit.x * invFine.x;
  let de = ba * s + SAFE * REL * (abs(e.x) + (a.x + recon.x) * s);
  var rl = vec2f(0.0, 0.0);
  if (qi > 1u) { rl = K[${K_LOG2}u + qi]; }
  return Q(dmul(dmul(e, e), wq), rl, wq.x * (2.0 * abs(e.x) * de + de * de), flag, qi);
}

@compute @workgroup_size(64)
fn costs(@builtin(workgroup_id) g: vec3u, @builtin(local_invocation_index) lid: u32) {
  let index = g.y * p.groupsX + g.x;
  if (index >= p.count) { return; }
  let WB = p.wb; let HB = p.hb; let SIZE = WB * HB;
  let bw = WB >> 3u; let bh = HB >> 3u; let AREA = bw * bh; let CHUNK = (SIZE + 63u) >> 6u;
  let bx = (index % p.originsX) * bw;
  let by = p.by0 + (index / p.originsX) * bh;
  let at = (p.oOut + index) * ${BK_OUT}u;
  if (bx + bw > p.stride || by + bh > p.rows) {
    if (lid == 0u) { for (var j = 0u; j < ${BK_OUT}u; j++) { outC[at + j] = 0.0; } outC[at + 5u] = 2.0; }
    return;
  }
  let slot = index * 2u * SIZE;
  let ti = (by >> 3u) * p.cflW + (bx >> 3u);
  let cell = (by * p.stride + bx) * 3u;
  let fine = blk[cell]; let invFine = blk[cell + 1u];
  let oSteps = ${K_COSTS_BASIS}u + WB * WB + HB * HB;
  let oUnits = oSteps + 3u * SIZE;
  let oMw = oUnits + 3u * SIZE;
  if (lid == 0u) { accD = vec2f(0.0, 0.0); accR = vec2f(0.0, 0.0); accE = 0.0; accF = 0u; }
  for (var ci = p.z0; ci < 3u; ci++) {
    let c = select(select(2u, 0u, ci == 1u), 1u, ci == 0u);
    let o = slot + select(SIZE, 0u, c == 1u);
    dctChannel(c, bx, by, ${K_COSTS_BASIS}u, o, lid);
    let bt = p.tr * mag[c] + 2.0 * p.plane; let btY = p.tr * mag[1] + 2.0 * p.plane;
    var fc = vec2f(0.0, 0.0);
    if (c == 0u) { fc = blk[p.oTile + ti * 2u]; } else if (c == 2u) { fc = blk[p.oTile + ti * 2u + 1u]; }
    var d = vec2f(0.0, 0.0); var rl = vec2f(0.0, 0.0); var n = 0u; var last = 0u; var e = 0.0; var f = 0u;
    for (var j = 0u; j < CHUNK; j++) {
      let k = lid * CHUNK + j;
      if (k >= SIZE) { break; }
      if (k < AREA) { continue; }
      let pos = T[k]; let idx = c * SIZE + pos;
      let x = costLevel(c, co[o + pos], co[slot + pos], K[oSteps + idx], K[oUnits + idx], T[SIZE + pos], fc, bt, btY, fine, invFine);
      d = dadd(d, x.d); rl = dadd(rl, x.rl); e += x.e; f |= x.flag;
      if (x.q != 0u) { n += 1u; last = k + 1u; }
    }
    pd[lid] = d; pr[lid] = rl; pn[lid] = n; plast[lid] = last; pe[lid] = e; pf[lid] = f;
    workgroupBarrier();
    for (var step = 32u; step > 0u; step >>= 1u) {
      if (lid < step) {
        pd[lid] = dadd(pd[lid], pd[lid + step]);
        pr[lid] = dadd(pr[lid], pr[lid + step]);
        pn[lid] += pn[lid + step];
        plast[lid] = max(plast[lid], plast[lid + step]);
        pe[lid] += pe[lid + step];
        pf[lid] |= pf[lid + step];
      }
      workgroupBarrier();
    }
    if (lid == 0u) {
      let sd = pd[0]; let srl = pr[0]; let sn = pn[0]; let slast = plast[0]; let se = pe[0]; let sf = pf[0];
      var zeros = 0u;
      if (sn > 0u) { zeros = slast - AREA - sn; }
      let scale = dmul(K[${K_NORM}u + c], K[oMw + p.oOut + index]) * f32(SIZE);
      // D += norm d w h blockMW; R += rc0 + rc3 zeros.
      accD = dadd(accD, dmul(sd, scale));
      let rate = dadd(K[${K_RC}u], dadd(dmul(K[${K_RC}u + 1u], vec2f(f32(sn), 0.0)), dadd(dmul(K[${K_RC}u + 2u], srl), dmul(K[${K_RC}u + 3u], vec2f(f32(zeros), 0.0)))));
      accR = dadd(accR, rate);
      accE += SAFE * scale.x * se * 1.01;
      accF |= sf;
    }
  }
  workgroupBarrier();
  if (lid == 0u) {
    outC[at] = accD.x; outC[at + 1u] = accD.y; outC[at + 2u] = accR.x; outC[at + 3u] = accR.y;
    outC[at + 4u] = accE + p.sumB * abs(accD.x) + ${bkF(B16_BOUNDS.floor)};
    outC[at + 5u] = f32(accF);
  }
}

@compute @workgroup_size(64)
fn levels(@builtin(workgroup_id) g: vec3u, @builtin(local_invocation_index) lid: u32) {
  let index = g.y * p.groupsX + g.x;
  if (index >= p.count) { return; }
  let WB = p.wb; let HB = p.hb; let SIZE = WB * HB;
  let bw = WB >> 3u; let bh = HB >> 3u; let AREA = bw * bh; let lg = max(bw, bh);
  let SLOT = 3u * SIZE + 3u * AREA + 1u;
  let bx = T[2u * SIZE + index * 2u]; let by = T[2u * SIZE + index * 2u + 1u];
  let slot = index * SLOT; let own = index * 2u * SIZE;
  let ti = (by >> 3u) * p.cflW + (bx >> 3u);
  let cell = (by * p.stride + bx) * 3u;
  let fine = blk[cell];
  let zi = u32(blk[cell + 2u].x);
  let oSteps = ${K_SMALL}u + WB * WB + HB * HB;
  let oLowM = oSteps + 3u * SIZE;
  if (lid == 0u) { atomicStore(&doubt, 0u); }
  for (var ci = p.z0; ci < 3u; ci++) {
    let c = select(select(2u, 0u, ci == 1u), 1u, ci == 0u);
    let o = own + select(SIZE, 0u, c == 1u);
    dctChannel(c, bx, by, ${K_SMALL}u, o, lid);
    let bt = p.tr * mag[c] + 2.0 * p.plane; let btY = p.tr * mag[1] + 2.0 * p.plane;
    if (lid < AREA) {
      var v = vec2f(0.0, 0.0); var sum = 0.0; var weight = 0.0;
      for (var j = 0u; j < AREA; j++) {
        let mj = K[oLowM + lid * AREA + j]; let t = dmul(co[o + (j / lg) * (lg * 8u) + j % lg], mj);
        v = dadd(v, t); sum += abs(t.x); weight += abs(mj.x);
      }
      // DC: the raw coefficients' low frequencies, in levels of the channel's DC step.
      let invDc = K[${K_DC_INV}u + c];
      let dcv = dmul(v, invDc);
      let e = SAFE * ((bt * weight + REL * sum) * invDc.x + REL * abs(dcv.x)) + 1e-30;
      let r = dround(dcv, vec2f(0.5, 0.0), e);
      var q = i32(r.x);
      if (r.y != 0.0 || abs(r.x) > 1e9) { q = ${BK_DOUBT}; atomicOr(&doubt, 1u); }
      outL[slot + 3u * SIZE + c * AREA + lid] = q;
    }
    var fc = vec2f(0.0, 0.0);
    if (c == 0u) { fc = blk[p.oTile + ti * 2u]; } else if (c == 2u) { fc = blk[p.oTile + ti * 2u + 1u]; }
    for (var k = lid; k < SIZE; k += 64u) {
      let pos = T[k];
      if (k < AREA) { outL[slot + c * SIZE + pos] = 0; continue; }
      let luma = co[own + pos];
      var coefficient = luma; var bc = bt;
      if (c != 1u) { let tr = co[o + pos]; let s = dmul(fc, luma); coefficient = dsub(tr, s); bc = bt + abs(fc.x) * btY + 16.0 * U2 * (abs(tr.x) + abs(s.x)); }
      let invStep = K[oSteps + c * SIZE + pos];
      let v = dmul(dmul(coefficient, invStep), fine);
      let a = dabs(v);
      let ba = SAFE * (bc * invStep.x * fine.x + REL * a.x) + 1e-30;
      var thr = vec2f(0.5, 0.0);
      if (p.oZone != 0u) { thr = blk[p.oZone + zi * 6u + c * 2u + T[SIZE + pos]]; }
      else if (p.hasDead == 1u) { thr = K[${K_DEAD}u + c * 2u + T[SIZE + pos]]; }
      let bthr = select(0.0, SAFE * U2 * abs(thr.x), p.oZone != 0u);
      let below = dsub(a, thr).x;
      var q = 0;
      var unsure = abs(below) <= ba + bthr;
      if (below >= 0.0) { let r = dround(a, vec2f(0.5, 0.0), ba); q = i32(r.x); if (r.y != 0.0 || r.x > 1e9) { unsure = true; } }
      if (v.x < 0.0) { q = -q; }
      if (unsure) { q = ${BK_DOUBT}; atomicOr(&doubt, 1u); } else if (q < -32768 || q > 32767) { atomicOr(&doubt, 2u); }
      outL[slot + c * SIZE + pos] = q;
    }
  }
  workgroupBarrier();
  if (lid == 0u) { outL[slot + SLOT - 1u] = i32(atomicLoad(&doubt)); }
}`;

function bkSmallHeader(input, search, out) {
  bkSplits(input.one, out, K_ONE * 2);
  if (input.dead) bkSplits(input.dead, out, K_DEAD * 2);
  bkSplits(input.norm, out, K_NORM * 2);
  bkSplits(search.rate ?? [4, 3, 2, 0.6], out, K_RC * 2);
  bkSplit(search.detailWeight ?? 1.25, out, K_DETAIL * 2);
  for (let c = 0; c < 3; c++) bkSplit(8 / input.dcSteps[c], out, (K_DC_INV + c) * 2);
}

function bkCostsPrefix(input, search) {
  const prefix = new Float32Array(K_COSTS_BASIS * 2);
  bkSmallHeader(input, search, prefix);
  bkSplits(input.recon, prefix, K_RECON * 2);
  const log2 = input.log2.slice(); log2[0] = 0;
  bkSplits(log2, prefix, K_LOG2 * 2);
  return prefix;
}

function bkCostsTables(prefix, input, scaledDCTBases, id, mw) {
  const t = input.transforms.get(id), {w, h} = t, size = w * h;
  const oBH = K_COSTS_BASIS + w * w, oSteps = oBH + h * h, oUnits = oSteps + 3 * size, oMw = oUnits + 3 * size;
  const K = new Float32Array(oMw * 2 + mw.length);
  K.set(prefix, 0);
  K.set(mw, oMw * 2);
  bkSplits(scaledDCTBases(w).basis, K, K_COSTS_BASIS * 2);
  bkSplits(scaledDCTBases(h).basis, K, oBH * 2);
  for (let c = 0; c < 3; c++) {
    const steps = t.steps[c], baseS = (oSteps + c * size) * 2, baseU = (oUnits + c * size) * 2;
    for (let k = 0; k < size; k++) {
      const s = steps[k];
      bkSplit(2048 / s, K, baseS + k * 2);
      bkSplit(s / 2048, K, baseU + k * 2);
    }
  }
  const T = new Uint32Array(2 * size);
  T.set(t.order, 0); T.set(t.high, size);
  return {K, T};
}

function bkLevelsTables(small, input, scaledDCTBases, id, lowFrequencies) {
  const t = input.transforms.get(id), {w, h, bw, bh} = t, size = w * h, area = bw * bh, long = Math.max(bw, bh);
  const oBH = K_SMALL + w * w, oSteps = oBH + h * h, oLowM = oSteps + 3 * size;
  const K = new Float32Array((oLowM + area * area) * 2);
  K.set(small, 0);
  bkSplits(scaledDCTBases(w).basis, K, K_SMALL * 2);
  bkSplits(scaledDCTBases(h).basis, K, oBH * 2);
  for (let c = 0; c < 3; c++) {
    const steps = t.steps[c], baseS = (oSteps + c * size) * 2;
    for (let k = 0; k < size; k++) bkSplit(2048 / steps[k], K, baseS + k * 2);
  }
  if (area === 1) bkSplit(1, K, oLowM * 2);
  else if (lowFrequencies) for (let j = 0; j < area; j++) {
    const e = new Float64Array(size); e[Math.floor(j / long) * long * 8 + j % long] = 1;
    const dc = lowFrequencies(e, bw, bh);
    for (let i = 0; i < area; i++) bkSplit(dc[i], K, (oLowM + i * area + j) * 2);
  }
  const T = new Uint32Array(2 * size);
  T.set(t.order, 0); T.set(t.high, size);
  return {K, T};
}

function bkBlockWeights(weight, stride, rows, bw, bh, originsX, originRows) {
  const mw = new Float32Array(originsX * originRows * 2), area = bw * bh;
  for (let oy = 0; oy < originRows; oy++) for (let ox = 0; ox < originsX; ox++) {
    const bx = ox * bw, by = oy * bh;
    if (bx + bw > stride || by + bh > rows) continue;
    let sum = 0, max = 0;
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) { const v = weight[(by + y) * stride + bx + x]; sum += v; if (v > max) max = v; }
    bkSplit(area === 1 ? sum : 0.70 * (sum / area) + 0.30 * max, mw, (oy * originsX + ox) * 2);
  }
  return mw;
}

const bkModules = new WeakMap(), bkBuilt = new WeakMap();
const bkModule = (device, ds) => gpuCached(bkModules, device, ds === GC_DS ? 'std' : ds, () => Promise.resolve(device.createShaderModule({code: bkShader(ds)})));
const bkEntry = (device, ds, entryPoint, label) => gpuCached(bkBuilt, device, (ds === GC_DS ? 'std:' : ds + ':') + entryPoint, () =>
  bkModule(device, ds).then(module => gpuWait(device, device.createComputePipelineAsync({label, layout: 'auto', compute: {module, entryPoint}}))).then(p => [p, 1]));

const bkCostsPipeline = (device, ds) => bkEntry(device, ds, 'costs', 'rapier-jxl:block-costs');
const bkLevelsPipeline = (device, ds) => bkEntry(device, ds, 'levels', 'rapier-jxl:block-levels');

export const gpuBlocksPipelines = (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) ? null : (device, ds) => bkCostsPipeline(device, ds);
export const gpuBlocksLevelsPipelines = (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) ? null : (device, ds) => bkLevelsPipeline(device, ds);

export const gpuBlocksStats = {costs: 0, flagged: 0, costsMs: 0, levels: 0, doubtful: 0, levelsMs: 0};

const BK_BATCH_BYTES = 128 << 20;

export async function gpuBlocksCosts(device, request, ds, core) {
  const started = performance.now();
  const [W, stride, rows, , bandCells, oTile, blk, planeBound, alloc, made, openBand] = b16Open(device, request, core, request.weight);
  try {
    return await gpuScoped(device, 'gpuBlocksCosts', async () => {
      const {input, search, scaledDCTBases} = request, weightDoubt = request.weightDoubt || 0;
      const ids = [...new Set([0, ...request.ids])].filter(id => input.transforms.has(id));
      const regionRows = Math.ceil(rows / 4), bandRegions = Math.max(1, Math.floor(bandCells / 2));
      const pipeline = await bkCostsPipeline(device, ds), prefix = bkCostsPrefix(input, search);
      const shapes = ids.map(id => {
        const t = input.transforms.get(id), {w, h, bw, bh} = t, oxN = Math.ceil(stride / bw), oyTotal = Math.ceil(rows / bh);
        const mw = bkBlockWeights(request.weight, stride, rows, bw, bh, oxN, oyTotal), {K, T} = bkCostsTables(prefix, input, scaledDCTBases, id, mw);
        return [id, w, h, bw, bh, oxN, oyTotal, gpuUpload(device, alloc, K), gpuUpload(device, alloc, T), alloc(oxN * oyTotal * BK_OUT * 4)];
      });
      let encoder = device.createCommandEncoder(), held = [], heldBytes = 0;
      const free = () => { for (const [co, release] of held) { co?.destroy(); release(); } held = []; heldBytes = 0; };
      for (let r0 = 0; r0 < regionRows; r0 += bandRegions) {
        const regions = Math.min(bandRegions, regionRows - r0), bytes = W * regions * 32 * 8 * 5;
        if (held.length && heldBytes + bytes > BK_BATCH_BYTES) { device.queue.submit([encoder.finish()]); free(); encoder = device.createCommandEncoder(); }
        const [planes, top, release] = openBand(encoder, r0 * 2, regions * 2);
        let maxCoBytes = 0;
        for (const [, w, h, , bh, oxN, oyTotal] of shapes) {
          const count = oxN * Math.min(oyTotal - r0 * 4 / bh, regions * 4 / bh);
          if (count > 0) maxCoBytes = Math.max(maxCoBytes, count * 2 * w * h * 8);
        }
        const co = maxCoBytes > 0 ? alloc(maxCoBytes, GPUBufferUsage.STORAGE) : null;
        for (const [, w, h, , bh, oxN, oyTotal, K, T, out] of shapes) {
          const oy0 = r0 * 4 / bh, count = oxN * Math.min(oyTotal - oy0, regions * 4 / bh);
          if (count <= 0) continue;
          const groupsX = Math.min(count, 65535);
          const u = gpuUni(device, alloc, [W, stride, rows, input.cfl.width, count, oxN, r0 * 4, top, input.dead ? 1 : 0, oTile, groupsX, oy0 * oxN, 0, w, h, 0],
            [[17, planeBound], [18, bTr(w, h)], [19, b16Sum(w * h)]], 16, 80);
          gpuStep(device, encoder, pipeline, [u, ...planes, K, T, blk, co, out], count);
        }
        held.push([co, release]); heldBytes += bytes + maxCoBytes;
      }
      const costs = Object.assign(new Map(), {certified: true});
      let flagged = 0;
      const read = await gpuRead(device, alloc, shapes.map(([, , , , , oxN, oyTotal, , , out]) => [out, 0, oxN * oyTotal * BK_OUT * 4]), encoder);
      free();
      shapes.forEach(([id, w, h, bw, bh, oxN, oyTotal], n) => {
        const o = new Float32Array(read[n]);
        const c = {D: new Float64Array(stride * rows).fill(NaN), R: new Float64Array(stride * rows).fill(NaN), De: new Float64Array(stride * rows).fill(NaN), Re: new Float64Array(stride * rows).fill(NaN)};
        for (let oy = 0; oy < oyTotal; oy++) for (let ox = 0; ox < oxN; ox++) {
          const bx = ox * bw, by = oy * bh;
          if (bx + bw > stride || by + bh > rows) continue;
          const at = (oy * oxN + ox) * BK_OUT, b = by * stride + bx, flag = o[at + 5];
          const D = o[at] + o[at + 1], R = o[at + 2] + o[at + 3], e = o[at + 4];
          const valid = (flag === 0 || flag === 1) && D >= 0 && R >= 0 && e >= 0 && Number.isFinite(D) && Number.isFinite(R) && Number.isFinite(e);
          if (!valid || flag === 1) { c.D[b] = 0; c.R[b] = 0; c.De[b] = Infinity; c.Re[b] = 0; flagged++; continue; }
          c.D[b] = D; c.R[b] = R; c.De[b] = e + maskDoubtOver(weightDoubt, stride, bx, by, bw, bh) * D; c.Re[b] = b16Sum(w * h) * R;
        }
        costs.set(id, c);
      });
      gpuBlocksStats.costs++; gpuBlocksStats.flagged += flagged; gpuBlocksStats.costsMs += performance.now() - started;
      return {costs, weight: request.weight, weightDoubt, flagged};
    });
  } finally { gpuDestroy(made); }
}

export async function gpuBlocksLevels(device, request, ds, core) {
  const started = performance.now();
  const [W, stride, rows, , bandCells, oTile, blk, planeBound, alloc, made, openBand, oZone] = b16Open(device, request, core);
  try {
    return await gpuScoped(device, 'gpuBlocksLevels', async () => {
      const {input, search, scaledDCTBases, lowFrequencies} = request;
      const regionRows = Math.ceil(rows / 4), bandRegions = Math.max(1, Math.floor(bandCells / 2)), bands = [];
      for (const b of request.layout) if (input.transforms.has(b.id)) ((bands[Math.floor((b.by >> 2) / bandRegions)] ||= new Map()).get(b.id) ?? bands[Math.floor((b.by >> 2) / bandRegions)].set(b.id, []).get(b.id)).push(b);
      const pipeline = await bkLevelsPipeline(device, ds);
      if (request.signal?.aborted) return null;
      const small = new Float32Array(K_SMALL * 2);
      bkSmallHeader(input, search, small);
      const shapes = new Map();
      for (const id of new Set(request.layout.map(b => b.id))) if (input.transforms.has(id)) {
        const t = input.transforms.get(id), {K, T} = bkLevelsTables(small, input, scaledDCTBases, id, lowFrequencies);
        shapes.set(id, [t, gpuUpload(device, alloc, K), T]);
      }
      const exact = new Map();
      let doubtful = 0;
      let encoder = null, batch = [], batchBytes = 0;
      const flush = async () => {
        if (!batch.length) return;
        const outs = batch.flatMap(b => b.outs), read = await gpuRead(device, alloc, outs.map(([out, list, , , slot]) => [out, 0, list.length * slot * 4]), encoder);
        outs.forEach(([out, list, size, area, slot], n) => {
          const all = new Int32Array(read[n]);
          out.destroy();
          list.forEach((b, i) => {
            const o = i * slot, flags = all[o + slot - 1], uncertain = (flags & 1) !== 0, d0 = o + 3 * size;
            if (uncertain) doubtful++;
            exact.set(b.id * 16777216 + b.by * stride + b.bx, {coeffs: [all.subarray(o, o + size), all.subarray(o + size, o + 2 * size), all.subarray(o + 2 * size, o + 3 * size)],
              dc: [all.subarray(d0, d0 + area), all.subarray(d0 + area, d0 + 2 * area), all.subarray(d0 + 2 * area, d0 + 3 * area)], uncertain, narrow: !uncertain && (flags & 2) === 0});
          });
        });
        for (const b of batch) { gpuDestroy(b.scratch); b.release(); }
        encoder = null; batch = []; batchBytes = 0;
      };
      for (const bandMap of bands) {
        if (!bandMap) continue;
        if (request.signal?.aborted) { for (const b of batch) { gpuDestroy(b.scratch); b.release(); } return null; }
        let rMin = regionRows, rMax = 0;
        for (const list of bandMap.values()) for (const b of list) { const r = b.by >> 2; if (r < rMin) rMin = r; if (r + 1 > rMax) rMax = r + 1; }
        const cells = Math.max(1, rMax - rMin) * 2, bytes = W * cells * 16 * 8 * 5;
        if (batch.length && batchBytes + bytes > BK_BATCH_BYTES) await flush();
        encoder ??= device.createCommandEncoder();
        const [planes, top, release] = openBand(encoder, rMin * 2, cells), outs = [], scratch = [];
        for (const [id, list] of bandMap) {
          const [t, K, T] = shapes.get(id), size = t.w * t.h, area = t.bw * t.bh, slot = 3 * size + 3 * area + 1;
          const table = new Uint32Array(2 * size + 2 * list.length);
          table.set(T); list.forEach((b, i) => { table[2 * size + i * 2] = b.bx; table[2 * size + i * 2 + 1] = b.by; });
          const groupsX = Math.min(list.length, 65535), out = alloc(list.length * slot * 4);
          const co = alloc(list.length * 2 * size * 8, GPUBufferUsage.STORAGE), tb = gpuUpload(device, alloc, table);
          const u = gpuUni(device, alloc, [W, stride, rows, input.cfl.width, list.length, 0, 0, top, input.dead ? 1 : 0, oTile, groupsX, 0, oZone, t.w, t.h, 0],
            [[17, planeBound], [18, bTr(t.w, t.h)]], 16, 80);
          gpuStep(device, encoder, pipeline, [u, ...planes, K, tb, blk, co, out], list.length);
          outs.push([out, list, size, area, slot]); scratch.push(co, tb);
        }
        batch.push({outs, scratch, release}); batchBytes += bytes;
      }
      await flush();
      gpuBlocksStats.levels++; gpuBlocksStats.doubtful += doubtful; gpuBlocksStats.levelsMs += performance.now() - started;
      return {exact, doubtful};
    });
  } finally { gpuDestroy(made); }
}
