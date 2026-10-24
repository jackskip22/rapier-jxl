// SPDX-License-Identifier: MIT
import {GpuButteraugli} from './gpu-butteraugli.mjs';
import {coefficientPlanes, epfInverseSigma, inverseBasis} from './reconstruct.mjs';
import {SRGB_TO_LINEAR} from './ssimulacra2.mjs';

const GR_WG = 128, GR_CORE = 1024, GR_MARGIN = 128;
const grF = v => { const s = Math.fround(v).toString(); return /[.eE]/.test(s) ? s : s + '.0'; };
const GR_GAB = [0.115169525, 0.061248592];
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
      let dx = array<i32, 4>(0, -1, 1, 0)[n]; let dy = array<i32, 4>(-1, 0, 0, 1)[n];
      var sad = 0.0;
      for (var o = 0; o < 5; o++) {
        let ox = array<i32, 5>(0, 0, -1, 1, 0)[o]; let oy = array<i32, 5>(0, -1, 0, 0, 1)[o];
        let a = at(i32(x) + ox, i32(y) + oy); let b = at(i32(x) + dx + ox, i32(y) + dy + oy);
        sad += abs(x0p[a] - x0p[b]) * 40.0 + abs(y0p[a] - y0p[b]) * 5.0 + abs(b0p[a] - b0p[b]) * 3.5;
      }
      let weight = max(0.0, 1.0 + sad * inv); let k = at(i32(x) + dx, i32(y) + dy);
      w += weight; acc += weight * vec3f(x0p[k], y0p[k], b0p[k]);
    }
    let o3 = acc / w; x1p[me] = o3.x; y1p[me] = o3.y; b1p[me] = o3.z;`,
  `fn mir(v: i32, n: i32) -> i32 { if (v < 0) { return -v - 1; } if (v >= n) { return 2 * n - v - 1; } return v; }
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
      sp += pow(d, P.a); mx = max(mx, d); s3 += d3; s6 += d3 * d3; s12 += d3 * d3 * d3 * d3;
    } }
    for (var yy = max(i32(cy) - i32(m), 0); yy < min(i32(cy + 8u + m), i32(P.i1)); yy++) {
      for (var xx = max(i32(cx) - i32(m), 0); xx < min(i32(cx + 8u + m), i32(P.i0)); xx++) { mm = max(mm, map[u32(yy) * P.i0 + u32(xx)]); } }
    let o = i * 6u; out[o] = sp; out[o + 1u] = mm; out[o + 2u] = mx; out[o + 3u] = s3; out[o + 4u] = s6; out[o + 5u] = s12;`),
  crop: grShader([...GR_R('rs', 'gs', 'bs'), ...GR_W('r', 'g', 'b')], `
    let k = (y + P.i3) * P.i0 + x + P.i2; r[i] = rs[k]; g[i] = gs[k]; b[i] = bs[k];`),
};

export class GpuMeasure {
  static async create(device, rgba, width, height, {tile = GR_CORE} = {}) {
    const self = new GpuMeasure();
    self.init(device, rgba, width, height, tile);
    return self;
  }

  init(device, rgba, width, height, tile) {
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
    this.read = device.createBuffer({size: this.out.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST});
    const n = width * height, lin = [0, 1, 2].map(() => new Float32Array(n));
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) lin[c][i] = SRGB_TO_LINEAR[rgba[i * 4 + c]];
    this.reference = lin.map(p => { const b = buffer(n * 4); device.queue.writeBuffer(b, 0, p); return b; });
    this.uniforms = [];
  }

  run(pass, name, grid, buffers, params = {}) {
    const u = this.device.createBuffer({size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
    const data = new ArrayBuffer(32), uv = new Uint32Array(data), fv = new Float32Array(data);
    uv[0] = grid[0]; uv[1] = grid[1]; uv[2] = params.i0 ?? 0; uv[3] = params.i1 ?? 0; uv[4] = params.i2 ?? 0; uv[5] = params.i3 ?? 0;
    fv[6] = params.a ?? 0; fv[7] = params.b ?? 0;
    this.device.queue.writeBuffer(u, 0, data); this.uniforms.push(u);
    const p = this.pipelines[name];
    pass.setPipeline(p);
    pass.setBindGroup(0, this.device.createBindGroup({layout: p.getBindGroupLayout(0), entries: [u, ...buffers].map((b, i) => ({binding: i, resource: {buffer: b}}))}));
    pass.dispatchWorkgroups(Math.ceil(grid[0] * grid[1] / GR_WG));
  }

  async measure(image, {p = 3, margin = 2} = {}) {
    const {width, height} = this, {planes, cells, W: planeWidth, stride} = coefficientPlanes(image), sigma = image.epf ? epfInverseSigma(image) : null;
    const gab = image.gab ? [0, 1, 2].map(c => image.gab === true ? GR_GAB : image.gab[c]) : null;
    const rows = Math.ceil(height / 8), cellSums = new Float64Array(stride * rows), blocks = new Float64Array(stride * rows);
    let max = 0; const sums = [0, 0, 0];
    for (const t of this.tiles) {
      const PW = Math.ceil(t.rw / 8) * 8, PH = Math.ceil(t.rh / 8) * 8, cs = PW / 8, cr = PH / 8, cx0 = t.rx / 8, cy0 = t.ry / 8;
      const region = new Float32Array(PW * PH), cellRegion = new Uint32Array(cs * cr), sigmaRegion = new Float32Array(cs * cr);
      for (let c = 0; c < 3; c++) {
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
      this.run(pass, 'crop', [t.rw, t.rh], [...this.reference, ...l0().rgb], {i0: width, i2: t.rx, i3: t.ry});
      this.ba.referenceFromLoaded(pass);
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
      this.ba.diffFromLoaded(pass);
      const ccw = Math.ceil(t.cw / 8), cch = Math.ceil(t.ch / 8);
      this.run(pass, 'cells', [ccw, cch], [l0().map, this.out], {i0: t.rw, i1: t.rh, i2: (t.x - t.rx) / 8, i3: (t.y - t.ry) / 8, a: p, b: margin});
      pass.end();
      encoder.copyBufferToBuffer(this.out, 0, this.read, 0, ccw * cch * 24);
      this.device.queue.submit([encoder.finish()]);
      await this.read.mapAsync(GPUMapMode.READ, 0, ccw * cch * 24);
      const o = new Float32Array(this.read.getMappedRange(0, ccw * cch * 24).slice(0));
      this.read.unmap();
      for (const u of this.uniforms) u.destroy();
      this.uniforms = []; this.ba.freeUniforms();
      for (let y = 0; y < cch; y++) for (let x = 0; x < ccw; x++) {
        const k = (y * ccw + x) * 6, cell = (t.y / 8 + y) * stride + t.x / 8 + x;
        cellSums[cell] = o[k]; blocks[cell] = o[k + 1]; max = Math.max(max, o[k + 2]);
        sums[0] += o[k + 3]; sums[1] += o[k + 4]; sums[2] += o[k + 5];
      }
    }
    const n = width * height, butteraugli3 = sums.reduce((a, s, k) => a + Math.pow(s / n, 1 / (3 * (1 << k))), 0) / 3;
    return {butteraugli: max, butteraugli3, cells: cellSums, blocks};
  }

  destroy() { for (const b of this.buffers) b.destroy(); this.read.destroy(); this.ba.destroy(); }
}

