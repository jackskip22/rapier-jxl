// SPDX-License-Identifier: MIT

const GC_GAB = [0.115169525, 0.061248592], GC_MARGIN = 8;

function gcTemplate(lib, data, width, height, quality, options) {
  const {complete, photoXYBSteps} = lib;
  const stride = Math.ceil(width / 8), rows = Math.ceil(height / 8);
  const probe = complete(photoXYBSteps(new Uint8Array(256).fill(128), 8, 8, quality, options));
  let alpha = null;
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) { alpha = data; break; }
  const tileWidth = Math.ceil(stride / 8), tiles = tileWidth * Math.ceil(rows / 8);
  return {...probe, width, height, alpha, components: probe.components.map(c => ({...c, stride, rows, coeffs: new Int16Array(stride * rows * 64)})),
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
    for (let k = 1; k < 64; k++) {
      const coefficient = sums[from + k] - (c !== 1 ? share * sums[64 + k] : 0);
      const value = coefficient * 256 / quant[k] * 1;
      out[offset + k] = Math.abs(value) < th[k] ? 0 : Math.round(value);
    }
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

export {gcTemplate, gcThresholds, gcExactTile, gcExactBlock};

const GC_K = 16, GC_EPS = 5.9604645e-8, GC_WG = 128, GC_BIAS = 0.0037930732552754493;
const gcF = v => { const s = Math.fround(v).toString(); return /[.eE]/.test(s) ? s : s + '.0'; };
const GC_LINEAR = Float32Array.from({length: 256}, (_, i) => { const v = i / 255; return v <= 10 / 255 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
const GC_ID = `let i = (wid.y * P.groupsX + wid.x) * ${GC_WG}u + lid;`;
const GC_HEAD = `struct Params { W: u32, H: u32, width: u32, height: u32, stride: u32, rows: u32, groupsX: u32, c: u32, a: f32, b: f32, d: f32, e: f32 }
@group(0) @binding(0) var<uniform> P: Params;`;
const gcKernel = (bindings, body, extra = '') => `${GC_HEAD}
${bindings.map(([name, access, type], k) => `@group(0) @binding(${k + 1}) var<storage, ${access}> ${name}: ${type};`).join('\n')}
${extra}
@compute @workgroup_size(${GC_WG})
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_index) lid: u32) {
  ${GC_ID}
  ${body}
}`;
const F = 'array<f32>', U = 'array<u32>';
export const GC_SHADERS = {
  xyb: gcKernel([['rgba', 'read', U], ['lut', 'read', F], ['tx', 'read_write', F], ['ty', 'read_write', F], ['tb', 'read_write', F]], `
    if (i >= P.W * P.H) { return; }
    let x = min(i % P.W, P.width - 1u); let y = min(i / P.W, P.height - 1u); let p = rgba[y * P.width + x];
    let r = lut[p & 255u]; let g = lut[(p >> 8u) & 255u]; let b = lut[(p >> 16u) & 255u];
    let l = cbrt(${gcF(0.3)} * r + ${gcF(0.622)} * g + ${gcF(0.078)} * b + ${gcF(GC_BIAS)}) - ${gcF(Math.cbrt(GC_BIAS))};
    let m = cbrt(${gcF(0.23)} * r + ${gcF(0.692)} * g + ${gcF(0.078)} * b + ${gcF(GC_BIAS)}) - ${gcF(Math.cbrt(GC_BIAS))};
    let s = cbrt(${gcF(0.24342268924547819)} * r + ${gcF(0.20476744424496821)} * g + ${gcF(0.5518098665095536)} * b + ${gcF(GC_BIAS)}) - ${gcF(Math.cbrt(GC_BIAS))};
    tx[i] = (l - m) * 127.5; let Y = (l + m) * 127.5; ty[i] = Y; tb[i] = s * 255.0 - Y;`,
    `fn cbrt(v: f32) -> f32 { let r = pow(v, 1.0 / 3.0); return (2.0 * r + v / (r * r)) / 3.0; }`),
  gab: gcKernel([['t', 'read', F], ['x', 'read', F], ['next', 'read_write', F]], `
    if (i >= P.W * P.H) { return; }
    let px = i % P.W; let py = i / P.W;
    let u = select(py - 1u, 0u, py == 0u) * P.W; let m = py * P.W; let d = min(py + 1u, P.H - 1u) * P.W;
    let l = select(px - 1u, 0u, px == 0u); let r = min(px + 1u, P.W - 1u);
    let g = (x[m + px] + P.a * (x[u + px] + x[d + px] + x[m + l] + x[m + r]) + P.b * (x[u + l] + x[u + r] + x[d + l] + x[d + r])) * P.d;
    next[i] = x[i] + (t[i] - g);`),
  finish: gcKernel([['t', 'read_write', F], ['x', 'read', F]], `if (i >= P.W * P.H) { return; } t[i] = t[i] + P.a * (x[i] - t[i]);`),
  dct: gcKernel([['pre', 'read', F], ['basis', 'read', F], ['out', 'read_write', F]], `
    if (i >= P.stride * P.rows * 64u) { return; }
    let blk = i / 64u; let k = i % 64u; let v = k / 8u; let u = k % 8u;
    let x0 = (blk % P.stride) * 8u; let y0 = (blk / P.stride) * 8u;
    var s = 0.0;
    for (var y = 0u; y < 8u; y++) {
      var row = 0.0;
      for (var x = 0u; x < 8u; x++) { row += pre[(y0 + y) * P.W + x0 + x] * basis[u * 8u + x]; }
      s += row * basis[v * 8u + y];
    }
    out[i] = s;`),
  cfl: gcKernel([['cx', 'read', F], ['cy', 'read', F], ['cb', 'read', F], ['out', 'read_write', 'array<i32>'], ['doubt', 'read_write', U]], `
    let tilesX = (P.stride + 7u) / 8u; if (i >= tilesX * ((P.rows + 7u) / 8u)) { return; }
    let bx0 = (i % tilesX) * 8u; let by0 = (i / tilesX) * 8u;
    var yy = 0.0; var xy = 0.0; var by = 0.0; var ayy = 0.0; var axy = 0.0; var aby = 0.0; var ax = 0.0; var ay = 0.0; var ab = 0.0;
    for (var bj = by0; bj < min(by0 + 8u, P.rows); bj++) { for (var bi = bx0; bi < min(bx0 + 8u, P.stride); bi++) {
      let base = (bj * P.stride + bi) * 64u;
      for (var k = 1u; k < 64u; k++) {
        let X = cx[base + k]; let Y = cy[base + k]; let B = cb[base + k];
        yy += Y * Y; xy += X * Y; by += B * Y; axy += abs(X * Y); aby += abs(B * Y); ax += abs(X); ay += abs(Y); ab += abs(B);
      }
    } }
    ayy = yy;
    let ea = ${GC_K}.0 * ${gcF(GC_EPS)} * 2040.0;
    let eyy = ${GC_K}.0 * ${gcF(GC_EPS)} * ayy + 2.0 * ea * ay;
    var flag = 0u;
    for (var c = 0u; c < 2u; c++) {
      let num = select(by, xy, c == 0u); let anum = select(aby, axy, c == 0u); let aother = select(ab, ax, c == 0u);
      let enm = ${GC_K}.0 * ${gcF(GC_EPS)} * anum + ea * (aother + ay);
      let v = P.a * num / (yy + 1.0);
      let ev = P.a * (enm + abs(num) * eyy / (yy + 1.0)) / (yy + 1.0) + 4.0 * ${gcF(GC_EPS)} * abs(v) + 1e-6;
      if (abs(v - floor(v) - 0.5) <= ev && abs(v) < 129.0) { flag = 1u; }
      out[i * 2u + c] = clamp(i32(floor(v + 0.5)), -128, 127);
    }
    doubt[i] = flag;`),
  quant: gcKernel([['co', 'read', F], ['cy', 'read', F], ['tab', 'read', F], ['cfl', 'read', 'array<i32>'], ['levels', 'read_write', U], ['blockDoubt', 'read_write', 'array<atomic<u32>>']], `
    let n64 = P.stride * P.rows * 64u; if (i * 2u >= n64) { return; }
    let blk = (i * 2u) / 64u; let k0 = (i * 2u) % 64u;
    let tile = ((blk / P.stride) / 8u) * ((P.stride + 7u) / 8u) + (blk % P.stride) / 8u;
    var share = 0.0;
    if (P.c == 0u) { share = f32(cfl[tile * 2u]) / 84.0; } else if (P.c == 2u) { share = f32(cfl[tile * 2u + 1u]) / 84.0; }
    var packed = 0u; var doubt = false;
    for (var j = 0u; j < 2u; j++) {
      let k = k0 + j; let q = tab[P.c * 64u + k]; let th = tab[192u + P.c * 64u + k];
      var value = co[blk * 64u + k];
      if (k > 0u && P.c != 1u) { value = value - share * cy[blk * 64u + k]; }
      value = value * 256.0 / q;
      let e = ${GC_K}.0 * ${gcF(GC_EPS)} * 2040.0 * (1.0 + abs(share)) * 256.0 / q + 4.0 * ${gcF(GC_EPS)} * abs(value);
      let a = abs(value);
      var level = 0;
      if (a >= th) { level = i32(floor(value + 0.5)); }
      if (abs(a - th) <= e || (a >= th && abs(value - floor(value) - 0.5) <= e) || abs(level) > 32767) { doubt = true; }
      packed = packed | ((u32(level) & 65535u) << (16u * j));
    }
    levels[(P.c * n64 + i * 2u) / 2u] = packed;
    if (doubt) { atomicStore(&blockDoubt[blk], 1u); }`),
};

export class GpuCore {
  static async create(device, lib) {
    const self = new GpuCore();
    self.device = device; self.lib = lib;
    self.pipelines = {};
    for (const [name, code] of Object.entries(GC_SHADERS)) self.pipelines[name] = await device.createComputePipelineAsync({layout: 'auto', compute: {module: device.createShaderModule({code}), entryPoint: 'main'}});
    return self;
  }

  async image(data, width, height, quality, options) {
    const {device, lib} = this, image = gcTemplate(lib, data, width, height, quality, options), thresholds = gcThresholds(options.deadzone);
    const stride = Math.ceil(width / 8), rows = Math.ceil(height / 8), W = stride * 8, H = rows * 8, n = W * H, n64 = stride * rows * 64;
    const tilesX = image.cfl.width, tiles = tilesX * Math.ceil(rows / 8);
    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC, made = [];
    const buffer = (bytes, u = usage) => { const b = device.createBuffer({size: Math.max(16, Math.ceil(bytes / 16) * 16), usage: u}); made.push(b); return b; };
    device.pushErrorScope('validation'); device.pushErrorScope('out-of-memory');
    try {
      const rgba = buffer(width * height * 4); device.queue.writeBuffer(rgba, 0, data.buffer, data.byteOffset, width * height * 4);
      const lut = buffer(1024); device.queue.writeBuffer(lut, 0, GC_LINEAR);
      const t = [buffer(n * 4), buffer(n * 4), buffer(n * 4)], xa = buffer(n * 4), xb = buffer(n * 4), coef = [buffer(n64 * 4), buffer(n64 * 4), buffer(n64 * 4)];
      const basis = buffer(256), tab = buffer(384 * 4), cfl = buffer(tiles * 8), tileDoubt = buffer(tiles * 4), levels = buffer(n64 * 6), blockDoubt = buffer(stride * rows * 4);
      device.queue.writeBuffer(basis, 0, Float32Array.from(lib.dct8Basis));
      const table = new Float32Array(384);
      for (let c = 0; c < 3; c++) for (let k = 0; k < 64; k++) { table[c * 64 + k] = image.components[c].quant[k]; table[192 + c * 64 + k] = thresholds[c][k]; }
      device.queue.writeBuffer(tab, 0, table);
      const uniforms = [], run = (pass, name, count, buffers, params = {}) => {
        const groups = Math.ceil(count / GC_WG), groupsX = Math.min(groups, 65535), groupsY = Math.ceil(groups / groupsX);
        const u = buffer(48, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST), d = new ArrayBuffer(48), uv = new Uint32Array(d), fv = new Float32Array(d);
        uv.set([W, H, width, height, stride, rows, groupsX, params.c ?? 0]); fv[8] = params.a ?? 0; fv[9] = params.b ?? 0; fv[10] = params.d ?? 0; fv[11] = params.e ?? 0;
        device.queue.writeBuffer(u, 0, d); uniforms.push(u);
        const p = this.pipelines[name];
        pass.setPipeline(p);
        pass.setBindGroup(0, device.createBindGroup({layout: p.getBindGroupLayout(0), entries: [u, ...buffers].map((b, k) => ({binding: k, resource: {buffer: b}}))}));
        pass.dispatchWorkgroups(groupsX, groupsY);
      };
      const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
      run(pass, 'xyb', n, [rgba, lut, ...t]);
      const [w1, w2] = GC_GAB, norm = 1 / (1 + 4 * w1 + 4 * w2), strength = options.gaborish?.strength ?? 1;
      for (let c = 0; c < 3; c++) {
        run(pass, 'gab', n, [t[c], t[c], xa], {a: w1, b: w2, d: norm});
        run(pass, 'gab', n, [t[c], xa, xb], {a: w1, b: w2, d: norm});
        run(pass, 'gab', n, [t[c], xb, xa], {a: w1, b: w2, d: norm});
        run(pass, 'gab', n, [t[c], xa, xb], {a: w1, b: w2, d: norm});
        run(pass, 'finish', n, [t[c], xb], {a: strength});
        run(pass, 'dct', n64, [t[c], basis, coef[c]]);
      }
      run(pass, 'cfl', tiles, [...coef, cfl, tileDoubt], {a: (options.cflScale ?? 1) * 84});
      for (let c = 0; c < 3; c++) run(pass, 'quant', n64 / 2, [coef[c], coef[1], tab, cfl, levels, blockDoubt], {c});
      pass.end();
      const readLevels = buffer(n64 * 6, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST), readSmall = buffer(tiles * 12 + stride * rows * 4, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
      encoder.copyBufferToBuffer(levels, 0, readLevels, 0, n64 * 6);
      encoder.copyBufferToBuffer(cfl, 0, readSmall, 0, tiles * 8);
      encoder.copyBufferToBuffer(tileDoubt, 0, readSmall, tiles * 8, tiles * 4);
      encoder.copyBufferToBuffer(blockDoubt, 0, readSmall, tiles * 12, stride * rows * 4);
      device.queue.submit([encoder.finish()]);
      await Promise.all([readLevels.mapAsync(GPUMapMode.READ), readSmall.mapAsync(GPUMapMode.READ)]);
      const oom = await device.popErrorScope(), invalid = await device.popErrorScope();
      if (oom || invalid) throw new Error('GpuCore: ' + (oom || invalid).message);
      const all = new Int16Array(readLevels.getMappedRange().slice(0));
      for (let c = 0; c < 3; c++) image.components[c].coeffs = all.subarray(c * n64, (c + 1) * n64);
      const small = readSmall.getMappedRange(), cf = new Int32Array(small, 0, tiles * 2), td = new Uint32Array(small, tiles * 8, tiles), bd = new Uint32Array(small, tiles * 12, stride * rows);
      for (let k = 0; k < tiles; k++) { image.cfl.x[k] = cf[k * 2]; image.cfl.b[k] = cf[k * 2 + 1]; }
      let doubtfulTiles = 0, doubtfulBlocks = 0;
      const tileDone = new Uint8Array(tiles);
      for (let k = 0; k < tiles; k++) if (td[k]) { gcExactTile(lib, data, width, height, image, thresholds, options, k % tilesX, Math.floor(k / tilesX)); tileDone[k] = 1; doubtfulTiles++; }
      for (let b = 0; b < stride * rows; b++) if (bd[b]) {
        const bx = b % stride, by = Math.floor(b / stride);
        if (tileDone[(by >> 3) * tilesX + (bx >> 3)]) continue;
        gcExactBlock(lib, data, width, height, image, thresholds, options, bx, by); doubtfulBlocks++;
      }
      readLevels.unmap(); readSmall.unmap();
      return {image, doubtfulBlocks, doubtfulTiles, blocks: stride * rows, tiles};
    } finally {
      for (const b of made) b.destroy();
    }
  }
}

const gcCores = new WeakMap();
export async function gpuCoreImage(device, request) {
  try {
    let core = gcCores.get(device);
    if (!core) gcCores.set(device, core = GpuCore.create(device, request.lib));
    const {image} = await (await core).image(request.data, request.width, request.height, request.quality, request.options);
    return image;
  } catch { gcCores.delete(device); return null; }
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
