// SPDX-License-Identifier: MIT
import {kernelHooks} from './kernel-hooks.mjs';

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
export {COSINES as dct8Basis};
export const QUANT_SHAPE = Float64Array.from({length: 64}, (_, k) => {
  const y = Math.max(0, Math.sqrt((k & 7) * (k & 7) + (k >> 3) * (k >> 3)) * 5 / Math.sqrt(98) - 1) * 0.26236426446749106;
  let term = 1, sum = 1;
  for (let n = 1; n < 30; n++) sum += term = term * y / n;
  return sum;
});

function dctChannel(src, o, mid, dst, d) {
  for (let y = 0; y < 8; y++) {
    const a = o + y * 8, x0 = src[a], x1 = src[a + 1], x2 = src[a + 2], x3 = src[a + 3], x4 = src[a + 4], x5 = src[a + 5], x6 = src[a + 6], x7 = src[a + 7];
    for (let u = 0, b = 0; u < 8; u++, b += 8) {
      let sum = 0;
      sum += x0 * COSINES[b]; sum += x1 * COSINES[b + 1]; sum += x2 * COSINES[b + 2]; sum += x3 * COSINES[b + 3];
      sum += x4 * COSINES[b + 4]; sum += x5 * COSINES[b + 5]; sum += x6 * COSINES[b + 6]; sum += x7 * COSINES[b + 7];
      mid[y * 8 + u] = sum;
    }
  }
  for (let u = 0; u < 8; u++) {
    const x0 = mid[u], x1 = mid[8 + u], x2 = mid[16 + u], x3 = mid[24 + u], x4 = mid[32 + u], x5 = mid[40 + u], x6 = mid[48 + u], x7 = mid[56 + u];
    for (let v = 0, b = 0; v < 8; v++, b += 8) {
      let sum = 0;
      sum += x0 * COSINES[b]; sum += x1 * COSINES[b + 1]; sum += x2 * COSINES[b + 2]; sum += x3 * COSINES[b + 3];
      sum += x4 * COSINES[b + 4]; sum += x5 * COSINES[b + 5]; sum += x6 * COSINES[b + 6]; sum += x7 * COSINES[b + 7];
      dst[d + v * 8 + u] = sum;
    }
  }
}

export function transformDCT8(block, intermediate, sums, offset = 0) {
  for (let c = 0; c < 3; c++) dctChannel(block, offset + c * 64, intermediate, sums, c * 64);
  return sums;
}

export function transformDCT8Blocks(blocks, count, intermediate) {
  if (kernelHooks.dct?.(blocks, count, COSINES)) return;
  for (let n = 0; n < count * 3; n++) dctChannel(blocks, n * 64, intermediate, blocks, n * 64);
}

const FAST_S = Float64Array.of(1, 0.7209598223816907, 0.7653668647301796, 0.8504300941521988, 1, 1.2727585826345942, 1.8477590650225744, 3.6245097377961106);
export const FAST_SCALE = Float64Array.from({length: 64}, (_, k) => FAST_S[k & 7] * FAST_S[k >> 3] / 8);
export function transformDCT8BlocksFast(blocks, count) {
  const x = blocks;
  for (let n = 0; n < count; n++) {
    let o = n * 192;
    for (let c = 0; c < 3; c++, o += 64) {
      for (let pass = 0; pass < 2; pass++) {
        const stride = pass ? 8 : 1, step = pass ? 1 : 8;
        for (let i = 0; i < 8; i++) {
          const p = o + i * step;
          const x0 = x[p], x1 = x[p + stride], x2 = x[p + 2 * stride], x3 = x[p + 3 * stride];
          const x4 = x[p + 4 * stride], x5 = x[p + 5 * stride], x6 = x[p + 6 * stride], x7 = x[p + 7 * stride];
          const tmp0 = x0 + x7, tmp7 = x0 - x7, tmp1 = x1 + x6, tmp6 = x1 - x6;
          const tmp2 = x2 + x5, tmp5 = x2 - x5, tmp3 = x3 + x4, tmp4 = x3 - x4;
          const tmp10 = tmp0 + tmp3, tmp13 = tmp0 - tmp3, tmp11 = tmp1 + tmp2, tmp12 = tmp1 - tmp2;
          x[p] = tmp10 + tmp11; x[p + 4 * stride] = tmp10 - tmp11;
          const z1 = (tmp12 + tmp13) * 0.7071067811865476;
          x[p + 2 * stride] = tmp13 + z1; x[p + 6 * stride] = tmp13 - z1;
          const t10 = tmp4 + tmp5, t11 = tmp5 + tmp6, t12 = tmp6 + tmp7;
          const z5 = (t10 - t12) * 0.3826834333650898;
          const z2 = 0.5411961001461969 * t10 + z5, z4 = 1.3065629648763766 * t12 + z5, z3 = t11 * 0.7071067811865476;
          const z11 = tmp7 + z3, z13 = tmp7 - z3;
          x[p + 5 * stride] = z13 + z2; x[p + 3 * stride] = z13 - z2;
          x[p + stride] = z11 + z4; x[p + 7 * stride] = z11 - z4;
        }
      }
      for (let k = 0; k < 64; k++) x[o + k] *= FAST_SCALE[k];
    }
  }
}

export function dctBlocks(data, width, height, gray = false) {
  const block = new Float64Array(192), intermediate = new Float64Array(64), sums = new Float64Array(192);
  return (bx, by) => {
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const at = (Math.min(height - 1, by * 8 + y) * width + Math.min(width - 1, bx * 8 + x)) * 4;
      const r = data[at], g = data[at + 1], b = data[at + 2], k = y * 8 + x;
      if (gray) { block[k] = r - 128; block[64 + k] = block[128 + k] = 0; continue; }
      block[k] = 0.299 * r + 0.587 * g + 0.114 * b - 128;
      block[64 + k] = -0.168735892 * r - 0.331264108 * g + 0.5 * b;
      block[128 + k] = 0.5 * r - 0.418687589 * g - 0.081312411 * b;
    }
    return transformDCT8(block, intermediate, sums);
  };
}

export function* photoCoefficientSteps(data, width, height, quality, colorSpace, gray = false) {
  const stride = Math.ceil(width / 8), rows = Math.ceil(height / 8), quantScale = 16;
  const distance = quality >= 30 ? 0.1 + (100 - quality) * 0.09 : 53 / 3000 * quality * quality - 23 / 20 * quality + 25;
  const strength = Math.max(0, Math.min(1, (90 - quality) / 15)), stepScale = 1 - 0.1 * strength;
  const components = (gray ? [0] : [0, 1, 2]).map(c => ({h: 1, v: 1, stride, rows,
    quant: Int32Array.from(QUANT_SHAPE, (shape, k) => Math.max(1, Math.round(quantScale * distance * stepScale * (c ? 18 : 10) * (k ? shape : 0.25)))),
    coeffs: new Int16Array(stride * rows * 64)}));
  const transform = dctBlocks(data, width, height, gray);
  const band = (from, to) => {
    for (let by = from; by < to; by++) for (let bx = 0; bx < stride; bx++) {
      const sums = transform(bx, by), offset = (by * stride + bx) * 64;
      for (let c = 0; c < components.length; c++) for (let k = 0; k < 64; k++) {
        const value = sums[c * 64 + k] * quantScale / components[c].quant[k];
        const threshold = k && c === 0 ? 0.5 + strength * ((k & 7) >= 4 || (k >> 3) >= 4 ? 0.14 : 0.08) : 0.5;
        components[c].coeffs[offset + k] = Math.abs(value) < threshold ? 0 : Math.round(value);
      }
    }
  };
  for (let by = 0; by < rows; by += 32) { band(by, Math.min(rows, by + 32)); yield Math.min(rows, by + 32) / rows; }
  let alpha = null;
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) { alpha = data; break; }
  return {width, height, components, quantScale, ycbcr: true, orientation: 1, alpha, colorSpace};
}
