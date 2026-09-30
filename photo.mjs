// SPDX-License-Identifier: MIT
// Rapier JXL's photograph door: pixels through the carrier's VarDCT writer, sRGB to YCbCr, forward DCT8, quantisation,
// then the carrier's contexts and prefix codes. Its own door, so the core carries none of it.
import {PHOTO_LIMITS, complete, part} from './bits.mjs';
import {varDCTSteps} from './vardct.mjs';
import {losslessSteps} from './lossless.mjs';
import {admitOptions, admitPixels, job} from './admit.mjs';

// This door's limits (bits.mjs): 40 million pixels, its memory 6.5 bytes a pixel besides the picture at that size.
export {PHOTO_LIMITS as LIMITS};

// Neither table comes from Math.cos, Math.hypot or `**`, which each engine rounds its own way; the same pixels must
// give the same bytes everywhere. The DCT8 basis, (u ? 1 : √½) · cos((2x + 1) · u · π / 16) / 2 at u · 8 + x, is
// written out as V8 computed it (the cosines of the larger angles carry their rounding, and a coefficient on a
// rounding edge would move without it). The quantisation shape, 1.3 ** max(0, hypot(u, v) · 5 / √98 − 1) at
// v · 8 + u, is the exponential series of its logarithm: libjxl 0.7's DCT8 luma distance bands
// (lib/jxl/quant_weights.cc), the reciprocal weight growing with radial frequency; its integer steps are V8's at every
// quality by 0.001. Both chroma planes keep full resolution; their scale accounts for YCbCr's larger RGB error.
const COSINES = Float64Array.of(0.3535533905932738, 0.3535533905932738, 0.3535533905932738, 0.3535533905932738,
  0.3535533905932738, 0.3535533905932738, 0.3535533905932738, 0.3535533905932738, 0.4903926402016152,
  0.4157348061512726, 0.27778511650980114, 0.09754516100806417, -0.0975451610080641, -0.277785116509801,
  -0.4157348061512727, -0.4903926402016152, 0.46193976625564337, 0.19134171618254492, -0.19134171618254486,
  -0.46193976625564337, -0.4619397662556434, -0.19134171618254517, 0.191341716182545, 0.46193976625564326,
  0.4157348061512726, -0.0975451610080641, -0.4903926402016152, -0.2777851165098011, 0.2777851165098009,
  0.4903926402016152, 0.09754516100806439, -0.41573480615127256, 0.3535533905932738, -0.35355339059327373,
  -0.35355339059327384, 0.3535533905932737, 0.35355339059327384, -0.35355339059327334, -0.35355339059327356,
  0.3535533905932733, 0.27778511650980114, -0.4903926402016152, 0.09754516100806415, 0.4157348061512728,
  -0.41573480615127256, -0.09754516100806401, 0.4903926402016153, -0.27778511650980076, 0.19134171618254492,
  -0.4619397662556434, 0.46193976625564326, -0.19134171618254495, -0.19134171618254528, 0.46193976625564337,
  -0.4619397662556432, 0.19134171618254478, 0.09754516100806417, -0.2777851165098011, 0.4157348061512728,
  -0.4903926402016153, 0.4903926402016152, -0.4157348061512725, 0.27778511650980076, -0.09754516100806429);
const QUANT_SHAPE = Float64Array.from({length: 64}, (_, k) => {
  const y = Math.max(0, Math.sqrt((k & 7) * (k & 7) + (k >> 3) * (k >> 3)) * 5 / Math.sqrt(98) - 1) * 0.26236426446749106;
  let term = 1, sum = 1;
  for (let n = 1; n < 30; n++) sum += term = term * y / n;
  return sum;
});

// Eight terms in the original accumulation order, including the initial zero. The two separable passes
// share this fixed dot product without a loop or a changed floating-point sum.
function dot8(data, at, step, basis) {
  let sum = 0;
  sum += data[at] * COSINES[basis];
  sum += data[at + step] * COSINES[basis + 1];
  sum += data[at + 2 * step] * COSINES[basis + 2];
  sum += data[at + 3 * step] * COSINES[basis + 3];
  sum += data[at + 4 * step] * COSINES[basis + 4];
  sum += data[at + 5 * step] * COSINES[basis + 5];
  sum += data[at + 6 * step] * COSINES[basis + 6];
  sum += data[at + 7 * step] * COSINES[basis + 7];
  return sum;
}

// A row of groups (32 block rows) per step.
function* coefficientSteps(data, width, height, quality, colorSpace) {
  const stride = Math.ceil(width / 8), rows = Math.ceil(height / 8), quantScale = 16;
  const distance = quality >= 30 ? 0.1 + (100 - quality) * 0.09 : 53 / 3000 * quality * quality - 23 / 20 * quality + 25;
  const components = [0, 1, 2].map(c => ({h: 1, v: 1, stride, rows,
    quant: Int32Array.from(QUANT_SHAPE, (shape, k) => Math.max(1, Math.round(quantScale * distance * (c ? 8 : 14) * (k ? shape : 0.5)))),
    coeffs: new Int16Array(stride * rows * 64)}));
  const block = new Float64Array(192), intermediate = new Float64Array(64);
  const band = (from, to) => {
    for (let by = from; by < to; by++) for (let bx = 0; bx < stride; bx++) {
      // Edge replication gives a complete transform without inventing a dark border in a partial block.
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        const at = (Math.min(height - 1, by * 8 + y) * width + Math.min(width - 1, bx * 8 + x)) * 4;
        const r = data[at], g = data[at + 1], b = data[at + 2], k = y * 8 + x;
        block[k] = 0.299 * r + 0.587 * g + 0.114 * b - 128;
        block[64 + k] = -0.168735892 * r - 0.331264108 * g + 0.5 * b;
        block[128 + k] = 0.5 * r - 0.418687589 * g - 0.081312411 * b;
      }
      for (let c = 0; c < 3; c++) {
        for (let y = 0; y < 8; y++) for (let u = 0; u < 8; u++) {
          intermediate[y * 8 + u] = dot8(block, c * 64 + y * 8, 1, u * 8);
        }
        const {coeffs, quant} = components[c], offset = (by * stride + bx) * 64;
        for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) {
          const sum = dot8(intermediate, u, 8, v * 8), k = v * 8 + u;
          coeffs[offset + k] = Math.round(sum * quantScale / quant[k]);
        }
      }
    }
  };
  for (let by = 0; by < rows; by += 32) { band(by, Math.min(rows, by + 32)); yield Math.min(rows, by + 32) / rows; }
  let alpha = null;
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) { alpha = data; break; }
  return {width, height, components, quantScale, ycbcr: true, orientation: 1, alpha, colorSpace};
}

// Quality 90 by default, 1 to 99 photographic, on libjxl's quality-to-distance curve; 100 is the core's exact stream,
// including RGB beneath transparent pixels. Alpha is always exact; the colour space is declared as the core declares
// it. The options are read before any work.
export function encodePhoto(data, width, height, options) { return complete(encodePhotoSteps(data, width, height, options)); }

// The same work as a job (admit.mjs): the coefficients a row of groups per step, then the VarDCT writer's steps.
export function encodePhotoSteps(data, width, height, options) {
  const {quality, colorSpace} = admitOptions(options, 90);
  admitPixels(data, width, height, PHOTO_LIMITS);
  return job(photoSteps(data, width, height, quality, colorSpace));
}

function* photoSteps(data, width, height, quality, colorSpace) {
  if (quality >= 100) return yield* losslessSteps(data, width, height, {colorSpace});
  return yield* part(varDCTSteps(yield* part(coefficientSteps(data, width, height, quality, colorSpace), 0, 2)), 1, 2);
}
