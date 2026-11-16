// SPDX-License-Identifier: MIT
import {float16Bits} from './bits.mjs';
import {fault} from './fault.mjs';

export const RECON_ONE = [1 - 0.05465007330715401, 1 - 0.07005449891748593, 1 - 0.049935103337343655];
const RC_COS = (n, d) => Math.cos(Math.PI * n / d);
export function half(value) {
  const bits = float16Bits(value), sign = bits & 0x8000 ? -1 : 1, e = (bits >> 10) & 31, m = bits & 1023;
  return sign * (e ? (1 + m / 1024) * Math.pow(2, e - 15) : m / 1024 * Math.pow(2, -14));
}

export function fillInverseBasis(n, out, from = 0, end = n, left = 0, right = n) {
  const width = right - left;
  for (let k = from; k < end; k++) for (let x = left; x < right; x++)
    out[(k - from) * width + x - left] = (k ? 1.4142135623730951 : 1) * RC_COS((2 * x + 1) * k, 2 * n);
  return out;
}
export function inverseBasis(n) {
  return fillInverseBasis(n, new Float64Array(n * n));
}

export function reconstructDCT8Planes(image, rgb = false, ycbcr = false, band) {
  if (image.strategyData) throw fault('JXL_INTERNAL', 'The fixed-DCT8 inverse does not accept variable transforms.');
  const comps = image.components, stride = comps[0].stride, rows = comps[0].rows, W = stride * 8, H = rows * 8;
  const QS = image.quantScale || 256;
  const cfl = image.cfl, base = image.quantFieldBase || 1, fields = image.quantFields;
  const outPlanes = [0, 1, 2].map(() => new Float32Array(W * H));
  if (stride === 0 || rows === 0) return {W, H, planes: outPlanes};
  for (let c = 0; c < 3; c++) {
    band.quantViews[c].set(comps[c].quant);
    band.dcView[c] = half(comps[c].quant[0] / (255 * 8 * QS) * 128) / 128 * 255 * 8;
  }
  const inverse = (bx0, by0, bw, bh) => {
    const first = by0 * stride + bx0, count = bw * bh;
    for (let c = 0; c < 3; c++) band.coeffViews[c].set(comps[c].coeffs.subarray(first * 64, (first + count) * 64));
    if (fields) band.fieldView.set(fields.subarray(first, first + count));
    const tx = bx0 >> 3, ty = by0 >> 3, tw = ((bx0 + bw + 7) >> 3) - tx;
    if (cfl) {
      const th = ((by0 + bh + 7) >> 3) - ty;
      for (let y = 0; y < th; y++) {
        const start = (ty + y) * cfl.width + tx;
        band.cflXView.set(cfl.x.subarray(start, start + tw), y * tw);
        band.cflBView.set(cfl.b.subarray(start, start + tw), y * tw);
      }
    }
    band.dequant8(band.coeff[0], band.coeff[1] - band.coeff[0], count, bw, bx0 & 7, by0 & 7, tw,
      band.quant, band.dc, band.one, fields ? band.field : 0, cfl ? band.cflX : 0, band.cflB, QS, base, rgb, ycbcr);
    const sw = bw * 8;
    const strip = band.strip.subarray(0, count * 64);
    for (let c = 0; c < 3; c++) {
      band.idct8f32(band.coeff[c], bw * bh, band.basis, band.out, sw * 4, bw, band.tmp);
      const plane = outPlanes[c];
      if (bw === stride) plane.set(strip, by0 * 8 * W);
      else for (let y = 0; y < bh * 8; y++) plane.set(strip.subarray(y * sw, y * sw + sw), (by0 * 8 + y) * W + bx0 * 8);
    }
  };
  for (let by = 0; by < rows;) {
    if (stride <= band.blocks) {
      const bh = Math.min(rows - by, Math.floor(band.blocks / stride));
      inverse(0, by, stride, bh);
      by += bh;
    } else {
      for (let bx = 0; bx < stride; bx += band.blocks) inverse(bx, by, Math.min(band.blocks, stride - bx), 1);
      by++;
    }
  }
  return {W, H, planes: outPlanes};
}
