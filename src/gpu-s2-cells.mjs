// SPDX-License-Identifier: MIT
import {SSIMULACRA2_WEIGHTS} from './ssimulacra2.mjs';
import {s2cLin, S2C_MIX, S2C_TAPS, s2cScales} from './s2-cells.mjs';
import {cbrtTables, IS_BIAS, BLACK} from './int-spec.mjs';
import {INT_WGSL} from './int-ops.mjs';
import {gpuDestroy, gpuAutoSet, gpuScoped, gpuAlloc, gpuSize, gpuUni, gpuStep, gpuStage} from './gpu-kit.mjs';

const GSC_BAND = 128, GSC_HALO = 4, GSC_WG = 64, GSC_HI = 256 + (1 << 16);

const GSC_DIV =  `
fn udiv64by32(a: vec2u, b: u32) -> u32 {
  var r = 0u; var q = 0u;
  for (var i = 43i; i >= 0i; i--) {
    var bit = 0u;
    if (i >= 32i) { bit = (a.y >> u32(i - 32i)) & 1u; } else { bit = (a.x >> u32(i)) & 1u; }
    r = (r << 1u) | bit;
    if (r >= b) { r = r - b; if (i < 32i) { q = q | (1u << u32(i)); } }
  }
  return q;
}`;

const GSC_SHADER =  `
struct U { w: u32, h: u32, pw: u32, ph: u32, y0: u32, y1: u32, ys: u32, ye: u32,
  c: u32, sh: u32, cstride: u32, n: u32, mode: u32, count: u32, plane: u32, cw: u32, wy: u32, wh: u32, pad0: u32, pad1: u32 }
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> dSrc: array<u32>;
@group(0) @binding(2) var<storage, read_write> dDst: array<u32>;
@group(0) @binding(3) var<storage, read> dT: array<i32>;
@group(0) @binding(2) var<storage, read> xSrcB: array<u32>;
@group(0) @binding(3) var<storage, read_write> xOutA: array<i32>;
@group(0) @binding(4) var<storage, read_write> xOutB: array<i32>;
@group(0) @binding(5) var<storage, read> xT: array<i32>;
@group(0) @binding(1) var<storage, read> PA: array<i32>;
@group(0) @binding(2) var<storage, read> PB: array<i32>;
@group(0) @binding(3) var<storage, read_write> rQ: array<i32>;
@group(0) @binding(3) var<storage, read> cQ: array<i32>;
@group(0) @binding(4) var<storage, read_write> cOut: array<u32>;

fn Ri(s: i32, k: u32) -> i32 { return (s + (1i << (k - 1u))) >> k; }
fn round64(a: vec2u, k: u32) -> i32 { return bitcast<i32>(shr64s(add64(a, vec2u(1u << (k - 1u), 0u)), k).x); }
const TAPS = array<i32, 9>(${Array.from(S2C_TAPS).join(', ')});
const MIX = array<i32, 9>(${Array.from(S2C_MIX).join(', ')});
${INT_WGSL}
${GSC_DIV}
fn flat(wg: vec3u, nw: vec3u, l: u32) -> u32 { return (wg.y * nw.x + wg.x) * ${GSC_WG}u + l; }

fn downAt(c: u32, k: u32) -> u32 {
  if (u.mode == 1u) { return u32(dT[(dSrc[k] >> (8u * c)) & 255u]); }
  return dSrc[c * u.pw * u.wh + k];
}

// The next scale's Q15 planes of one picture: from the 8-bit bytes (mode 1) or the scale before.
@compute @workgroup_size(${GSC_WG})
fn down(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nw: vec3u, @builtin(local_invocation_index) l: u32) {
  let i = flat(wg, nw, l);
  let m = u.w * (u.y1 - u.y0); if (i >= m) { return; }
  let x = i % u.w; let y = u.y0 + i / u.w; let x0 = 2u * x; let y0 = 2u * y - u.wy;
  let x1 = min(x0 + 1u, u.pw - 1u); let y1 = min(2u * y + 1u, u.ph - 1u) - u.wy;
  for (var c = 0u; c < 3u; c++) {
    dDst[c * m + i] = (downAt(c, y0 * u.pw + x0) + downAt(c, y0 * u.pw + x1) + downAt(c, y1 * u.pw + x0) + downAt(c, y1 * u.pw + x1) + 2u) >> 2u;
  }
}

fn cbrt(v: i32) -> i32 { if (v < 65536i) { return xT[256 + v]; } return xT[${GSC_HI} + Ri(v, 4u)]; }
fn rgb(k: u32, b: bool) -> vec3i {
  if (u.mode == 1u) { let v = select(dSrc[k], xSrcB[k], b); return vec3i(xT[v & 255u], xT[(v >> 8u) & 255u], xT[(v >> 16u) & 255u]); }
  let n = u.w * u.wh;
  if (b) { return vec3i(i32(xSrcB[k]), i32(xSrcB[n + k]), i32(xSrcB[2u * n + k])); }
  return vec3i(i32(dSrc[k]), i32(dSrc[n + k]), i32(dSrc[2u * n + k]));
}
fn xybValue(v: vec3i) -> i32 {
  let r = v.x; let g = v.y; let b = v.z;
  let l = cbrt(Ri(MIX[0] * r + MIX[1] * g + MIX[2] * b, 9u) + ${IS_BIAS}i) - ${BLACK}i;
  let m = cbrt(Ri(MIX[3] * r + MIX[4] * g + MIX[5] * b, 9u) + ${IS_BIAS}i) - ${BLACK}i;
  if (u.c == 0u) { return Ri(7i * (l - m) + 440402i, 8u); }
  if (u.c == 1u) { return Ri(l + m + 20972i, 9u); }
  let s = cbrt(Ri(MIX[6] * r + MIX[7] * g + MIX[8] * b, 9u) + ${IS_BIAS}i) - ${BLACK}i;
  return Ri(2i * s - (l + m) + 1153434i, 9u);
}

// Both pictures' Q12 plane of channel c for rows [ys, ye) (s2-cells.mjs xyb).
@compute @workgroup_size(${GSC_WG})
fn xyb(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nw: vec3u, @builtin(local_invocation_index) l: u32) {
  let i = flat(wg, nw, l);
  if (i >= (u.ye - u.ys) * u.w) { return; }
  let k = (u.ys - u.wy) * u.w + i;
  xOutA[i] = xybValue(rgb(k, false)); xOutB[i] = xybValue(rgb(k, true));
}

// The five quantities blurred along x, rows [ys, ye): means in i32, moments in 64 bits, each rounded R(s, 16).
@compute @workgroup_size(${GSC_WG})
fn rows(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nw: vec3u, @builtin(local_invocation_index) l: u32) {
  let i = flat(wg, nw, l);
  if (i >= (u.ye - u.ys) * u.w) { return; }
  let x = i32(i % u.w); let base = i - u32(x); let w = i32(u.w);
  let k0 = select(0i, 4i - x, x < 4i); let k1 = select(8i, 4i + w - 1i - x, x + 4i >= w);
  var m1 = 0i; var m2 = 0i; var s11 = vec2u(0u); var s22 = vec2u(0u); var s12 = vec2u(0u);
  for (var k = k0; k <= k1; k++) {
    let t = TAPS[k]; let o = base + u32(x + k - 4i); let p = PA[o]; let q = PB[o];
    m1 += t * p; m2 += t * q;
    s11 = add64(s11, mulS64(p * p, u32(t))); s22 = add64(s22, mulS64(q * q, u32(t))); s12 = add64(s12, mulS64(p * q, u32(t)));
  }
  rQ[i] = Ri(m1, 16u); rQ[u.plane + i] = Ri(m2, 16u);
  rQ[2u * u.plane + i] = round64(s11, 16u); rQ[3u * u.plane + i] = round64(s22, 16u); rQ[4u * u.plane + i] = round64(s12, 16u);
}

fn fourth(v: u32) -> vec2u { let q = shr64u(add64(mul64(v, v), vec2u(128u, 0u)), 8u).x; return mul64(q, q); }

// One cell's sums (kernels.mjs s2cChannel; public/test/s2-cells-reference.mjs): the column blur, e, art and lost, their sums and fourth-power sums.
@compute @workgroup_size(${GSC_WG})
fn cells(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nw: vec3u, @builtin(local_invocation_index) l: u32) {
  let i = flat(wg, nw, l);
  if (i >= u.count) { return; }
  let side = 1u << u.sh; let cx = i % u.cw; let cy = (u.y0 >> u.sh) + i / u.cw;
  var se = 0u; var sa = 0u; var sl = 0u; var fe = vec2u(0u); var fa = vec2u(0u); var fl = vec2u(0u);
  let h = i32(u.h);
  for (var y = cy * side; y < min(u.h, (cy + 1u) * side); y++) {
    for (var x = cx * side; x < min(u.w, (cx + 1u) * side); x++) {
      var m1 = 0i; var m2 = 0i; var s11 = vec2u(0u); var s22 = vec2u(0u); var s12 = vec2u(0u);
      for (var k = 0i; k < 9i; k++) {
        let yy = i32(y) + k - 4i;
        if (yy < 0i || yy >= h) { continue; }
        let t = TAPS[k]; let o = (u32(yy) - u.ys) * u.w + x;
        m1 += t * cQ[o]; m2 += t * cQ[u.plane + o];
        s11 = add64(s11, mulS64(cQ[2u * u.plane + o], u32(t))); s22 = add64(s22, mulS64(cQ[3u * u.plane + o], u32(t)));
        s12 = add64(s12, mulS64(cQ[4u * u.plane + o], u32(t)));
      }
      let mu1 = Ri(m1, 16u); let mu2 = Ri(m2, 16u);
      let v1 = round64(s11, 16u) - mu1 * mu1; let v2 = round64(s22, 16u) - mu2 * mu2; let cov = round64(s12, 16u) - mu1 * mu2;
      let sv = v1 + v2; let lift = select(0i, -sv, sv < 0i);
      let numS = 2i * cov + 15099i + lift; let denS = u32(sv + lift + 15099i);
      let ratio = i32(min(65536u, udiv64by32(add64(mul64(u32(abs(numS)), 65536u), vec2u(denS >> 1u, 0u)), denS)));
      let r = select(ratio, -ratio, numS < 0i);
      let d = mu1 - mu2; let numM = 16777216i - d * d;
      let e = u32(clamp(65536i - round64(mulSS64(numM, r), 24u), 0i, 131071i));
      let o = (y - u.ys) * u.w + x;
      let num = u32(4096i + abs(PB[o] - mu2)); let den = u32(4096i + abs(PA[o] - mu1));
      let dd = i32((num * 65536u + (den >> 1u)) / den) - 65536i;
      let art = u32(clamp(dd, 0i, 131071i)); let lost = u32(max(0i, -dd));
      se += e; sa += art; sl += lost;
      fe = add64(fe, fourth(e)); fa = add64(fa, fourth(art)); fl = add64(fl, fourth(lost));
    }
  }
  let at = cy * u.cstride + cx; let n = u.n;
  cOut[at] = se; cOut[n + at] = sa; cOut[2u * n + at] = sl;
  cOut[3u * n + 2u * at] = fe.x; cOut[3u * n + 2u * at + 1u] = fe.y;
  cOut[5u * n + 2u * at] = fa.x; cOut[5u * n + 2u * at + 1u] = fa.y;
  cOut[7u * n + 2u * at] = fl.x; cOut[7u * n + 2u * at + 1u] = fl.y;
}`;

const GSC_ENTRIES = [['down', GSC_WG], ['xyb', GSC_WG], ['rows', GSC_WG], ['cells', GSC_WG]];
export const gpuS2CellsPipelines = device => gpuAutoSet(device, 's2c', GSC_SHADER, GSC_ENTRIES);

const GSC_KEYS = ['w', 'h', 'pw', 'ph', 'y0', 'y1', 'ys', 'ye', 'c', 'sh', 'cstride', 'n', 'mode', 'count', 'plane', 'cw', 'wy', 'wh'];

const gscTables = new WeakMap();
const getTableBuf = (device, st) => {
  let b = gscTables.get(device);
  if (b) return b;
  const {lo, hi} = cbrtTables(), table = new Int32Array(GSC_HI + hi.length);
  table.set(s2cLin()); table.set(lo, 256); table.set(hi, GSC_HI);
  const size = gpuSize(table.byteLength);
  b = device.createBuffer({size, usage: st, mappedAtCreation: true});
  try {
    new Uint8Array(b.getMappedRange(0, size)).set(new Uint8Array(table.buffer, table.byteOffset, table.byteLength));
    b.unmap();
  } catch (error) { b.destroy(); throw error; }
  gscTables.set(device, b);
  return b;
};

export async function gpuS2Cells(device, {reference, decoded, decodedList = null, decodedBuffer = null, width, height, yOnly = false, held = null}) {
  if (Array.isArray(decodedList)) {
    if (!decodedList.length) return [];
    const limit = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize);
    const scales = s2cScales(width, height), stride = Math.ceil(width / 8), rows = Math.ceil(height / 8);
    if (!scales.length || 9 * stride * rows * 4 > limit) return null;
    const banded = Math.max(width * height * 4, scales[1] ? 3 * scales[1].w * scales[1].h * 4 : 0) > limit;
    if (banded) {
      const seq = [];
      for (const frame of decodedList) {
        const one = await gpuS2Cells(device, {reference, decoded: frame, width, height, yOnly, held});
        if (!one) return null;
        seq.push(one);
      }
      return seq;
    }
    const made = [], buf = gpuAlloc(device, made), st = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    let pending = null;
    try {
      const built = await gpuScoped(device, 's2-cells-batch', async seal => {
        const pipelines = await gpuS2CellsPipelines(device);
        const mapped = (bytes, keepList = made) => {
          const size = gpuSize(bytes.byteLength), b = device.createBuffer({size, usage: st, mappedAtCreation: true});
          keepList.push(b);
          new Uint8Array(b.getMappedRange(0, size)).set(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
          b.unmap();
          return b;
        };
        const T = getTableBuf(device, st);
        const canHoldRef = held && (!held.device || held.device === device);
        let refPyramids = canHoldRef && held.width === width && held.height === height ? held.pyramids : null;
        let refNeedsBuild = false;
        if (canHoldRef && !refPyramids) {
          held.release?.();
          const owned = pending = [];
          mapped(new Uint8Array(reference.buffer, reference.byteOffset, width * height * 4), owned);
          for (let k = 1; k < scales.length; k++) owned.push(device.createBuffer({size: gpuSize(3 * scales[k].w * scales[k].h * 4), usage: st}));
          Object.assign(held, {device, width, height, pyramids: owned, release() { gpuDestroy(owned); held.pyramids = null; }});
          refPyramids = owned; refNeedsBuild = true;
        }
        const localPyramids = refPyramids ?? [mapped(new Uint8Array(reference.buffer, reference.byteOffset, width * height * 4)),
          ...scales.slice(1).map(({w, h}) => buf(3 * w * h * 4))];
        const needRefDown = !refPyramids || refNeedsBuild;
        const frames = decodedList.map(frame => mapped(new Uint8Array(frame.buffer, frame.byteOffset, width * height * 4)));
        const nextBs = scales.slice(1).map(({w, h}) => buf(3 * w * h * 4));
        const maxW = scales[0].w, windowRows = Math.min(GSC_BAND, scales[0].h) + 2 * GSC_HALO, plane = windowRows * maxW;
        const PA = buf(plane * 4), PB = buf(plane * 4), Q = buf(5 * plane * 4);
        const uniform = params => gpuUni(device, buf, GSC_KEYS.map(k => params[k] ?? 0), null, undefined, 80);
        const run = (pass, name, threads, bound, u) => gpuStep(device, pass, pipelines[name], [u, ...bound], threads);
        const downUniforms = scales.map(({w, h}, k) => k ? uniform({w, h, pw: scales[k - 1].w, ph: scales[k - 1].h, mode: k === 1 ? 1 : 0, y0: 0, y1: h, wy: 0, wh: scales[k - 1].h}) : null);
        const batchOut = [], stageSources = [], stageMeta = [];
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        for (let m = 0; m < frames.length; m++) {
          let A = localPyramids[0], B = frames[m], mode = 1;
          const out = [];
          for (const [k, {w, h}] of scales.entries()) {
            if (k) {
              const nextA = localPyramids[k], nextB = nextBs[k - 1], u = downUniforms[k];
              if (m === 0 && needRefDown) run(pass, 'down', w * h, [A, nextA, T], u);
              run(pass, 'down', w * h, [B, nextB, T], u);
              A = nextA; B = nextB; mode = 0;
            }
            const cells = k <= 3, sh = cells ? 3 - k : 0, cstride = cells ? stride : w, n = cells ? stride * rows : w * h, sums = [];
            const cw = cells ? Math.ceil(w / (1 << sh)) : w;
            for (let c = yOnly && !k ? 1 : 0; c < (yOnly && !k ? 2 : 3); c++) {
              const active = [];
              for (let t = 0; t < 3; t++) for (const p of [1, 4]) {
                const wi = c * 36 + k * 6 + t + (p === 4 ? 3 : 0);
                if (SSIMULACRA2_WEIGHTS[wi]) active.push({k: wi, c, t, p});
              }
              if (!active.length) continue;
              const sumsBuffer = buf(9 * n * 4);
              for (let y0 = 0; y0 < h; y0 += GSC_BAND) {
                const y1 = Math.min(h, y0 + GSC_BAND), ys = Math.max(0, y0 - GSC_HALO), ye = Math.min(h, y1 + GSC_HALO);
                const count = ((y1 + (1 << sh) - 1 >> sh) - (y0 >> sh)) * cw;
                const u = uniform({w, h, y0, y1, ys, ye, c, sh, cstride, n, mode, plane, count, cw, wy: 0, wh: h});
                run(pass, 'xyb', (ye - ys) * w, [A, B, PA, PB, T], u);
                run(pass, 'rows', (ye - ys) * w, [PA, PB, Q], u);
                run(pass, 'cells', count, [PA, PB, Q, sumsBuffer], u);
              }
              for (const term of active) {
                const [first, count] = term.p === 1 ? [term.t * n, n] : [3 * n + term.t * 2 * n, 2 * n];
                stageSources.push([sumsBuffer, first * 4, count * 4]); stageMeta.push([term, count]);
              }
              sums.push(...active);
            }
            out.push({w, h, sums});
          }
          batchOut.push(out);
        }
        pass.end();
        const [map, take] = gpuStage(device, buf, encoder, stageSources);
        device.queue.submit([encoder.finish()]);
        seal();
        await map();
        take((mapped, at) => stageMeta.forEach(([term, count], idx) => { term.sum = new Uint32Array(mapped, at[idx], count).slice(); }));
        return batchOut;
      }, true, () => null);
      if (!built) return null;
      pending = null;
      return built.map(scalesOut => ({scales: scalesOut, stride, rows}));
    } catch { return null; }
    finally {
      gpuDestroy(made);
      if (pending) { gpuDestroy(pending); if (held?.pyramids === pending) held.pyramids = null; }
    }
  }
  return singleGpuS2Cells(device, {reference, decoded, decodedBuffer, width, height, yOnly, held});
}

async function singleGpuS2Cells(device, {reference, decoded, decodedBuffer = null, width, height, yOnly = false, held = null}) {
  const limit = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize);
  const scales = s2cScales(width, height), stride = Math.ceil(width / 8), rows = Math.ceil(height / 8);
  if (!scales.length || 9 * stride * rows * 4 > limit) return null;
  const banded = Math.max(width * height * 4, decodedBuffer ? decodedBuffer.size : 0, scales[1] ? 3 * scales[1].w * scales[1].h * 4 : 0) > limit;
  const made = [], buf = gpuAlloc(device, made), st = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
  let pending = null;
  try {
    const built = await gpuScoped(device, 's2-cells', async seal => {
      const pipelines = await gpuS2CellsPipelines(device);
      const mapped = (bytes, keepList = made) => {
        const size = gpuSize(bytes.byteLength), b = device.createBuffer({size, usage: st, mappedAtCreation: true});
        keepList.push(b);
        new Uint8Array(b.getMappedRange(0, size)).set(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
        b.unmap();
        return b;
      };
      const T = getTableBuf(device, st);
      const canHoldRef = !banded && held && (!held.device || held.device === device);
      let refPyramids = canHoldRef && held.width === width && held.height === height ? held.pyramids : null;
      let refNeedsBuild = false;
      if (canHoldRef && !refPyramids) {
        held.release?.();
        const owned = pending = [];
        mapped(new Uint8Array(reference.buffer, reference.byteOffset, width * height * 4), owned);
        for (let s = 1; s < scales.length; s++) owned.push(device.createBuffer({size: gpuSize(3 * scales[s].w * scales[s].h * 4), usage: st}));
        Object.assign(held, {device, width, height, pyramids: owned, release() { gpuDestroy(owned); held.pyramids = null; }});
        refPyramids = owned; refNeedsBuild = true;
      }
      let A = refPyramids ? refPyramids[0] : mapped(new Uint8Array(reference.buffer, reference.byteOffset, width * height * 4));
      let B = decodedBuffer ?? mapped(new Uint8Array(decoded.buffer, decoded.byteOffset, width * height * 4)), mode = 1;
      const maxW = scales[0].w, windowRows = Math.min(GSC_BAND, scales[0].h) + 2 * GSC_HALO, plane = windowRows * maxW;
      const PA = buf(plane * 4), PB = buf(plane * 4), Q = buf(5 * plane * 4);
      const uniform = params => gpuUni(device, buf, GSC_KEYS.map(k => params[k] ?? 0), null, undefined, 80);
      const run = (pass, name, threads, bound, u) => gpuStep(device, pass, pipelines[name], [u, ...bound], threads);
      const out = [], stageSources = [], stageMeta = [];
      const tall = banded ? Math.max(1, Math.floor(limit / (24 * scales[0].w))) : 0;
      const WA = banded ? buf(3 * maxW * windowRows * 4) : null, WB = banded ? buf(3 * maxW * windowRows * 4) : null;
      const SW = banded ? buf(3 * maxW * Math.min(scales[0].h, 2 * tall) * 4) : null, DW = banded ? buf(3 * maxW * tall * 4) : null;
      const encoder = device.createCommandEncoder();
      let pass = encoder.beginComputePass();
      const rowsOf = (store, planes, pw, ph, wy, wh, into) => { for (let c = 0; c < planes; c++) encoder.copyBufferToBuffer(store, (c * pw * ph + wy * pw) * 4, into, c * pw * wh * 4, pw * wh * 4); };
      const copies = make => { pass.end(); make(); pass = encoder.beginComputePass(); };
      for (const [s, {w, h}] of scales.entries()) {
        if (s) {
          const p = scales[s - 1], nextA = refPyramids ? refPyramids[s] : buf(3 * w * h * 4), nextB = buf(3 * w * h * 4), planes = mode ? 1 : 3;
          if (!banded) {
            const u = uniform({w, h, pw: p.w, ph: p.h, mode, y0: 0, y1: h, wy: 0, wh: p.h});
            if (!refPyramids || refNeedsBuild) run(pass, 'down', w * h, [A, nextA, T], u);
            run(pass, 'down', w * h, [B, nextB, T], u);
          } else for (let y0 = 0; y0 < h; y0 += tall) {
            const y1 = Math.min(h, y0 + tall), wy = 2 * y0, wh = Math.min(p.h, 2 * y1) - wy, m = w * (y1 - y0);
            const u = uniform({w, h, pw: p.w, ph: p.h, mode, y0, y1, wy, wh});
            for (const [from, to] of [[A, nextA], [B, nextB]]) {
              copies(() => rowsOf(from, planes, p.w, p.h, wy, wh, SW));
              run(pass, 'down', m, [SW, DW, T], u);
              copies(() => { for (let c = 0; c < 3; c++) encoder.copyBufferToBuffer(DW, c * m * 4, to, (c * w * h + y0 * w) * 4, m * 4); });
            }
          }
          A = nextA; B = nextB; mode = 0;
        }
        const cells = s <= 3, sh = cells ? 3 - s : 0, cstride = cells ? stride : w, n = cells ? stride * rows : w * h, sums = [];
        const cw = cells ? Math.ceil(w / (1 << sh)) : w;
        for (let c = yOnly && !s ? 1 : 0; c < (yOnly && !s ? 2 : 3); c++) {
          const active = [];
          for (let t = 0; t < 3; t++) for (const p of [1, 4]) {
            const k = c * 36 + s * 6 + t + (p === 4 ? 3 : 0);
            if (SSIMULACRA2_WEIGHTS[k]) active.push({k, c, t, p});
          }
          if (!active.length) continue;
          const sumsBuffer = buf(9 * n * 4);
          for (let y0 = 0; y0 < h; y0 += GSC_BAND) {
            const y1 = Math.min(h, y0 + GSC_BAND), ys = Math.max(0, y0 - GSC_HALO), ye = Math.min(h, y1 + GSC_HALO);
            const count = ((y1 + (1 << sh) - 1 >> sh) - (y0 >> sh)) * cw;
            const u = uniform({w, h, y0, y1, ys, ye, c, sh, cstride, n, mode, plane, count, cw, wy: banded ? ys : 0, wh: banded ? ye - ys : h});
            if (banded) copies(() => { rowsOf(A, mode ? 1 : 3, w, h, ys, ye - ys, WA); rowsOf(B, mode ? 1 : 3, w, h, ys, ye - ys, WB); });
            run(pass, 'xyb', (ye - ys) * w, [banded ? WA : A, banded ? WB : B, PA, PB, T], u);
            run(pass, 'rows', (ye - ys) * w, [PA, PB, Q], u);
            run(pass, 'cells', count, [PA, PB, Q, sumsBuffer], u);
          }
          for (const term of active) {
            const [first, count] = term.p === 1 ? [term.t * n, n] : [3 * n + term.t * 2 * n, 2 * n];
            stageSources.push([sumsBuffer, first * 4, count * 4]); stageMeta.push([term, count]);
          }
          sums.push(...active);
        }
        out.push({w, h, sums});
      }
      pass.end();
      const [map, take] = gpuStage(device, buf, encoder, stageSources);
      device.queue.submit([encoder.finish()]);
      seal();
      await map();
      take((mapped, at) => stageMeta.forEach(([term, count], idx) => { term.sum = new Uint32Array(mapped, at[idx], count).slice(); }));
      return out;
    }, true, () => null);
    if (!built) return null;
    pending = null;
    return {scales: built, stride, rows};
  } catch { return null; }
  finally {
    gpuDestroy(made);
    if (pending) { gpuDestroy(pending); if (held?.pyramids === pending) held.pyramids = null; }
  }
}
