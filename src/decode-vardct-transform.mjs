// SPDX-License-Identifier: MIT
import {inverseScaledDCT, TRANSFORMS} from './decode-strategies.mjs';
import {AFV_BASIS} from './afv-basis.mjs';
import {decodeKernels} from './decode-kernels.mjs';

const copyBlock = (target, source, left, top, width, height) => {
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) target[(top + y) * 8 + left + x] = source[y * width + x];
};

const scaledBases = new Map();
export function scaledBasis(n) {
  let b = scaledBases.get(n);
  if (!b) {
    b = new Float64Array(n * n);
    for (let u = 0; u < n; u++) { const impulse = new Float64Array(n); impulse[u] = 1; b.set(inverseScaledDCT(impulse, n, 1), u * n); }
    scaledBases.set(n, b);
  }
  return b;
}
let idctTemp = new Float64Array(64), idctRows = new Uint8Array(8);

export function inverseDCTInto(coeffs, width, height, out) {
  const kernels = decodeKernels();
  if (kernels && coeffs.buffer === kernels.buffer && height > 1) {
    kernels.idct(coeffs.byteOffset, width, height, kernels.basis(width, () => scaledBasis(width)), kernels.basis(height, () => scaledBasis(height)));
    return kernels.output;
  }
  if (width === 8 && height === 8) return inverseDCT8(coeffs, out);
  const bx = scaledBasis(width), by = height === 1 ? null : scaledBasis(height), size = width * height, tall = height >= width;
  if (idctTemp.length < size) idctTemp = new Float64Array(size);
  if (idctRows.length < height) idctRows = new Uint8Array(height);
  const tmp = idctTemp, rows = idctRows;
  tmp.fill(0, 0, size);
  for (let v = 0; v < height; v++) {
    const row = v * width; let any = 0;
    for (let u = 0; u < width; u++) {
      const c = coeffs[tall ? u * height + v : row + u];
      if (c === 0) continue;
      any = 1;
      for (let x = 0, b = u * width; x < width; x++) tmp[row + x] += c * bx[b + x];
    }
    rows[v] = any;
  }
  out.fill(0, 0, size);
  if (!by) { for (let x = 0; x < width; x++) out[x] += tmp[x]; return out; }
  for (let v = 0; v < height; v++) {
    if (!rows[v]) continue;
    const row = v * width, column = v * height;
    for (let y = 0; y < height; y++) {
      const t = by[column + y], o = y * width;
      for (let x = 0; x < width; x++) out[o + x] += tmp[row + x] * t;
    }
  }
  return out;
}
function inverseDCT8(coeffs, out) {
  const b = scaledBasis(8), tmp = idctTemp, rows = idctRows;
  tmp.fill(0, 0, 64);
  for (let v = 0; v < 8; v++) {
    const row = v * 8; let any = 0;
    for (let u = 0; u < 8; u++) {
      const c = coeffs[u * 8 + v];
      if (c === 0) continue;
      any = 1;
      const k = u * 8;
      tmp[row] += c * b[k]; tmp[row + 1] += c * b[k + 1]; tmp[row + 2] += c * b[k + 2]; tmp[row + 3] += c * b[k + 3];
      tmp[row + 4] += c * b[k + 4]; tmp[row + 5] += c * b[k + 5]; tmp[row + 6] += c * b[k + 6]; tmp[row + 7] += c * b[k + 7];
    }
    rows[v] = any;
  }
  out.fill(0, 0, 64);
  for (let v = 0; v < 8; v++) {
    if (!rows[v]) continue;
    const row = v * 8, t0 = tmp[row], t1 = tmp[row + 1], t2 = tmp[row + 2], t3 = tmp[row + 3], t4 = tmp[row + 4], t5 = tmp[row + 5], t6 = tmp[row + 6], t7 = tmp[row + 7];
    for (let y = 0; y < 8; y++) {
      const t = b[row + y], o = y * 8;
      out[o] += t0 * t; out[o + 1] += t1 * t; out[o + 2] += t2 * t; out[o + 3] += t3 * t;
      out[o + 4] += t4 * t; out[o + 5] += t5 * t; out[o + 6] += t6 * t; out[o + 7] += t7 * t;
    }
  }
  return out;
}
const vdWork = new Float64Array(64), vdOut = new Float64Array(64), vdScratch = new Float64Array(64), vdPart = new Float64Array(32), vdDCT = new Float64Array(32);
const dct = (coeffs, width, height) => inverseDCTInto(coeffs, width, height, vdDCT);

export function inverseVarDCT(coefficients, id, target) {
  const transform = TRANSFORMS[id];
  if (!transform || coefficients.length < transform.width * transform.height) throw new RangeError('Invalid JPEG XL transform.');
  if (id === 0 || id >= 4 && id <= 11 || id >= 18) return inverseDCTInto(coefficients, transform.width, transform.height, target ?? new Float64Array(transform.width * transform.height));
  const work = vdWork, out = vdOut;
  for (let i = 0; i < 64; i++) work[i] = coefficients[i];
  if (id <= 3) {
    const combine = size => {
      const half = size / 2, scratch = vdScratch;
      for (let y = 0; y < half; y++) for (let x = 0; x < half; x++) {
        const a = work[y * 8 + x], b = work[y * 8 + x + half];
        const c = work[(y + half) * 8 + x], d = work[(y + half) * 8 + x + half];
        const p = y * 2 * size + x * 2;
        scratch[p] = a + b + c + d; scratch[p + 1] = a + b - c - d;
        scratch[p + size] = a - b + c - d; scratch[p + size + 1] = a - b - c + d;
      }
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) work[y * 8 + x] = scratch[y * size + x];
    };
    combine(2);
    if (id === 2) { combine(4); combine(8); return work; }
    for (let by = 0; by < 2; by++) for (let bx = 0; bx < 2; bx++) {
      let part = vdPart;
      for (let k = 0; k < 16; k++) part[k] = work[(by + (k >> 2) * 2) * 8 + bx + (k & 3) * 2];
      if (id === 3) part = dct(part, 4, 4);
      else {
        let residual = 0;
        for (let k = 1; k < 16; k++) residual += part[k];
        const center = part[0] - residual / 16;
        part[0] = part[5]; part[5] = 0;
        for (let k = 0; k < 16; k++) part[k] += center;
      }
      copyBlock(out, part, bx * 4, by * 4, 4, 4);
    }
    return out;
  }
  if (id === 12 || id === 13) {
    work[0] = coefficients[0] + coefficients[8]; work[8] = coefficients[0] - coefficients[8];
    for (let half = 0; half < 2; half++) {
      const part = vdPart;
      for (let k = 0; k < 32; k++) part[k] = work[((k >> 3) * 2 + half) * 8 + (k & 7)];
      const w = id === 12 ? 8 : 4, h = id === 12 ? 4 : 8;
      copyBlock(out, dct(part, w, h), id === 13 ? half * 4 : 0, id === 12 ? half * 4 : 0, w, h);
    }
    return out;
  }
  const flipX = (id - 14) & 1, flipY = (id - 14) >> 1;
  const afv = vdPart;
  for (let k = 0; k < 16; k++) afv[k] = work[(k >> 2) * 16 + (k & 3) * 2];
  afv[0] = 4 * (work[0] + work[1] + work[8]);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
    const i = (flipY ? 3 - y : y) * 4 + (flipX ? 3 - x : x);
    let value = 0;
    for (let k = 0; k < 16; k++) value += afv[k] * AFV_BASIS[i * 16 + k];
    out[(flipY * 4 + y) * 8 + flipX * 4 + x] = value;
  }
  const quarter = vdPart;
  for (let k = 0; k < 16; k++) quarter[k] = work[(k >> 2) * 16 + (k & 3) * 2 + 1];
  quarter[0] = work[0] - work[1] + work[8];
  copyBlock(out, dct(quarter, 4, 4), (1 - flipX) * 4, flipY * 4, 4, 4);
  const half = vdPart;
  for (let k = 0; k < 32; k++) half[k] = work[((k >> 3) * 2 + 1) * 8 + (k & 7)];
  half[0] = work[0] - work[8];
  copyBlock(out, dct(half, 8, 4), 0, (1 - flipY) * 4, 8, 4);
  return out;
}

const mirror = (v, size) => { const n = size * 2; v = (v % n + n) % n; return v < size ? v : n - 1 - v; };

export function smoothLF(planes, widths, heights, hshifts, vshifts, steps) {
  if (widths.some(w => w <= 2) || heights.some(h => h <= 2)) return planes;
  const means = planes.map((p, c) => {
    const w = widths[c], h = heights[c], out = Float32Array.from(p);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const at = y * w + x;
      const sides = p[at - 1] + p[at + 1] + p[at - w] + p[at + w];
      const corners = p[at - w - 1] + p[at - w + 1] + p[at + w - 1] + p[at + w + 1];
      out[at] = p[at] * .052262735 + sides * .2034514 + corners * .03348292;
    }
    return out;
  });
  const out = planes.map(p => Float32Array.from(p)), w = Math.max(...widths), h = Math.max(...heights);
  if (hshifts.every(s => !s) && vshifts.every(s => !s) && widths.every(v => v === w) && heights.every(v => v === h)) {
    const [p0, p1, p2] = planes, [m0, m1, m2] = means, [o0, o1, o2] = out, [s0, s1, s2] = steps;
    for (let y = 1; y < h - 1; y++) for (let x = 1, i = y * w + 1; x < w - 1; x++, i++) {
      const gap = Math.max(Math.max(Math.max(.5, Math.abs(m0[i] - p0[i]) / s0), Math.abs(m1[i] - p1[i]) / s1), Math.abs(m2[i] - p2[i]) / s2);
      const scale = Math.max(0, 3 - 4 * gap);
      o0[i] = p0[i] + scale * (m0[i] - p0[i]); o1[i] = p1[i] + scale * (m1[i] - p1[i]); o2[i] = p2[i] + scale * (m2[i] - p2[i]);
    }
    return out;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let gap = .5, edge = false;
    const indices = [];
    for (let c = 0; c < 3; c++) {
      const cx = x >> hshifts[c], cy = y >> vshifts[c], i = cy * widths[c] + cx;
      indices.push(i);
      if (!cx || !cy || cx === widths[c] - 1 || cy === heights[c] - 1) { edge = true; break; }
      gap = Math.max(gap, Math.abs(means[c][i] - planes[c][i]) / steps[c]);
    }
    if (edge) continue;
    const scale = Math.max(0, 3 - 4 * gap);
    for (let c = 0; c < 3; c++) if ((x & ((1 << hshifts[c]) - 1)) === 0 && (y & ((1 << vshifts[c]) - 1)) === 0) {
      const i = indices[c]; out[c][i] = planes[c][i] + scale * (means[c][i] - planes[c][i]);
    }
  }
  return out;
}

function gaborishRows(p, top, out, outTop, width, height, y0, y1, side, diagonal) {
  const normal = 1 / (1 + 4 * side + 4 * diagonal), kernels = decodeKernels();
  const wasm = kernels && p.buffer === kernels.buffer && out.buffer === kernels.buffer && width > 2;
  for (let y = y0; y < y1; y++) {
    const ym = (Math.max(0, y - 1) - top) * width, yp = (Math.min(height - 1, y + 1) - top) * width, row = (y - top) * width, o = (y - outTop) * width;
    if (wasm) kernels.gab(p.byteOffset + row * 4, p.byteOffset + ym * 4, p.byteOffset + yp * 4, out.byteOffset + o * 4, width - 2, side, diagonal, normal);
    for (let x = 0; x < width; x++) {
      if (wasm && x === 1) x = width - 1;
      if (x === 1 && width > 2) {
        for (; x < width - 1; x++) {
          const cross = p[row + x - 1] + p[row + x + 1] + p[ym + x] + p[yp + x];
          const corners = p[ym + x - 1] + p[ym + x + 1] + p[yp + x - 1] + p[yp + x + 1];
          out[o + x] = normal * (p[row + x] + side * cross + diagonal * corners);
        }
      }
      const xm = Math.max(0, x - 1), xp = Math.min(width - 1, x + 1);
      const cross = p[row + xm] + p[row + xp] + p[ym + x] + p[yp + x];
      const corners = p[ym + xm] + p[ym + xp] + p[yp + xm] + p[yp + xp];
      out[o + x] = normal * (p[row + x] + side * cross + diagonal * corners);
    }
  }
}

const EPF_CROSS = [[0, -1], [-1, 0], [1, 0], [0, 1]];
const EPF_RADIUS2 = [[0, -2], [-1, -1], [0, -1], [1, -1], [-2, 0], [-1, 0], [1, 0], [2, 0], [-1, 1], [0, 1], [1, 1], [0, 2]];

function epfCrossRow(ring, distUp, distDown, upValid, source, out, row, outRow, y, width, sigma, sw, cs0, cs1, cs2, multiplier, borderMultiplier, modularSigma) {
  const p0 = source[0], p1 = source[1], p2 = source[2], o0 = out[0], o1 = out[1], o2 = out[2], w = width;
  const [H00, H01, H02] = ring[0].h, [H10, H11, H12] = ring[1].h, [H20, H21, H22] = ring[2].h;
  const [V00, V01, V02, V03] = ring[0].v, [V10, V11, V12, V13] = ring[1].v, [V20, V21, V22, V23] = ring[2].v;
  const rowBorder = (y & 7) === 0 || (y & 7) === 7, sigmaRow = (y >> 3) * sw, base = row * w, outBase = outRow * w;
  if (!upValid) for (let x = 3, end = width - 3; x < end; x++) {
    let distance = 0; distance += cs0 * (V00[x] + V01[x - 1] + V01[x] + V01[x + 1] + V02[x]); distance += cs1 * (V10[x] + V11[x - 1] + V11[x] + V11[x + 1] + V12[x]); distance += cs2 * (V20[x] + V21[x - 1] + V21[x] + V21[x + 1] + V22[x]);
    distUp[x] = distance;
  }
  let left = 0; left += cs0 * (H00[2] + H01[1] + H01[2] + H01[3] + H02[2]); left += cs1 * (H10[2] + H11[1] + H11[2] + H11[3] + H12[2]); left += cs2 * (H20[2] + H21[1] + H21[2] + H21[3] + H22[2]);
  let s = 0, inner = 0, edge = 0;
  for (let x = 3, end = width - 3; x < end; x++) {
    let right = 0; right += cs0 * (H00[x] + H01[x - 1] + H01[x] + H01[x + 1] + H02[x]); right += cs1 * (H10[x] + H11[x - 1] + H11[x] + H11[x + 1] + H12[x]); right += cs2 * (H20[x] + H21[x - 1] + H21[x] + H21[x + 1] + H22[x]);
    let down = 0; down += cs0 * (V01[x] + V02[x - 1] + V02[x] + V02[x + 1] + V03[x]); down += cs1 * (V11[x] + V12[x - 1] + V12[x] + V12[x + 1] + V13[x]); down += cs2 * (V21[x] + V22[x - 1] + V22[x] + V22[x + 1] + V23[x]);
    const up = distUp[x], before = left;
    distDown[x] = down; left = right;
    const at = base + x, to = outBase + x;
    if (x === 3 || (x & 7) === 0) {
      s = sigma ? sigma[sigmaRow + (x >> 3)] : modularSigma; inner = -1.9330952441687866 / s * multiplier; edge = inner * borderMultiplier;
    }
    if (s < .3) { o0[to] = p0[at]; o1[to] = p1[at]; o2[to] = p2[at]; continue; }
    const factor = rowBorder || (x & 7) === 0 || (x & 7) === 7 ? edge : inner;
    let weightSum = 1, v0 = p0[at], v1 = p1[at], v2 = p2[at], weight, ni;
    weight = Math.max(0, 1 + up * factor); ni = at - w;
    weightSum += weight; v0 += p0[ni] * weight; v1 += p1[ni] * weight; v2 += p2[ni] * weight;
    weight = Math.max(0, 1 + before * factor); ni = at - 1;
    weightSum += weight; v0 += p0[ni] * weight; v1 += p1[ni] * weight; v2 += p2[ni] * weight;
    weight = Math.max(0, 1 + right * factor); ni = at + 1;
    weightSum += weight; v0 += p0[ni] * weight; v1 += p1[ni] * weight; v2 += p2[ni] * weight;
    weight = Math.max(0, 1 + down * factor); ni = at + w;
    weightSum += weight; v0 += p0[ni] * weight; v1 += p1[ni] * weight; v2 += p2[ni] * weight;
    o0[to] = v0 / weightSum; o1[to] = v1 / weightSum; o2[to] = v2 / weightSum;
  }
}

function epfRows(source, top, out, outTop, width, height, y0, y1, step, epf, sigma, kernel = null) {
  const channelScale = epf.channelScale || [40, 5, 3.5], sw = Math.ceil(width / 8), cs0 = channelScale[0], cs1 = channelScale[1], cs2 = channelScale[2];
  const reflectedX = Int32Array.from({length: width + 6}, (_, i) => mirror(i - 3, width));
  const first = Math.max(0, y0 - 3), reflectedY = Int32Array.from({length: y1 - first + 6}, (_, i) => (mirror(first + i - 3, height) - top) * width);
  const ry = y => reflectedY[y - first + 3];
  const offsets = step === 0 ? EPF_RADIUS2 : EPF_CROSS, p0 = source[0], p1 = source[1], p2 = source[2], o0 = out[0], o1 = out[1], o2 = out[2];
  const deltas = Int32Array.from(offsets, ([dx, dy]) => dy * width + dx), count = deltas.length;
  const multiplier = step === 0 ? epf.pass0SigmaScale ?? .9 : step === 2 ? epf.pass2SigmaScale ?? 6.5 : 1;
  const borderMultiplier = epf.borderSadMul ?? 2 / 3, w = width;
  const pixel = (x, y) => {
    const at = (y - top) * width + x, to = (y - outTop) * width + x, s = sigma ? sigma[(y >> 3) * sw + (x >> 3)] : epf.sigmaForModular ?? 1;
    if (s < .3) { o0[to] = p0[at]; o1[to] = p1[at]; o2[to] = p2[at]; return; }
    const border = (x & 7) === 0 || (x & 7) === 7 || (y & 7) === 0 || (y & 7) === 7;
    const factor = -1.9330952441687866 / s * multiplier * (border ? borderMultiplier : 1);
    let weightSum = 1, v0 = p0[at], v1 = p1[at], v2 = p2[at];
    const a0 = ry(y + 2 - 3) + x, a1 = at - x + reflectedX[x + 2];
    const a3 = at - x + reflectedX[x + 4], a4 = ry(y + 4 - 3) + x;
    for (const [dx, dy] of offsets) {
      const row = ry(y + dy), column = reflectedX[x + dx + 3], ni = row + column;
      let d0, d1, d2;
      if (step === 2) {
        d0 = Math.abs(p0[at] - p0[ni]); d1 = Math.abs(p1[at] - p1[ni]); d2 = Math.abs(p2[at] - p2[ni]);
      } else {
        const b0 = ry(y + dy - 1) + column, b1 = row + reflectedX[x + dx + 2];
        const b3 = row + reflectedX[x + dx + 4], b4 = ry(y + dy + 1) + column;
        d0 = Math.abs(p0[a0] - p0[b0]) + Math.abs(p0[a1] - p0[b1]) + Math.abs(p0[at] - p0[ni]) + Math.abs(p0[a3] - p0[b3]) + Math.abs(p0[a4] - p0[b4]);
        d1 = Math.abs(p1[a0] - p1[b0]) + Math.abs(p1[a1] - p1[b1]) + Math.abs(p1[at] - p1[ni]) + Math.abs(p1[a3] - p1[b3]) + Math.abs(p1[a4] - p1[b4]);
        d2 = Math.abs(p2[a0] - p2[b0]) + Math.abs(p2[a1] - p2[b1]) + Math.abs(p2[at] - p2[ni]) + Math.abs(p2[a3] - p2[b3]) + Math.abs(p2[a4] - p2[b4]);
      }
      let distance = 0; distance += cs0 * d0; distance += cs1 * d1; distance += cs2 * d2;
      const weight = Math.max(0, 1 + distance * factor);
      weightSum += weight; v0 += p0[ni] * weight; v1 += p1[ni] * weight; v2 += p2[ni] * weight;
    }
    o0[to] = v0 / weightSum; o1[to] = v1 / weightSum; o2[to] = v2 / weightSum;
  };
  const ring = step === 1 && !(kernel && decodeKernels()) ? source.map(() => ({h: [0, 1, 2].map(() => new Float64Array(width)), v: [0, 1, 2, 3].map(() => new Float64Array(width))})) : null;
  let ringRow = -2, upRow = -2, distUp = ring && new Float64Array(width), distDown = ring && new Float64Array(width);
  const differences = (c, y, kind, out) => {
    const p = source[c], at = (y - top) * w;
    if (kind === 0) for (let x = 0; x < w - 1; x++) out[x] = Math.abs(p[at + x] - p[at + x + 1]);
    else for (let x = 0; x < w; x++) out[x] = Math.abs(p[at + x] - p[at + w + x]);
  };
  const advance = y => {
    for (let c = 0; c < 3; c++) {
      const {h, v} = ring[c];
      if (ringRow === y - 1) {
        const h0 = h[0], v0 = v[0];
        h[0] = h[1]; h[1] = h[2]; h[2] = h0; v[0] = v[1]; v[1] = v[2]; v[2] = v[3]; v[3] = v0;
        differences(c, y + 1, 0, h[2]); differences(c, y + 1, 1, v[3]);
      } else {
        for (let i = 0; i < 3; i++) differences(c, y - 1 + i, 0, h[i]);
        for (let i = 0; i < 4; i++) differences(c, y - 2 + i, 1, v[i]);
      }
    }
    ringRow = y;
  };
  const kernels = decodeKernels(), ya = Math.max(y0, 3), yb = Math.min(y1, height - 3);
  const wasm = step === 1 && kernel && width >= 7 && ya < yb && [...source, ...out].every(p => p.buffer === kernels.buffer);
  if (wasm) {
    const {i32} = kernels;
    for (let c = 0; c < 3; c++) { i32[kernel.args / 4 + c] = source[c].byteOffset; i32[kernel.args / 4 + 3 + c] = out[c].byteOffset; }
    kernels.epf1(kernel.args, kernel.args + 12, width, top, outTop, ya, yb, sigma ? kernel.sigma : 0, sw, kernel.ring, kernel.up, kernel.down,
      cs0, cs1, cs2, multiplier, borderMultiplier, epf.sigmaForModular ?? 1);
  }
  for (let y = y0; y < y1; y++) {
    if (y < 3 || y >= height - 3 || width < 7) { for (let x = 0; x < width; x++) pixel(x, y); continue; }
    for (let x = 0; x < 3; x++) pixel(x, y);
    if (wasm) { for (let x = Math.max(3, width - 3); x < width; x++) pixel(x, y); continue; }
    if (ring) {
      advance(y);
      epfCrossRow(ring, distUp, distDown, upRow === y - 1, source, out, y - top, y - outTop, y, width, sigma, sw, cs0, cs1, cs2, multiplier, borderMultiplier, epf.sigmaForModular ?? 1);
      [distUp, distDown] = [distDown, distUp]; upRow = y;
      for (let x = Math.max(3, width - 3); x < width; x++) pixel(x, y);
      continue;
    }
    const rowBorder = (y & 7) === 0 || (y & 7) === 7, sigmaRow = (y >> 3) * sw, base = (y - top) * w, outBase = (y - outTop) * w;
    for (let x = 3, end = width - 3; x < end; x++) {
      const at = base + x, to = outBase + x, s = sigma ? sigma[sigmaRow + (x >> 3)] : epf.sigmaForModular ?? 1;
      if (s < .3) { o0[to] = p0[at]; o1[to] = p1[at]; o2[to] = p2[at]; continue; }
      const factor = -1.9330952441687866 / s * multiplier * (rowBorder || (x & 7) === 0 || (x & 7) === 7 ? borderMultiplier : 1);
      let weightSum = 1, v0 = p0[at], v1 = p1[at], v2 = p2[at];
      for (let k = 0; k < count; k++) {
        const ni = at + deltas[k];
        let d0, d1, d2;
        if (step === 2) {
          d0 = Math.abs(p0[at] - p0[ni]); d1 = Math.abs(p1[at] - p1[ni]); d2 = Math.abs(p2[at] - p2[ni]);
        } else {
          d0 = Math.abs(p0[at - w] - p0[ni - w]) + Math.abs(p0[at - 1] - p0[ni - 1]) + Math.abs(p0[at] - p0[ni]) + Math.abs(p0[at + 1] - p0[ni + 1]) + Math.abs(p0[at + w] - p0[ni + w]);
          d1 = Math.abs(p1[at - w] - p1[ni - w]) + Math.abs(p1[at - 1] - p1[ni - 1]) + Math.abs(p1[at] - p1[ni]) + Math.abs(p1[at + 1] - p1[ni + 1]) + Math.abs(p1[at + w] - p1[ni + w]);
          d2 = Math.abs(p2[at - w] - p2[ni - w]) + Math.abs(p2[at - 1] - p2[ni - 1]) + Math.abs(p2[at] - p2[ni]) + Math.abs(p2[at + 1] - p2[ni + 1]) + Math.abs(p2[at + w] - p2[ni + w]);
        }
        let distance = 0; distance += cs0 * d0; distance += cs1 * d1; distance += cs2 * d2;
        const weight = Math.max(0, 1 + distance * factor);
        weightSum += weight; v0 += p0[ni] * weight; v1 += p1[ni] * weight; v2 += p2[ni] * weight;
      }
      o0[to] = v0 / weightSum; o1[to] = v1 / weightSum; o2[to] = v2 / weightSum;
    }
    for (let x = Math.max(3, width - 3); x < width; x++) pixel(x, y);
  }
}

export function restorationStages(filter) {
  const stages = [];
  if (filter?.gaborish) stages.push({radius: 1});
  const iters = filter?.epf?.iters;
  for (const step of iters === 3 ? [0, 1, 2] : iters === 2 ? [1, 2] : iters ? [1] : []) stages.push({radius: step === 0 ? 3 : step === 1 ? 2 : 1, step});
  return stages;
}

export function restoreRows(planes, top, width, height, filter, sigma, output, outTop, a, b, scratch = []) {
  const stages = restorationStages(filter);
  let source = planes, sourceTop = top, after = stages.reduce((n, s) => n + s.radius, 0);
  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i]; after -= stage.radius;
    const y0 = Math.max(0, a - after), y1 = Math.min(height, b + after), last = i === stages.length - 1;
    let target = last && !scratch.kernel ? output : last ? scratch.kernel.final : null;
    if (!last) {
      const size = (y1 - y0) * width;
      if (!scratch[i] || scratch[i][0].length < size) scratch[i] = source.map(() => new Float32Array(size));
      target = scratch[i];
    }
    const targetTop = last ? scratch.kernel ? a : outTop : y0;
    if (stage.step === undefined) for (let c = 0; c < source.length; c++) {
      const [side, diagonal] = filter.gaborish === true ? [.115169525, .061248592] : filter.gaborish[c];
      gaborishRows(source[c], sourceTop, target[c], targetTop, width, height, y0, y1, side, diagonal);
    } else epfRows(source, sourceTop, target, targetTop, width, height, y0, y1, stage.step, filter.epf, sigma, scratch.kernel);
    source = target; sourceTop = targetTop;
  }
  if (stages.length && scratch.kernel && source[0].byteOffset !== output[0].byteOffset) for (let c = 0; c < 3; c++) output[c].set(source[c].subarray(0, (b - a) * width), (a - outTop) * width);
  if (!stages.length) for (let c = 0; c < planes.length; c++) output[c].set(planes[c].subarray((a - top) * width, (b - top) * width), (a - outTop) * width);
}

export function restoreFilters(planes, width, height, filter, sigma = null) {
  if (!filter || !restorationStages(filter).length) return planes;
  const output = planes.map(p => new Float32Array(p.length));
  restoreRows(planes, 0, width, height, filter, sigma, output, 0, 0, height);
  return output;
}
