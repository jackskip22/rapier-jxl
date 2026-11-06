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

let basis8, scratch;
const rcBasis = () => basis8 ??= inverseBasis(8);
export function reconstructDCT8Planes(image, rgb = false, ycbcr = false) {
  if (image.strategyData) throw new TypeError('The fixed-DCT8 inverse does not accept variable transforms.');
  const comps = image.components, stride = comps[0].stride, rows = comps[0].rows, W = stride * 8, H = rows * 8;
  const QS = image.quantScale || 256, outPlanes = [0, 1, 2].map(() => new Float32Array(W * H));
  const cfl = image.cfl, base = image.quantFieldBase || 1, fields = image.quantFields;
  const dcStep = comps.map(c => half(c.quant[0] / (255 * 8 * QS) * 128) / 128 * 255 * 8);
  const f32 = Math.fround;
  const {acc, rowTmp, activeV} = scratch ??= {acc: new Float64Array(8), rowTmp: new Float32Array(64), activeV: new Uint8Array(8)};

  const B8 = rcBasis(), y = new Float64Array(64), coef = new Float64Array(64), order = [1, 0, 2];
  const quants = comps.map(c => c.quant), coeffs = comps.map(c => c.coeffs), one = [RC_ONE[0], RC_ONE[1], RC_ONE[2]];
  for (let by = 0; by < rows; by++) for (let bx = 0; bx < stride; bx++) {
    const at = (by * stride + bx) * 64, QSf = QS * (fields ? fields[by * stride + bx] / base : 1);
    const t = ycbcr ? 0 : (by >> 3) * cfl.width + (bx >> 3);
    const kx = ycbcr ? 0 : (rgb ? 1 : 0) + cfl.x[t] / 84, kb = ycbcr ? 0 : 1 + cfl.b[t] / 84;
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
        coef[0] += (!ycbcr && (rgb || c === 2) ? 1 : 0) * y[0];
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

export function reconstructDCT8RGB(image, {planes: floating = false} = {}) {
  return rgbPixels(reconstructDCT8Planes(image, true), image.width, image.height, floating);
}
