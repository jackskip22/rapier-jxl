// SPDX-License-Identifier: MIT
import {scaledDCT, inverseSmallTransform, TRANSFORMS} from './vardct-strategies.mjs';
import {llfDivisors} from './vardct-bases.mjs';
import {half, inverseBasis, RECON_ONE as RC_ONE, reconstructDCT8Planes, rgbPixels} from './reconstruct-dct8.mjs';
export {half, inverseBasis} from './reconstruct-dct8.mjs';
import {dct8Band} from './dct8-band.mjs';

const rcRecon = (q, c) => q === 0 ? 0 : q === 1 ? RC_ONE[c] : q === -1 ? -RC_ONE[c] : q - 0.145 / q;


const RC_LLF_ONE = llfDivisors(1, 1)[0];
export function rcLlfFromDC(means, bw, bh) {
  const w = Math.max(bw, bh), h = Math.min(bw, bh), low = scaledDCT(means, bw, bh), divisors = llfDivisors(w, h);
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = low[y * w + x] / divisors[y * w + x];
  return out;
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
    if (!steps) tableSteps.set(t.table, steps = strategy.tables[t.table].planes);
    const f = fields ? fields[by * stride + bx] / base : 1, ct = (by >> 3) * cfl.width + (bx >> 3), k3 = [cfl.x[ct] / 84, 0, 1 + cfl.b[ct] / 84];
    const L = Math.max(bw, bh), S = Math.min(bw, bh), divisor = 8 * QS * f;
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) cells[(by + y) * stride + bx + x] = bx | by << 12 | (bw - 1) << 24 | (bh - 1) << 28;
    let lumaNzLen = 0;
    const lumaNz = rc().lumaNz;
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
let rcScratch;
const rc = () => rcScratch ||= {acc: new Float64Array(256), rowTmp: new Float32Array(256 * 256), activeV: new Uint8Array(256), smallPx: new Float64Array(64),
  smallDct: new Float64Array(64), tr: new Float64Array(256 * 256), lumaAC: new Float64Array(256 * 256), lumaNz: new Uint16Array(256 * 256)};
const RC_MEANS_SCRATCH = new Map();

function rcBlockIdct(tr, w, h, tall, Bw, Bh, out, x0, y0, W) {
  const {acc, rowTmp, activeV} = rc();
  const numActive = inverseBlockRows(tr, w, h, tall, Bw, acc, rowTmp, activeV);
  inverseBlockColumns(rowTmp, activeV, numActive, Bh, acc, out, w, h, x0, y0, W);
}

export function inverseBlockRows(tr, w, h, tall, Bw, acc, rowTmp, activeV, columns = w) {
  const f32 = Math.fround;
  let numActive = 0;
  for (let v = 0; v < h; v++) {
    const vw = v * w;
    let any = 0;
    acc.fill(0, 0, columns);
    if (tall) {
      for (let u = 0; u < w; u++) {
        const cu = f32(tr[u * h + v] / 255);
        if (cu !== 0) {
          any = 1;
          const uw = u * columns;
          for (let lx = 0; lx < columns; lx++) acc[lx] += cu * Bw[uw + lx];
        }
      }
    } else {
      for (let u = 0; u < w; u++) {
        const cu = f32(tr[vw + u] / 255);
        if (cu !== 0) {
          any = 1;
          const uw = u * columns;
          for (let lx = 0; lx < columns; lx++) acc[lx] += cu * Bw[uw + lx];
        }
      }
    }
    if (any) {
      activeV[numActive++] = v;
      for (let lx = 0; lx < columns; lx++) rowTmp[v * columns + lx] = acc[lx];
    }
  }
  return numActive;
}
export function inverseBlockColumns(rowTmp, activeV, numActive, Bh, acc, out, w, h, x0, y0, W, from = 0, end = h) {
  for (let ly = from; ly < end; ly++) {
    const yW = (y0 + ly) * W + x0;
    acc.fill(0, 0, w);
    for (let a = 0; a < numActive; a++) {
      const v = activeV[a], bvl = Bh[v * h + ly], vw = v * w;
      for (let lx = 0; lx < w; lx++) acc[lx] += rowTmp[vw + lx] * bvl;
    }
    for (let lx = 0; lx < w; lx++) out[yW + lx] = acc[lx];
  }
}

export const reconstructionDCSteps = (comps, QS) => comps.map(c => half(c.quant[0] / (255 * 8 * QS) * 128) / 128 * 255 * 8);
export function reconstructionBlockScale(image, bx, by, rgb) {
  const QS = image.quantScale || 256, base = image.quantFieldBase || 1, fields = image.quantFields;
  const stride = image.components[0].stride, cfl = image.cfl;
  const f = fields ? fields[by * stride + bx] / base : 1, ct = (by >> 3) * cfl.width + (bx >> 3);
  return [(rgb ? 1 : 0) + cfl.x[ct] / 84, 8 * QS * f, 1 + cfl.b[ct] / 84];
}
export function dequantizeStrategyAC(q, steps, order, from, end, divisor, c, tr, lumaAC, lumaNz, count = 0) {
  const r1 = RC_ONE[c];
  if (c === 1) {
    for (let k = from; k < end; k++) {
      const pos = order[k], v = q[pos];
      if (v !== 0) { const val = (v === 1 ? r1 : v === -1 ? -r1 : v - 0.145 / v) * steps[pos] / divisor; tr[pos] = val; lumaAC[pos] = val; lumaNz[count++] = pos; }
    }
  } else {
    for (let k = from; k < end; k++) {
      const pos = order[k], v = q[pos];
      if (v !== 0) tr[pos] = (v === 1 ? r1 : v === -1 ? -r1 : v - 0.145 / v) * steps[pos] / divisor;
    }
  }
  return count;
}
export function addStrategyChroma(tr, lumaAC, lumaNz, from, end, factor) {
  for (let i = from; i < end; i++) { const pos = lumaNz[i]; tr[pos] += factor * lumaAC[pos]; }
}
export function reconstructionBlockDC(comps, dcStep, c, rgb, pos) {
  return ((comps[c].dc[pos] * dcStep[c] + (c !== 1 && (rgb || c === 2) ? comps[1].dc[pos] * dcStep[1] : 0)) / 8 + 0) / RC_LLF_ONE;
}
export function reconstructionBlockMeans(comps, dcStep, c, rgb, bx, by, bw, stride, means, from = 0, end = means.length) {
  for (let i = from; i < end; i++) {
    const y = Math.floor(i / bw), x = i % bw, pos = (by + y) * stride + bx + x;
    means[i] = (comps[c].dc[pos] * dcStep[c] + (c !== 1 && (rgb || c === 2) ? comps[1].dc[pos] * dcStep[1] : 0)) / 8;
  }
}
export function writeReconstructionLLF(llf, bw, bh, tr, from = 0, end = bw * bh) {
  const L = Math.max(bw, bh);
  for (let i = from; i < end; i++) { const y = Math.floor(i / L), x = i % L; tr[y * L * 8 + x] = llf[i]; }
}

function rcXybPlanes(image, rgb = false, ycbcr = false) {
  if (!image.strategyData) return reconstructDCT8Planes(image, rgb, ycbcr, dct8Band());
  const comps = image.components, stride = comps[0].stride, rows = comps[0].rows, W = stride * 8, H = rows * 8;
  const QS = image.quantScale || 256, outPlanes = [0, 1, 2].map(() => new Float32Array(W * H));
  const dcStep = reconstructionDCSteps(comps, QS);
  const strategy = image.strategyData;

  

  const {tr, lumaAC, smallPx, smallDct} = rc(), lumaNz = new Uint16Array(65536), channels = [1, 0, 2];
  const tableSteps = new Map(), meansScratch = RC_MEANS_SCRATCH;
  for (const block of strategy.blocks) {
    const {id, bx, by, bw, bh, area, size, order} = block, t = TRANSFORMS[id], w = t.width, h = t.height;
    const x0 = bx * 8, y0 = by * 8;
    let steps = tableSteps.get(t.table);
    if (!steps) tableSteps.set(t.table, steps = strategy.tables[t.table].planes);
    const k3 = reconstructionBlockScale(image, bx, by, rgb), divisor = k3[1];
    const Bw = rcBasis(w), Bh = rcBasis(h), tall = h >= w;
    let nLumaNz = 0;
    for (let o = 0; o < 3; o++) {
      const c = channels[o], q = block.coeffs[c], s = steps[c];
      tr.fill(0, 0, size);
      nLumaNz = dequantizeStrategyAC(q, s, order, area, size, divisor, c, tr, lumaAC, lumaNz, nLumaNz);
      if (c !== 1 && k3[c] !== 0) addStrategyChroma(tr, lumaAC, lumaNz, 0, nLumaNz, k3[c]);
      if (bw === 1 && bh === 1) {
        const pos = by * stride + bx;
        tr[0] = reconstructionBlockDC(comps, dcStep, c, rgb, pos);
        if (id !== 0) { rcBlockIdct(scaledDCT(inverseSmallTransform(tr, id, smallPx), 8, 8, smallDct), 8, 8, true, Bw, Bh, outPlanes[c], x0, y0, W); continue; }
      } else {
        let means = meansScratch.get(area);
        if (!means) meansScratch.set(area, means = new Float64Array(area));
        reconstructionBlockMeans(comps, dcStep, c, rgb, bx, by, bw, stride, means);
        const llf = rcLlfFromDC(means, bw, bh);
        writeReconstructionLLF(llf, bw, bh, tr);
      }
      rcBlockIdct(tr, w, h, tall, Bw, Bh, outPlanes[c], x0, y0, W);
    }
  }
  return {W, H, planes: outPlanes};
}

const RC_INV_SIGMA_NUM = -1.1715728752538099024;

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

export function reconstructRGB(image, {planes: floating = false} = {}) {
  return rgbPixels(rcXybPlanes(image, true), image.width, image.height, floating);
}

export function reconstructYCbCr(image, {planes: floating = false} = {}) {
  const {width, height} = image;
  return ycbcrPixels(rcXybPlanes({...image, components: [1, 0, 2].map(c => image.components[c])}, false, true), width, height, floating, image.alpha);
}

export function ycbcrPixels({planes, W}, width, height, floating, alpha = null) {
  const rgba = floating ? null : new Uint8Array(width * height * 4);
  const output = floating ? [0, 1, 2].map(() => new Float32Array(width * height)) : null;
  for (let y = 0, at = 0; y < height; y++) for (let x = 0; x < width; x++, at += 4) {
    const p = y * W + x, cb = planes[0][p], luma = planes[1][p] + 128 / 255, cr = planes[2][p];
    const r = luma + 1.402 * cr, g = luma - 0.344136286 * cb - 0.714136286 * cr, b = luma + 1.772 * cb;
    if (floating) { output[0][at >> 2] = r; output[1][at >> 2] = g; output[2][at >> 2] = b; }
    else {
      rgba[at] = Math.max(0, Math.min(255, Math.round(255 * r)));
      rgba[at + 1] = Math.max(0, Math.min(255, Math.round(255 * g)));
      rgba[at + 2] = Math.max(0, Math.min(255, Math.round(255 * b)));
      rgba[at + 3] = alpha?.[at + 3] ?? 255;
    }
  }
  return output ?? rgba;
}

export {toRGBA, toRGBAInto} from './rgb8-output.mjs';
