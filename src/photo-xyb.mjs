// SPDX-License-Identifier: MIT
import {QUANT_SHAPE, transformDCT8Blocks} from './photo-dct.mjs';

const BIAS = 0.0037930732552754493;
function seedRoot(v) {
  let root = Math.sqrt(Math.sqrt(v));
  for (let i = 0; i < 7; i++) root = (2 * root + v / (root * root)) / 3;
  return root;
}
const ROOT_BIAS = seedRoot(BIAS);
const ROOTS = Float64Array.from({length: 4113}, (_, i) => i ? seedRoot(i / 4096) : 0);
function cubeRoot(v) {
  const scaled = v * 4096, at = Math.floor(scaled);
  let root = ROOTS[at] + (ROOTS[at + 1] - ROOTS[at]) * (scaled - at);
  for (let i = 0; i < 2; i++) root = (2 * root + v / (root * root)) / 3;
  return root;
}
function signedRoot(v) {
  const a = Math.abs(v), root = a <= 1 ? cubeRoot(a) : seedRoot(a);
  return v < 0 ? -root : root;
}
const LINEAR = Float64Array.from({length: 256}, (_, i) => {
  const v = i / 255;
  if (i <= 10) return v / 12.92;
  const base = (v + 0.055) / 1.055, square = base * base;
  let fifth = Math.sqrt(Math.sqrt(square));
  for (let n = 0; n < 12; n++) fifth = (4 * fifth + square / (fifth * fifth * fifth * fifth)) / 5;
  return square * fifth;
});


export function preferXYB(data, width, height) {
  let lumaEnergy = 0, chromaEnergy = 0;
  const pair = (a, b) => {
    const r = data[a] - data[b], g = data[a + 1] - data[b + 1], blue = data[a + 2] - data[b + 2];
    const y = 77 * r + 150 * g + 29 * blue, cb = 256 * blue - y, cr = 256 * r - y;
    lumaEnergy += y * y; chromaEnergy += cb * cb + cr * cr;
  };
  for (let y = 0; y < height; y += Math.max(1, height / 32 | 0)) for (let x = 0; x < width; x += Math.max(1, width / 32 | 0)) {
    const at = (y * width + x) * 4;
    if (x + 1 < width) pair(at, at + 4);
    if (y + 1 < height) pair(at, at + width * 4);
  }
  return chromaEnergy <= lumaEnergy;
}

const ONE = [1 - 0.05465007330715401, 1 - 0.07005449891748593, 1 - 0.049935103337343655];
function biasedRound(value, c) {
  const a = Math.abs(value), sign = value < 0 ? -1 : 1;
  let n = Math.max(1, Math.round(a));
  const point = m => m === 1 ? ONE[c] : m - 0.145 / m;
  if (n > 1 && Math.abs(a - point(n - 1)) < Math.abs(a - point(n))) n--;
  else if (Math.abs(a - point(n + 1)) < Math.abs(a - point(n))) n++;
  return sign * n;
}

export function* photoXYBSteps(data, width, height, quality, options) {
  const T = options?.transform, lms = T?.lms;
  const stride = Math.ceil(width / 8), rows = Math.ceil(height / 8), quantScale = 256;
  const distance = quality >= 30 ? 0.1 + (100 - quality) * 0.09 : 53 / 3000 * quality * quality - 23 / 20 * quality + 25;
  const strength = Math.max(0, Math.min(1, (90 - quality) / 15)), stepScale = 1 - 0.1 * strength, acScale = 1.175 + 0.075 * strength;
  const t = options?.tune, tune = typeof t === "function" ? t : t ? (c, k) => t[c] * (1 + t[3 + c] * Math.sqrt(((k & 7) * (k & 7) + (k >> 3) * (k >> 3)) / 98)) : () => 1;
  const d = options?.dcScale, dcScale = typeof d === 'function' ? c => d(c, distance) : Array.isArray(d) ? c => d[c] : () => d ?? 1;
  const components = [0, 1, 2].map(c => ({h: 1, v: 1, stride, rows,
    quant: Int32Array.from(QUANT_SHAPE, (shape, k) => Math.max(1, Math.round(quantScale * distance * stepScale *
      (k ? acScale * [0.84, 7, 5.6][c] * shape * (1 + [1, 0, 5][c] * Math.sqrt(((k & 7) * (k & 7) + (k >> 3) * (k >> 3)) / 98)) * tune(c, k) : [1.05, 7, 12.6][c] * 0.25 * dcScale(c))))),
    coeffs: new Int16Array(stride * rows * 64)}));
  const tileWidth = Math.ceil(stride / 8), tileRows = Math.ceil(rows / 8);
  const cfl = {width: tileWidth, x: new Int8Array(tileWidth * tileRows), b: new Int8Array(tileWidth * tileRows)};
  const intermediate = new Float64Array(64), sums = new Float64Array(192), tile = new Float64Array(64 * 192);
  const roundtrip = !!options?.roundtrip, lumaBack = new Float64Array(64), dead = options?.deadzone, biased = !!options?.biasedRound;
  const fieldScale = options?.fieldScale, FIELD = 64, quantFields = fieldScale && new Int32Array(stride * rows);
  if (quantFields) for (let i = 0; i < quantFields.length; i++) quantFields[i] = Math.max(1, Math.min(256, Math.round(FIELD * fieldScale[i])));
  for (let ty = 0; ty < tileRows; ty++) {
    for (let tx = 0; tx < tileWidth; tx++) {
      const bx0 = tx * 8, by0 = ty * 8, bw = Math.min(8, stride - bx0), bh = Math.min(8, rows - by0);
      let yy = 0, xy = 0, bySum = 0;
      for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
        const offset = (by * bw + bx) * 192;
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
          const at = (Math.min(height - 1, (by0 + by) * 8 + y) * width + Math.min(width - 1, (bx0 + bx) * 8 + x)) * 4, k = y * 8 + x;
          let l, m, s;
          if (T) {
            const r = T.tables[0][data[at]], g = T.tables[1][data[at + 1]], b = T.tables[2][data[at + 2]];
            l = signedRoot(lms[0] * r + lms[1] * g + lms[2] * b + BIAS) - ROOT_BIAS;
            m = signedRoot(lms[3] * r + lms[4] * g + lms[5] * b + BIAS) - ROOT_BIAS;
            s = signedRoot(lms[6] * r + lms[7] * g + lms[8] * b + BIAS) - ROOT_BIAS;
          } else {
            const r = LINEAR[data[at]], g = LINEAR[data[at + 1]], b = LINEAR[data[at + 2]];
            l = cubeRoot(0.3 * r + 0.622 * g + 0.078 * b + BIAS) - ROOT_BIAS;
            m = cubeRoot(0.23 * r + 0.692 * g + 0.078 * b + BIAS) - ROOT_BIAS;
            s = cubeRoot(0.24342268924547819 * r + 0.20476744424496821 * g + 0.5518098665095536 * b + BIAS) - ROOT_BIAS;
          }
          tile[offset + k] = (l - m) * 127.5;
          tile[offset + 64 + k] = (l + m) * 127.5;
          tile[offset + 128 + k] = s * 255 - tile[offset + 64 + k];
        }
      }
      transformDCT8Blocks(tile, bw * bh, intermediate, sums);
      for (let n = 0; n < bw * bh; n++) for (let k = 1; k < 64; k++) {
        const at = n * 192;
        yy += tile[at + 64 + k] * tile[at + 64 + k];
        xy += tile[at + k] * tile[at + 64 + k];
        bySum += tile[at + 128 + k] * tile[at + 64 + k];
      }
      const index = ty * tileWidth + tx;
      const cflScale = options?.cflScale ?? 1;
      const fx = cfl.x[index] = Math.max(-128, Math.min(127, Math.round(cflScale * 84 * xy / (yy + 1))));
      const fb = cfl.b[index] = Math.max(-128, Math.min(127, Math.round(cflScale * 84 * bySum / (yy + 1))));
      for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
        const at = (by * bw + bx) * 192, offset = ((by0 + by) * stride + bx0 + bx) * 64;
        const fine = quantFields ? quantFields[(by0 + by) * stride + bx0 + bx] / FIELD : 1;
        for (const c of roundtrip ? [1, 0, 2] : [0, 1, 2]) for (let k = 0; k < 64; k++) {
          const luma = roundtrip && k ? lumaBack[k] : tile[at + 64 + k];
          const coefficient = tile[at + c * 64 + k] - (k && c !== 1 ? (c === 0 ? fx : fb) / 84 * luma : 0)
            + (roundtrip && k && c === 2 ? tile[at + 64 + k] - luma : 0);
          const value = coefficient * quantScale / components[c].quant[k] * (k ? fine : 1);
          const high = (k & 7) >= 4 || (k >> 3) >= 4;
          const threshold = dead && k ? dead[c * 2 + (high ? 1 : 0)] : k && c === 1 ? 0.5 + strength * (high ? 0.14 : 0.08) : 0.5;
          const q = components[c].coeffs[offset + k] = Math.abs(value) < threshold ? 0 : biased && k ? biasedRound(value, c) : Math.round(value);
          if (roundtrip && c === 1 && k) lumaBack[k] = (q === 0 ? 0 : q === 1 || q === -1 ? q * 0.92994550108251407 : q - 0.145 / q)
            * components[1].quant[k] / (quantScale * fine);
        }
      }
    }
    yield (ty + 1) / tileRows;
  }
  let alpha = null;
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) { alpha = data; break; }
  const epf = (quality <= 90 || options?.filterAlways) && options?.filter !== 'off' ? 20 * distance : 0;
  const image = {width, height, components, quantScale, cfl, epf, xyb: true, ycbcr: false, orientation: 1, alpha, colorSpace: options?.space ?? 'srgb'};
  if (quantFields) { image.quantFields = quantFields; image.quantFieldBase = FIELD; image.epf = epf * FIELD / 32; }
  if (options?.epfScale !== undefined) image.epf *= options.epfScale;
  if (options?.sharpness) image.sharpness = options.sharpness;
  if (options?.epfIterations) image.epfIterations = options.epfIterations;
  return image;
}
