// SPDX-License-Identifier: MIT
import {exactCbrt, exactCos, exactPow, EXACT_PI} from './exact-math.mjs';
import {scaledDCT, inverseSmallTransform, TRANSFORMS} from './vardct-strategies.mjs';
import {float16Bits} from './bits.mjs';

const rcCube = v => v * v * v;
const RC_ONE = [1 - 0.05465007330715401, 1 - 0.07005449891748593, 1 - 0.049935103337343655];
const rcRecon = (q, c) => q === 0 ? 0 : q === 1 ? RC_ONE[c] : q === -1 ? -RC_ONE[c] : q - 0.145 / q;
const RC_BIAS = 0.0037930732552754493, RC_ROOT_BIAS = exactCbrt(RC_BIAS);
const RC_GAB = [0.115169525, 0.061248592];

export function half(value) {
  const bits = float16Bits(value), sign = bits & 0x8000 ? -1 : 1, e = (bits >> 10) & 31, m = bits & 1023;
  return sign * (e ? (1 + m / 1024) * exactPow(2, e - 15) : m / 1024 * exactPow(2, -14));
}

const RC_M = [0.3, 0.622, 0.078, 0.23, 0.692, 0.078, 0.24342268924547819, 0.20476744424496821, 0.5518098665095536];
const RC_INV = (() => {
  const [a, b, c, d, e, f, g, h, i] = RC_M, det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  return [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det, (f * g - d * i) / det, (a * i - c * g) / det,
    (c * d - a * f) / det, (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det];
})();

const RC_COS = (n, d) => exactCos(EXACT_PI * n / d);
const RC_LLF_DIVISORS = new Map();
function rcLlfDivisors(w, h) {
  let d = RC_LLF_DIVISORS.get(w * 64 + h);
  if (!d) {
    const scale = (k, size) => RC_COS(k, 2 * size) * RC_COS(k, size) * RC_COS(2 * k, size);
    d = new Float64Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d[y * w + x] = scale(x, w * 8) * scale(y, h * 8);
    RC_LLF_DIVISORS.set(w * 64 + h, d);
  }
  return d;
}
const RC_LLF_ONE = rcLlfDivisors(1, 1)[0];
export function rcLlfFromDC(means, bw, bh) {
  const w = Math.max(bw, bh), h = Math.min(bw, bh), low = scaledDCT(means, bw, bh), divisors = rcLlfDivisors(w, h);
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = low[y * w + x] / divisors[y * w + x];
  return out;
}

export function inverseBasis(n) {
  return Float64Array.from({length: n * n}, (_, i) => { const k = Math.floor(i / n), x = i % n; return (k ? 1.4142135623730951 : 1) * RC_COS((2 * x + 1) * k, 2 * n); });
}

export function coefficientPlanes(image) {
  const comps = image.components, stride = comps[0].stride, rows = comps[0].rows, W = stride * 8, H = rows * 8;
  const QS = image.quantScale || 256, planes = [0, 1, 2].map(() => new Float32Array(W * H)), cells = new Uint32Array(stride * rows);
  const cfl = image.cfl, base = image.quantFieldBase || 1, fields = image.quantFields;
  const dcStep = comps.map(c => half(c.quant[0] / (255 * 8 * QS) * 128) / 128 * 255 * 8);
  const strategy = image.strategyData;
  if (!strategy) {
    const y = new Float64Array(64), coef = new Float64Array(64), order = [1, 0, 2];
    const quants = comps.map(c => c.quant), coeffs = comps.map(c => c.coeffs), one = [RC_ONE[0], RC_ONE[1], RC_ONE[2]];
    for (let by = 0; by < rows; by++) for (let bx = 0; bx < stride; bx++) {
      const at = (by * stride + bx) * 64, QSf = QS * (fields ? fields[by * stride + bx] / base : 1);
      const t = (by >> 3) * cfl.width + (bx >> 3), kx = cfl.x[t] / 84, kb = 1 + cfl.b[t] / 84;
      cells[by * stride + bx] = bx | by << 12;
      for (let o = 0; o < 3; o++) {
        const c = order[o], q = coeffs[c], quant = quants[c], r1 = one[c];
        coef[0] = q[at] * dcStep[c];
        for (let k = 1; k < 64; k++) {
          const v = q[at + k];
          coef[k] = v === 0 ? 0 : (v === 1 ? r1 : v === -1 ? -r1 : v - 0.145 / v) * quant[k] / QSf;
        }
        if (c === 1) y.set(coef);
        else {
          const k3 = c === 0 ? kx : kb;
          coef[0] += (c === 2 ? 1 : 0) * y[0];
          for (let k = 1; k < 64; k++) coef[k] += k3 * y[k];
        }
        const p = planes[c];
        for (let v = 0, row = by * 8 * W + bx * 8; v < 8; v++, row += W) for (let u = 0; u < 8; u++) p[row + u] = coef[v * 8 + u] / (8 * 255);
      }
    }
    return {planes, cells, W, H, stride, rows};
  }
  const tr = new Float64Array(256 * 256), lumaAC = new Float64Array(256 * 256), smallPx = new Float64Array(64), smallDct = new Float64Array(64);
  const channels = [1, 0, 2], one = [RC_ONE[0], RC_ONE[1], RC_ONE[2]];
  const tableSteps = new Map();
  for (const block of strategy.blocks) {
    const {id, bx, by, bw, bh, area, size, order} = block, t = TRANSFORMS[id], w = t.width, h = t.height;
    let steps = tableSteps.get(t.table);
    if (!steps) tableSteps.set(t.table, steps = strategy.tables.get(t.table).planes);
    const f = fields ? fields[by * stride + bx] / base : 1, ct = (by >> 3) * cfl.width + (bx >> 3), k3 = [cfl.x[ct] / 84, 0, 1 + cfl.b[ct] / 84];
    const L = Math.max(bw, bh), S = Math.min(bw, bh), divisor = 8 * QS * f;
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) cells[(by + y) * stride + bx + x] = bx | by << 12 | (bw - 1) << 24 | (bh - 1) << 28;
    let lumaNzLen = 0;
    const lumaNz = RC_LUMA_NZ;
    for (let o = 0; o < 3; o++) {
      const c = channels[o], q = block.coeffs[c], s = steps[c], r1 = one[c];
      tr.fill(0, 0, size);
      if (c === 1) {
        for (let k = area; k < size; k++) {
          const pos = order[k], v = q[pos];
          if (v !== 0) {
            const val = (v === 1 ? r1 : v === -1 ? -r1 : v - 0.145 / v) * s[pos] / divisor;
            tr[pos] = val; lumaAC[pos] = val; lumaNz[lumaNzLen++] = pos;
          }
        }
      } else {
        for (let k = area; k < size; k++) {
          const pos = order[k], v = q[pos];
          if (v !== 0) tr[pos] = (v === 1 ? r1 : v === -1 ? -r1 : v - 0.145 / v) * s[pos] / divisor;
        }
        const k = k3[c];
        if (k !== 0) for (let i = 0; i < lumaNzLen; i++) { const pos = lumaNz[i]; tr[pos] += k * lumaAC[pos]; }
      }
      if (bw === 1 && bh === 1) {
        const pos = by * stride + bx;
        tr[0] = ((comps[c].dc[pos] * dcStep[c] + (c === 2 ? comps[1].dc[pos] * dcStep[1] : 0)) / 8 + 0) / RC_LLF_ONE;
        const d8 = id === 0 ? tr : scaledDCT(inverseSmallTransform(tr, id, smallPx), 8, 8, smallDct);
        const p = planes[c];
        for (let v = 0, row = by * 8 * W + bx * 8; v < 8; v++, row += W) for (let u = 0; u < 8; u++) p[row + u] = d8[u * 8 + v] / 255;
        continue;
      }
      const means = new Float64Array(bw * bh);
      for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
        const pos = (by + y) * stride + bx + x;
        means[y * bw + x] = (comps[c].dc[pos] * dcStep[c] + (c === 2 ? comps[1].dc[pos] * dcStep[1] : 0)) / 8;
      }
      const llf = rcLlfFromDC(means, bw, bh);
      for (let y = 0; y < S; y++) for (let x = 0; x < L; x++) tr[y * L * 8 + x] = llf[y * L + x];
      const p = planes[c];
      for (let v = 0; v < h; v++) for (let u = 0; u < w; u++) p[(by * 8 + v) * W + bx * 8 + u] = tr[h >= w ? u * h + v : v * w + u] / 255;
    }
  }
  return {planes, cells, W, H, stride, rows};
}

const RC_BASES = [];
const rcBasis = n => RC_BASES[n] || (RC_BASES[n] = inverseBasis(n));
const RC_ACC = new Float64Array(256), RC_ROW_TMP = new Float32Array(256 * 256), RC_ACTIVE_V = new Uint8Array(256);
const RC_SMALL_PX = new Float64Array(64), RC_SMALL_DCT = new Float64Array(64);
const RC_TR = new Float64Array(256 * 256), RC_LUMA_AC = new Float64Array(256 * 256), RC_LUMA_NZ = new Uint16Array(256 * 256), RC_MEANS_SCRATCH = new Map();

function rcBlockIdct(tr, w, h, tall, Bw, Bh, out, x0, y0, W) {
  const f32 = Math.fround, acc = RC_ACC, rowTmp = RC_ROW_TMP, activeV = RC_ACTIVE_V;
  let numActive = 0;
  for (let v = 0; v < h; v++) {
    const vw = v * w;
    let any = 0;
    acc.fill(0, 0, w);
    if (tall) {
      for (let u = 0; u < w; u++) {
        const cu = f32(tr[u * h + v] / 255);
        if (cu !== 0) {
          any = 1;
          const uw = u * w;
          for (let lx = 0; lx < w; lx++) acc[lx] += cu * Bw[uw + lx];
        }
      }
    } else {
      for (let u = 0; u < w; u++) {
        const cu = f32(tr[vw + u] / 255);
        if (cu !== 0) {
          any = 1;
          const uw = u * w;
          for (let lx = 0; lx < w; lx++) acc[lx] += cu * Bw[uw + lx];
        }
      }
    }
    if (any) {
      activeV[numActive++] = v;
      for (let lx = 0; lx < w; lx++) rowTmp[vw + lx] = acc[lx];
    }
  }
  for (let ly = 0; ly < h; ly++) {
    const yW = (y0 + ly) * W + x0;
    acc.fill(0, 0, w);
    for (let a = 0; a < numActive; a++) {
      const v = activeV[a], bvl = Bh[v * h + ly], vw = v * w;
      for (let lx = 0; lx < w; lx++) acc[lx] += rowTmp[vw + lx] * bvl;
    }
    for (let lx = 0; lx < w; lx++) out[yW + lx] = acc[lx];
  }
}

function rcXybPlanes(image) {
  const comps = image.components, stride = comps[0].stride, rows = comps[0].rows, W = stride * 8, H = rows * 8;
  const QS = image.quantScale || 256, outPlanes = [0, 1, 2].map(() => new Float32Array(W * H));
  const cfl = image.cfl, base = image.quantFieldBase || 1, fields = image.quantFields;
  const dcStep = comps.map(c => half(c.quant[0] / (255 * 8 * QS) * 128) / 128 * 255 * 8);
  const strategy = image.strategyData, f32 = Math.fround;
  const acc = RC_ACC, rowTmp = RC_ROW_TMP, activeV = RC_ACTIVE_V;

  if (!strategy) {
    const B8 = rcBasis(8), y = new Float64Array(64), coef = new Float64Array(64), order = [1, 0, 2];
    const quants = comps.map(c => c.quant), coeffs = comps.map(c => c.coeffs), one = [RC_ONE[0], RC_ONE[1], RC_ONE[2]];
    for (let by = 0; by < rows; by++) for (let bx = 0; bx < stride; bx++) {
      const at = (by * stride + bx) * 64, QSf = QS * (fields ? fields[by * stride + bx] / base : 1);
      const t = (by >> 3) * cfl.width + (bx >> 3), kx = cfl.x[t] / 84, kb = 1 + cfl.b[t] / 84;
      const x0 = bx * 8, y0 = by * 8;
      for (let o = 0; o < 3; o++) {
        const c = order[o], q = coeffs[c], quant = quants[c], r1 = one[c];
        coef[0] = q[at] * dcStep[c];
        for (let k = 1; k < 64; k++) {
          const v = q[at + k];
          coef[k] = v === 0 ? 0 : (v === 1 ? r1 : v === -1 ? -r1 : v - 0.145 / v) * quant[k] / QSf;
        }
        if (c === 1) y.set(coef);
        else {
          const k3 = c === 0 ? kx : kb;
          coef[0] += (c === 2 ? 1 : 0) * y[0];
          for (let k = 1; k < 64; k++) coef[k] += k3 * y[k];
        }
        for (let v = 0; v < 8; v++) {
          const v8 = v * 8;
          let any = 0;
          acc.fill(0, 0, 8);
          for (let u = 0; u < 8; u++) {
            const cu = f32(coef[v8 + u] / (8 * 255));
            if (cu !== 0) {
              any = 1;
              const u8 = u * 8;
              for (let lx = 0; lx < 8; lx++) acc[lx] += cu * B8[u8 + lx];
            }
          }
          activeV[v] = any;
          if (any) for (let lx = 0; lx < 8; lx++) rowTmp[v8 + lx] = acc[lx];
        }
        const out = outPlanes[c];
        for (let ly = 0; ly < 8; ly++) {
          const yW = (y0 + ly) * W + x0;
          acc.fill(0, 0, 8);
          for (let v = 0; v < 8; v++) {
            if (!activeV[v]) continue;
            const bvl = B8[v * 8 + ly], v8 = v * 8;
            for (let lx = 0; lx < 8; lx++) acc[lx] += rowTmp[v8 + lx] * bvl;
          }
          for (let lx = 0; lx < 8; lx++) out[yW + lx] = acc[lx];
        }
      }
    }
    return {W, H, planes: outPlanes};
  }

  const tr = RC_TR, lumaAC = RC_LUMA_AC, channels = [1, 0, 2], one = [RC_ONE[0], RC_ONE[1], RC_ONE[2]];
  const tableSteps = new Map(), meansScratch = RC_MEANS_SCRATCH;
  for (const block of strategy.blocks) {
    const {id, bx, by, bw, bh, area, size, order} = block, t = TRANSFORMS[id], w = t.width, h = t.height;
    const x0 = bx * 8, y0 = by * 8;
    let steps = tableSteps.get(t.table);
    if (!steps) tableSteps.set(t.table, steps = strategy.tables.get(t.table).planes);
    const f = fields ? fields[by * stride + bx] / base : 1, ct = (by >> 3) * cfl.width + (bx >> 3), k3 = [cfl.x[ct] / 84, 0, 1 + cfl.b[ct] / 84];
    const L = Math.max(bw, bh), S = Math.min(bw, bh), divisor = 8 * QS * f;
    const Bw = rcBasis(w), Bh = rcBasis(h), tall = h >= w;
    for (let o = 0; o < 3; o++) {
      const c = channels[o], q = block.coeffs[c], s = steps[c], r1 = one[c];
      tr.fill(0, 0, size);
      for (let k = area; k < size; k++) {
        const pos = order[k], v = q[pos];
        if (v !== 0) tr[pos] = (v === 1 ? r1 : v === -1 ? -r1 : v - 0.145 / v) * s[pos] / divisor;
      }
      if (c === 1) lumaAC.set(tr.subarray(0, size));
      else { const k = k3[c]; for (let i = area; i < size; i++) { const pos = order[i]; tr[pos] += k * lumaAC[pos]; } }
      if (bw === 1 && bh === 1) {
        const pos = by * stride + bx;
        tr[0] = ((comps[c].dc[pos] * dcStep[c] + (c === 2 ? comps[1].dc[pos] * dcStep[1] : 0)) / 8 + 0) / RC_LLF_ONE;
        if (id !== 0) { rcBlockIdct(scaledDCT(inverseSmallTransform(tr, id, RC_SMALL_PX), 8, 8, RC_SMALL_DCT), 8, 8, true, Bw, Bh, outPlanes[c], x0, y0, W); continue; }
      } else {
        let means = meansScratch.get(area);
        if (!means) meansScratch.set(area, means = new Float64Array(area));
        for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
          const pos = (by + y) * stride + bx + x;
          means[y * bw + x] = (comps[c].dc[pos] * dcStep[c] + (c === 2 ? comps[1].dc[pos] * dcStep[1] : 0)) / 8;
        }
        const llf = rcLlfFromDC(means, bw, bh);
        for (let y = 0; y < S; y++) for (let x = 0; x < L; x++) tr[y * L * 8 + x] = llf[y * L + x];
      }
      rcBlockIdct(tr, w, h, tall, Bw, Bh, outPlanes[c], x0, y0, W);
    }
  }
  return {W, H, planes: outPlanes};
}

function rcGaborish(planes, W, width, height, weights) {
  const above = new Float32Array(width), here = new Float32Array(width);
  for (let c = 0; c < 3; c++) {
    const p = planes[c], [w1, w2] = weights === true ? RC_GAB : weights[c], n = 1 / (1 + 4 * w1 + 4 * w2);
    for (let y = 0; y < height; y++) {
      const m = y * W;
      here.set(p.subarray(m, m + width));
      if (y === 0) above.set(here);
      const D = y + 1 < height ? p : here, d = y + 1 < height ? m + W : 0, U = above, M = here;
      if (width >= 2) {
        p[m] = (M[0] + w1 * (U[0] + D[d] + M[0] + M[1]) + w2 * (U[0] + U[1] + D[d] + D[d + 1])) * n;
        const end = width - 1;
        for (let x = 1; x < end; x++) {
          p[m + x] = (M[x] + w1 * (U[x] + D[d + x] + M[x - 1] + M[x + 1]) + w2 * (U[x - 1] + U[x + 1] + D[d + x - 1] + D[d + x + 1])) * n;
        }
        p[m + end] = (M[end] + w1 * (U[end] + D[d + end] + M[end - 1] + M[end]) + w2 * (U[end - 1] + U[end] + D[d + end - 1] + D[d + end])) * n;
      } else {
        for (let x = 0; x < width; x++) {
          const l = Math.max(0, x - 1), r = Math.min(width - 1, x + 1);
          p[m + x] = (M[x] + w1 * (U[x] + D[d + x] + M[l] + M[r]) + w2 * (U[l] + U[r] + D[d + l] + D[d + r])) * n;
        }
      }
      above.set(here);
    }
  }
  return planes;
}

const RC_INV_SIGMA_NUM = -1.1715728752538099024, RC_MIN_SIGMA = -3.90524291751269967465540850526868, RC_SCALE = [40, 5, 3.5];
function rcEpfInteriorRow(y, W, width, stride, invSigma, rowBorder, bsm, sm, P0, P1, P2, O0, O1, O2, row, H0, H1, H2, V0, V1, V2, above, haveAbove, leftState) {
  const rm2 = ((y - 2) & 3) * width, rm1 = ((y - 1) & 3) * width, r0 = (y & 3) * width, rp1 = ((y + 1) & 3) * width;
  const rowIn = y * W, rowSigma = (y >> 3) * stride, end = width - 2;
  let left = leftState.left, haveLeft = leftState.haveLeft;
  for (let x = 2; x < end; x++) {
    const s = invSigma[rowSigma + (x >> 3)];
    if (s < RC_MIN_SIGMA) { haveLeft = false; haveAbove[x] = 0; continue; }
    const mul = rowBorder || (x & 7) === 0 || (x & 7) === 7 ? bsm : sm, inv = s * mul;
    const i = rowIn + x;
    let w = 1, X = P0[i], Y = P1[i], B = P2[i];
    const sad0 = haveAbove[x] ? above[x] : (
      (V0[rm1 + x] + V0[rm2 + x] + V0[rm1 + x - 1] + V0[rm1 + x + 1] + V0[r0 + x]) * 40 +
      (V1[rm1 + x] + V1[rm2 + x] + V1[rm1 + x - 1] + V1[rm1 + x + 1] + V1[r0 + x]) * 5 +
      (V2[rm1 + x] + V2[rm2 + x] + V2[rm1 + x - 1] + V2[rm1 + x + 1] + V2[r0 + x]) * 3.5);
    const w0 = Math.max(0, 1 + sad0 * inv), j0 = i - W;
    w += w0; X += w0 * P0[j0]; Y += w0 * P1[j0]; B += w0 * P2[j0];
    const sad1 = haveLeft ? left : (
      (H0[r0 + x - 1] + H0[rm1 + x - 1] + H0[r0 + x - 2] + H0[r0 + x] + H0[rp1 + x - 1]) * 40 +
      (H1[r0 + x - 1] + H1[rm1 + x - 1] + H1[r0 + x - 2] + H1[r0 + x] + H1[rp1 + x - 1]) * 5 +
      (H2[r0 + x - 1] + H2[rm1 + x - 1] + H2[r0 + x - 2] + H2[r0 + x] + H2[rp1 + x - 1]) * 3.5);
    const w1 = Math.max(0, 1 + sad1 * inv), j1 = i - 1;
    w += w1; X += w1 * P0[j1]; Y += w1 * P1[j1]; B += w1 * P2[j1];
    const sad2 = (
      (H0[r0 + x] + H0[rm1 + x] + H0[r0 + x - 1] + H0[r0 + x + 1] + H0[rp1 + x]) * 40 +
      (H1[r0 + x] + H1[rm1 + x] + H1[r0 + x - 1] + H1[r0 + x + 1] + H1[rp1 + x]) * 5 +
      (H2[r0 + x] + H2[rm1 + x] + H2[r0 + x - 1] + H2[r0 + x + 1] + H2[rp1 + x]) * 3.5);
    left = sad2;
    const w2 = Math.max(0, 1 + sad2 * inv), j2 = i + 1;
    w += w2; X += w2 * P0[j2]; Y += w2 * P1[j2]; B += w2 * P2[j2];
    const sad3 = (
      (V0[r0 + x] + V0[rm1 + x] + V0[r0 + x - 1] + V0[r0 + x + 1] + V0[rp1 + x]) * 40 +
      (V1[r0 + x] + V1[rm1 + x] + V1[r0 + x - 1] + V1[r0 + x + 1] + V1[rp1 + x]) * 5 +
      (V2[r0 + x] + V2[rm1 + x] + V2[r0 + x - 1] + V2[r0 + x + 1] + V2[rp1 + x]) * 3.5);
    above[x] = sad3;
    const w3 = Math.max(0, 1 + sad3 * inv), j3 = i + W;
    w += w3; X += w3 * P0[j3]; Y += w3 * P1[j3]; B += w3 * P2[j3];
    haveLeft = true; haveAbove[x] = 1;
    O0[row + x] = X / w; O1[row + x] = Y / w; O2[row + x] = B / w;
  }
  leftState.left = left; leftState.haveLeft = haveLeft;
}

function rcEpf1(planes, W, width, height, invSigma, stride, borderMul) {
  const mir = (v, n) => v < 0 ? -v - 1 : v >= n ? 2 * n - v - 1 : v;
  const rows = Number.isSafeInteger(width) && width > 0 && width <= W &&
    Number.isSafeInteger(height) && height > 0 && height * W <= planes[0].length;
  const out = planes.map(p => rows ? new Float32Array(3 * width) : Float32Array.from(p));
  const commit = y => {
    const row = (y % 3) * width;
    for (let c = 0; c < 3; c++) planes[c].set(out[c].subarray(row, row + width), y * W);
  };
  const at = (c, x, y) => planes[c][mir(y, height) * W + mir(x, width)];
  const plus = [[0, 0], [0, -1], [-1, 0], [1, 0], [0, 1]], nb = [[0, -1], [-1, 0], [1, 0], [0, 1]];
  const above = new Float64Array(width), haveAbove = new Uint8Array(width);
  const sm = 1.65, bsm = sm * borderMul;
  const P0 = planes[0], P1 = planes[1], P2 = planes[2], O0 = out[0], O1 = out[1], O2 = out[2];
  const borderPixel = (x, y, inv, leftObj) => {
    let w = 1, X = at(0, x, y), Y = at(1, x, y), B = at(2, x, y), left = leftObj.left, haveLeft = leftObj.haveLeft;
    for (let n = 0; n < 4; n++) {
      const [dx, dy] = nb[n];
      let sad;
      if (n === 0 && haveAbove[x]) sad = above[x];
      else if (n === 1 && haveLeft) sad = left;
      else {
        sad = 0;
        for (let c = 0; c < 3; c++) {
          let sc = 0;
          for (const [ox, oy] of plus) sc += Math.abs(at(c, x + ox, y + oy) - at(c, x + dx + ox, y + dy + oy));
          sad += sc * RC_SCALE[c];
        }
      }
      if (n === 2) left = sad;
      else if (n === 3) above[x] = sad;
      const weight = Math.max(0, 1 + sad * inv);
      w += weight; X += weight * at(0, x + dx, y + dy); Y += weight * at(1, x + dx, y + dy); B += weight * at(2, x + dx, y + dy);
    }
    leftObj.left = left; leftObj.haveLeft = true; haveAbove[x] = 1;
    const row = rows ? (y % 3) * width : y * W;
    O0[row + x] = X / w; O1[row + x] = Y / w; O2[row + x] = B / w;
  };
  const H0 = new Float64Array(4 * width), H1 = new Float64Array(4 * width), H2 = new Float64Array(4 * width);
  const V0 = new Float64Array(4 * width), V1 = new Float64Array(4 * width), V2 = new Float64Array(4 * width);
  const fillDiffRow = r => {
    const dst = (r & 3) * width, src = r * W;
    for (let x = 0; x < width - 1; x++) {
      const i = src + x;
      H0[dst + x] = Math.abs(P0[i] - P0[i + 1]);
      H1[dst + x] = Math.abs(P1[i] - P1[i + 1]);
      H2[dst + x] = Math.abs(P2[i] - P2[i + 1]);
    }
    if (r < height - 1) {
      for (let x = 0; x < width; x++) {
        const i = src + x, j = i + W;
        V0[dst + x] = Math.abs(P0[i] - P0[j]);
        V1[dst + x] = Math.abs(P1[i] - P1[j]);
        V2[dst + x] = Math.abs(P2[i] - P2[j]);
      }
    }
  };
  if (height >= 5 && width >= 5) { fillDiffRow(0); fillDiffRow(1); fillDiffRow(2); }
  for (let y = 0; y < height; y++) {
    if (height >= 5 && width >= 5 && y >= 2 && y + 1 < height) fillDiffRow(y + 1);
    const row = rows ? (y % 3) * width : y * W;
    if (rows) for (let c = 0; c < 3; c++) out[c].set(planes[c].subarray(y * W, y * W + width), row);
    const rowBorder = (y & 7) === 0 || (y & 7) === 7;
    if (y >= 2 && y < height - 2 && width >= 5) {
      const leftState = {left: 0, haveLeft: false};
      for (let x = 0; x < 2; x++) {
        const s = invSigma[(y >> 3) * stride + (x >> 3)];
        if (s < RC_MIN_SIGMA) { leftState.haveLeft = false; haveAbove[x] = 0; continue; }
        borderPixel(x, y, s * (rowBorder || (x & 7) === 0 || (x & 7) === 7 ? bsm : sm), leftState);
      }
      rcEpfInteriorRow(y, W, width, stride, invSigma, rowBorder, bsm, sm, P0, P1, P2, O0, O1, O2, row, H0, H1, H2, V0, V1, V2, above, haveAbove, leftState);
      for (let x = width - 2; x < width; x++) {
        const s = invSigma[(y >> 3) * stride + (x >> 3)];
        if (s < RC_MIN_SIGMA) { leftState.haveLeft = false; haveAbove[x] = 0; continue; }
        borderPixel(x, y, s * (rowBorder || (x & 7) === 0 || (x & 7) === 7 ? bsm : sm), leftState);
      }
    } else {
      const leftState = {left: 0, haveLeft: false};
      for (let x = 0; x < width; x++) {
        const s = invSigma[(y >> 3) * stride + (x >> 3)];
        if (s < RC_MIN_SIGMA) { leftState.haveLeft = false; haveAbove[x] = 0; continue; }
        borderPixel(x, y, s * (rowBorder || (x & 7) === 0 || (x & 7) === 7 ? bsm : sm), leftState);
      }
    }
    if (rows && y >= 2) commit(y - 2);
  }
  if (rows) for (let y = Math.max(0, height - 2); y < height; y++) commit(y);
  return rows ? planes : out;
}

export function epfInverseSigma(image) {
  const stride = image.components[0].stride, rows = image.components[0].rows, field = image.quantFieldBase || 1;
  let shift = 1;
  while (field * shift / (8 * 255 * (image.quantScale || 1)) < 1 / 16384) shift *= 2;
  const mul = half(image.epf), inv = new Float32Array(stride * rows);
  const firstOf = image.strategyData ? new Int32Array(stride * rows) : null;
  if (firstOf) for (const b of image.strategyData.blocks) for (let y = 0; y < b.bh; y++) for (let x = 0; x < b.bw; x++) firstOf[(b.by + y) * stride + b.bx + x] = b.by * stride + b.bx;
  for (let b = 0; b < inv.length; b++) {
    const first = firstOf ? firstOf[b] : b, raw = (image.quantFields ? image.quantFields[first] : field) * shift;
    inv[b] = 1 / Math.min(-1e-4, mul / (raw * RC_INV_SIGMA_NUM) * (image.sharpness ? image.sharpness[b] : 7) / 7);
  }
  return inv;
}

export function reconstruct(image) {
  const {width, height} = image, comps = image.components, stride = comps[0].stride, rows = comps[0].rows;
  let {planes, W, H} = rcXybPlanes(image);
  if (image.gab) planes = rcGaborish(planes, W, width, height, image.gab);
  if (image.epf) planes = rcEpf1(planes, W, width, height, epfInverseSigma(image), stride, 2 / 3);
  const n = width * height, compact = Number.isSafeInteger(width) && width > 0 && width <= W &&
    Number.isSafeInteger(height) && height > 0 && height <= H;
  const out = compact ? planes : [0, 1, 2].map(() => new Float32Array(n));
  const p0 = planes[0], p1 = planes[1], p2 = planes[2], o0 = out[0], o1 = out[1], o2 = out[2];
  const m0 = RC_INV[0], m1 = RC_INV[1], m2 = RC_INV[2], m3 = RC_INV[3], m4 = RC_INV[4], m5 = RC_INV[5], m6 = RC_INV[6], m7 = RC_INV[7], m8 = RC_INV[8];
  for (let y = 0; y < height; y++) {
    const rIn = y * W, rOut = y * width;
    for (let x = 0; x < width; x++) {
      const i = rIn + x, X = p0[i], Y = p1[i], B = p2[i];
      const l = rcCube(Y + X + RC_ROOT_BIAS) - RC_BIAS, m = rcCube(Y - X + RC_ROOT_BIAS) - RC_BIAS, s = rcCube(B + RC_ROOT_BIAS) - RC_BIAS, o = rOut + x;
      o0[o] = m0 * l + m1 * m + m2 * s;
      o1[o] = m3 * l + m4 * m + m5 * s;
      o2[o] = m6 * l + m7 * m + m8 * s;
    }
  }
  if (!compact || planes.every(p => p.length === n)) return out;
  return planes.map((p, c) => {
    const result = p.slice(0, n);
    planes[c] = null;
    return result;
  });
}

export function toRGBA(linear, width, height) { return toRGBAInto(linear, 0, width * height, new Uint8ClampedArray(width * height * 4), 0); }
let RGBA_STEP_HI = null;
function rgbaStepHi(T) {
  const step = new Uint8Array(65536);
  let k = 0;
  for (let i = 0; i < 65536; i++) {
    const minV = i / 65536;
    while (k < 255 && minV >= T[k + 1]) k++;
    step[i] = k;
  }
  return step;
}

export function toRGBAInto(linear, from, count, out, at) {
  if (linear.every(p => p instanceof Float32Array)) {
    const T = RGBA_THRESHOLDS ??= rgbaThresholds(), S = RGBA_STEP_HI ??= rgbaStepHi(T);
    const L0 = linear[0], L1 = linear[1], L2 = linear[2];
    for (let i = 0; i < count; i++) {
      const idx = from + i, dst = (at + i) * 4;
      const v0 = L0[idx];
      if (!(v0 >= T[1])) out[dst] = 0;
      else if (v0 >= T[255]) out[dst] = 255;
      else { const k0 = S[(v0 * 65536) | 0]; out[dst] = v0 >= T[k0 + 1] ? k0 + 1 : k0; }
      const v1 = L1[idx];
      if (!(v1 >= T[1])) out[dst + 1] = 0;
      else if (v1 >= T[255]) out[dst + 1] = 255;
      else { const k1 = S[(v1 * 65536) | 0]; out[dst + 1] = v1 >= T[k1 + 1] ? k1 + 1 : k1; }
      const v2 = L2[idx];
      if (!(v2 >= T[1])) out[dst + 2] = 0;
      else if (v2 >= T[255]) out[dst + 2] = 255;
      else { const k2 = S[(v2 * 65536) | 0]; out[dst + 2] = v2 >= T[k2 + 1] ? k2 + 1 : k2; }
      out[dst + 3] = 255;
    }
    return out;
  }
  return toRGBAExact(linear, from, count, out, at);
}
function toRGBAExact(linear, from, count, out, at) {
  const enc = v => v <= 0.0031308 ? 12.92 * v : 1.055 * exactPow(v, 1 / 2.4) - 0.055;
  for (let i = 0; i < count; i++) {
    for (let c = 0; c < 3; c++) out[(at + i) * 4 + c] = Math.round(255 * Math.min(1, Math.max(0, enc(linear[c][from + i]))));
    out[(at + i) * 4 + 3] = 255;
  }
  return out;
}

let RGBA_THRESHOLDS = null;
function rgbaThresholds() {
  const one = new Float32Array(1), zero = new Float32Array(1), bits = new Uint32Array(1), f = new Float32Array(bits.buffer), out = new Float32Array(256);
  const level = b => { bits[0] = b; one[0] = f[0]; return toRGBAExact([one, zero, zero], 0, 1, new Uint8ClampedArray(4), 0)[0]; };
  for (let k = 1; k < 256; k++) {
    let lo = 0, hi = 0x3f800000;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (level(mid) >= k) hi = mid; else lo = mid + 1; }
    bits[0] = lo; out[k] = f[0];
  }
  return out;
}
