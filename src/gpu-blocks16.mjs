// SPDX-License-Identifier: MIT
import {gpuFloat as b16F, gpuSplit as b16Split, gpuSplits as b16Splits, gpuGroupsX, gpuDestroy, gpuKernel, gpuScoped, gpuAlloc, gpuUpload, gpuUni, gpuStep, gpuStage, gpuRead} from './gpu-kit.mjs';
export {b16F, b16Split, b16Splits};

export const B16_BOUNDS = Object.freeze({u2: 2 ** -48, u64: 2 ** -53, safety: 8, rel: 32 * 2 ** -48 + 8 * 2 ** -53, floor: 1e-30});
export const b16Sum = size => 3 * size * (8 * B16_BOUNDS.u2 + B16_BOUNDS.u64);

const dsLit = v => { const hi = Math.fround(v); return `vec2f(${b16F(hi)}, ${b16F(v - hi)})`; };

const B16_PIXEL = `fn pixel(c: u32, i: u32) -> vec2f { if (c == 0u) { return plX[i]; } if (c == 1u) { return plY[i]; } return plB[i]; }
fn dsqrt(a: vec2f) -> vec2f { if (a.x <= 0.0) { return vec2f(0.0, 0.0); } let s = sqrt(a.x); let r = dsub(a, tp(s, s)); return fs(s, r.x / (2.0 * s)); }`;

const b16EnergyShader = ds =>  `
struct P { W: u32, stride: u32, by0: u32, blocks: u32, top: u32, groupsX: u32, plane: f32, pad: u32, q0: u32, q1: u32, q2: u32, q3: u32, one: f32 }
@group(0) @binding(0) var<uniform> p: P;
fn gcOne() -> f32 { return p.one; }
@group(0) @binding(1) var<storage, read> plX: array<vec2f>;
@group(0) @binding(2) var<storage, read> plY: array<vec2f>;
@group(0) @binding(3) var<storage, read> plB: array<vec2f>;
@group(0) @binding(4) var<storage, read_write> out: array<f32>;
${ds}
${B16_PIXEL}
const REL = ${b16F(B16_BOUNDS.rel)};
const SAFE = ${b16F(B16_BOUNDS.safety)};
fn soft(e: vec2f) -> vec2f { return ddiv(e, dadd(vec2f(1.0, 0.0), dmul(${dsLit(0.08)}, e))); }
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) g: vec3u, @builtin(local_invocation_index) lid: u32) {
  let index = (g.y * p.groupsX + g.x) * 64u + lid;
  if (index >= p.blocks) { return; }
  let bx = index % p.stride; let by = p.by0 + index / p.stride; let W = p.W; let z0 = u32(gcOne() < 0.0);
  var s = vec2f(0.0, 0.0); var size = 0.0;
  for (var y = z0; y < 7u; y++) { for (var x = z0; x < 7u; x++) {
    let i = (by * 8u + y - p.top) * W + bx * 8u + x;
    let dy1 = dsub(plY[i + 1u], plY[i]); let dy2 = dsub(plY[i + W], plY[i]); let dd = dsub(dsub(dadd(plY[i + W + 1u], plY[i]), plY[i + 1u]), plY[i + W]);
    let dx = dsub(plX[i + 1u], plX[i]); let db = dsub(plB[i + 1u], plB[i]);
    let eY = dsqrt(dadd(dadd(dmul(dy1, dy1), dmul(dy2, dy2)), dmul(vec2f(0.5, 0.0), dmul(dd, dd))));
    let eC = dsqrt(dadd(dmul(vec2f(4.0, 0.0), dmul(dx, dx)), dmul(vec2f(0.25, 0.0), dmul(db, db))));
    s = dadd(s, dadd(soft(eY), dmul(${dsLit(0.35)}, soft(eC))));
    size += eY.x + eC.x + abs(dy1.x) + abs(dy2.x) + abs(dd.x) + abs(dx.x) + abs(db.x);
  } }
  let hf = ddiv(s, vec2f(49.0, 0.0));
  out[index * 3u] = hf.x; out[index * 3u + 1u] = hf.y;
  out[index * 3u + 2u] = 8.6 * p.plane + SAFE * REL * 32.0 * size / 49.0 + 1e-30;
}`;

export function b16Blocks(input, weight) {
  const {stride, rows, fine, cfl, zones} = input, cells = stride * rows, oTile = cells * 3, tiles = cfl.x.length;
  const oZone = zones ? oTile + tiles * 2 : 0;
  const blk = new Float32Array((oTile + tiles * 2 + (zones ? zones.thresholds.length : 0)) * 2);
  for (let b = 0; b < cells; b++) {
    const f = fine[b];
    b16Split(f, blk, b * 6);
    if (f === 1) blk[b * 6 + 2] = 1;
    else b16Split(1 / f, blk, b * 6 + 2);
    if (zones) blk[b * 6 + 4] = zones.indices[b];
    else if (weight) b16Split(weight[b], blk, b * 6 + 4);
  }
  for (let k = 0; k < tiles; k++) { b16Split(cfl.x[k] / 84, blk, (oTile + k * 2) * 2); b16Split(cfl.b[k] / 84, blk, (oTile + k * 2 + 1) * 2); }
  if (zones) b16Splits(zones.thresholds, blk, oZone * 2);
  return {blk, oTile, oZone};
}

const b16Kernel = (device, ds) => gpuKernel(device, 'b16:energy', () => b16EnergyShader(ds), 64);
export const gpuBlocks16Pipelines = (device, ds) => b16Kernel(device, ds);
export const gpuBlocks16Stats = {costs: 0, levels: 0, flagged: 0, doubtful: 0, bands: 0, energy: 0, costsMs: 0, levelsMs: 0};

export function b16Open(device, request, core, weight) {
  const {stride, rows} = request.input, W = stride * 8, H = rows * 8, cellRows = Math.ceil(rows / 2), made = [], alloc = gpuAlloc(device, made);
  const {blk, oTile, oZone} = b16Blocks(request.input, weight ?? new Float64Array(stride * rows));
  let blkBuf;
  try { blkBuf = gpuUpload(device, alloc, blk); } catch (error) { gpuDestroy(made); throw error; }
  const planeBound = request.planeBound;
  const budget = Math.min(64 << 20, device.limits.maxStorageBufferBindingSize);
  const bandCells = Math.max(1, Math.min(cellRows, request.devicePlanes ? 16 : cellRows, Math.floor(budget / (3 * W * 16 * 8))));
  const band = (encoder, c0, cells) => {
    const top = c0 * 16, bandPx = Math.min(H - top, cells * 16), before = made.length;
    const res = core.encodePlanes(encoder, alloc, request.data, request.width, request.height, top, top + bandPx, request.options);
    gpuBlocks16Stats.bands++;
    const own = made.splice(before), release = () => gpuDestroy(own);
    made.push({destroy: release});
    return [res.planes, top - res.row, release];
  };
  return [W, stride, rows, cellRows, bandCells, oTile, blkBuf, planeBound, alloc, made, band, oZone];
}

export async function gpuBlocks16EnergyHook(device, ds, width, height, planeBound) {
  const kernel = await b16Kernel(device, ds), stride = Math.ceil(width / 8), rows = Math.ceil(height / 8), hf = new Float64Array(stride * rows);
  let bound = 0, done = 0;
  const each = new Float64Array(stride * rows);
  return {
    band(encoder, set, {y, from, to}, owner) {
      const made = [], alloc = gpuAlloc(device, made), by0 = y / 8, by1 = to === height ? rows : (to - 64) / 8, blocks = (by1 - by0) * stride, gx = gpuGroupsX(blocks);
      owner.push({destroy: () => gpuDestroy(made)});
      const out = alloc(blocks * 12), u = gpuUni(device, alloc, [set.W, stride, by0, blocks, from, gx], [[6, planeBound]], 12, 64);
      gpuStep(device, encoder, kernel, [u, ...set.planes, out], blocks);
      const [map, take] = gpuStage(device, alloc, encoder, [[out, 0, blocks * 12]]);
      return async () => {
        try {
          await map();
          const o = new Float32Array(take()[0]);
          for (let i = 0; i < blocks; i++) { hf[by0 * stride + i] = o[i * 3] + o[i * 3 + 1]; each[by0 * stride + i] = o[i * 3 + 2]; if (o[i * 3 + 2] > bound) bound = o[i * 3 + 2]; }
          done += blocks;
        } finally { gpuDestroy(made); }
      };
    },
    result: () => done === stride * rows ? (gpuBlocks16Stats.energy++, {hf, bound, each}) : null,
  };
}

export async function gpuBlocks16Mask(device, request, ds, core) {
  const [W, stride, rows, cellRows, bandCells, , , planeBound, alloc, made, openBand] = b16Open(device, request, core);
  try {
    return await gpuScoped(device, 'gpuBlocks16Mask', async () => {
      const kernel = await b16Kernel(device, ds), hf = new Float64Array(stride * rows);
      let bound = 0;
      for (let c0 = 0; c0 < cellRows; c0 += bandCells) {
        const cells = Math.min(bandCells, cellRows - c0), encoder = device.createCommandEncoder(), [planes, top, release] = openBand(encoder, c0, cells);
        const by0 = c0 * 2, blocks = Math.min(rows - by0, cells * 2) * stride, gx = gpuGroupsX(blocks);
        const out = alloc(blocks * 12), u = gpuUni(device, alloc, [W, stride, by0, blocks, top, gx], [[6, planeBound]], 12, 64);
        gpuStep(device, encoder, kernel, [u, ...planes, out], blocks);
        const o = new Float32Array((await gpuRead(device, alloc, [[out, 0, blocks * 12]], encoder))[0]);
        release(); out.destroy();
        for (let i = 0; i < blocks; i++) { hf[by0 * stride + i] = o[i * 3] + o[i * 3 + 1]; if (o[i * 3 + 2] > bound) bound = o[i * 3 + 2]; }
      }
      return {weight: request.maskWeights(hf, stride, rows).weight, weightDoubt: 0.75 * bound + 1e-12};
    });
  } finally { gpuDestroy(made); }
}
