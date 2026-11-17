// SPDX-License-Identifier: MIT
import {dct8Band} from './dct8-band.mjs';
import {reconstructDCT8Planes} from './reconstruct-dct8.mjs';
let views;
export function colorPixels(planes, width, height, stride, mode, alpha = null, alphaStep = 1) {
  const band = dct8Band(), buffer = band.buffer();
  if (views?.buffer !== buffer) views = {buffer,
    f64: band.coeffViews,
    f32: band.coeff.map(at => new Float32Array(buffer, at, band.blocks * 64)), u8: new Uint8Array(buffer),
  };
  const {f64, f32, u8} = views;
  const floating = mode & 2, count = width * height, capacity = band.blocks * 64;
  const output = floating ? [0, 1, 2].map(() => new Float32Array(count)) : new Uint8Array(count * 4);
  for (let from = 0; from < count; from += capacity) {
    const n = Math.min(capacity, count - from);
    if (stride === width) for (let c = 0; c < 3; c++) f64[c].set(planes[c].subarray(from, from + n));
    else for (let i = 0; i < n;) {
      const pixel = from + i, x = pixel % width, at = Math.floor(pixel / width) * stride + x, take = Math.min(n - i, width - x);
      for (let c = 0; c < 3; c++) f64[c].set(planes[c].subarray(at, at + take), i);
      i += take;
    }
    if (alpha && !floating) u8.set(alpha.subarray(from * alphaStep, (from + n) * alphaStep), band.out);
    band.colorRows(band.coeff[0], band.coeff[1], band.coeff[2], n, mode, alpha && !floating ? band.out : 0, alphaStep);
    if (floating) for (let c = 0; c < 3; c++) output[c].set(f32[c].subarray(0, n), from);
    else output.set(u8.subarray(band.coeff[0], band.coeff[0] + n * 4), from * 4);
  }
  return output;
}

export function rgbPixels({planes, W}, width, height, floating) {
  return colorPixels(planes, width, height, W, floating ? 2 : 0);
}

export function reconstructDCT8RGB(image, band, {planes: floating = false} = {}) {
  return rgbPixels(reconstructDCT8Planes(image, true, false, band), image.width, image.height, floating);
}
