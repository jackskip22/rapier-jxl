// SPDX-License-Identifier: MIT
import {UniformRing} from './gpu-uniforms.mjs';
import {gpuPipelineSet} from './gpu-pipelines.mjs';
import {MALTA_LF, MALTA_HF, blurKernel} from './butteraugli.mjs';
import {SRGB_TO_LINEAR} from './ssimulacra2.mjs';

const GB_WG = 128;
const gbF = v => { const s = Math.fround(v).toString(); return /[.eE]/.test(s) ? s : s + '.0'; };
const gbD = v => { const hi = Math.fround(v); return `vec2f(${gbF(hi)}, ${gbF(v - hi)})`; };

const GB_DF = [
  ['opaque', `fn opaque(x: f32) -> f32 { return bitcast<f32>(bitcast<u32>(x) ^ bitcast<u32>(P.d)); }`],
  ['twoSum', `fn twoSum(a: f32, b: f32) -> vec2f { let s = opaque(a + b); let bb = opaque(s - a); return vec2f(s, (a - (s - bb)) + (b - bb)); }`],
  ['quick', `fn quick(a: f32, b: f32) -> vec2f { let s = opaque(a + b); return vec2f(s, b - (s - a)); }`],
  ['split', `fn split(a: f32) -> vec2f { let c = opaque(4097.0 * a); let h = opaque(c - opaque(c - a)); return vec2f(h, a - h); }`],
  ['twoProd', `fn twoProd(a: f32, b: f32) -> vec2f { let p = opaque(a * b); let x = split(a); let y = split(b); return vec2f(p, ((opaque(x.x * y.x) - p) + opaque(x.x * y.y) + opaque(x.y * y.x)) + opaque(x.y * y.y)); }`],
  ['dadd', `fn dadd(a: vec2f, b: vec2f) -> vec2f { let s = twoSum(a.x, b.x); return quick(s.x, s.y + a.y + b.y); }`],
  ['dmul', `fn dmul(a: vec2f, b: vec2f) -> vec2f { let p = twoProd(a.x, b.x); return quick(p.x, p.y + opaque(a.x * b.y) + opaque(a.y * b.x)); }`],
  ['dscale', `fn dscale(a: vec2f, s: f32) -> vec2f { let p = twoProd(a.x, s); return quick(p.x, p.y + opaque(a.y * s)); }`],
  ['ddiv', `fn ddiv(a: vec2f, b: vec2f) -> vec2f {
  let q1 = a.x / b.x; let r1 = dadd(a, -dscale(b, q1)); let q2 = r1.x / b.x; let r2 = dadd(r1, -dscale(b, q2)); let q3 = r2.x / b.x;
  return dadd(quick(q1, q2), vec2f(q3, 0.0));
}`],
  ['dmax', `fn dmax(a: vec2f, b: vec2f) -> vec2f { if (a.x > b.x || (a.x == b.x && a.y >= b.y)) { return a; } return b; }`],
  ['dround', `fn dround(a: vec2f) -> f32 { return opaque(a.x + a.y); }`],
  ['dlog', `// The natural log of a positive double-float: a / 2^e = m in [0.707, 1.414], log m = 2 atanh((m - 1) / (m + 1)) by its
// series to s^19 (|s| < 0.172, the last term under 1e-16).
fn dlog(a: vec2f) -> vec2f {
  let f = frexp(a.x); var e = f.exp; var scale = ldexp(1.0, -e);
  var m = vec2f(a.x * scale, a.y * scale);
  if (m.x < 0.70710678) { m = vec2f(m.x * 2.0, m.y * 2.0); e = e - 1; }
  let s = ddiv(dadd(m, vec2f(-1.0, 0.0)), dadd(m, vec2f(1.0, 0.0))); let s2 = dmul(s, s);
  var p = ${gbD(1 / 19)};
  ${[17, 15, 13, 11, 9, 7, 5, 3, 1].map(k => `p = dadd(${gbD(1 / k)}, dmul(s2, p));`).join(' ')}
  let r = dmul(s, p);
  return dadd(vec2f(r.x * 2.0, r.y * 2.0), dscale(${gbD(Math.LN2)}, f32(e)));
}`],
];
const GB_DF_PARTS = GB_DF.map(([name, code]) => ({code, call: new RegExp('\\b' + name + '\\s*\\(')}));
function gbDoubleFloat(source) {
  const used = new Set();
  const include = part => {
    if (used.has(part)) return;
    used.add(part);
    for (const dependency of GB_DF_PARTS) if (dependency.call.test(part.code)) include(dependency);
  };
  for (const part of GB_DF_PARTS) if (part.call.test(source)) include(part);
  return GB_DF_PARTS.filter(part => used.has(part)).map(part => part.code).join('\n');
}


function gbShader(buffers, body, extra = '') {
  return `struct Params { w: u32, h: u32, i0: u32, i1: u32, a: f32, b: f32, c: f32, d: f32 }
@group(0) @binding(0) var<uniform> P: Params;
${buffers.map(([name, access, type = 'array<f32>'], k) => `@group(0) @binding(${k + 1}) var<storage, ${access}> ${name}: ${type};`).join('\n')}
${gbDoubleFloat(body + extra)}
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
  linearize: gbShader([['lut', 'read', 'array<f32, 512>'], ['rgba', 'read', 'array<u32>'], ...GB_W('r', 'g', 'b', 'lo')],
    `let p = rgba[i]; let kr = 2u * (p & 255u); let kg = 2u * ((p >> 8u) & 255u); let kb = 2u * ((p >> 16u) & 255u);
    r[i] = lut[kr]; lo[i] = lut[kr + 1u]; g[i] = lut[kg]; lo[n + i] = lut[kg + 1u]; b[i] = lut[kb]; lo[2u * n + i] = lut[kb + 1u];`),
  clearLo: gbShader(GB_W('lo'), `lo[i] = 0.0; lo[n + i] = 0.0; lo[2u * n + i] = 0.0;`),
  subsample: gbShader([...GB_R('r0', 'g0', 'b0', 'lo0'), ...GB_W('r', 'g', 'b', 'lo')], `
    var sr = vec2f(0.0); var sg = vec2f(0.0); var sb = vec2f(0.0); let sw = P.i0; let sh = P.i1; let n0 = sw * sh;
    for (var dy = 0u; dy < 2u; dy++) { for (var dx = 0u; dx < 2u; dx++) {
      let xx = 2u * x + dx; let yy = 2u * y + dy;
      if (xx < sw && yy < sh) { let k = yy * sw + xx;
        sr = dadd(sr, vec2f(r0[k] * 0.25, lo0[k] * 0.25)); sg = dadd(sg, vec2f(g0[k] * 0.25, lo0[n0 + k] * 0.25)); sb = dadd(sb, vec2f(b0[k] * 0.25, lo0[2u * n0 + k] * 0.25)); }
    } }
    if ((sw & 1u) == 1u && x == P.w - 1u) { sr *= 2.0; sg *= 2.0; sb *= 2.0; }
    if ((sh & 1u) == 1u && y == P.h - 1u) { sr *= 2.0; sg *= 2.0; sb *= 2.0; }
    let qr = quick(sr.x, sr.y); let qg = quick(sg.x, sg.y); let qb = quick(sb.x, sb.y);
    r[i] = qr.x; lo[i] = qr.y; g[i] = qg.x; lo[n + i] = qg.y; b[i] = qb.x; lo[2u * n + i] = qb.y;`),
  blurH: gbShader([['taps', 'read', 'array<f32>'], ...GB_R('src'), ...GB_W('dst')], blurBody(false)),
  blurV: gbShader([['taps', 'read', 'array<f32>'], ...GB_R('src'), ...GB_W('dst')], blurBody(true)),
  blurHd: gbShader([['taps', 'read', 'array<f32>'], ...GB_R('src', 'srcLo'), ...GB_W('dst', 'dstLo')], blurBody(false, true)),
  blurVd: gbShader([['taps', 'read', 'array<f32>'], ...GB_R('src', 'srcLo'), ...GB_W('dst', 'dstLo')], blurBody(true, true)),
  sensitivity: gbShader(GB_W('t0', 't1', 't2', 'tl'), `
    let b0 = dscale(vec2f(t0[i], tl[i]), 80.0); let b1 = dscale(vec2f(t1[i], tl[n + i]), 80.0); let b2 = dscale(vec2f(t2[i], tl[2u * n + i]), 80.0);
    let s0 = sens(dadd(dadd(dadd(dmul(${gbD(0.29956550340058319)}, b0), dmul(${gbD(0.63373087833825936)}, b1)), dmul(${gbD(0.077705617820981968)}, b2)), ${gbD(1.7557483643287353)}), ${gbD(1.7557483643287353)});
    let s1 = sens(dadd(dadd(dadd(dmul(${gbD(0.22158691104574774)}, b0), dmul(${gbD(0.69391388044116142)}, b1)), dmul(${gbD(0.0987313588422)}, b2)), ${gbD(1.7557483643287353)}), ${gbD(1.7557483643287353)});
    let s2 = sens(dadd(dadd(dadd(dmul(${gbD(0.02)}, b0), dmul(${gbD(0.02)}, b1)), dmul(${gbD(0.20480129041026129)}, b2)), ${gbD(12.226454707163354)}), ${gbD(12.226454707163354)});
    t0[i] = s0.x; tl[i] = s0.y; t1[i] = s1.x; tl[n + i] = s1.y; t2[i] = s2.x; tl[2u * n + i] = s2.y;`, `
fn sens(v: vec2f, floor: vec2f) -> vec2f {
  let pre = dmax(dmax(v, floor), ${gbD(1e-4)});
  let gam = dadd(dmul(${gbD(19.245013259874995)}, dlog(dadd(pre, ${gbD(9.9710635769299145)}))), -${gbD(23.16046239805755)});
  return dmax(ddiv(gam, pre), ${gbD(1e-4)});
}`),
  opsin: gbShader([...GB_R('r', 'g', 'b', 'lo', 'tl'), ...GB_W('t0', 't1', 't2')], `
    let cr = dscale(vec2f(r[i], lo[i]), 80.0); let cg = dscale(vec2f(g[i], lo[n + i]), 80.0); let cb = dscale(vec2f(b[i], lo[2u * n + i]), 80.0);
    let c0 = dmax(dmul(dadd(dadd(dadd(dmul(${gbD(0.29956550340058319)}, cr), dmul(${gbD(0.63373087833825936)}, cg)), dmul(${gbD(0.077705617820981968)}, cb)), ${gbD(1.7557483643287353)}), vec2f(t0[i], tl[i])), ${gbD(1.7557483643287353)});
    let c1 = dmax(dmul(dadd(dadd(dadd(dmul(${gbD(0.22158691104574774)}, cr), dmul(${gbD(0.69391388044116142)}, cg)), dmul(${gbD(0.0987313588422)}, cb)), ${gbD(1.7557483643287353)}), vec2f(t1[i], tl[n + i])), ${gbD(1.7557483643287353)});
    let c2 = dmax(dmul(dadd(dadd(dadd(dmul(${gbD(0.02)}, cr), dmul(${gbD(0.02)}, cg)), dmul(${gbD(0.20480129041026129)}, cb)), ${gbD(12.226454707163354)}), vec2f(t2[i], tl[2u * n + i])), ${gbD(12.226454707163354)});
    t0[i] = dround(dadd(c0, -c1)); t1[i] = dround(dadd(c0, c1)); t2[i] = dround(c2);`),
  subtract: gbShader([...GB_R('a', 'b'), ...GB_W('out')], `out[i] = a[i] - b[i];`),
  copy: gbShader([...GB_R('src'), ...GB_W('dst')], `dst[i] = src[i];`),
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
      let xx = i32(x) + EROSION_DX[k]; let yy = i32(y) + EROSION_DY[k];
      if (xx < 0 || yy < 0 || xx >= i32(P.w) || yy >= i32(P.h)) { continue; }
      let v = src[u32(yy) * P.w + u32(xx)];
      if (v < m2) { if (v < m0) { m2 = m1; m1 = m0; m0 = v; } else if (v < m1) { m2 = m1; m1 = v; } else { m2 = v; } }
    }
    dst[i] = 0.45 * m0 + 0.3 * m1 + 0.25 * m2;`, `const EROSION_DX = array<i32, 8>(-3, -3, -3, 3, 3, 3, 0, 0);
const EROSION_DY = array<i32, 8>(0, -3, 3, 0, -3, 3, -3, 3);`),
  maskAcc: gbShader([...GB_R('b0', 'b1'), ...GB_W('acc')], `let d = b0[i] - b1[i]; acc[i] += 10.0 * d * d;`),
  combine: gbShader([...GB_R('dc0', 'dc1', 'dc2', 'ac0', 'ac1', 'ac2', 'mask'), ...GB_W('out')], `
    let m = mask[i]; let g = ${gbF(1 / (17.83 * 0.79079917404))};
    let my = g * (1.0 + ${gbF(2.5485944793)} / (${gbF(0.451936922203)} * m + ${gbF(0.829591754942)}));
    let md = g * (1.0 + ${gbF(0.505054525019)} / (${gbF(3.87449418804)} * m + ${gbF(0.20025578522)}));
    out[i] = sqrt((dc0[i] + dc1[i] + dc2[i]) * md * md + (ac0[i] + ac1[i] + ac2[i]) * my * my);`),
  mix: gbShader([...GB_R('sub'), ...GB_W('map')], `map[i] = map[i] * ${gbF(1 - 0.3 * 0.5)} + 0.5 * sub[(y >> 1u) * P.i0 + (x >> 1u)];`),
  clear: gbShader(GB_W('a', 'b', 'c', 'd', 'e', 'g'), `a[i] = 0.0; b[i] = 0.0; c[i] = 0.0; d[i] = 0.0; e[i] = 0.0; g[i] = 0.0;`),
};

function blurBody(vertical, df = false) {
  const at = vertical ? 'u32(j) * P.w + x' : 'y * P.w + u32(j)';
  return `
    let count = i32(${vertical ? 'P.h' : 'P.w'}); let at = i32(${vertical ? 'y' : 'x'}); let reach = i32(P.i0); let mirror = (P.i1 & 1u) == 1u;
    let inLo = ((P.i1 >> 4u) & 15u) * n; let outLo = ((P.i1 >> 8u) & 15u) * n;
    var sum = vec2f(0.0); var weight = vec2f(0.0);
    for (var k = -reach; k <= reach; k++) {
      var j = at + k;
      if (mirror) { if (j < 0) { j = -j - 1; } if (j >= count) { j = 2 * count - 1 - j; } }
      else if (j < 0 || j >= count) { continue; }
      let t = vec2f(taps[2u * u32(k + reach)], taps[2u * u32(k + reach) + 1u]);
      sum = dadd(sum, ${df ? `dmul(t, vec2f(src[${at}], srcLo[inLo + ${at}]))` : `dscale(t, src[${at}])`}); weight = dadd(weight, t);
    }
    var v = vec2f(0.0);
    if (mirror) { v = ddiv(sum, vec2f(P.a, P.c)); } else { v = ddiv(sum, weight); }
    ${df ? 'let q = quick(v.x, v.y); dst[i] = q.x; dstLo[outLo + i] = q.y;' : 'dst[i] = dround(v);'}`;
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
const gbPipelines = gpuPipelineSet({...GB_SHADERS, reduce: GB_REDUCE});

export class GpuButteraugli {
  static prepare(device) { return gbPipelines(device); }
  static async create(device, width, height) {
    const self = new GpuButteraugli();
    try { self.init(device, width, height, await gbPipelines(device)); return self; }
    catch (error) { self.destroy(); throw error; }
  }

  init(device, width, height, pipelines) {
    this.device = device; this.width = width; this.height = height;
    this.pipelines = pipelines;
    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    this.buffers = [];
    const plane = n => { const b = device.createBuffer({size: Math.max(16, Math.ceil(n / 4) * 16), usage}); this.buffers.push(b); return b; };
    const lut = new Float32Array(512);
    for (let v = 0; v < 256; v++) { lut[2 * v] = Math.fround(SRGB_TO_LINEAR[v]); lut[2 * v + 1] = Math.fround(SRGB_TO_LINEAR[v] - lut[2 * v]); }
    this.lut = plane(512); device.queue.writeBuffer(this.lut, 0, lut);
    this.rgba = plane(width * height);
    this.taps = {};
    for (const [name, sigma] of Object.entries(GB_SIGMAS)) {
      const kernel = blurKernel(sigma), k = new Float32Array(2 * kernel.length), total = kernel.reduce((a, b) => a + b);
      kernel.forEach((v, i) => { k[2 * i] = Math.fround(v); k[2 * i + 1] = Math.fround(v - k[2 * i]); });
      this.taps[name] = {buffer: plane(k.length), reach: (kernel.length - 1) / 2, total: Math.fround(total), totalLo: Math.fround(total - Math.fround(total))};
      device.queue.writeBuffer(this.taps[name].buffer, 0, k);
    }
    const level = (w, h) => {
      const n = w * h, p = () => plane(n);
      return {w, h, n, groups: Math.ceil(n / GB_WG),
        ref: {lf: [p(), p(), p()], mf: [p(), p(), p()], hf: [p(), p()], uhf: [p(), p()], blurredMask: p(), mask: p()},
        dist: {lf: [p(), p(), p()], mf: [p(), p(), p()], hf: [p(), p()], uhf: [p(), p()], blurredMask: p()},
        rgb: [p(), p(), p()], rgbLo: plane(3 * n), t: [p(), p(), p()], tLo: plane(3 * n), xyb: [p(), p(), p()], tmp: p(), tmp2: p(), ac: [p(), p(), p()], dc: [p(), p(), p()], map: p()};
    };
    this.levels = [level(width, height)];
    const sw = (width + 1) >> 1, sh = (height + 1) >> 1;
    if (sw >= 8 && sh >= 8) this.levels.push(level(sw, sh));
    this.partial = plane(this.levels[0].groups * 4);
    this.read = device.createBuffer({size: this.partial.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST});
    this.mapRead = device.createBuffer({size: this.levels[0].map.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST});
    this.ring = new UniformRing(device);
  }

  run(pass, name, lv, buffers, params = {}) {
    const ring = this.ring, at = ring.take(), uv = at === null ? new Uint32Array(8) : ring.u32, fv = at === null ? new Float32Array(uv.buffer) : ring.f32, o = at ?? 0;
    uv[o] = params.w ?? lv.w; uv[o + 1] = params.h ?? lv.h; uv[o + 2] = params.i0 ?? 0; uv[o + 3] = params.i1 ?? 0;
    fv[o + 4] = params.a ?? 0; fv[o + 5] = params.b ?? 0; fv[o + 6] = params.c ?? 0; fv[o + 7] = params.d ?? 0;
    const p = this.pipelines[name];
    pass.setPipeline(p);
    pass.setBindGroup(0, ring.bind(p, at, buffers, uv));
    pass.dispatchWorkgroups(Math.ceil((params.w ?? lv.w) * (params.h ?? lv.h) / GB_WG));
  }

  blur(pass, lv, sigma, src, dst) {
    const t = this.taps[sigma], params = {i0: t.reach, i1: t.reach === 2 ? 1 : 0, a: t.total, c: t.totalLo};
    this.run(pass, 'blurH', lv, [t.buffer, src, lv.tmp2], params);
    this.run(pass, 'blurV', lv, [t.buffer, lv.tmp2, dst], params);
  }
  blurDF(pass, lv, sigma, c, src, srcLo, dst, dstLo) {
    const t = this.taps[sigma], mirror = t.reach === 2 ? 1 : 0, params = {i0: t.reach, a: t.total, c: t.totalLo};
    this.run(pass, 'blurHd', lv, [t.buffer, src, srcLo, lv.tmp2, lv.tmp], {...params, i1: mirror | c << 4});
    this.run(pass, 'blurVd', lv, [t.buffer, lv.tmp2, lv.tmp, dst, dstLo], {...params, i1: mirror | c << 8});
  }

  referenceSet(k) {
    const n = this.levels[k].n, usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    const p = () => { const b = this.device.createBuffer({size: Math.max(16, Math.ceil(n / 4) * 16), usage}); this.buffers.push(b); return b; };
    return {lf: [p(), p(), p()], mf: [p(), p(), p()], hf: [p(), p()], uhf: [p(), p()], blurredMask: p(), mask: p()};
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
    if (l1) this.run(pass, 'subsample', l1, [...l0.rgb, l0.rgbLo, ...l1.rgb, l1.rgbLo], {i0: l0.w, i1: l0.h});
  }
  referenceFromLoaded(pass) {
    this.subsampleLoaded(pass);
    for (const lv of this.active ?? this.levels) { this.bands(pass, lv, lv.ref); this.run(pass, 'erosion', lv, [lv.ref.blurredMask, lv.ref.mask]); }
  }
  diffFromLoaded(pass) {
    this.run(pass, 'clearLo', (this.active ?? this.levels)[0], [(this.active ?? this.levels)[0].rgbLo]);
    this.subsampleLoaded(pass);
    const levels = this.active ?? this.levels, [l0, l1] = levels;
    for (const lv of levels) this.diffmap(pass, lv);
    if (l1) this.run(pass, 'mix', l0, [l1.map, l0.map], {i0: l1.w});
  }
  freeUniforms() { this.ring.reset(); }

  loadPicture(pass, rgba) {
    this.device.queue.writeBuffer(this.rgba, 0, rgba.buffer, rgba.byteOffset, this.width * this.height * 4);
    const [l0, l1] = this.levels;
    this.run(pass, 'linearize', l0, [this.lut, this.rgba, ...l0.rgb, l0.rgbLo]);
    if (l1) this.run(pass, 'subsample', l1, [...l0.rgb, l0.rgbLo, ...l1.rgb, l1.rgbLo], {i0: l0.w, i1: l0.h});
  }

  bands(pass, lv, bands) {
    for (let c = 0; c < 3; c++) this.blurDF(pass, lv, 'opsin', c, lv.rgb[c], lv.rgbLo, lv.t[c], lv.tLo);
    this.run(pass, 'sensitivity', lv, [...lv.t, lv.tLo]);
    this.run(pass, 'opsin', lv, [...lv.rgb, lv.rgbLo, lv.tLo, ...lv.t]);
    for (let c = 0; c < 3; c++) {
      this.blur(pass, lv, 'lf', lv.t[c], bands.lf[c]);
      this.run(pass, 'subtract', lv, [lv.t[c], bands.lf[c], lv.xyb[c]]);
    }
    this.run(pass, 'lfVals', lv, bands.lf);
    for (let c = 0; c < 3; c++) {
      if (c === 2) { this.blur(pass, lv, 'mf', lv.xyb[2], bands.mf[2]); continue; }
      this.blur(pass, lv, 'mf', lv.xyb[c], lv.tmp);
      this.run(pass, 'mfHf', lv, [lv.xyb[c], lv.tmp, bands.hf[c], bands.mf[c]], {i0: c});
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

  copy(pass, lv, src, dst) { this.run(pass, 'copy', lv, [src, dst]); }

  setReference(rgba) {
    const encoder = this.device.createCommandEncoder(), pass = encoder.beginComputePass();
    this.loadPicture(pass, rgba);
    for (const lv of this.levels) {
      this.bands(pass, lv, lv.ref);
      this.run(pass, 'erosion', lv, [lv.ref.blurredMask, lv.ref.mask]);
    }
    pass.end(); this.ring.flush(); this.device.queue.submit([encoder.finish()]);
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
    this.ring.flush();
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
    this.ring.reset();
    return {score: max, pnorm3, map};
  }

  destroy() {
    for (const b of this.buffers ?? []) b.destroy();
    this.buffers = []; this.read?.destroy(); this.mapRead?.destroy(); this.ring?.destroy();
  }
}

