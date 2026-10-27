// SPDX-License-Identifier: MIT
import {GpuButteraugli} from './gpu-butteraugli.mjs';
import {UniformRing} from './gpu-uniforms.mjs';
import {GpuSsimulacra2Measure} from './gpu-ssimulacra2-measure.mjs';
import {GpuNativeSsimulacra2} from './gpu-ssimulacra2-native.mjs';
import {coefficientPlanes, epfInverseSigma, inverseBasis, half, rcLlfFromDC} from './reconstruct.mjs';
import {TRANSFORMS} from './vardct-strategies.mjs';
import {SRGB_TO_LINEAR} from './ssimulacra2.mjs';

const GR_WG = 128, GR_CORE = 1024, GR_MARGIN = 128;
const grF = v => { const s = Math.fround(v).toString(); return /[.eE]/.test(s) ? s : s + '.0'; };
const GR_GAB = [0.115169525, 0.061248592];
const GR_ONE = [1 - 0.05465007330715401, 1 - 0.07005449891748593, 1 - 0.049935103337343655];
const GR_BIAS = 0.0037930732552754493, GR_ROOT_BIAS = Math.cbrt(GR_BIAS);
const GR_M = [0.3, 0.622, 0.078, 0.23, 0.692, 0.078, 0.24342268924547819, 0.20476744424496821, 0.5518098665095536];
const GR_INV = (() => {
  const [a, b, c, d, e, g, h, i, j] = GR_M, det = a * (e * j - g * i) - b * (d * j - g * h) + c * (d * i - e * h);
  return [(e * j - g * i) / det, (c * i - b * j) / det, (b * g - c * e) / det, (g * h - d * j) / det, (a * j - c * h) / det,
    (c * d - a * g) / det, (d * i - e * h) / det, (b * h - a * i) / det, (a * e - b * d) / det];
})();

function grShader(buffers, body, extra = '') {
  return `struct Params { w: u32, h: u32, i0: u32, i1: u32, i2: u32, i3: u32, a: f32, b: f32 }
@group(0) @binding(0) var<uniform> P: Params;
${buffers.map(([name, access, type = 'array<f32>'], k) => `@group(0) @binding(${k + 1}) var<storage, ${access}> ${name}: ${type};`).join('\n')}
${extra}
@compute @workgroup_size(${GR_WG})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x; if (i >= P.w * P.h) { return; }
  let x = i % P.w; let y = i / P.w;
  ${body}
}`;
}
const GR_R = (...n) => n.map(x => [x, 'read']), GR_W = (...n) => n.map(x => [x, 'read_write']);
const GR_OFFSET = {8: 0, 16: 64, 32: 320, 64: 1344}, GR_BASIS = 5440;
const grBlockOf = `
  let cell = cells[(y >> 3u) * P.i0 + (x >> 3u)];
  let x0 = (cell & 4095u) * 8u - P.i2; let y0 = ((cell >> 12u) & 4095u) * 8u - P.i3;
  let bw = (((cell >> 24u) & 15u) + 1u) * 8u; let bh = ((cell >> 28u) + 1u) * 8u;
  let ow = select(select(select(1344u, 320u, bw == 32u), 64u, bw == 16u), 0u, bw == 8u);
  let oh = select(select(select(1344u, 320u, bh == 32u), 64u, bh == 16u), 0u, bh == 8u);`;

const GR_SHADERS = {
  rows: grShader([['cells', 'read', 'array<u32>'], ...GR_R('basis', 'coef'), ...GR_W('tmp')], `${grBlockOf}
    var s = 0.0; let lx = x - x0;
    for (var u = 0u; u < bw; u++) { s += coef[y * P.w + x0 + u] * basis[ow + u * bw + lx]; }
    tmp[i] = s;`),
  cols: grShader([['cells', 'read', 'array<u32>'], ...GR_R('basis', 'tmp'), ...GR_W('out')], `${grBlockOf}
    var s = 0.0; let ly = y - y0;
    for (var v = 0u; v < bh; v++) { s += tmp[(y0 + v) * P.w + x] * basis[oh + v * bh + ly]; }
    out[i] = s;`),
  gaborish: grShader([...GR_R('src'), ...GR_W('dst')], `
    let u = max(i32(y) - 1, 0); let d = min(y + 1u, P.h - 1u); let l = max(i32(x) - 1, 0); let r = min(x + 1u, P.w - 1u);
    let S = P.i0; let c = 1.0 - 4.0 * (P.a + P.b);
    dst[y * S + x] = src[y * S + x] * c + P.a * (src[u32(u) * S + x] + src[d * S + x] + src[y * S + u32(l)] + src[y * S + r])
      + P.b * (src[u32(u) * S + u32(l)] + src[u32(u) * S + r] + src[d * S + u32(l)] + src[d * S + r]);`),
  epf: grShader([...GR_R('x0p', 'y0p', 'b0p', 'sigma'), ...GR_W('x1p', 'y1p', 'b1p')], `
    let s = sigma[(y >> 3u) * P.i1 + (x >> 3u)];
    let S = P.i0; let me = y * S + x;
    if (s < ${grF(-3.90524291751269967465540850526868)}) { x1p[me] = x0p[me]; y1p[me] = y0p[me]; b1p[me] = b0p[me]; return; }
    let border = (y & 7u) == 0u || (y & 7u) == 7u || (x & 7u) == 0u || (x & 7u) == 7u;
    let inv = s * select(P.a, P.b, border);
    var w = 1.0; var acc = vec3f(x0p[me], y0p[me], b0p[me]);
    for (var n = 0; n < 4; n++) {
      let dx = EPF_DX[n]; let dy = EPF_DY[n];
      var sad = 0.0;
      for (var o = 0; o < 5; o++) {
        let ox = EPF_OX[o]; let oy = EPF_OY[o];
        let a = at(i32(x) + ox, i32(y) + oy); let b = at(i32(x) + dx + ox, i32(y) + dy + oy);
        sad += abs(x0p[a] - x0p[b]) * 40.0 + abs(y0p[a] - y0p[b]) * 5.0 + abs(b0p[a] - b0p[b]) * 3.5;
      }
      let weight = max(0.0, 1.0 + sad * inv); let k = at(i32(x) + dx, i32(y) + dy);
      w += weight; acc += weight * vec3f(x0p[k], y0p[k], b0p[k]);
    }
    let o3 = acc / w; x1p[me] = o3.x; y1p[me] = o3.y; b1p[me] = o3.z;`,
  `const EPF_DX = array<i32, 4>(0, -1, 1, 0); const EPF_DY = array<i32, 4>(-1, 0, 0, 1);
const EPF_OX = array<i32, 5>(0, 0, -1, 1, 0); const EPF_OY = array<i32, 5>(0, -1, 0, 0, 1);
fn mir(v: i32, n: i32) -> i32 { if (v < 0) { return -v - 1; } if (v >= n) { return 2 * n - v - 1; } return v; }
fn at(x: i32, y: i32) -> u32 { return u32(mir(y, i32(P.h))) * P.i0 + u32(mir(x, i32(P.w))); }`),
  linear: grShader([...GR_R('xp', 'yp', 'bp'), ...GR_W('r', 'g', 'b')], `
    let k = y * P.i0 + x; let X = xp[k]; let Y = yp[k]; let B = bp[k]; let rb = ${grF(GR_ROOT_BIAS)};
    let l = pow3(Y + X + rb) - ${grF(GR_BIAS)}; let m = pow3(Y - X + rb) - ${grF(GR_BIAS)}; let s = pow3(B + rb) - ${grF(GR_BIAS)};
    r[i] = ${grF(GR_INV[0])} * l + ${grF(GR_INV[1])} * m + ${grF(GR_INV[2])} * s;
    g[i] = ${grF(GR_INV[3])} * l + ${grF(GR_INV[4])} * m + ${grF(GR_INV[5])} * s;
    b[i] = ${grF(GR_INV[6])} * l + ${grF(GR_INV[7])} * m + ${grF(GR_INV[8])} * s;`, `fn pow3(v: f32) -> f32 { return v * v * v; }`),
  cells: grShader([...GR_R('map'), ...GR_W('out')], `
    let cx = (x + P.i2) * 8u; let cy = (y + P.i3) * 8u; let m = u32(P.b);
    var sp = 0.0; var mx = 0.0; var mm = 0.0; var s3 = 0.0; var s6 = 0.0; var s12 = 0.0;
    for (var yy = cy; yy < min(cy + 8u, P.i1); yy++) { for (var xx = cx; xx < min(cx + 8u, P.i0); xx++) {
      let d = map[yy * P.i0 + xx]; let d3 = d * d * d;
      sp += select(0.0, pow(max(d, 1e-30), P.a), d > 0.0); mx = max(mx, d); s3 += d3; s6 += d3 * d3; s12 += d3 * d3 * d3 * d3;
    } }
    for (var yy = max(i32(cy) - i32(m), 0); yy < min(i32(cy + 8u + m), i32(P.i1)); yy++) {
      for (var xx = max(i32(cx) - i32(m), 0); xx < min(i32(cx + 8u + m), i32(P.i0)); xx++) { mm = max(mm, map[u32(yy) * P.i0 + u32(xx)]); } }
    let o = i * 6u; out[o] = sp; out[o + 1u] = mm; out[o + 2u] = mx; out[o + 3u] = s3; out[o + 4u] = s6; out[o + 5u] = s12;`),
  dequant8: grShader([['levels', 'read', 'array<u32>'], ...GR_R('consts', 'blocks'), ...GR_W('cx', 'cy', 'cb')], `
    let gx = x + P.i2; let gy = y + P.i3; let blk = (gy >> 3u) * P.i0 + (gx >> 3u); let k = (gy & 7u) * 8u + (gx & 7u);
    let at = blk * 64u + k; let QF = blocks[blk * 3u]; let o = y * P.w + x;
    let ly = recon(level(P.i1 + at), 1u); let lx = recon(level(at), 0u); let lb = recon(level(2u * P.i1 + at), 2u);
    if (k == 0u) {
      let Y = f32(level(P.i1 + at)) * consts[193u];
      cy[o] = Y / 2040.0; cx[o] = f32(level(at)) * consts[192u] / 2040.0; cb[o] = (f32(level(2u * P.i1 + at)) * consts[194u] + Y) / 2040.0;
      return;
    }
    let Y = ly * consts[64u + k] / QF;
    cy[o] = Y / 2040.0;
    cx[o] = (lx * consts[k] / QF + blocks[blk * 3u + 1u] * Y) / 2040.0;
    cb[o] = (lb * consts[128u + k] / QF + blocks[blk * 3u + 2u] * Y) / 2040.0;`,
  `fn level(i: u32) -> i32 { let w = levels[i >> 1u]; return select(bitcast<i32>(w << 16u) >> 16u, bitcast<i32>(w) >> 16u, (i & 1u) == 1u); }
fn recon(q: i32, c: u32) -> f32 {
  if (q == 0) { return 0.0; } if (q == 1) { return consts[195u + c]; } if (q == -1) { return -consts[195u + c]; }
  let v = f32(q); return v - 0.145 / v;
}`),
  dequantVar: grShader([['levels', 'read', 'array<u32>'], ...GR_R('consts'), ['words', 'read', 'array<u32>'], ...GR_R('data'), ...GR_W('cx', 'cy', 'cb')], `
    let gx = x + P.i2; let gy = y + P.i3; let blk = words[(gy >> 3u) * P.i0 + (gx >> 3u)]; let o = y * P.w + x;
    let wb = P.i1 + blk * 8u; let packed = words[wb + 7u];
    let bw = ((packed >> 24u) & 15u) + 1u; let bh = (packed >> 28u) + 1u;
    let u = gx - (packed & 4095u) * 8u; let v = gy - ((packed >> 12u) & 4095u) * 8u; let w = bw * 8u; let h = bh * 8u;
    let pos = select(v * w + u, u * h + v, h >= w); let L = max(bw, bh); let S = min(bw, bh);
    let row = pos / (L * 8u); let col = pos % (L * 8u); let size = w * h;
    let lo = words[wb]; let so = words[wb + 1u]; let sn = words[wb + 2u]; let fo = words[wb + 3u];
    if (row < S && col < L) {
      let f = fo + row * L + col; let n = L * S;
      cx[o] = data[f] / 255.0; cy[o] = data[f + n] / 255.0; cb[o] = data[f + 2u * n] / 255.0;
      return;
    }
    let QF = 8.0 * bitcast<f32>(words[wb + 4u]);
    let Y = recon(level(lo + size + pos), 1u) * data[so + sn + pos] / QF;
    cy[o] = Y / 255.0;
    cx[o] = (recon(level(lo + pos), 0u) * data[so + pos] / QF + bitcast<f32>(words[wb + 5u]) * Y) / 255.0;
    cb[o] = (recon(level(lo + 2u * size + pos), 2u) * data[so + 2u * sn + pos] / QF + bitcast<f32>(words[wb + 6u]) * Y) / 255.0;`,
  `fn level(i: u32) -> i32 { let w = levels[i >> 1u]; return select(bitcast<i32>(w << 16u) >> 16u, bitcast<i32>(w) >> 16u, (i & 1u) == 1u); }
fn recon(q: i32, c: u32) -> f32 {
  if (q == 0) { return 0.0; } if (q == 1) { return consts[195u + c]; } if (q == -1) { return -consts[195u + c]; }
  let v = f32(q); return v - 0.145 / v;
}`),
  crop: grShader([...GR_R('rs', 'gs', 'bs'), ...GR_W('r', 'g', 'b')], `
    let k = (y + P.i3) * P.i0 + x + P.i2; r[i] = rs[k]; g[i] = gs[k]; b[i] = bs[k];`),
  cropLo: grShader([['rgba', 'read', 'array<u32>'], ['lutLo', 'read', 'array<f32, 256>'], ...GR_W('dst')], `
    let p = rgba[(y + P.i3) * P.i0 + x + P.i2]; let n = P.w * P.h;
    dst[i] = lutLo[p & 255u]; dst[n + i] = lutLo[(p >> 8u) & 255u]; dst[2u * n + i] = lutLo[(p >> 16u) & 255u];`),
};

export const GR_REFERENCE_BUDGET = 0;

export function gpuSetup(start, {signal, dispose = owner => owner?.destroy?.()} = {}) {
  if (signal !== undefined && (typeof signal?.addEventListener !== 'function' || typeof signal?.aborted !== 'boolean'))
    return Promise.reject(new TypeError('signal must be an AbortSignal.'));
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    let canceled = false;
    const release = owner => { try { dispose(owner); } catch {  } };
    const onAbort = () => { canceled = true; signal.removeEventListener('abort', onAbort); release(); reject(signal.reason); };
    signal?.addEventListener('abort', onAbort, {once: true});
    let pending;
    try { pending = start(); }
    catch (error) { signal?.removeEventListener('abort', onAbort); reject(error); return; }
    Promise.resolve(pending).then(owner => {
      signal?.removeEventListener('abort', onAbort);
      if (canceled || signal?.aborted) { release(owner); if (!canceled) reject(signal.reason); }
      else resolve(owner);
    }, error => { signal?.removeEventListener('abort', onAbort); if (!canceled) reject(error); });
  });
}

export class GpuMeasure {
  static async create(device, rgba, width, height, {tile = GR_CORE, keepReference = false, referenceBytes = 0, signal} = {}) {
    if (!Number.isSafeInteger(tile) || tile < 64 || tile % 64) throw new RangeError('GPU metric tile must be a positive multiple of 64.');
    if (!Number.isSafeInteger(referenceBytes) || referenceBytes < 0) throw new RangeError('GPU reference allowance must be nonnegative bytes.');
    if (keepReference !== true && keepReference !== false && (!Number.isSafeInteger(keepReference) || keepReference < 0))
      throw new RangeError('GPU kept references must be a boolean or nonnegative tile count.');
    const self = new GpuMeasure();
    return gpuSetup(async () => {
      device.pushErrorScope('validation'); device.pushErrorScope('out-of-memory');
      let remaining = 2;
      try {
        self.init(device, rgba, width, height, tile);
        const setBytes = self.ba.levels.reduce((a, lv) => a + 12 * Math.max(16, Math.ceil(lv.n / 4) * 16), 0);
        const requested = keepReference === true ? self.tiles.length : keepReference === false ? 0 : keepReference;
        const keep = Math.min(self.tiles.length, requested, Math.floor(referenceBytes / setBytes));
        if (keep && self.tiles.length > 1) self.tileReferences = self.tiles.map((_, i) => i < keep ? self.ba.levels.map((_, k) => self.ba.referenceSet(k)) : null);
        self._cacheBytes = self.tiles.length > 1 ? keep * setBytes : 0;
        self.reservedReferenceBytes = referenceBytes;
        remaining--; const memory = await device.popErrorScope();
        remaining--; const validation = await device.popErrorScope();
        if (self.lost || memory || validation) throw Object.assign(new Error('GPU metric creation failed.'), {code: 'JXL_GPU', cause: memory ?? validation ?? self.lost});
        return self;
      } catch (error) { self.destroy(); throw error; }
      finally { while (remaining-- > 0) await device.popErrorScope().catch(() => null); }
    }, {signal, dispose: () => self.destroy()});
  }

  get cacheBytes() { return this.destroyed ? 0 : this._cacheBytes ?? 0; }
  get lost() { return this.lossState?.info ?? null; }

  get gpuBufferBytes() {
    if (this.destroyed) return 0;
    const all = new Set(), add = b => { if (b) all.add(b); };
    for (const owner of [this, this.ba, this.s2, this.native, this.varblockResources]) if (owner) {
      for (const b of owner.buffers ?? []) add(b);
      for (const key of ['read', 'mapRead', 'levels', 'blockParams', 'consts', 'varWords', 'varData']) {
        const b = owner[key]; if (b && typeof b.size === 'number') add(b);
      }
      add(owner.ring?.buffer); for (const b of owner.ring?.overflow ?? []) add(b);
    }
    let bytes = 0; for (const b of all) bytes += b.size; return bytes;
  }

  get hostBufferBytes() {
    return this.destroyed ? 0 : [this, this.ba, this.s2, this.native].reduce((n, o) => n + (o?.ring?.data?.byteLength ?? 0), 0);
  }

  init(device, rgba, width, height, tile) {
    this.rgba = rgba; this.destroyed = false; this.measuring = false;
    this.stats = {gpuProbes: 0, failures: 0};
    const lossState = this.lossState = {info: null};
    device.lost?.then(info => { lossState.info = info ?? {reason: 'unknown'}; });
    this.device = device; this.width = width; this.height = height;
    this.tiles = [];
    for (let y = 0; y < height; y += tile) for (let x = 0; x < width; x += tile) {
      const rx = Math.max(0, x - GR_MARGIN), ry = Math.max(0, y - GR_MARGIN);
      this.tiles.push({x, y, cw: Math.min(tile, width - x), ch: Math.min(tile, height - y), rx, ry,
        rw: Math.min(width, x + tile + GR_MARGIN) - rx, rh: Math.min(height, y + tile + GR_MARGIN) - ry});
    }
    const maxW = Math.max(...this.tiles.map(t => t.rw)), maxH = Math.max(...this.tiles.map(t => t.rh));
    const PW = Math.ceil(maxW / 8) * 8, PH = Math.ceil(maxH / 8) * 8;
    this.ba = new GpuButteraugli(); this.ba.init(device, maxW, maxH);
    this.sharedReference = this.ba.levels.map(lv => lv.ref);
    this.pipelines = {};
    for (const [name, code] of Object.entries(GR_SHADERS)) this.pipelines[name] = device.createComputePipeline({layout: 'auto', compute: {module: device.createShaderModule({code}), entryPoint: 'main'}});
    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    this.buffers = [];
    const buffer = bytes => { const b = device.createBuffer({size: Math.max(16, Math.ceil(bytes / 16) * 16), usage}); this.buffers.push(b); return b; };
    const plane = () => buffer(PW * PH * 4);
    this.coef = [plane(), plane(), plane()]; this.xyb = [plane(), plane(), plane()]; this.tmp = plane(); this.filtered = [plane(), plane(), plane()];
    this.cellsBuf = buffer((PW / 8) * (PH / 8) * 4); this.sigmaBuf = buffer((PW / 8) * (PH / 8) * 4);
    this.basis = buffer(GR_BASIS * 4);
    const basis = new Float32Array(GR_BASIS);
    for (const n of [8, 16, 32, 64]) basis.set(inverseBasis(n), GR_OFFSET[n]);
    device.queue.writeBuffer(this.basis, 0, basis);
    const maxCells = Math.max(...this.tiles.map(t => Math.ceil(t.cw / 8) * Math.ceil(t.ch / 8)));
    this.out = buffer(maxCells * 24);
    let readBytes = 0;
    for (const t of this.tiles) { t.readOffset = readBytes; readBytes += Math.ceil(t.cw / 8) * Math.ceil(t.ch / 8) * 24; }
    this.readBytes = readBytes;
    this.read = device.createBuffer({size: Math.max(16, readBytes), usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST});
    const n = width * height, channel = new Float32Array(n);
    this.reference = [0, 1, 2].map(c => {
      for (let i = 0; i < n; i++) channel[i] = SRGB_TO_LINEAR[rgba[i * 4 + c]];
      const b = buffer(n * 4); device.queue.writeBuffer(b, 0, channel); return b;
    });
    this.referenceRgba = buffer(n * 4); device.queue.writeBuffer(this.referenceRgba, 0, rgba.buffer, rgba.byteOffset, n * 4);
    this.lutLo = buffer(256 * 4); device.queue.writeBuffer(this.lutLo, 0, Float32Array.from(SRGB_TO_LINEAR, v => v - Math.fround(v)));
    this.ring = new UniformRing(device);
    this.gpuDequant = true;
  }

  run(pass, name, grid, buffers, params = {}) {
    const ring = this.ring, at = ring.take(), uv = at === null ? new Uint32Array(8) : ring.u32, fv = at === null ? new Float32Array(uv.buffer) : ring.f32, o = at ?? 0;
    uv[o] = grid[0]; uv[o + 1] = grid[1]; uv[o + 2] = params.i0 ?? 0; uv[o + 3] = params.i1 ?? 0; uv[o + 4] = params.i2 ?? 0; uv[o + 5] = params.i3 ?? 0;
    fv[o + 6] = params.a ?? 0; fv[o + 7] = params.b ?? 0;
    const p = this.pipelines[name];
    pass.setPipeline(p);
    pass.setBindGroup(0, ring.bind(p, at, buffers, uv));
    pass.dispatchWorkgroups(Math.ceil(grid[0] * grid[1] / GR_WG));
  }

  fits(...sizes) {
    const {maxStorageBufferBindingSize, maxBufferSize} = this.device.limits;
    return sizes.every(bytes => Math.ceil(bytes / 16) * 16 <= Math.min(maxStorageBufferBindingSize, maxBufferSize));
  }

  uploadLevels(image) {
    const comps = image.components, stride = comps[0].stride, rows = comps[0].rows, n = stride * rows;
    if (!this.gpuDequant) return null;
    if (image.strategyData) return image.wideCoefficients ? null : this.uploadVarblocks(image);
    if (comps.some(c => !(c.coeffs instanceof Int16Array) || c.coeffs.length !== n * 64)) return null;
    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, bytes = 3 * n * 128;
    if (!this.fits(bytes, n * 12)) return null;
    if (!this.levels || this.levels.size < bytes) { this.levels?.destroy(); this.levels = this.device.createBuffer({size: bytes, usage}); }
    if (!this.blockParams || this.blockParams.size < n * 12) { this.blockParams?.destroy(); this.blockParams = this.device.createBuffer({size: Math.ceil(n * 12 / 16) * 16, usage}); }
    this.consts ??= this.device.createBuffer({size: 198 * 4, usage});
    for (let c = 0; c < 3; c++) this.device.queue.writeBuffer(this.levels, c * n * 128, comps[c].coeffs.buffer, comps[c].coeffs.byteOffset, n * 128);
    const QS = image.quantScale || 256, consts = new Float32Array(198);
    for (let c = 0; c < 3; c++) {
      for (let k = 0; k < 64; k++) consts[c * 64 + k] = comps[c].quant[k];
      consts[192 + c] = half(comps[c].quant[0] / (255 * 8 * QS) * 128) / 128 * 255 * 8; consts[195 + c] = GR_ONE[c];
    }
    this.device.queue.writeBuffer(this.consts, 0, consts);
    const cfl = image.cfl, base = image.quantFieldBase || 1, fields = image.quantFields, params = new Float32Array(n * 3), cells = new Uint32Array(n);
    for (let by = 0; by < rows; by++) for (let bx = 0; bx < stride; bx++) {
      const i = by * stride + bx, t = (by >> 3) * cfl.width + (bx >> 3);
      params[i * 3] = QS * (fields ? fields[i] / base : 1); params[i * 3 + 1] = cfl.x[t] / 84; params[i * 3 + 2] = 1 + cfl.b[t] / 84;
      cells[i] = bx | by << 12;
    }
    this.device.queue.writeBuffer(this.blockParams, 0, params);
    return {cells, stride, n, pass: 'dequant8', buffers: [this.levels, this.consts, this.blockParams]};
  }

  uploadVarblocks(image) {
    const comps = image.components, stride = comps[0].stride, rows = comps[0].rows, n = stride * rows, sd = image.strategyData;
    const QS = image.quantScale || 256, cfl = image.cfl, base = image.quantFieldBase || 1, fields = image.quantFields, blocks = sd.blocks;
    const dcStep = comps.map(c => half(c.quant[0] / (255 * 8 * QS) * 128) / 128 * 255 * 8);
    const families = new Map(); let steps = 0, levels = 0, llf = 0;
    for (const block of blocks) {
      const family = TRANSFORMS[block.id].table;
      if (!families.has(family)) { const len = sd.tables.get(family).planes[0].length; families.set(family, {at: steps, len}); steps += 3 * len; }
      levels += 3 * block.size; llf += 3 * block.bw * block.bh;
    }
    if (!this.fits((levels + (levels & 1)) * 2, (steps + llf) * 4, (n + blocks.length * 8) * 4)) return null;
    const level16 = new Int16Array(levels + (levels & 1)), data = new Float32Array(steps + llf), words = new Uint32Array(n + blocks.length * 8), wf = new Float32Array(words.buffer);
    for (const [family, {at, len}] of families) for (let c = 0; c < 3; c++) data.set(sd.tables.get(family).planes[c], at + c * len);
    const cells = new Uint32Array(n);
    let lo = 0, fo = steps;
    for (let b = 0; b < blocks.length; b++) {
      const {id, bx, by, bw, bh, size} = blocks[b], {at, len} = families.get(TRANSFORMS[id].table), packed = bx | by << 12 | (bw - 1) << 24 | (bh - 1) << 28;
      for (let c = 0; c < 3; c++) level16.set(blocks[b].coeffs[c], lo + c * size);
      for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) { const pos = (by + y) * stride + bx + x; words[pos] = b; cells[pos] = packed; }
      const t = (by >> 3) * cfl.width + (bx >> 3), wb = n + b * 8;
      words[wb] = lo; words[wb + 1] = at; words[wb + 2] = len; words[wb + 3] = fo;
      wf[wb + 4] = QS * (fields ? fields[by * stride + bx] / base : 1); wf[wb + 5] = cfl.x[t] / 84; wf[wb + 6] = 1 + cfl.b[t] / 84; words[wb + 7] = packed;
      const means = new Float64Array(bw * bh);
      for (let c = 0; c < 3; c++) {
        for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
          const pos = (by + y) * stride + bx + x;
          means[y * bw + x] = (comps[c].dc[pos] * dcStep[c] + (c === 2 ? comps[1].dc[pos] * dcStep[1] : 0)) / 8;
        }
        data.set(rcLlfFromDC(means, bw, bh), fo + c * bw * bh);
      }
      lo += 3 * size; fo += 3 * bw * bh;
    }
    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, sized = (old, bytes) => {
      if (old && old.size >= bytes) return old;
      old?.destroy(); return this.device.createBuffer({size: Math.max(16, Math.ceil(bytes / 16) * 16), usage});
    };
    this.levels = sized(this.levels, level16.byteLength); this.varWords = sized(this.varWords, words.byteLength); this.varData = sized(this.varData, data.byteLength);
    this.consts ??= this.device.createBuffer({size: 198 * 4, usage});
    this.device.queue.writeBuffer(this.levels, 0, level16); this.device.queue.writeBuffer(this.varWords, 0, words); this.device.queue.writeBuffer(this.varData, 0, data);
    this.device.queue.writeBuffer(this.consts, 195 * 4, new Float32Array(GR_ONE));
    return {cells, stride, n, pass: 'dequantVar', buffers: [this.levels, this.consts, this.varWords, this.varData]};
  }

  async measure(image, want = {}) {
    if (this.destroyed || this.lost) throw Object.assign(new Error('GPU metric device is unavailable.'), {code: 'JXL_GPU'});
    if (this.measuring) throw new Error('GPU metric measures must be sequential.');
    this.measuring = true;
    const device = this.device;
    device.pushErrorScope('validation'); device.pushErrorScope('out-of-memory');
    let remaining = 2;
    try {
      const out = await this.measureImage(image, want);
      remaining--; const memory = await device.popErrorScope();
      remaining--; const validation = await device.popErrorScope();
      if (this.lost || memory || validation) throw Object.assign(new Error('GPU metric calculation failed.'), {code: 'JXL_GPU', cause: memory ?? validation ?? this.lost});
      for (const key of ['butteraugli', 'butteraugli3', 'ssimulacra2', 'ssimulacra2Native'])
        if (out[key] !== undefined && !Number.isFinite(out[key])) throw Object.assign(new Error('GPU metric result is not finite.'), {code: 'JXL_GPU'});
      this.stats.gpuProbes++;
      return out;
    } catch (error) { this.stats.failures++; throw error; }
    finally {
      while (remaining-- > 0) await device.popErrorScope().catch(() => null);
      this.measuring = false;
    }
  }

  async measureImage(image, {p = 3, margin = 2, ssimulacra2: wantS2 = false, butteraugli: wantBA = true} = {}) {
    const native = wantS2 === 'native';
    if (native && this.native === undefined) {
      const child = await GpuNativeSsimulacra2.create(this.device, this.rgba, this.width, this.height);
      if (this.destroyed) { child?.destroy(); throw Object.assign(new Error('GPU metric owner was destroyed during setup.'), {code: 'JXL_GPU'}); }
      this.native = child;
    }
    if (wantS2 && !native && this.s2 === undefined)
      this.s2 = GpuSsimulacra2Measure.fits(this.device, this.width, this.height) ? new GpuSsimulacra2Measure(this.device, this.width, this.height, this.reference) : null;
    const s2 = wantS2 ? (native ? this.native : this.s2) : null;
    const onGpu = this.uploadLevels(image);
    const {width, height} = this, {planes, cells, W: planeWidth, stride} = onGpu || coefficientPlanes(image), sigma = image.epf ? epfInverseSigma(image) : null;
    const gab = image.gab ? [0, 1, 2].map(c => image.gab === true ? GR_GAB : image.gab[c]) : null;
    const rows = Math.ceil(height / 8), cellSums = new Float64Array(stride * rows), blocks = new Float64Array(stride * rows);
    let max = 0; const sums = [0, 0, 0];
    for (const [index, t] of this.tiles.entries()) {
      const PW = Math.ceil(t.rw / 8) * 8, PH = Math.ceil(t.rh / 8) * 8, cs = PW / 8, cr = PH / 8, cx0 = t.rx / 8, cy0 = t.ry / 8;
      const region = onGpu ? null : new Float32Array(PW * PH), cellRegion = new Uint32Array(cs * cr), sigmaRegion = new Float32Array(cs * cr);
      if (!onGpu) for (let c = 0; c < 3; c++) {
        for (let y = 0; y < PH; y++) region.set(planes[c].subarray((t.ry + y) * planeWidth + t.rx, (t.ry + y) * planeWidth + t.rx + PW), y * PW);
        this.device.queue.writeBuffer(this.coef[c], 0, region);
      }
      for (let y = 0; y < cr; y++) for (let x = 0; x < cs; x++) {
        cellRegion[y * cs + x] = cells[(cy0 + y) * stride + cx0 + x];
        if (sigma) sigmaRegion[y * cs + x] = sigma[(cy0 + y) * stride + cx0 + x];
      }
      this.device.queue.writeBuffer(this.cellsBuf, 0, cellRegion);
      if (sigma) this.device.queue.writeBuffer(this.sigmaBuf, 0, sigmaRegion);
      const encoder = this.device.createCommandEncoder(), pass = encoder.beginComputePass(), l0 = () => this.ba.levels[0];
      this.ba.resize(t.rw, t.rh);
      if (onGpu) this.run(pass, onGpu.pass, [PW, PH], [...onGpu.buffers, ...this.coef], {i0: stride, i1: onGpu.pass === 'dequant8' ? onGpu.n * 64 : onGpu.n, i2: t.rx, i3: t.ry});
      const kept = this.tileReferences?.[index];
      this.ba.levels.forEach((lv, k) => { lv.ref = kept ? kept[k] : this.sharedReference[k]; });
      if (kept ? !t.referenceReady : !(this.tiles.length === 1 && this.referenceReady)) {
        this.run(pass, 'crop', [t.rw, t.rh], [...this.reference, ...l0().rgb], {i0: width, i2: t.rx, i3: t.ry});
        this.run(pass, 'cropLo', [t.rw, t.rh], [this.referenceRgba, this.lutLo, l0().rgbLo], {i0: width, i2: t.rx, i3: t.ry});
        this.ba.referenceFromLoaded(pass);
        this.referenceReady = this.tiles.length === 1; t.referenceReady = !!kept;
      }
      for (let c = 0; c < 3; c++) {
        this.run(pass, 'rows', [PW, PH], [this.cellsBuf, this.basis, this.coef[c], this.tmp], {i0: cs, i2: t.rx, i3: t.ry});
        this.run(pass, 'cols', [PW, PH], [this.cellsBuf, this.basis, this.tmp, this.xyb[c]], {i0: cs, i2: t.rx, i3: t.ry});
      }
      let current = this.xyb;
      if (gab) {
        for (let c = 0; c < 3; c++) {
          const [w1, w2] = gab[c], n = 1 + 4 * w1 + 4 * w2;
          this.run(pass, 'gaborish', [t.rw, t.rh], [current[c], this.filtered[c]], {i0: PW, a: w1 / n, b: w2 / n});
        }
        current = this.filtered;
      }
      if (sigma) {
        const next = current === this.xyb ? this.filtered : this.xyb;
        this.run(pass, 'epf', [t.rw, t.rh], [...current, this.sigmaBuf, ...next], {i0: PW, i1: cs, a: 1.65, b: 1.65 * 2 / 3});
        current = next;
      }
      this.run(pass, 'linear', [t.rw, t.rh], [...current, ...l0().rgb], {i0: PW});
      s2?.place(pass, l0().rgb, t);
      const ccw = Math.ceil(t.cw / 8), cch = Math.ceil(t.ch / 8);
      if (!(s2 && !wantBA)) {
        this.ba.diffFromLoaded(pass);
        this.run(pass, 'cells', [ccw, cch], [l0().map, this.out], {i0: t.rw, i1: t.rh, i2: (t.x - t.rx) / 8, i3: (t.y - t.ry) / 8, a: p, b: margin});
      }
      pass.end();
      if (!(s2 && !wantBA)) encoder.copyBufferToBuffer(this.out, 0, this.read, t.readOffset, ccw * cch * 24);
      this.ring.flush(); this.ba.ring.flush(); s2?.ring.flush();
      this.device.queue.submit([encoder.finish()]);
    }
    if (s2 && !wantBA) await this.device.queue.onSubmittedWorkDone();
    else {
      await this.read.mapAsync(GPUMapMode.READ, 0, this.readBytes);
      const all = new Float32Array(this.read.getMappedRange(0, this.readBytes).slice(0));
      this.read.unmap();
      for (const t of this.tiles) {
        const ccw = Math.ceil(t.cw / 8), cch = Math.ceil(t.ch / 8), o = all.subarray(t.readOffset / 4);
        for (let y = 0; y < cch; y++) for (let x = 0; x < ccw; x++) {
          const k = (y * ccw + x) * 6, cell = (t.y / 8 + y) * stride + t.x / 8 + x;
          cellSums[cell] = o[k]; blocks[cell] = o[k + 1]; max = Math.max(max, o[k + 2]);
          sums[0] += o[k + 3]; sums[1] += o[k + 4]; sums[2] += o[k + 5];
        }
      }
    }
    this.ring.reset(); this.ba.ring.reset(); s2?.ring.reset();
    const n = width * height, butteraugli3 = sums.reduce((a, s, k) => a + Math.pow(s / n, 1 / (3 * (1 << k))), 0) / 3;
    const out = s2 && !wantBA ? {} : {butteraugli: max, butteraugli3, cells: cellSums, blocks};
    if (s2) out[native ? 'ssimulacra2Native' : 'ssimulacra2'] = (await s2.score()).score;
    return out;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.s2?.destroy(); this.native?.destroy(); for (const b of this.buffers ?? []) b.destroy();
    this.buffers = []; this.levels?.destroy(); this.blockParams?.destroy(); this.consts?.destroy(); this.varWords?.destroy(); this.varData?.destroy();
    this.read?.destroy(); this.ring?.destroy(); this.ba?.destroy();
    for (const name of ['rgba', 'tileReferences', 'sharedReference', 'reference', 'referenceRgba', 'lutLo', 'coef', 'xyb',
      'tmp', 'filtered', 'cellsBuf', 'sigmaBuf', 'basis', 'out', 'read', 'levels', 'blockParams', 'consts', 'varWords',
      'varData', 'ba', 's2', 'native', 'ring', 'pipelines', 'tiles', 'device', 'lossState']) this[name] = null;
  }
}


