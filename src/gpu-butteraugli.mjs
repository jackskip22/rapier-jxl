// SPDX-License-Identifier: MIT
import {MALTA_LF, MALTA_HF, blurKernel} from './butteraugli.mjs';
import {SRGB_TO_LINEAR} from './ssimulacra2.mjs';

const GB_WG = 128;
const gbF = v => { const s = Math.fround(v).toString(); return /[.eE]/.test(s) ? s : s + '.0'; };

function gbShader(buffers, body, extra = '') {
  return `struct Params { w: u32, h: u32, i0: u32, i1: u32, a: f32, b: f32, c: f32, d: f32 }
@group(0) @binding(0) var<uniform> P: Params;
${buffers.map(([name, access, type = 'array<f32>'], k) => `@group(0) @binding(${k + 1}) var<storage, ${access}> ${name}: ${type};`).join('\n')}
${extra}
@compute @workgroup_size(${GB_WG})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let n = P.w * P.h; let i = gid.x;
  if (i >= n) { return; }
  let x = i % P.w; let y = i / P.w;
  ${body}
}`;
}

const GB_R = (...names) => names.map(n => [n, 'read']), GB_W = (...names) => names.map(n => [n, 'read_write']);
const GB_RANGE = `
fn removeRange(w: f32, v: f32) -> f32 { if (v > w) { return v - w; } if (v < -w) { return v + w; } return 0.0; }
fn amplifyRange(w: f32, v: f32) -> f32 { if (v > w) { return v + w; } if (v < -w) { return v - w; } return v + v; }
fn maximumClamp(v: f32, m: f32) -> f32 { if (v >= m) { return (v - m) * ${gbF(0.724216145665)} + m; } if (v < -m) { return (v + m) * ${gbF(0.724216145665)} - m; } return v; }`;

const GB_SHADERS = {
  linearize: gbShader([['lut', 'read', 'array<f32, 256>'], ['rgba', 'read', 'array<u32>'], ...GB_W('r', 'g', 'b')],
    `let p = rgba[i]; r[i] = lut[p & 255u]; g[i] = lut[(p >> 8u) & 255u]; b[i] = lut[(p >> 16u) & 255u];`),
  subsample: gbShader([...GB_R('r0', 'g0', 'b0'), ...GB_W('r', 'g', 'b')], `
    var s = vec3f(0.0); let sw = P.i0; let sh = P.i1;
    for (var dy = 0u; dy < 2u; dy++) { for (var dx = 0u; dx < 2u; dx++) {
      let xx = 2u * x + dx; let yy = 2u * y + dy;
      if (xx < sw && yy < sh) { let k = yy * sw + xx; s += vec3f(r0[k], g0[k], b0[k]) * 0.25; }
    } }
    if ((sw & 1u) == 1u && x == P.w - 1u) { s *= 2.0; }
    if ((sh & 1u) == 1u && y == P.h - 1u) { s *= 2.0; }
    r[i] = s.x; g[i] = s.y; b[i] = s.z;`),
  blurH: gbShader([['taps', 'read', 'array<f32>'], ...GB_R('src'), ...GB_W('dst')], blurBody(false)),
  blurV: gbShader([['taps', 'read', 'array<f32>'], ...GB_R('src'), ...GB_W('dst')], blurBody(true)),
  sensitivity: gbShader(GB_W('t0', 't1', 't2'), `
    let m0 = vec4f(${gbF(0.29956550340058319)}, ${gbF(0.63373087833825936)}, ${gbF(0.077705617820981968)}, ${gbF(1.7557483643287353)});
    let m1 = vec4f(${gbF(0.22158691104574774)}, ${gbF(0.69391388044116142)}, ${gbF(0.0987313588422)}, ${gbF(1.7557483643287353)});
    let m2 = vec4f(0.02, 0.02, ${gbF(0.20480129041026129)}, ${gbF(12.226454707163354)});
    let blurred = vec4f(t0[i] * 80.0, t1[i] * 80.0, t2[i] * 80.0, 1.0);
    var pre = vec3f(max(dot(m0, blurred), m0.w), max(dot(m1, blurred), m1.w), max(dot(m2, blurred), m2.w));
    pre = max(pre, vec3f(1e-4));
    let gam = ${gbF(19.245013259874995)} * log(pre + vec3f(${gbF(9.9710635769299145)})) - vec3f(${gbF(23.16046239805755)});
    let s = max(gam / pre, vec3f(1e-4));
    t0[i] = s.x; t1[i] = s.y; t2[i] = s.z;`),
  opsin: gbShader([...GB_R('r', 'g', 'b'), ...GB_W('t0', 't1', 't2')], `
    let m0 = vec4f(${gbF(0.29956550340058319)}, ${gbF(0.63373087833825936)}, ${gbF(0.077705617820981968)}, ${gbF(1.7557483643287353)});
    let m1 = vec4f(${gbF(0.22158691104574774)}, ${gbF(0.69391388044116142)}, ${gbF(0.0987313588422)}, ${gbF(1.7557483643287353)});
    let m2 = vec4f(0.02, 0.02, ${gbF(0.20480129041026129)}, ${gbF(12.226454707163354)});
    let cur = vec4f(r[i] * 80.0, g[i] * 80.0, b[i] * 80.0, 1.0);
    let c0 = max(dot(m0, cur) * t0[i], ${gbF(1.7557483643287353)});
    let c1 = max(dot(m1, cur) * t1[i], ${gbF(1.7557483643287353)});
    let c2 = max(dot(m2, cur) * t2[i], ${gbF(12.226454707163354)});
    t0[i] = c0 - c1; t1[i] = c0 + c1; t2[i] = c2;`),
  subtract: gbShader([...GB_R('a', 'b'), ...GB_W('out')], `out[i] = a[i] - b[i];`),
  lfVals: gbShader(GB_W('lx', 'ly', 'lb'), `
    let vy = ly[i]; lx[i] = lx[i] * ${gbF(33.832837186260)}; lb[i] = (lb[i] + ${gbF(-0.362267051518)} * vy) * ${gbF(49.87984651440)}; ly[i] = vy * ${gbF(14.458268100570)};`),
  mfHf: gbShader([...GB_R('mf', 'blurred'), ...GB_W('hf', 'mfOut')], `
    let bl = blurred[i]; hf[i] = mf[i] - bl;
    if (P.i0 == 0u) { mfOut[i] = removeRange(0.29, bl); } else { mfOut[i] = amplifyRange(0.1, bl); }`, GB_RANGE),
  suppress: gbShader([...GB_R('hy'), ...GB_W('hx')], `let v = hy[i]; hx[i] = hx[i] * (46.0 / (v * v + 46.0) * ${gbF(1 - 0.653020556257)} + ${gbF(0.653020556257)});`),
  hfUhf: gbShader([...GB_R('hf', 'blurred'), ...GB_W('hfOut', 'uhf')], `
    let bl = blurred[i];
    if (P.i0 == 0u) { uhf[i] = removeRange(0.04, hf[i] - bl); hfOut[i] = removeRange(1.5, bl); }
    else { let hv = maximumClamp(bl, ${gbF(28.4691806922)}); uhf[i] = maximumClamp(hf[i] - hv, ${gbF(5.19175294647)}) * ${gbF(2.69313763794)};
      hfOut[i] = amplifyRange(0.132, hv * 2.155); }`, GB_RANGE),
  maltaPre: gbShader([...GB_R('a', 'b'), ...GB_W('diffs')], `
    let r0 = a[i]; let r1 = b[i]; let absval = 0.5 * (abs(r0) + abs(r1));
    var d = P.a / (P.c + absval) * (r0 - r1);
    let s2 = P.b / (P.c + absval); let f0 = abs(r0); let small = 0.55 * f0; let big = 1.05 * f0;
    if (r0 < 0.0) { if (r1 > -small) { d -= s2 * (r1 + small); } else if (r1 < -big) { d += s2 * (-r1 - big); } }
    else { if (r1 < small) { d += s2 * (small - r1); } else if (r1 > big) { d -= s2 * (r1 - big); } }
    diffs[i] = d;`),
  maltaLF: maltaShader(MALTA_LF), maltaHF: maltaShader(MALTA_HF),
  l2: gbShader([...GB_R('a', 'b'), ...GB_W('acc')], `let d = a[i] - b[i]; acc[i] += d * d * P.a;`),
  l2Asym: gbShader([...GB_R('a', 'b'), ...GB_W('acc')], `
    let v0 = a[i]; let v1 = b[i]; let d = v0 - v1; let f0 = abs(v0); let small = 0.4 * f0; let big = f0;
    var v = 0.0;
    if (v0 < 0.0) { if (v1 > -small) { v = v1 + small; } else if (v1 < -big) { v = -v1 - big; } }
    else { if (v1 < small) { v = small - v1; } else if (v1 > big) { v = v1 - big; } }
    acc[i] += d * d * P.a * 0.8 + P.b * 0.8 * v * v;`),
  maskInput: gbShader([...GB_R('ux', 'uy', 'hx', 'hy'), ...GB_W('out')], `
    let xd = (ux[i] + hx[i]) * 2.5; let yd = uy[i] * 0.4 + hy[i] * 0.4;
    let mul = ${gbF(6.19424080439)}; let bias = mul * ${gbF(12.61050594197)};
    out[i] = sqrt(mul * sqrt(xd * xd + yd * yd) + bias) - sqrt(bias);`),
  erosion: gbShader([...GB_R('src'), ...GB_W('dst')], `
    var m0 = src[i]; var m1 = 2.0 * m0; var m2 = m1;
    for (var k = 0u; k < 8u; k++) {
      let xx = i32(x) + array<i32, 8>(-3, -3, -3, 3, 3, 3, 0, 0)[k]; let yy = i32(y) + array<i32, 8>(0, -3, 3, 0, -3, 3, -3, 3)[k];
      if (xx < 0 || yy < 0 || xx >= i32(P.w) || yy >= i32(P.h)) { continue; }
      let v = src[u32(yy) * P.w + u32(xx)];
      if (v < m2) { if (v < m0) { m2 = m1; m1 = m0; m0 = v; } else if (v < m1) { m2 = m1; m1 = v; } else { m2 = v; } }
    }
    dst[i] = 0.45 * m0 + 0.3 * m1 + 0.25 * m2;`),
  maskAcc: gbShader([...GB_R('b0', 'b1'), ...GB_W('acc')], `let d = b0[i] - b1[i]; acc[i] += 10.0 * d * d;`),
  combine: gbShader([...GB_R('dc0', 'dc1', 'dc2', 'ac0', 'ac1', 'ac2', 'mask'), ...GB_W('out')], `
    let m = mask[i]; let g = ${gbF(1 / (17.83 * 0.79079917404))};
    let my = g * (1.0 + ${gbF(2.5485944793)} / (${gbF(0.451936922203)} * m + ${gbF(0.829591754942)}));
    let md = g * (1.0 + ${gbF(0.505054525019)} / (${gbF(3.87449418804)} * m + ${gbF(0.20025578522)}));
    out[i] = sqrt((dc0[i] + dc1[i] + dc2[i]) * md * md + (ac0[i] + ac1[i] + ac2[i]) * my * my);`),
  mix: gbShader([...GB_R('sub'), ...GB_W('map')], `map[i] = map[i] * ${gbF(1 - 0.3 * 0.5)} + 0.5 * sub[(y >> 1u) * P.i0 + (x >> 1u)];`),
  clear: gbShader(GB_W('a', 'b', 'c', 'd', 'e', 'g'), `a[i] = 0.0; b[i] = 0.0; c[i] = 0.0; d[i] = 0.0; e[i] = 0.0; g[i] = 0.0;`),
};

function blurBody(vertical) {
  return `
    let count = i32(${vertical ? 'P.h' : 'P.w'}); let at = i32(${vertical ? 'y' : 'x'}); let reach = i32(P.i0);
    var sum = 0.0; var weight = 0.0;
    for (var k = -reach; k <= reach; k++) {
      var j = at + k;
      if (P.i1 == 1u) { if (j < 0) { j = -j - 1; } if (j >= count) { j = 2 * count - 1 - j; } }
      else if (j < 0 || j >= count) { continue; }
      let t = taps[u32(k + reach)];
      sum += t * src[${vertical ? 'u32(j) * P.w + x' : 'y * P.w + u32(j)'}]; weight += t;
    }
    if (P.i1 == 1u) { dst[i] = sum / P.a; } else { dst[i] = sum / weight; }`;
}

function maltaShader(lines) {
  const points = lines.flat(), starts = [];
  let at = 0;
  for (const line of lines) { starts.push(at); at += line.length / 2; }
  starts.push(at);
  return gbShader([...GB_R('diffs'), ...GB_W('acc')], `
    var total = 0.0;
    for (var l = 0u; l < ${lines.length}u; l++) {
      var sum = 0.0;
      for (var k = STARTS[l]; k < STARTS[l + 1u]; k++) {
        let xx = i32(x) + POINTS[2u * k]; let yy = i32(y) + POINTS[2u * k + 1u];
        if (xx >= 0 && yy >= 0 && xx < i32(P.w) && yy < i32(P.h)) { sum += diffs[u32(yy) * P.w + u32(xx)]; }
      }
      total += sum * sum;
    }
    acc[i] += total;`, `const POINTS = array<i32, ${points.length}>(${points.join(', ')});
const STARTS = array<u32, ${starts.length}>(${starts.map(s => s + 'u').join(', ')});`);
}

const GB_REDUCE = `struct Params { w: u32, h: u32, i0: u32, i1: u32, a: f32, b: f32, c: f32, d: f32 }
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> map: array<f32>;
@group(0) @binding(2) var<storage, read_write> partial: array<f32>;
var<workgroup> acc: array<vec4f, ${GB_WG}>;
@compute @workgroup_size(${GB_WG})
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_index) li: u32, @builtin(workgroup_id) wg: vec3u) {
  var v = vec4f(0.0);
  if (gid.x < P.w * P.h) { let d = map[gid.x]; let d3 = d * d * d; v = vec4f(d, d3, d3 * d3, d3 * d3 * d3 * d3); }
  acc[li] = v;
  workgroupBarrier();
  for (var s = ${GB_WG / 2}u; s > 0u; s >>= 1u) {
    if (li < s) { let o = acc[li + s]; acc[li] = vec4f(max(acc[li].x, o.x), acc[li].yzw + o.yzw); }
    workgroupBarrier();
  }
  if (li == 0u) { partial[wg.x * 4u] = acc[0].x; partial[wg.x * 4u + 1u] = acc[0].y; partial[wg.x * 4u + 2u] = acc[0].z; partial[wg.x * 4u + 3u] = acc[0].w; }
}`;

const GB_SIGMAS = {opsin: 1.2, lf: 7.15593339443, mf: 3.22489901262, uhf: 1.56416327805, mask: 2.7};
const GB_MALTA = {
  uhfY: [1.10039032555, 71.7800275169, 'maltaHF', 0.39905817637], uhfX: [173.5, 5.0, 'maltaHF', 0.39905817637],
  hfY: [18.7237414387, 4498534.45232, 'maltaLF', 0.611612573796], hfX: [6923.99476109, 8051.15833247, 'maltaLF', 0.611612573796],
  mfY: [37.0819870399, 130262059.556, 'maltaLF', 0.611612573796], mfX: [8246.75321353, 1009002.70582, 'maltaLF', 0.611612573796],
};
const GB_WMUL = [400.0, 1.50815703118, 0, 2150.0, 10.6195433239, 16.2176043152, 29.2353797994, 0.844626970982, 0.703646627719];

export class GpuButteraugli {
  static async create(device, width, height) {
    const self = new GpuButteraugli();
    self.init(device, width, height);
    return self;
  }

  init(device, width, height) {
    this.device = device; this.width = width; this.height = height;
    this.pipelines = {};
    for (const [name, code] of Object.entries({...GB_SHADERS, reduce: GB_REDUCE}))
      this.pipelines[name] = device.createComputePipeline({layout: 'auto', compute: {module: device.createShaderModule({code}), entryPoint: 'main'}});
    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    this.buffers = [];
    const plane = n => { const b = device.createBuffer({size: Math.max(16, Math.ceil(n / 4) * 16), usage}); this.buffers.push(b); return b; };
    this.lut = plane(256); device.queue.writeBuffer(this.lut, 0, Float32Array.from(SRGB_TO_LINEAR));
    this.rgba = plane(width * height);
    this.taps = {};
    for (const [name, sigma] of Object.entries(GB_SIGMAS)) {
      const k = Float32Array.from(blurKernel(sigma)); this.taps[name] = {buffer: plane(k.length), reach: (k.length - 1) / 2, total: k.reduce((a, b) => a + b)};
      device.queue.writeBuffer(this.taps[name].buffer, 0, k);
    }
    const level = (w, h) => {
      const n = w * h, p = () => plane(n);
      return {w, h, n, groups: Math.ceil(n / GB_WG),
        ref: {lf: [p(), p(), p()], mf: [p(), p(), p()], hf: [p(), p()], uhf: [p(), p()], blurredMask: p(), mask: p()},
        dist: {lf: [p(), p(), p()], mf: [p(), p(), p()], hf: [p(), p()], uhf: [p(), p()], blurredMask: p()},
        rgb: [p(), p(), p()], t: [p(), p(), p()], xyb: [p(), p(), p()], tmp: p(), tmp2: p(), ac: [p(), p(), p()], dc: [p(), p(), p()], map: p()};
    };
    this.levels = [level(width, height)];
    const sw = (width + 1) >> 1, sh = (height + 1) >> 1;
    if (sw >= 8 && sh >= 8) this.levels.push(level(sw, sh));
    this.partial = plane(this.levels[0].groups * 4);
    this.read = device.createBuffer({size: this.partial.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST});
    this.mapRead = device.createBuffer({size: this.levels[0].map.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST});
    this.uniforms = [];
  }

  run(pass, name, lv, buffers, params = {}) {
    const u = this.device.createBuffer({size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
    const data = new ArrayBuffer(32), uv = new Uint32Array(data), fv = new Float32Array(data);
    uv[0] = params.w ?? lv.w; uv[1] = params.h ?? lv.h; uv[2] = params.i0 ?? 0; uv[3] = params.i1 ?? 0;
    fv[4] = params.a ?? 0; fv[5] = params.b ?? 0; fv[6] = params.c ?? 0; fv[7] = params.d ?? 0;
    this.device.queue.writeBuffer(u, 0, data); this.uniforms.push(u);
    const p = this.pipelines[name];
    pass.setPipeline(p);
    pass.setBindGroup(0, this.device.createBindGroup({layout: p.getBindGroupLayout(0), entries: [u, ...buffers].map((b, i) => ({binding: i, resource: {buffer: b}}))}));
    pass.dispatchWorkgroups(Math.ceil((params.w ?? lv.w) * (params.h ?? lv.h) / GB_WG));
  }

  blur(pass, lv, sigma, src, dst) {
    const t = this.taps[sigma], params = {i0: t.reach, i1: t.reach === 2 ? 1 : 0, a: t.total};
    this.run(pass, 'blurH', lv, [t.buffer, src, lv.tmp2], params);
    this.run(pass, 'blurV', lv, [t.buffer, lv.tmp2, dst], params);
  }

  resize(width, height) {
    const sw = (width + 1) >> 1, sh = (height + 1) >> 1, sizes = [[width, height], [sw, sh]];
    if (this.levels.length < 2 && sw >= 8 && sh >= 8) throw new Error('GpuButteraugli: a resized picture needs the half level its creation had');
    this.width = width; this.height = height;
    this.levels.forEach((lv, k) => { [lv.w, lv.h] = sizes[k]; lv.n = lv.w * lv.h; lv.groups = Math.ceil(lv.n / GB_WG); });
    this.active = this.levels[1] && sw >= 8 && sh >= 8 ? this.levels : this.levels.slice(0, 1);
  }

  subsampleLoaded(pass) {
    const [l0, l1] = this.active ?? this.levels;
    if (l1) this.run(pass, 'subsample', l1, [...l0.rgb, ...l1.rgb], {i0: l0.w, i1: l0.h});
  }
  referenceFromLoaded(pass) {
    this.subsampleLoaded(pass);
    for (const lv of this.active ?? this.levels) { this.bands(pass, lv, lv.ref); this.run(pass, 'erosion', lv, [lv.ref.blurredMask, lv.ref.mask]); }
  }
  diffFromLoaded(pass) {
    this.subsampleLoaded(pass);
    const levels = this.active ?? this.levels, [l0, l1] = levels;
    for (const lv of levels) this.diffmap(pass, lv);
    if (l1) this.run(pass, 'mix', l0, [l1.map, l0.map], {i0: l1.w});
  }
  freeUniforms() { for (const u of this.uniforms) u.destroy(); this.uniforms = []; }

  loadPicture(pass, rgba) {
    this.device.queue.writeBuffer(this.rgba, 0, rgba.buffer, rgba.byteOffset, this.width * this.height * 4);
    const [l0, l1] = this.levels;
    this.run(pass, 'linearize', l0, [this.lut, this.rgba, ...l0.rgb]);
    if (l1) this.run(pass, 'subsample', l1, [...l0.rgb, ...l1.rgb], {i0: l0.w, i1: l0.h});
  }

  bands(pass, lv, bands) {
    for (let c = 0; c < 3; c++) this.blur(pass, lv, 'opsin', lv.rgb[c], lv.t[c]);
    this.run(pass, 'sensitivity', lv, lv.t);
    this.run(pass, 'opsin', lv, [...lv.rgb, ...lv.t]);
    for (let c = 0; c < 3; c++) {
      this.blur(pass, lv, 'lf', lv.t[c], bands.lf[c]);
      this.run(pass, 'subtract', lv, [lv.t[c], bands.lf[c], lv.xyb[c]]);
    }
    this.run(pass, 'lfVals', lv, bands.lf);
    for (let c = 0; c < 3; c++) {
      this.blur(pass, lv, 'mf', lv.xyb[c], lv.tmp);
      if (c === 2) this.copy(pass, lv, lv.tmp, bands.mf[2]);
      else this.run(pass, 'mfHf', lv, [lv.xyb[c], lv.tmp, bands.hf[c], bands.mf[c]], {i0: c});
    }
    this.run(pass, 'suppress', lv, [bands.hf[1], bands.hf[0]]);
    for (let c = 0; c < 2; c++) {
      this.blur(pass, lv, 'uhf', bands.hf[c], lv.tmp);
      this.run(pass, 'hfUhf', lv, [bands.hf[c], lv.tmp, lv.t[c], bands.uhf[c]], {i0: c});
      this.copy(pass, lv, lv.t[c], bands.hf[c]);
    }
    this.run(pass, 'maskInput', lv, [bands.uhf[0], bands.uhf[1], bands.hf[0], bands.hf[1], lv.tmp]);
    this.blur(pass, lv, 'mask', lv.tmp, bands.blurredMask);
  }

  copy(pass, lv, src, dst) { this.run(pass, 'subtract', lv, [src, this.zero(lv), dst]); }
  zero(lv) {
    if (!lv.zeroPlane) { lv.zeroPlane = this.device.createBuffer({size: lv.map.size, usage: GPUBufferUsage.STORAGE}); this.buffers.push(lv.zeroPlane); }
    return lv.zeroPlane;
  }

  setReference(rgba) {
    const encoder = this.device.createCommandEncoder(), pass = encoder.beginComputePass();
    this.loadPicture(pass, rgba);
    for (const lv of this.levels) {
      this.bands(pass, lv, lv.ref);
      this.run(pass, 'erosion', lv, [lv.ref.blurredMask, lv.ref.mask]);
    }
    pass.end(); this.device.queue.submit([encoder.finish()]);
  }

  diffmap(pass, lv) {
    const r = lv.ref, d = lv.dist;
    this.bands(pass, lv, d);
    this.run(pass, 'clear', lv, [...lv.ac, ...lv.dc]);
    const malta = (key, a, b, into) => {
      const [w, norm1, kind, mulli] = GB_MALTA[key], len = 3.75;
      const gt = Math.fround(mulli * Math.sqrt(0.5 * w) / (len * 2 + 1) * norm1), lt = Math.fround(mulli * Math.sqrt(0.33 * w) / (len * 2 + 1) * norm1);
      this.run(pass, 'maltaPre', lv, [a, b, lv.tmp], {a: gt, b: lt, c: norm1});
      this.run(pass, kind, lv, [lv.tmp, into]);
    };
    malta('uhfY', r.uhf[1], d.uhf[1], lv.ac[1]); malta('uhfX', r.uhf[0], d.uhf[0], lv.ac[0]);
    malta('hfY', r.hf[1], d.hf[1], lv.ac[1]); malta('hfX', r.hf[0], d.hf[0], lv.ac[0]);
    malta('mfY', r.mf[1], d.mf[1], lv.ac[1]); malta('mfX', r.mf[0], d.mf[0], lv.ac[0]);
    for (let c = 0; c < 3; c++) {
      if (c < 2) this.run(pass, 'l2Asym', lv, [r.hf[c], d.hf[c], lv.ac[c]], {a: GB_WMUL[c], b: GB_WMUL[c]});
      this.run(pass, 'l2', lv, [r.mf[c], d.mf[c], lv.ac[c]], {a: GB_WMUL[3 + c]});
      this.run(pass, 'l2', lv, [r.lf[c], d.lf[c], lv.dc[c]], {a: GB_WMUL[6 + c]});
    }
    this.run(pass, 'maskAcc', lv, [r.blurredMask, d.blurredMask, lv.ac[1]]);
    this.run(pass, 'combine', lv, [...lv.dc, ...lv.ac, r.mask, lv.map]);
  }

  async score(rgba, {wantMap = false} = {}) {
    const encoder = this.device.createCommandEncoder(), pass = encoder.beginComputePass();
    this.loadPicture(pass, rgba);
    for (const lv of this.levels) this.diffmap(pass, lv);
    const [l0, l1] = this.levels;
    if (l1) this.run(pass, 'mix', l0, [l1.map, l0.map], {i0: l1.w});
    this.run(pass, 'reduce', l0, [l0.map, this.partial]);
    pass.end();
    encoder.copyBufferToBuffer(this.partial, 0, this.read, 0, l0.groups * 16);
    if (wantMap) encoder.copyBufferToBuffer(l0.map, 0, this.mapRead, 0, l0.n * 4);
    this.device.queue.submit([encoder.finish()]);
    await this.read.mapAsync(GPUMapMode.READ, 0, l0.groups * 16);
    const part = new Float32Array(this.read.getMappedRange(0, l0.groups * 16).slice(0));
    this.read.unmap();
    let max = 0; const sums = [0, 0, 0];
    for (let g = 0; g < l0.groups; g++) { max = Math.max(max, part[g * 4]); for (let k = 0; k < 3; k++) sums[k] += part[g * 4 + 1 + k]; }
    const pnorm3 = sums.reduce((a, s, k) => a + Math.pow(s / l0.n, 1 / (3 * (1 << k))), 0) / 3;
    let map = null;
    if (wantMap) {
      await this.mapRead.mapAsync(GPUMapMode.READ, 0, l0.n * 4);
      map = new Float32Array(this.mapRead.getMappedRange(0, l0.n * 4).slice(0));
      this.mapRead.unmap();
    }
    for (const u of this.uniforms) u.destroy();
    this.uniforms = [];
    return {score: max, pnorm3, map};
  }

  destroy() { for (const b of this.buffers) b.destroy(); this.read.destroy(); this.mapRead.destroy(); }
}
