// SPDX-License-Identifier: MIT
import {fail} from './primitives.mjs';
import {measuredLook} from '../photo-quality-table.mjs';
import {call} from '../capture-kernels.mjs';
import {both, outUpTo, room} from '../kernel-call.mjs';
import {fault} from '../fault.mjs';

const ROWS = [[0.3, 10.56, 10.165], [0.4, 11.82, 14.049], [0.5, 22.73, 13.492], [0.6, 31.92, 12.291], [0.7, 42.11, 10.617], [0.75, 45.95, 10.18], [0.8, 55.65, 8.762], [0.85, 65.86, 7.115], [0.9, 75.31, 5.383], [0.92, 79.07, 4.77], [0.95, 84.42, 3.451], [0.98, 88.66, 2.506]];

function linearOf({data, sampleFormat, transferFunction, icc}) {
  const named = icc === undefined ? transferFunction ?? (data instanceof Float32Array || sampleFormat === 'float16' ? 'linear' : 'srgb') : 'srgb';
  if (named === 'pq' || named === 'hlg') throw fail('JXL_OPTIONS', `${named.toUpperCase()}: use 'exact'`);
  return named === 'linear';
}

export function gradient(picture, {stride = picture.width, origin = 0} = {}) {
  const {data, width, height, bitDepth, sampleFormat} = picture, linear = linearOf(picture);
  const float = data instanceof Float32Array, halves = sampleFormat === 'float16', wide = data instanceof Uint16Array;
  const depth = wide ? bitDepth ?? 16 : 8;
  if (wide && !halves && ![10, 12, 16].includes(depth))
    throw fail('JXL_INPUT', 'bitDepth: 10, 12 or 16');
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
  const acc = {sum: 0, n: 0};
  gradientRows(acc, data, width, height, 1, height, {table, stride, origin});
  return acc.n ? acc.sum / acc.n : 0;
}
const whole = new WeakMap();
const wholeTable = table => {
  if (table.length === 65536) return table;
  if (!whole.has(table)) { const full = new Float64Array(65536).fill(table[table.length - 1]); full.set(table); whole.set(table, full); }
  return whole.get(table);
};
function sweep(acc, data, width, height, from, to, stride, origin, row0, blocks, table) {
  const kind = !table ? 0 : data instanceof Float32Array ? 2 : data instanceof Uint16Array ? 1 : 3, T = data.constructor === Uint8ClampedArray ? Uint8Array : data.constructor;
  if (!kind && !(data instanceof Uint8Array || data instanceof Uint8ClampedArray)) throw fault('JXL_INTERNAL', 'intent-quality:depth');
  const columns = (width - 1) >> 3, sample = kind === 2 ? 4 : kind === 1 ? 2 : 1, pair = width * 8, pairBytes = pair * sample, band = Math.max(1, (4 << 20) / pairBytes | 0), rowSamples = stride * 4;
  const wordTable = kind ? wholeTable(table) : new Float64Array(1);
  let sums = Float64Array.of(acc.sum, acc.n, acc.chroma ?? 0, acc.clear ?? 0, acc.edge ?? 0, acc.leaves ?? (kind ? 0 : 0x7fff));
  let columnSums = blocks ? Float64Array.of(...blocks.sum, ...blocks.squares, ...blocks.steps) : new Float64Array(1);
  for (let y = from + ((1 - from) % 4 + 4) % 4, last = Math.min(to, height - 1); y < last;) {
    const top = y, pairs = Math.min(band, Math.ceil((last - y) / 4)), rows = {T, size: pairs * pair, bytes: pairs * pairBytes, put: into => {
      for (let j = 0; j < pairs; j++) {
        const at = (origin + (top + 4 * j - row0) * stride) * 4;
        into.set(data.subarray(at, at + width * 4), j * width * 8);
        into.set(data.subarray(at + rowSamples, at + rowSamples + width * 4), j * width * 8 + width * 4);
      }
    }};
    let values;
    [, sums, columnSums, values] = call(k => k.gradRows, [rows, width, pairs, (top & 7) === 5 ? 1 : 0, both(Float64Array, sums),
      both(Float64Array, columnSums), outUpTo(Float64Array, Math.ceil(pairs / 2 + 1) * columns * 2, n => n), room(width * 40), wordTable, kind]);
    for (let j = 0; j < values.length; j += 2) { blocks.spread[binOf(values[j])]++; blocks.slope[binOf(values[j + 1])]++; }
    y += 4 * pairs;
  }
  [acc.sum, acc.n, acc.chroma, acc.clear, acc.edge] = sums;
  if (!kind) acc.leaves = sums[5];
  if (blocks) { blocks.sum.set(columnSums.subarray(0, columns)); blocks.squares.set(columnSums.subarray(columns, 2 * columns)); blocks.steps.set(columnSums.subarray(2 * columns)); }
}
export function gradientRows(acc, data, width, height, from, to, {table = null, stride = width, origin = 0, row0 = 0} = {}) {
  const columns = (width - 1) >> 3;
  const blocks = columns ? acc.blocks ??= {sum: new Float64Array(columns), squares: new Float64Array(columns), steps: new Float64Array(columns),
    spread: new Uint32Array(BLOCK_BINS), slope: new Uint32Array(BLOCK_BINS)} : null;
  sweep(acc, data, width, height, from, to, stride, origin, row0, blocks, table);
}

export const exactlyPredicted = acc => !!acc.leaves && acc.n > 0;

const SOFT_STEP = 16;
export const softEdges = acc => acc.n > 0 && (acc.edge ?? Infinity) <= SOFT_STEP;
export function softPicture(data, width, height) {
  if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray) || width < 2 || height < 3) return false;
  const acc = {sum: 0, n: 0};
  gradientRows(acc, data, width, height, 1, height);
  return softEdges(acc);
}

const BLOCK_BINS = 128, BIN_LOW = -1, BIN_STEP = 0.05;
const binOf = v => Math.max(0, Math.min(BLOCK_BINS - 1, Math.floor((Math.log(v) - BIN_LOW) / BIN_STEP)));
function percentile(bins, total, p) {
  let below = 0, k = 0;
  const want = p * total;
  while (k < BLOCK_BINS - 1 && below + bins[k] < want) below += bins[k++];
  return BIN_LOW + (k + (bins[k] ? (want - below) / bins[k] : 0)) * BIN_STEP;
}
export function blockFacts(acc) {
  const blocks = acc.blocks, total = blocks ? blocks.spread.reduce((s, v) => s + v, 0) : 0;
  if (!total) return null;
  return {spread10: percentile(blocks.spread, total, 0.1), spread50: percentile(blocks.spread, total, 0.5),
    spread90: percentile(blocks.spread, total, 0.9), slope50: percentile(blocks.slope, total, 0.5), slope90: percentile(blocks.slope, total, 0.9)};
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

const tenths = (v, steps) => { const a = new Float64Array(steps.length + 1); a[0] = v / 10; for (let i = 0; i < steps.length; i++) { const c = steps.charCodeAt(i); v += c > 92 ? c - 36 : c - 35; a[i + 1] = v / 10; } return a; };
const CEILING = /* @__PURE__ */ tenths(690, "#-#-#-##-##-#-##-#-#-####----------#7#-----#-#-#");
const LOW_CEILING = /* @__PURE__ */ tenths(130, "7-7--7#--7-#7-7-7A7--A-7#--7A----##-#--#--#-#--#");
const ceilingAt = q => q < 50 ? LOW_CEILING[q - 1] : CEILING[q - 50];
export const ceilingFor = q => {
  if (q > 0.98) return Infinity;
  const at = Math.max(1, q * 100), lower = Math.min(98, Math.floor(at + 1e-9));
  const fraction = Math.max(0, at - lower), low = ceilingAt(lower);
  return fraction > 1e-9 ? low + (ceilingAt(Math.min(98, lower + 1)) - low) * fraction : low;
};

export const measuredNeed = (q, pixels = 0) => Math.max(CEILING[42], lookNeed(measuredLook(Math.min(q, 1)), pixels));

const LOOK_NEED_FROM = 85.8, LOOK_NEED_TOP = 92.6, FULL_FROM = 1280 * 1280, LOOK_NEED_FULL_TOP = 88.7;
const LOOK_NEED_FULL = [92.02, 92.24, 92.45, 92.66, 92.87, 93.13, 93.48, 93.82, 94.16, 94.5, 94.84, 95.08, 95.23, 95.37, 95.52, 95.67, 95.82, 95.96, 96.22, 96.52, 96.82, 97.08, 98.02, 98.24, 98.46, 99.08, 99.2, 99.35, 99.77, 99.86];
const LOOK_NEED = [92.1, 92.2, 92.3, 92.5, 92.6, 92.6, 92.7, 93, 93, 93, 93.1, 93.1, 93.2, 93.3, 93.4, 93.5, 93.6, 93.7, 93.9, 94, 94, 94.1, 94.2, 94.3, 94.4, 94.4, 94.6, 94.6, 95, 95, 95, 95, 95.2, 95.3, 95.7, 95.7, 96, 96, 96, 96.3, 96.5, 96.6, 96.6, 96.6, 96.9, 97.3, 97.3, 97.3, 97.4, 97.5, 97.8, 98.1, 98.2, 98.3, 98.5, 98.7, 98.8, 98.8, 99, 99.1, 99.2, 99.2, 99.25, 99.4, 99.5, 99.6, 99.7, 99.7, 99.9];
export const lookNeed = (look, pixels = 0) => {
  const full = pixels > FULL_FROM, table = full ? LOOK_NEED_FULL : LOOK_NEED;
  if (look > (full ? LOOK_NEED_FULL_TOP : LOOK_NEED_TOP) + 1e-9) return 100;
  return table[Math.min(table.length - 1, Math.max(0, Math.ceil((look - LOOK_NEED_FROM) * 10 - 1e-9)))];
};

const SMALL_TEXTURE = 25;
const SMOOTH_256 = [12, 14, 16, 17, 18, 19, 20, 21, 22, 23, 26, 27, 27.5, 28, 30, 32, 33, 35, 37, 38, 40, 42, 46, 47, 48, 49, 50, 50.5, 51, 52, 53, 56, 57, 58, 58.5, 58.5, 59, 59.5, 60, 61, 62, 63, 64, 64.5, 65, 66, 66.5, 67, 67.5, 68, 69, 69.5, 70, 70.5, 70.5, 70.5, 71, 72, 72.5, 72.5, 72.5, 73, 73.5, 73.5, 74, 75, 75.5, 76, 77, 77.5, 77.5, 77.5, 77.5, 77.5, 78, 78.5, 80, 80.5, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96, 96, 96.5, 97, 97, 97];
const TINY_STEP = {
  24: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 12, 12, 13, 13, 13, 14, 14, 14, 15, 16, 19, 19, 19, 22, 22, 22, 26, 27, 29, 29, 30, 30, 37, 37, 37, 40, 44, 46, 47, 49, 49, 49, 50, 53, 55, 55, 55, 58, 59, 59, 62, 62, 64, 67, 70, 73, 73, 74, 75, 76, 80, 81, 82, 83, 86, 87, 88, 90, 91, 92, 93, 94, 95, 95, 96, 97],
  32: [45, 51, 54, 58, 59, 61, 65, 66, 67, 68, 69, 69, 71, 72, 73, 74, 74, 75, 76, 76, 76, 77, 78, 79, 79, 79, 80, 81, 81, 82, 82, 82, 82, 83, 84, 84, 84, 84, 84, 85, 85, 86, 86, 86, 86, 86, 87, 87, 87, 88, 88, 88, 88, 88, 88, 89, 89, 89, 89, 89, 89, 89, 90, 90, 90, 90, 90, 90, 91, 91, 91, 91, 91, 91, 91, 92, 92, 93, 93, 93, 94, 94, 94, 95, 95, 95, 96, 96, 97, 97, 98, 98, 98, 98, 99, 99, 99, 99, 100],
  64: [47, 52, 57, 59, 62, 64, 67, 68, 70, 71, 72, 73, 74, 75, 75, 76, 76, 77, 77, 77, 78, 78, 79, 79, 80, 80, 81, 81, 82, 83, 83, 83, 84, 84, 84, 84, 85, 85, 85, 85, 85, 86, 86, 86, 87, 87, 88, 88, 88, 88, 89, 89, 89, 89, 89, 89, 90, 90, 90, 90, 90, 90, 91, 91, 91, 91, 92, 92, 92, 92, 92, 92, 92, 92, 93, 93, 93, 94, 94, 94, 95, 95, 95, 96, 96, 96, 97, 97, 97, 98, 98, 99, 99, 99, 99, 99, 99.5, 99.5, 99.5],
  128: [1, 2, 13, 15, 17, 17, 20, 20, 22, 23, 24, 24, 26, 27, 28, 29, 29, 31, 35, 37, 38, 39, 42, 43, 46, 47, 47, 48, 50, 51, 53, 54, 55, 56, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 67.5, 68, 69, 70, 71, 71.5, 71.5, 72, 73, 73, 73, 73, 74, 74.5, 74.5, 74.5, 75, 76, 76.5, 76.5, 76.5, 77, 77.5, 77.5, 78, 79, 79.5, 79.5, 79.5, 80, 82, 83, 84, 85, 85.5, 86, 87, 88, 89, 89.5, 90, 91, 91.5, 92, 92.5, 93, 93, 94, 94.5, 95, 96, 97, 98],
  256: [13, 15, 16, 18, 19, 20, 22, 23, 24, 25, 26, 28, 28, 30, 34, 36, 36, 38, 42, 43, 45, 45, 47, 48, 51, 51, 52, 54, 55, 56, 57, 58, 59, 60, 60, 60, 61, 62, 63, 63, 64, 65, 66, 66, 67, 67, 68, 68, 68, 69, 70, 70, 71, 71, 71, 72, 72, 72, 73, 73, 73, 74, 74, 74, 75, 75, 75.5, 76, 77, 77.5, 77.5, 77.5, 78, 78, 79, 80, 81, 81, 82, 83, 84, 86, 87, 88, 89, 90, 91, 92, 92, 93, 94, 95, 95, 96, 96, 96.5, 97, 97, 97],
};
export const smallReading = (q, side, gradient = Infinity) => {
  const row = side < 24 ? TINY_STEP[24] : side < 32 ? TINY_STEP[32] : side < 64 ? TINY_STEP[64] : side < 128 ? TINY_STEP[128] :
    side < 256 ? gradient < SMALL_TEXTURE ? SMOOTH_256 : TINY_STEP[256] : null;
  if (!row) return Infinity;
  if (q >= 1) return 100;
  if (!(q > 0)) return row[0];
  const x = Math.max(1, q * 100);
  if (x >= 99) return row[98] >= 100 ? 100 : row[98] + (99.99 - row[98]) * Math.min(1, x - 99);
  const lower = Math.floor(x + 1e-9);
  const frac = Math.max(0, x - lower);
  return row[lower - 1] + (row[lower] - row[lower - 1]) * frac;
};

export const qualityForIntent = (q, picture) => q >= 1 ? (linearOf(picture), 100) : qualityFor(q, gradient(picture));

export function settleIntent(codec, picture) {
  if (codec.qualityIntent === undefined) return codec;
  const {qualityIntent, ...rest} = codec;
  return {...rest, quality: qualityForIntent(qualityIntent, picture)};
}

const BUMPS = [[0.8, [[100, 8], [250, 6], [Infinity, 3]]], [0.92, [[100, 4], [250, 3], [Infinity, 2]]]];

const OFF_GRID = [2, 1];

export function regionQuality(q, data, width, rect, offGrid = false) {
  if (q >= 1) return 100;
  const side = Math.min(rect.width, rect.height), step = rows => rows.find(([under]) => side < under)[1];
  const lo = BUMPS[0], hi = BUMPS[1], t = Math.min(1, Math.max(0, (q - lo[0]) / (hi[0] - lo[0])));
  return Math.min(99, Math.max(1, Math.round(fixedReading(q) + step(lo[1]) + t * (step(hi[1]) - step(lo[1])) + (offGrid ? OFF_GRID[0] + t * (OFF_GRID[1] - OFF_GRID[0]) : 0))));
}

const fixedReading = intent => { const q = intent * 100; return q >= 76 ? q - 3 : q >= 68 ? q - (q - 68) * 3 / 8 : q >= 60 ? q + (68 - q) / 2 : q + 4; };
export const fixedQuality = webp => Math.max(1, Math.min(99, Math.round(fixedReading(webp))));

export const intentCoding = intent => ({quality: fixedQuality(intent), regionQuality: (data, width, rect, offGrid) => regionQuality(intent, data, width, rect, offGrid), readingIntent: intent});

