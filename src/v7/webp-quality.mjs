// SPDX-License-Identifier: MIT
import {fail} from './primitives.mjs';

const ROWS = [[0.3, 10.56, 10.165], [0.4, 11.82, 14.049], [0.5, 22.73, 13.492], [0.6, 31.92, 12.291], [0.7, 42.11, 10.617], [0.75, 45.95, 10.18], [0.8, 55.65, 8.762], [0.85, 65.86, 7.115], [0.9, 75.31, 5.383], [0.92, 79.07, 4.77], [0.95, 84.42, 3.451], [0.98, 88.66, 2.506]];

const word = (data, i, float) => float ? (data[i] > 0 ? data[i] < 1 ? data[i] : 1 : 0) * 65535 + 0.5 | 0 : data[i];
const luma = (data, i, table, float) => table ? 0.299 * table[word(data, i, float)] + 0.587 * table[word(data, i + 1, float)] + 0.114 * table[word(data, i + 2, float)]
  : 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];

function linearOf({data, sampleFormat, transferFunction, icc}) {
  const named = icc === undefined ? transferFunction ?? (data instanceof Float32Array || sampleFormat === 'float16' ? 'linear' : 'srgb') : 'srgb';
  if (named === 'pq' || named === 'hlg') throw fail('JXL_OPTIONS', `The photo reading has no ${named.toUpperCase()}; use 'exact'.`);
  return named === 'linear';
}

export function gradient(picture, {stride = picture.width, origin = 0} = {}) {
  const {data, width, height, bitDepth, sampleFormat} = picture, linear = linearOf(picture);
  const float = data instanceof Float32Array, halves = sampleFormat === 'float16', wide = data instanceof Uint16Array;
  const depth = wide ? bitDepth ?? 16 : 8;
  if (wide && !halves && ![10, 12, 16].includes(depth))
    throw fail('JXL_INPUT', 'Uint16Array integer samples use 10, 12 or 16 bits.');
  const top = halves || float ? 65535 : 2 ** depth - 1;
  let table = null;
  if (wide || float || linear) {
    table = new Float64Array(top + 1);
    for (let w = 0; w <= top; w++) {
      let v = halves ? (w & 0x8000 ? -1 : 1) * (w & 0x7c00 ? (1024 + (w & 1023)) * 2 ** ((w >> 10 & 31) - 25) : (w & 1023) * 2 ** -24) : w / top;
      v = v > 0 ? v < 1 ? v : 1 : 0;
      table[w] = 255 * (linear ? v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055 : v);
    }
  }
  const rowStride = stride * 4;
  let sum = 0, n = 0;
  for (let y = 1; y < height - 1; y += 4) {
    let i = (origin + y * stride) * 4, here = luma(data, i, table, float);
    for (let x = 0; x < width - 1; x++, i += 4) {
      const right = luma(data, i + 4, table, float);
      sum += Math.abs(right - here) + Math.abs(luma(data, i + rowStride, table, float) - here); here = right; n++;
    }
  }
  return n ? sum / n : 0;
}

function line(at, g) {
  let i = 0;
  while (i + 2 < ROWS.length && ROWS[i + 1][0] < at) i++;
  const [q0, a0, b0] = ROWS[i], [q1, a1, b1] = ROWS[i + 1], t = (at - q0) / (q1 - q0);
  return (a0 + t * (a1 - a0)) + (b0 + t * (b1 - b0)) * Math.log(Math.max(g, 0.5));
}

export function qualityFor(q, g) {
  if (q >= 1) return 100;
  const at = Math.min(Math.max(q, ROWS[0][0]), ROWS.at(-1)[0]);
  let most = line(at, g);
  for (const [r] of ROWS) if (r < at) most = Math.max(most, line(r, g));
  return Math.min(99, Math.max(1, Math.round(most)));
}

const CEILING = [67, 68, 68, 68, 69, 69, 70, 70, 71, 71, 72, 72, 73, 73, 73, 74, 74, 75, 75, 76, 76, 77, 77, 77, 78, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 88, 90, 90, 91, 92, 93, 94, 95, 95, 96, 96, 97, 97];
export const ceilingFor = q => q < 0.5 || q > 0.98 ? Infinity : CEILING[Math.ceil((q - 0.5) * 100 - 1e-9)];

const SMALL = [[32, [51, 51, 51, 51, 51, 51, 51, 51, 51, 51, 51, 51, 51, 51, 51, 51, 51, 51, 51, 53, 53, 63, 63, 63, 63, 63, 65, 67, 71, 73, 73, 81, 83, 87, 87, 89, 91, 91, 93, 93, 93, 95, 97, 99, 99, 99, 99, 99, 99]], [64, [99, 99, 99, 99, 99.5, 99.5, 99.5, 99.5, 99.5, 99.5, 99.5, 99.5, 99.5, 99.5, 99.5, 99.5, 99.5, 99.5, 99.5, 99.5, 99.5, 99.5, 99.5, 99.5, 99.5, 99.5, 99.5, 99.9, 99.9, 99.9, 99.9, 99.9, 99.9, 99.9, 99.9, 99.9, 99.9, 99.9, 99.99, 99.99, 99.99, 99.99, 99.99, 99.99, 99.99, 99.99, 99.99, 99.99, 99.99]], [128, [97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99.5, 99.5, 99.5, 99.5, 99.5, 99.5, 99.9, 99.9, 99.9, 99.9, 99.9, 99.9, 99.9, 99.9, 99.9]], [256, [67, 69, 69, 69, 69, 69, 71, 71, 71, 71, 71, 73, 73, 73, 73, 73, 75, 75, 75, 75, 75, 77, 77, 77, 77, 77, 79, 79, 81, 81, 83, 83, 85, 85, 87, 87, 89, 89, 91, 91, 93, 93, 93, 95, 95, 97, 97, 97, 97]]];
export const smallReading = (q, side) => {
  const table = SMALL.find(([under]) => side < under)?.[1];
  if (!table) return Infinity;
  const at = Math.min(0.98, Math.max(0.5, q));
  return Math.min(q > 0.98 ? 99.99 : table[Math.ceil((at - 0.5) * 100 - 1e-9)], q > 0.98 ? Infinity : ceilingFor(at));
};

export const webpQuality = (q, picture) => q >= 1 ? (linearOf(picture), 100) : qualityFor(q, gradient(picture));

export function settleWebp(codec, picture) {
  if (codec.qualityIntent === undefined) return codec;
  const {qualityIntent, ...rest} = codec;
  return {...rest, quality: webpQuality(qualityIntent, picture)};
}

const BUMPS = [[0.8, [[100, 8], [250, 6], [Infinity, 3]]], [0.92, [[100, 4], [250, 3], [Infinity, 2]]]];

const OFF_GRID = [2, 1];

export function regionQuality(q, data, width, rect, offGrid = false) {
  if (q >= 1) return 100;
  const side = Math.min(rect.width, rect.height), step = rows => rows.find(([under]) => side < under)[1];
  const lo = BUMPS[0], hi = BUMPS[1], t = Math.min(1, Math.max(0, (q - lo[0]) / (hi[0] - lo[0])));
  return Math.min(99, Math.max(1, Math.round(fixedReading(q) + step(lo[1]) + t * (step(hi[1]) - step(lo[1])) + (offGrid ? OFF_GRID[0] + t * (OFF_GRID[1] - OFF_GRID[0]) : 0))));
}

const fixedReading = webp => { const q = webp * 100; return q >= 76 ? q - 3 : q >= 68 ? q - (q - 68) * 3 / 8 : q >= 60 ? q + (68 - q) / 2 : q + 4; };
export const fixedQuality = webp => Math.max(1, Math.min(99, Math.round(fixedReading(webp))));

export const webpCoding = webp => ({quality: fixedQuality(webp), regionQuality: (data, width, rect, offGrid) => regionQuality(webp, data, width, rect, offGrid), readingWebp: webp});
