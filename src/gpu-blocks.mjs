// SPDX-License-Identifier: MIT
import {B16_BOUNDS, B16Session, b16Sum} from './gpu-blocks16.mjs';
import {maskDoubtOver} from './aq.mjs';

export const bTr = (w, h) => ((3 * (w + h) + 20) * B16_BOUNDS.u2 + (w + h + 2) * B16_BOUNDS.u64) * 2 / (w * h);
const bkF = v => { const s = Math.fround(v).toString(); return /[.eE]/.test(s) ? s : s + '.0'; };
const bkSplit = (v, out, at) => { const hi = Math.fround(v); out[at] = hi; out[at + 1] = Math.fround(v - hi); };
const bkSplits = (values, out, at) => { for (let i = 0; i < values.length; i++) bkSplit(values[i], out, at + 2 * i); };

const BK_OUT = 6;

const bkLayout = (w, h) => {
  const size = w * h, basisW = 0, basisH = w * w, steps = basisH + h * h, recon = steps + 3 * size;
  const log2 = recon + 4096, one = log2 + 4096, dead = one + 3, norm = dead + 6, rc = norm + 3, detail = rc + 4;
  const dcStep = detail + 1, lowM = dcStep + 3, area = (w / 8) * (h / 8);
  return {basisW, basisH, steps, recon, log2, one, dead, norm, rc, detail, dcStep, lowM, size: lowM + area * area};
};

const bkCostsShader = (ds, w, h) => {
  const size = w * h, area = (w / 8) * (h / 8), L = bkLayout(w, h), chunk = Math.ceil(size / 64), tall = h >= w;
  return  `
struct P { W: u32, stride: u32, rows: u32, cflW: u32, count: u32, originsX: u32, by0: u32, top: u32, hasDead: u32, oTile: u32, groupsX: u32, plane: f32, one: f32, oOut: u32 }
@group(0) @binding(0) var<uniform> p: P;
fn gcOne() -> f32 { return p.one; }
@group(0) @binding(1) var<storage, read> plX: array<vec2f>;
@group(0) @binding(2) var<storage, read> plY: array<vec2f>;
@group(0) @binding(3) var<storage, read> plB: array<vec2f>;
@group(0) @binding(4) var<storage, read> K: array<vec2f>;
@group(0) @binding(5) var<storage, read> T: array<u32>;
@group(0) @binding(6) var<storage, read> blk: array<vec2f>;
@group(0) @binding(7) var<storage, read_write> co: array<vec2f>;
@group(0) @binding(8) var<storage, read_write> out: array<f32>;
${ds}
fn pixel(c: u32, i: u32) -> vec2f { if (c == 0u) { return plX[i]; } if (c == 1u) { return plY[i]; } return plB[i]; }
const WB = ${w}u;
const HB = ${h}u;
const SIZE = ${size}u;
const AREA = ${area}u;
const CHUNK = ${chunk}u;
const U2 = ${bkF(B16_BOUNDS.u2)};
const REL = ${bkF(B16_BOUNDS.rel)};
const SAFE = ${bkF(B16_BOUNDS.safety)};
const TR = ${bkF(bTr(w, h))};
var<workgroup> tm: array<vec2f, ${size}>;
var<workgroup> pd: array<vec2f, 64>;
var<workgroup> pr: array<vec2f, 64>;
var<workgroup> pn: array<u32, 64>;
var<workgroup> plast: array<u32, 64>;
var<workgroup> pe: array<f32, 64>;
var<workgroup> pf: array<u32, 64>;
var<workgroup> mag: array<f32, 3>;
var<workgroup> accD: vec2f;
var<workgroup> accR: vec2f;
var<workgroup> accE: f32;
var<workgroup> accF: u32;

struct Q { d: vec2f, r: vec2f, e: f32, flag: u32, q: u32 }

fn level(c: u32, tr: vec2f, luma: vec2f, step: vec2f, high: u32, fc: vec2f, bt: f32, btY: f32, fine: vec2f) -> Q {
  var coefficient = tr;
  var bc = bt;
  if (c != 1u) { let s = dmul(fc, luma); coefficient = dsub(tr, s); bc = bt + abs(fc.x) * btY + 16.0 * U2 * (abs(tr.x) + abs(s.x)); }
  let v = dmul(ddiv(coefficient * 2048.0, step), fine);
  let a = dabs(v);
  let scale = 2048.0 * fine.x / step.x;
  let ba = SAFE * (bc * scale + REL * a.x) + 1e-30;
  var thr = vec2f(0.5, 0.0);
  if (p.hasDead == 1u) { thr = K[${L.dead}u + c * 2u + high]; }
  var flag = 0u;
  let below = dsub(a, thr).x;
  if (abs(below) <= ba) { flag = 1u; }
  var q = 0.0;
  if (below >= 0.0) { let r = dround(a, vec2f(0.5, 0.0), ba); q = r.x; if (r.y != 0.0) { flag = 1u; } }
  if (q >= 4096.0) { flag = 1u; q = 4095.0; }
  let qi = u32(q);
  var recon = vec2f(0.0, 0.0);
  if (qi == 1u) { recon = K[${L.one}u + c]; } else if (qi > 1u) { recon = K[${L.recon}u + qi]; }
  let unit = fine * 2048.0;
  let e = ddiv(dmul(dsub(a, recon), step), unit);
  var wq = vec2f(1.0, 0.0);
  if (qi == 0u) { wq = K[${L.detail}u]; }
  let s = step.x / unit.x;
  let de = ba * s + SAFE * REL * (abs(e.x) + (a.x + recon.x) * s);
  var r = vec2f(0.0, 0.0);
  if (qi != 0u) { r = dadd(K[${L.rc}u + 1u], dmul(K[${L.rc}u + 2u], K[${L.log2}u + qi])); }
  return Q(dmul(dmul(e, e), wq), r, wq.x * (2.0 * abs(e.x) * de + de * de), flag, qi);
}

@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) g: vec3u, @builtin(local_invocation_index) lid: u32) {
  let index = g.y * p.groupsX + g.x;
  if (index >= p.count) { return; }
  let bx = (index % p.originsX) * (WB / 8u);
  let by = p.by0 + (index / p.originsX) * (HB / 8u);
  let at = (p.oOut + index) * ${BK_OUT}u;
  let absent = bx + WB / 8u > p.stride || by + HB / 8u > p.rows;
  if (absent) { if (lid == 0u) { for (var j = 0u; j < ${BK_OUT}u; j++) { out[at + j] = 0.0; } out[at + 5u] = 2.0; } return; }
  let slot = index * 2u * SIZE;
  let ti = (by >> 3u) * p.cflW + (bx >> 3u);
  let fine = blk[(by * p.stride + bx) * 2u];
  if (lid == 0u) { accD = vec2f(0.0, 0.0); accR = vec2f(0.0, 0.0); accE = 0.0; accF = 0u; }
  for (var ci = 0u; ci < 3u; ci++) {
    let c = select(select(2u, 0u, ci == 1u), 1u, ci == 0u);
    workgroupBarrier();
    // Sum |p| of the block, and its rows.
    var m = 0.0;
    for (var i = lid; i < SIZE; i += 64u) {
      let y = i / WB; let u = i % WB; let row = (by * 8u + y - p.top) * p.W + bx * 8u;
      var s = vec2f(0.0, 0.0);
      for (var x = 0u; x < WB; x++) { s = dadd(s, dmul(pixel(c, row + x), K[${L.basisW}u + u * WB + x])); }
      tm[y * WB + u] = s;
      m += abs(pixel(c, row + u).x);
    }
    pe[lid] = m;
    workgroupBarrier();
    if (lid == 0u) { var t = 0.0; for (var j = 0u; j < 64u; j++) { t += pe[j]; } mag[c] = t * 1.001; }
    // The columns, into the block's slot (luma at 0, chroma at SIZE).
    let o = slot + select(SIZE, 0u, c == 1u);
    for (var i = lid; i < SIZE; i += 64u) {
      let u = i % WB; let v = i / WB; var s = vec2f(0.0, 0.0);
      for (var y = 0u; y < HB; y++) { s = dadd(s, dmul(tm[y * WB + u], K[${L.basisH}u + v * HB + y])); }
      co[o + ${tall ? 'u * HB + v' : 'v * WB + u'}] = s;
    }
    storageBarrier();
    workgroupBarrier();
    var fc = vec2f(0.0, 0.0);
    if (c == 0u) { fc = blk[p.oTile + ti * 2u]; } else if (c == 2u) { fc = blk[p.oTile + ti * 2u + 1u]; }
    let bt = TR * mag[c] + 2.0 * p.plane; let btY = TR * mag[1] + 2.0 * p.plane;
    {
      var d = vec2f(0.0, 0.0); var r = vec2f(0.0, 0.0); var n = 0u; var last = 0u; var e = 0.0; var f = 0u;
      for (var j = 0u; j < CHUNK; j++) {
        let k = lid * CHUNK + j;
        if (k >= SIZE) { break; }
        if (k < AREA) { continue; }
        let pos = T[k];
        let x = level(c, co[o + pos], co[slot + pos], K[${L.steps}u + c * SIZE + pos], T[SIZE + pos], fc, bt, btY, fine);
        d = dadd(d, x.d); r = dadd(r, x.r); e += x.e; f |= x.flag;
        if (x.q != 0u) { n += 1u; last = k + 1u; }
      }
      pd[lid] = d; pr[lid] = r; pn[lid] = n; plast[lid] = last; pe[lid] = e; pf[lid] = f;
    }
    workgroupBarrier();
    // D += norm d w h blockMW; R += rc0 + rc3 zeros.
    if (lid == 0u) {
      var d = vec2f(0.0, 0.0); var r = vec2f(0.0, 0.0); var n = 0u; var last = 0u; var e = 0.0; var f = 0u;
      for (var j = 0u; j < 64u; j++) { d = dadd(d, pd[j]); r = dadd(r, pr[j]); n += pn[j]; last = max(last, plast[j]); e += pe[j]; f |= pf[j]; }
      var zeros = 0u;
      if (n > 0u) { zeros = last - AREA - n; }
      let scale = dmul(K[${L.norm}u + c], K[${L.size}u + p.oOut + index]) * f32(SIZE);
      accD = dadd(accD, dmul(d, scale));
      accR = dadd(accR, dadd(r, dadd(K[${L.rc}u], dmul(K[${L.rc}u + 3u], vec2f(f32(zeros), 0.0)))));
      accE += SAFE * scale.x * e * 1.01;
      accF |= f;
    }
  }
  workgroupBarrier();
  if (lid == 0u) {
    out[at] = accD.x; out[at + 1u] = accD.y; out[at + 2u] = accR.x; out[at + 3u] = accR.y;
    out[at + 4u] = accE + ${bkF(b16Sum(size))} * abs(accD.x) + ${bkF(B16_BOUNDS.floor)};
    out[at + 5u] = f32(accF);
  }
}`;
};

function bkShapeTables(input, search, scaledDCTBases, id, mw = new Float32Array(0), lowFrequencies = null) {
  const t = input.transforms.get(id), {w, h} = t, L = bkLayout(w, h), K = new Float32Array(L.size * 2 + mw.length);
  K.set(mw, L.size * 2);
  bkSplits(scaledDCTBases(w).basis, K, L.basisW * 2);
  bkSplits(scaledDCTBases(h).basis, K, L.basisH * 2);
  for (let c = 0; c < 3; c++) bkSplits(t.steps[c], K, (L.steps + c * w * h) * 2);
  bkSplits(input.recon, K, L.recon * 2);
  const log2 = input.log2.slice(); log2[0] = 0;
  bkSplits(log2, K, L.log2 * 2);
  bkSplits(input.one, K, L.one * 2);
  if (input.dead) bkSplits(input.dead, K, L.dead * 2);
  bkSplits(input.norm, K, L.norm * 2);
  bkSplits(search.rate ?? [4, 3, 2, 0.6], K, L.rc * 2);
  bkSplit(search.detailWeight ?? 1.25, K, L.detail * 2);
  bkSplits(input.dcSteps, K, L.dcStep * 2);
  const bw = w / 8, bh = h / 8, area = bw * bh, long = Math.max(bw, bh);
  if (area === 1) bkSplit(1, K, L.lowM * 2);
  else if (lowFrequencies) for (let j = 0; j < area; j++) {
    const e = new Float64Array(w * h); e[Math.floor(j / long) * long * 8 + j % long] = 1;
    const dc = lowFrequencies(e, bw, bh);
    for (let i = 0; i < area; i++) bkSplit(dc[i], K, (L.lowM + i * area + j) * 2);
  }
  const T = new Uint32Array(2 * w * h);
  T.set(t.order, 0); T.set(t.high, w * h);
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

const bkPipelines = new WeakMap();
function bkPipeline(device, ds, w, h) {
  let set = bkPipelines.get(device);
  if (!set) bkPipelines.set(device, set = {});
  return set[w + 'x' + h] ||= device.createComputePipelineAsync({layout: 'auto', compute: {module: device.createShaderModule({code: bkCostsShader(ds, w, h)}), entryPoint: 'main'}});
}
export function gpuBlocksPipelines(device, ds, shapes = [[8, 8], [16, 16], [8, 16], [16, 8], [32, 32], [16, 32], [32, 16]]) { return Promise.all(shapes.map(([w, h]) => bkPipeline(device, ds, w, h))); }

export const gpuBlocksStats = {costs: 0, flagged: 0, costsMs: 0, levels: 0, doubtful: 0, levelsMs: 0};

export async function gpuBlocksCosts(device, request, ds, core) {
  const started = performance.now();
  device.pushErrorScope('validation'); device.pushErrorScope('out-of-memory');
  let scopes = 2;
  const session = new B16Session(device, request, ds, core, request.weight);
  try {
    const {stride, rows} = session, {input, search, scaledDCTBases} = request, weightDoubt = request.weightDoubt || 0;
    const ids = [...new Set([0, ...request.ids])].filter(id => input.transforms.has(id));
    const regionRows = Math.ceil(rows / 4), bandRegions = Math.max(1, Math.floor(session.bandCells / 2));
    const shapes = await Promise.all(ids.map(async id => {
      const t = input.transforms.get(id), {w, h, bw, bh} = t, originsX = Math.ceil(stride / bw), originRows = Math.ceil(rows / bh);
      const mw = bkBlockWeights(request.weight, stride, rows, bw, bh, originsX, originRows), {K, T} = bkShapeTables(input, search, scaledDCTBases, id, mw);
      return {id, w, h, bw, bh, originsX, originRows, K: session.upload(K), T: session.upload(T), pipeline: await bkPipeline(device, ds, w, h),
        out: session.buffer(originsX * originRows * BK_OUT * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC)};
    }));
    for (let r0 = 0; r0 < regionRows; r0 += bandRegions) {
      const regions = Math.min(bandRegions, regionRows - r0), encoder = device.createCommandEncoder(), band = session.band(encoder, r0 * 2, regions * 2), scratch = [];
      for (const s of shapes) {
        const oy0 = r0 * 4 / s.bh, oyN = Math.min(s.originRows - oy0, regions * 4 / s.bh), count = s.originsX * oyN;
        if (count <= 0) continue;
        const groupsX = Math.min(count, 65535), co = session.buffer(count * 2 * s.w * s.h * 8, GPUBufferUsage.STORAGE);
        const [u, d] = session.uniform([session.W, stride, rows, input.cfl.width, count, s.originsX, r0 * 4, band.top, input.dead ? 1 : 0, session.oTile, groupsX, 0]);
        new Float32Array(d)[11] = session.planeBound; new Uint32Array(d)[13] = oy0 * s.originsX; device.queue.writeBuffer(u, 0, d);
        const pass = encoder.beginComputePass();
        pass.setPipeline(s.pipeline);
        pass.setBindGroup(0, device.createBindGroup({layout: s.pipeline.getBindGroupLayout(0), entries: [u, ...band.planes, s.K, s.T, session.blk, co, s.out].map((b, k) => ({binding: k, resource: {buffer: b}}))}));
        pass.dispatchWorkgroups(groupsX, Math.ceil(count / groupsX));
        pass.end();
        scratch.push(co);
      }
      device.queue.submit([encoder.finish()]);
      await device.queue.onSubmittedWorkDone();
      for (const b of scratch) b.destroy();
      band.release();
    }
    const costs = Object.assign(new Map(), {certified: true});
    let flagged = 0;
    const read = await session.readAll(device.createCommandEncoder(), shapes.map(s => [s.out, s.originsX * s.originRows * BK_OUT * 4]));
    for (const [n, s] of shapes.entries()) {
      const o = new Float32Array(read[n]);
      const c = {D: new Float64Array(stride * rows).fill(NaN), R: new Float64Array(stride * rows).fill(NaN), De: new Float64Array(stride * rows).fill(NaN), Re: new Float64Array(stride * rows).fill(NaN)};
      for (let oy = 0; oy < s.originRows; oy++) for (let ox = 0; ox < s.originsX; ox++) {
        const bx = ox * s.bw, by = oy * s.bh;
        if (bx + s.bw > stride || by + s.bh > rows) continue;
        const at = (oy * s.originsX + ox) * BK_OUT, b = by * stride + bx, flag = o[at + 5];
        const D = o[at] + o[at + 1], R = o[at + 2] + o[at + 3], e = o[at + 4];
        const valid = (flag === 0 || flag === 1) && D >= 0 && R >= 0 && e >= 0 && Number.isFinite(D) && Number.isFinite(R) && Number.isFinite(e);
        if (!valid || flag === 1) { c.D[b] = 0; c.R[b] = 0; c.De[b] = Infinity; c.Re[b] = 0; flagged++; continue; }
        c.D[b] = D; c.R[b] = R; c.De[b] = e + maskDoubtOver(weightDoubt, stride, bx, by, s.bw, s.bh) * D; c.Re[b] = b16Sum(s.w * s.h) * R;
      }
      costs.set(s.id, c);
    }
    scopes--; const oom = await device.popErrorScope();
    scopes--; const invalid = await device.popErrorScope();
    if (oom || invalid) throw new Error('gpuBlocksCosts: ' + (oom || invalid).message);
    gpuBlocksStats.costs++; gpuBlocksStats.flagged += flagged; gpuBlocksStats.costsMs += performance.now() - started;
    return {costs, weight: request.weight, weightDoubt, flagged};
  } finally {
    session.destroy();
    while (scopes-- > 0) await device.popErrorScope().catch(() => null);
  }
}

const BK_DOUBT = 2130706432;
const bkLevelsShader = (ds, w, h) => {
  const size = w * h, bw = w / 8, bh = h / 8, area = bw * bh, long = Math.max(bw, bh), L = bkLayout(w, h), tall = h >= w;
  return  `
struct P { W: u32, stride: u32, rows: u32, cflW: u32, count: u32, top: u32, hasDead: u32, oTile: u32, groupsX: u32, plane: f32, pad0: u32, pad1: u32, one: f32 }
@group(0) @binding(0) var<uniform> p: P;
fn gcOne() -> f32 { return p.one; }
@group(0) @binding(1) var<storage, read> plX: array<vec2f>;
@group(0) @binding(2) var<storage, read> plY: array<vec2f>;
@group(0) @binding(3) var<storage, read> plB: array<vec2f>;
@group(0) @binding(4) var<storage, read> K: array<vec2f>;
@group(0) @binding(5) var<storage, read> T: array<u32>;
@group(0) @binding(6) var<storage, read> blk: array<vec2f>;
@group(0) @binding(7) var<storage, read_write> co: array<vec2f>;
@group(0) @binding(8) var<storage, read_write> out: array<i32>;
${ds}
fn pixel(c: u32, i: u32) -> vec2f { if (c == 0u) { return plX[i]; } if (c == 1u) { return plY[i]; } return plB[i]; }
const WB = ${w}u;
const HB = ${h}u;
const SIZE = ${size}u;
const AREA = ${area}u;
const SLOT = ${3 * size + 3 * area + 1}u;
const U2 = ${bkF(B16_BOUNDS.u2)};
const REL = ${bkF(B16_BOUNDS.rel)};
const SAFE = ${bkF(B16_BOUNDS.safety)};
const TR = ${bkF(bTr(w, h))};
var<workgroup> tm: array<vec2f, ${size}>;
var<workgroup> part: array<f32, 64>;
var<workgroup> mag: array<f32, 3>;
var<workgroup> doubt: atomic<u32>;

@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) g: vec3u, @builtin(local_invocation_index) lid: u32) {
  let index = g.y * p.groupsX + g.x;
  if (index >= p.count) { return; }
  let bx = T[2u * SIZE + index * 2u]; let by = T[2u * SIZE + index * 2u + 1u];
  let slot = index * SLOT; let own = index * 2u * SIZE;
  let ti = (by >> 3u) * p.cflW + (bx >> 3u);
  let fine = blk[(by * p.stride + bx) * 2u];
  if (lid == 0u) { atomicStore(&doubt, 0u); }
  for (var ci = 0u; ci < 3u; ci++) {
    let c = select(select(2u, 0u, ci == 1u), 1u, ci == 0u);
    workgroupBarrier();
    var m = 0.0;
    for (var i = lid; i < SIZE; i += 64u) {
      let y = i / WB; let u = i % WB; let row = (by * 8u + y - p.top) * p.W + bx * 8u;
      var s = vec2f(0.0, 0.0);
      for (var x = 0u; x < WB; x++) { s = dadd(s, dmul(pixel(c, row + x), K[${L.basisW}u + u * WB + x])); }
      tm[y * WB + u] = s;
      m += abs(pixel(c, row + u).x);
    }
    part[lid] = m;
    workgroupBarrier();
    if (lid == 0u) { var t = 0.0; for (var j = 0u; j < 64u; j++) { t += part[j]; } mag[c] = t * 1.001; }
    let o = own + select(SIZE, 0u, c == 1u);
    for (var i = lid; i < SIZE; i += 64u) {
      let u = i % WB; let v = i / WB; var s = vec2f(0.0, 0.0);
      for (var y = 0u; y < HB; y++) { s = dadd(s, dmul(tm[y * WB + u], K[${L.basisH}u + v * HB + y])); }
      co[o + ${tall ? 'u * HB + v' : 'v * WB + u'}] = s;
    }
    storageBarrier();
    workgroupBarrier();
    let bt = TR * mag[c] + 2.0 * p.plane; let btY = TR * mag[1] + 2.0 * p.plane;
    // DC: the raw coefficients' low frequencies, in levels of the channel's DC step.
    if (lid < AREA) {
      var v = vec2f(0.0, 0.0); var sum = 0.0; var weight = 0.0;
      for (var j = 0u; j < AREA; j++) {
        let mj = K[${L.lowM}u + lid * AREA + j]; let t = dmul(co[o + (j / ${long}u) * ${long * 8}u + j % ${long}u], mj);
        v = dadd(v, t); sum += abs(t.x); weight += abs(mj.x);
      }
      let step = K[${L.dcStep}u + c];
      let dcv = ddiv(v * 8.0, step);
      let e = SAFE * ((bt * weight + REL * sum) * 8.0 / step.x + REL * abs(dcv.x)) + 1e-30;
      let r = dround(dcv, vec2f(0.5, 0.0), e);
      var q = i32(r.x);
      if (r.y != 0.0 || abs(r.x) > 1e9) { q = ${BK_DOUBT}; atomicOr(&doubt, 1u); }
      out[slot + 3u * SIZE + c * AREA + lid] = q;
    }
    var fc = vec2f(0.0, 0.0);
    if (c == 0u) { fc = blk[p.oTile + ti * 2u]; } else if (c == 2u) { fc = blk[p.oTile + ti * 2u + 1u]; }
    for (var k = lid; k < SIZE; k += 64u) {
      let pos = T[k];
      if (k < AREA) { out[slot + c * SIZE + pos] = 0; continue; }
      let luma = co[own + pos];
      var coefficient = luma; var bc = bt;
      if (c != 1u) { let tr = co[o + pos]; let s = dmul(fc, luma); coefficient = dsub(tr, s); bc = bt + abs(fc.x) * btY + 16.0 * U2 * (abs(tr.x) + abs(s.x)); }
      let step = K[${L.steps}u + c * SIZE + pos];
      let v = dmul(ddiv(coefficient * 2048.0, step), fine);
      let a = dabs(v);
      let ba = SAFE * (bc * 2048.0 * fine.x / step.x + REL * a.x) + 1e-30;
      var thr = vec2f(0.5, 0.0);
      if (p.hasDead == 1u) { thr = K[${L.dead}u + c * 2u + T[SIZE + pos]]; }
      let below = dsub(a, thr).x;
      var q = 0;
      var unsure = abs(below) <= ba;
      if (below >= 0.0) { let r = dround(a, vec2f(0.5, 0.0), ba); q = i32(r.x); if (r.y != 0.0 || r.x > 1e9) { unsure = true; } }
      if (v.x < 0.0) { q = -q; }
      if (unsure) { q = ${BK_DOUBT}; atomicOr(&doubt, 1u); }
      out[slot + c * SIZE + pos] = q;
    }
  }
  workgroupBarrier();
  if (lid == 0u) { out[slot + SLOT - 1u] = i32(atomicLoad(&doubt)); }
}`;
};
function bkLevelsPipeline(device, ds, w, h) {
  let set = bkPipelines.get(device);
  if (!set) bkPipelines.set(device, set = {});
  return set['levels' + w + 'x' + h] ||= device.createComputePipelineAsync({layout: 'auto', compute: {module: device.createShaderModule({code: bkLevelsShader(ds, w, h)}), entryPoint: 'main'}});
}

export async function gpuBlocksLevels(device, request, ds, core) {
  const started = performance.now();
  device.pushErrorScope('validation'); device.pushErrorScope('out-of-memory');
  let scopes = 2;
  const session = new B16Session(device, request, ds, core);
  try {
    const {stride, rows} = session, {input, search, scaledDCTBases, lowFrequencies} = request;
    const regionRows = Math.ceil(rows / 4), bandRegions = Math.max(1, Math.floor(session.bandCells / 2));
    const bands = [];
    for (const b of request.layout) if (input.transforms.has(b.id)) ((bands[Math.floor((b.by >> 2) / bandRegions)] ||= new Map()).get(b.id) ?? bands[Math.floor((b.by >> 2) / bandRegions)].set(b.id, []).get(b.id)).push(b);
    const shapes = new Map();
    for (const id of new Set(request.layout.map(b => b.id))) if (input.transforms.has(id)) {
      const t = input.transforms.get(id), {K, T} = bkShapeTables(input, search, scaledDCTBases, id, undefined, lowFrequencies);
      shapes.set(id, {t, K: session.upload(K), T, pipeline: await bkLevelsPipeline(device, ds, t.w, t.h)});
    }
    const exact = new Map();
    let doubtful = 0;
    for (let k = 0; k < bands.length; k++) {
      if (!bands[k]) continue;
      const r0 = k * bandRegions, regions = Math.min(bandRegions, regionRows - r0);
      const encoder = device.createCommandEncoder(), band = session.band(encoder, r0 * 2, regions * 2), outs = [], scratch = [];
      for (const [id, list] of bands[k]) {
        const {t, K, T, pipeline} = shapes.get(id), size = t.w * t.h, area = t.bw * t.bh, slot = 3 * size + 3 * area + 1;
        const table = new Uint32Array(2 * size + 2 * list.length);
        table.set(T); list.forEach((b, i) => { table[2 * size + i * 2] = b.bx; table[2 * size + i * 2 + 1] = b.by; });
        const groupsX = Math.min(list.length, 65535), out = session.buffer(list.length * slot * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
        const co = session.buffer(list.length * 2 * size * 8, GPUBufferUsage.STORAGE), tb = session.upload(table);
        const [u, d] = session.uniform([session.W, stride, rows, input.cfl.width, list.length, band.top, input.dead ? 1 : 0, session.oTile, groupsX]);
        new Float32Array(d)[9] = session.planeBound; device.queue.writeBuffer(u, 0, d);
        session.dispatch(encoder, pipeline, [u, ...band.planes, K, tb, session.blk, co, out], groupsX, Math.ceil(list.length / groupsX));
        outs.push({out, list, size, area, slot}); scratch.push(co, tb);
      }
      const read = await session.readAll(encoder, outs.map(({out, list, slot}) => [out, list.length * slot * 4]));
      for (const [n, {out, list, size, area, slot}] of outs.entries()) {
        const all = new Int32Array(read[n]);
        out.destroy();
        list.forEach((b, i) => {
          const o = i * slot, uncertain = all[o + slot - 1] !== 0;
          if (uncertain) doubtful++;
          exact.set(b.id + ':' + b.bx + ':' + b.by, {coeffs: [0, 1, 2].map(c => all.subarray(o + c * size, o + (c + 1) * size)),
            dc: [0, 1, 2].map(c => all.subarray(o + 3 * size + c * area, o + 3 * size + (c + 1) * area)), uncertain});
        });
      }
      for (const b of scratch) b.destroy();
      band.release();
    }
    scopes--; const oom = await device.popErrorScope();
    scopes--; const invalid = await device.popErrorScope();
    if (oom || invalid) throw new Error('gpuBlocksLevels: ' + (oom || invalid).message);
    gpuBlocksStats.levels++; gpuBlocksStats.doubtful += doubtful; gpuBlocksStats.levelsMs += performance.now() - started;
    return {exact, doubtful};
  } finally {
    session.destroy();
    while (scopes-- > 0) await device.popErrorScope().catch(() => null);
  }
}
