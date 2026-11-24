// SPDX-License-Identifier: MIT
import {scaledDCT, TRANSFORMS} from './vardct-strategies.mjs';
import {llfDivisors} from './vardct-bases.mjs';
import {rgbPixels, colorPixels} from './color-band.mjs';
import {half, inverseBasis, RECON_ONE, reconstructDCT8Planes} from './reconstruct-dct8.mjs';
export {half, inverseBasis} from './reconstruct-dct8.mjs';
import {dct8Band, VAR_BASE} from './dct8-band.mjs';
import {fault} from './fault.mjs';

const BASES = new Map();
function basisOf(n) {
  let b = BASES.get(n);
  if (!b) BASES.set(n, b = inverseBasis(n));
  return b;
}

function rcXybPlanes(image, rgb = false, ycbcr = false) {
  const band = dct8Band();
  if ((typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) || !image.strategyData)
    return reconstructDCT8Planes(image, rgb, ycbcr, band);
  const comps = image.components, stride = comps[0].stride, rows = comps[0].rows, W = stride * 8, H = rows * 8, pixels = W * H;
  const QS = image.quantScale || 256, base = image.quantFieldBase || 1, fields = image.quantFields, cfl = image.cfl;
  const dcStep = comps.map(c => half(c.quant[0] / (255 * 8 * QS) * 128) / 128 * 255 * 8);
  const strategy = image.strategyData;
  let maxSize = 64, maxSide = 8, maxArea = 1;
  for (const b of strategy.blocks) {
    if (b.bw === 1 && b.bh === 1 && b.id !== 0) throw fault('JXL_INTERNAL', 'reconstruct-planes:small-transform');
    if (b.size > maxSize) maxSize = b.size;
    const t = TRANSFORMS[b.id];
    if (t.width > maxSide) maxSide = t.width;
    if (t.height > maxSide) maxSide = t.height;
    if (b.area > maxArea) maxArea = b.area;
  }
  const align8 = p => (p + 7) & ~7;
  const argsAt = VAR_BASE;
  const basis8At = argsAt + 160, basis16At = basis8At + 512, basis32At = basis16At + 2048, basis64At = basis32At + 8192, basis128At = basis64At + 32768, basis256At = basis128At + 131072;
  const basisPtr = n => n === 8 ? basis8At : n === 16 ? basis16At : n === 32 ? basis32At : n === 64 ? basis64At : n === 128 ? basis128At : basis256At;
  const orderAt = (maxSide <= 32 ? basis32At + 8192 : basis256At + 524288);
  const stepsAt = align8(orderAt + maxSize * 4);
  const qAt = stepsAt + maxSize * 24;
  const llfAt = align8(qAt + maxSize * 12);
  const trAt = llfAt + maxArea * 24;
  const lumaACAt = trAt + maxSize * 8;
  const lumaNzAt = lumaACAt + maxSize * 8;
  const accAt = align8(lumaNzAt + maxSize * 4);
  const rowTmpAt = accAt + maxSide * 8;
  const activeVAt = rowTmpAt + maxSize * 4;
  const out0At = align8(activeVAt + maxSide * 4);
  const out1At = out0At + maxSize * 4, out2At = out1At + maxSize * 4, totalEnd = out2At + maxSize * 4;
  const buf = band.grow(totalEnd);
  const i32 = new Int32Array(buf), f64 = new Float64Array(buf), f32 = new Float32Array(buf);
  const outPlanes = [0, 1, 2].map(() => new Float32Array(pixels)), outAt = [out0At >> 2, out1At >> 2, out2At >> 2];
  for (const n of [8, 16, 32, ...(maxSide > 32 ? [64, 128, 256] : [])]) if (n <= maxSide) f64.set(basisOf(n), basisPtr(n) >> 3);
  i32[(argsAt + 36) >> 2] = orderAt; i32[(argsAt + 40) >> 2] = stepsAt; i32[(argsAt + 44) >> 2] = qAt; i32[(argsAt + 48) >> 2] = llfAt;
  i32[(argsAt + 52) >> 2] = out0At; i32[(argsAt + 56) >> 2] = out1At; i32[(argsAt + 60) >> 2] = out2At;
  i32[(argsAt + 128) >> 2] = trAt; i32[(argsAt + 132) >> 2] = lumaACAt; i32[(argsAt + 136) >> 2] = lumaNzAt;
  i32[(argsAt + 140) >> 2] = accAt; i32[(argsAt + 144) >> 2] = rowTmpAt; i32[(argsAt + 148) >> 2] = activeVAt;
  f64[(argsAt + 104) >> 3] = RECON_ONE[0]; f64[(argsAt + 112) >> 3] = RECON_ONE[1]; f64[(argsAt + 120) >> 3] = RECON_ONE[2];
  let loadedSteps = null, loadedOrder = null;
  const means = new Float64Array(maxArea);
  for (const block of strategy.blocks) {
    const {id, bx, by, bw, bh, area, size, order} = block, t = TRANSFORMS[id], w = t.width, h = t.height;
    const steps = strategy.tables[t.table].planes;
    if (loadedSteps !== steps) {
      for (let c = 0; c < 3; c++) f64.set(steps[c], (stepsAt >> 3) + c * size);
      loadedSteps = steps;
    }
    if (loadedOrder !== order) { i32.set(order, orderAt >> 2); loadedOrder = order; }
    for (let c = 0; c < 3; c++) i32.set(block.coeffs[c], (qAt >> 2) + c * size);
    const f = fields ? fields[by * stride + bx] / base : 1, ct = (by >> 3) * cfl.width + (bx >> 3);
    f64[(argsAt + 80) >> 3] = 8 * QS * f;
    f64[(argsAt + 88) >> 3] = (rgb ? 1 : 0) + cfl.x[ct] / 84;
    f64[(argsAt + 96) >> 3] = (ycbcr ? 0 : 1) + cfl.b[ct] / 84;
    const baseB = !ycbcr;
    if (area === 1) {
      const pos = by * stride + bx, yDc = comps[1].dc[pos] * dcStep[1];
      f64[(llfAt >> 3)] = (comps[0].dc[pos] * dcStep[0] + (rgb ? yDc : 0)) / 8;
      f64[(llfAt >> 3) + 1] = yDc / 8;
      f64[(llfAt >> 3) + 2] = (comps[2].dc[pos] * dcStep[2] + (rgb || baseB ? yDc : 0)) / 8;
    } else {
      const L = Math.max(bw, bh), S = Math.min(bw, bh), div = llfDivisors(L, S), mSub = means.subarray(0, area);
      for (let c = 0; c < 3; c++) {
        const addY = c !== 1 && (rgb || baseB && c === 2);
        for (let i = 0; i < area; i++) {
          const pos = (by + ((i / bw) | 0)) * stride + bx + (i % bw);
          mSub[i] = (comps[c].dc[pos] * dcStep[c] + (addY ? comps[1].dc[pos] * dcStep[1] : 0)) / 8;
        }
        const low = scaledDCT(mSub, bw, bh);
        for (let i = 0; i < area; i++) f64[(llfAt >> 3) + c * area + i] = low[i] / div[i];
      }
    }
    i32[(argsAt + 0) >> 2] = w; i32[(argsAt + 4) >> 2] = h; i32[(argsAt + 8) >> 2] = bw; i32[(argsAt + 12) >> 2] = bh;
    i32[(argsAt + 16) >> 2] = area; i32[(argsAt + 20) >> 2] = size; i32[(argsAt + 24) >> 2] = h >= w ? 1 : 0;
    i32[(argsAt + 28) >> 2] = basisPtr(w); i32[(argsAt + 32) >> 2] = basisPtr(h);
    i32[(argsAt + 64) >> 2] = w; i32[(argsAt + 68) >> 2] = 0; i32[(argsAt + 72) >> 2] = 0;
    band.idct8f32(argsAt, 0, 0, 0, 0, 0, 0);
    for (let c = 0; c < 3; c++) {
      const plane = outPlanes[c], baseAt = outAt[c];
      for (let y = 0; y < h; y++) plane.set(f32.subarray(baseAt + y * w, baseAt + (y + 1) * w), (by * 8 + y) * W + bx * 8);
    }
  }
  return {W, H, planes: outPlanes};
}

export function reconstructRGB(image, {planes: floating = false} = {}) {
  return rgbPixels(rcXybPlanes(image, true), image.width, image.height, floating);
}

export function reconstructYCbCr(image, {planes: floating = false} = {}) {
  const {width, height} = image;
  const components = image.frameOrder ? image.components : [1, 0, 2].map(c => image.components[c]);
  return ycbcrPixels(rcXybPlanes({...image, components}, false, true), width, height, floating, image.alpha);
}

export function ycbcrPixels({planes, W}, width, height, floating, alpha = null) {
  return colorPixels(planes, width, height, W, floating ? 3 : 1, alpha, 4);
}
