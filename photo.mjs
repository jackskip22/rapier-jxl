// SPDX-License-Identifier: MIT
// Photographic pixels through the shared VarDCT writer: sRGB to YCbCr, forward DCT8, quantisation, then the
// carrier's contexts and prefix codes. Separate from index.mjs so artwork does not import this optional path.
import {LIMITS} from './bits.mjs';
import {encodeVarDCT} from './vardct.mjs';
import {encodeLossless} from './lossless.mjs';

const photoFault = (code, message) => Object.assign(new Error(message), {code});
const COSINES = Float64Array.from({length: 64}, (_, i) => (i < 8 ? Math.SQRT1_2 : 1) * Math.cos((2 * (i & 7) + 1) * (i >> 3) * Math.PI / 16) / 2);
// libjxl 0.7's DCT8 luma distance bands, from lib/jxl/quant_weights.cc. The reciprocal weight grows with radial
// frequency. Both chroma planes keep full resolution; their scale accounts for YCbCr's larger RGB error.
const QUANT_SHAPE = Float64Array.from({length: 64}, (_, k) => 1.3 ** Math.max(0, Math.hypot(k & 7, k >> 3) * 5 / Math.sqrt(98) - 1));

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

function photoCoefficients(data, width, height, quality) {
  const stride = Math.ceil(width / 8), rows = Math.ceil(height / 8), quantScale = 16;
  const distance = quality >= 30 ? 0.1 + (100 - quality) * 0.09 : 53 / 3000 * quality * quality - 23 / 20 * quality + 25;
  const components = [0, 1, 2].map(c => ({h: 1, v: 1, stride, rows,
    quant: Int32Array.from(QUANT_SHAPE, (shape, k) => Math.max(1, Math.round(quantScale * distance * (c ? 8 : 14) * (k ? shape : 0.5)))),
    coeffs: new Int16Array(stride * rows * 64)}));
  const block = new Float64Array(192), intermediate = new Float64Array(64);
  for (let by = 0; by < rows; by++) for (let bx = 0; bx < stride; bx++) {
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
  let alpha = null;
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) { alpha = data; break; }
  return {width, height, components, quantScale, ycbcr: true, orientation: 1, alpha};
}

// Photographs below quality 100; quality 100 delegates to the existing exact encoder. Alpha is always exact.
export function encodePhotoRGBA(data, width, height, options = {}) {
  if (options === null || typeof options !== 'object') throw photoFault('JXL_INPUT', 'Options are an object: {quality}.');
  const quality = options.quality === undefined ? 90 : options.quality;
  if (typeof quality !== 'number' || !Number.isFinite(quality) || quality < 1 || quality > 100) throw photoFault('JXL_INPUT', 'Quality is a number from 1 to 100.');
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw photoFault('JXL_INPUT', 'A picture has positive whole pixel dimensions.');
  if (width > LIMITS.edge || height > LIMITS.edge || width * height > LIMITS.pixels) throw photoFault('JXL_DIMENSIONS', 'The picture exceeds the JPEG XL pixel limits.');
  if (!(data instanceof Uint8Array) && !(data instanceof Uint8ClampedArray) || data.length !== width * height * 4) throw photoFault('JXL_INPUT', 'Pixels are width * height * 4 straight RGBA bytes.');
  try {
    const bytes = quality >= 100 ? encodeLossless(data, width, height) : encodeVarDCT(photoCoefficients(data, width, height, quality));
    if (bytes.length > LIMITS.bytes) throw photoFault('JXL_SIZE', 'The encoded picture exceeds 16 MiB.');
    return bytes;
  } catch (error) { if (error instanceof RangeError && !error.code) throw photoFault('JXL_MEMORY', 'Not enough memory for this picture.'); throw error; }
}
