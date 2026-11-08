// SPDX-License-Identifier: MIT

export const B16_BOUNDS = Object.freeze({u2: 2 ** -48, u64: 2 ** -53, safety: 8, rel: 32 * 2 ** -48 + 8 * 2 ** -53, floor: 1e-30});
export const b16Sum = size => 3 * size * (8 * B16_BOUNDS.u2 + B16_BOUNDS.u64);
export const b16Tr = side => ((3 * 2 * side + 20) * B16_BOUNDS.u2 + (2 * side + 2) * B16_BOUNDS.u64) * 2 / (side * side);
const b16F = v => { const s = Math.fround(v).toString(); return /[.eE]/.test(s) ? s : s + '.0'; };

const B16K = {basis8: 0, basis16: 64, steps8: 320, steps16: 512, recon: 1280, log2: 5376, one: 9472, dead: 9475, norm: 9481, rc: 9484, detail: 9488, dcStep: 9489, lowM: 9492, mask: 9508, size: 9510};
const B16T = {order8: 0, order16: 64, high8: 320, high16: 384, size: 640};

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
function b16Pipeline(device, ds) {
  if (!b16Pipelines.has(device)) b16Pipelines.set(device, device.createComputePipelineAsync({layout: 'auto', compute: {module: device.createShaderModule({code: b16EnergyShader(ds)}), entryPoint: 'main'}}));
  return b16Pipelines.get(device);
}

export function gpuBlocks16Pipelines(device, ds) { return b16Pipeline(device, ds); }

export const gpuBlocks16Stats = {costs: 0, levels: 0, flagged: 0, doubtful: 0, bands: 0, energy: 0, costsMs: 0, levelsMs: 0};

export class B16Session {
  constructor(device, request, ds, core, weight) {
    const {input, search, scaledDCTBases} = request, {stride, rows} = input;
    Object.assign(this, {device, request, ds, core, stride, rows, W: stride * 8, H: rows * 8, cellsX: Math.ceil(stride / 2), cellRows: Math.ceil(rows / 2), made: []});
    this.planeBound = request.planeBound;
    const {K, T} = b16Tables(input, search, scaledDCTBases, request), {blk, oCell, oTile} = b16Blocks(input, weight ?? new Float64Array(stride * rows), this.cellsX, this.cellRows);
    Object.assign(this, {oCell, oTile, K: this.upload(K), T: this.upload(T), blk: this.upload(blk)});
    const budget = Math.min(64 << 20, device.limits.maxStorageBufferBindingSize);
    this.bandCells = Math.max(1, Math.min(this.cellRows, request.devicePlanes ? 16 : this.cellRows, Math.floor(budget / (3 * this.W * 16 * 8))));
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
  const {device, ds, stride, rows, request} = session, pipeline = await b16Pipeline(device, ds);
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
  const pipeline = await b16Pipeline(device, ds), stride = Math.ceil(width / 8), rows = Math.ceil(height / 8), hf = new Float64Array(stride * rows);
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

export async function gpuBlocks16Mask(device, request, ds, core) {
  return b16Scoped(device, 'gpuBlocks16Mask', async () => { const session = new B16Session(device, request, ds, core); try { return await b16Mask(session); } finally { session.destroy(); } });
}
