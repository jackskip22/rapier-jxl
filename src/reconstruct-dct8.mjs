// SPDX-License-Identifier: MIT
import {exactCos, exactPow, EXACT_PI} from './exact-math.mjs';
import {float16Bits} from './bits.mjs';

export const RECON_ONE = [1 - 0.05465007330715401, 1 - 0.07005449891748593, 1 - 0.049935103337343655];
const RC_ONE = RECON_ONE, RC_COS = (n, d) => exactCos(EXACT_PI * n / d);
export function half(value) {
  const bits = float16Bits(value), sign = bits & 0x8000 ? -1 : 1, e = (bits >> 10) & 31, m = bits & 1023;
  return sign * (e ? (1 + m / 1024) * exactPow(2, e - 15) : m / 1024 * exactPow(2, -14));
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
  if (image.strategyData) throw new TypeError('The fixed-DCT8 inverse does not accept variable transforms.');
  const comps = image.components, stride = comps[0].stride, rows = comps[0].rows, W = stride * 8, H = rows * 8;
  const QS = image.quantScale || 256;
  const cfl = image.cfl, base = image.quantFieldBase || 1, fields = image.quantFields;
  const dcStep = comps.map(c => half(c.quant[0] / (255 * 8 * QS) * 128) / 128 * 255 * 8);
  const outPlanes = [0, 1, 2].map(() => new Float32Array(W * H));
  if (stride === 0 || rows === 0) return {W, H, planes: outPlanes};
  const order = [1, 0, 2], buffer = band.buffer();
  const coefPlanes = band.coeff.map(at => new Float64Array(buffer, at, band.blocks * 64));
  const quants = comps.map(c => c.quant), coeffs = comps.map(c => c.coeffs), one = [RC_ONE[0], RC_ONE[1], RC_ONE[2]];
  const inverse = (bx0, by0, bw, bh) => {
    for (let ly = 0; ly < bh; ly++) for (let lx = 0; lx < bw; lx++) {
      const bx = bx0 + lx, by = by0 + ly, src = (by * stride + bx) * 64, dst = (ly * bw + lx) * 64;
      const QSf = QS * (fields ? fields[by * stride + bx] / base : 1);
      const tile = ycbcr ? 0 : (by >> 3) * cfl.width + (bx >> 3);
      const kx = ycbcr ? 0 : (rgb ? 1 : 0) + cfl.x[tile] / 84, kb = ycbcr ? 0 : 1 + cfl.b[tile] / 84;
      for (let o = 0; o < 3; o++) {
        const c = order[o], q = coeffs[c], quant = quants[c], r1 = one[c], coef = coefPlanes[c];
        coef[dst] = q[src] * dcStep[c];
        for (let k = 1; k < 64; k++) {
          const v = q[src + k];
          coef[dst + k] = v === 0 ? 0 : (v === 1 ? r1 : v === -1 ? -r1 : v - 0.145 / v) * quant[k] / QSf;
        }
        if (c !== 1) {
          const k3 = c === 0 ? kx : kb, y = coefPlanes[1], dc = !ycbcr && (rgb || c === 2) ? 1 : 0;
          coef[dst] += dc * y[dst];
          for (let k = 1; k < 64; k++) coef[dst + k] += k3 * y[dst + k];
        }
      }
    }
    const sw = bw * 8;
    for (let c = 0; c < 3; c++) {
      band.idct8f32(band.coeff[c], bw * bh, band.basis, band.out, sw * 4, bw, band.tmp);
      const strip = new Float32Array(buffer, band.out, bh * sw * 8);
      const plane = outPlanes[c];
      for (let y = 0; y < bh * 8; y++) plane.set(strip.subarray(y * sw, y * sw + sw), (by0 * 8 + y) * W + bx0 * 8);
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

export function rgbPixels({planes, W}, width, height, floating) {
  const rgba = floating ? null : new Uint8Array(width * height * 4);
  const output = floating ? [0, 1, 2].map(() => new Float32Array(width * height)) : null;
  for (let y = 0, at = 0; y < height; y++) for (let x = 0; x < width; x++, at += 4) {
    const p = y * W + x;
    if (floating) for (let c = 0; c < 3; c++) output[c][at >> 2] = planes[c][p];
    else {
      for (let c = 0; c < 3; c++) rgba[at + c] = Math.max(0, Math.min(255, Math.round(planes[c][p] * 255)));
      rgba[at + 3] = 255;
    }
  }
  return output ?? rgba;

}

export function reconstructDCT8RGB(image, band, {planes: floating = false} = {}) {
  return rgbPixels(reconstructDCT8Planes(image, true, false, band), image.width, image.height, floating);
}
