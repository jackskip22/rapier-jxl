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
      if (width === stride) for (let j = 0; j < pairs; j++) {
        const at = (origin + (top + 4 * j - row0) * width) * 4;
        into.set(data.subarray(at, at + pair), j * pair);
      } else for (let j = 0; j < pairs; j++) {
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

const tenths = (v, s, d = 10) => { const out = [v / d]; for (let i = 0; i < s.length; i++) { let a = 0, c; while ((c = s.charCodeAt(i)) === 126) { a += 89; i++; } v += a + (c > 92 ? c - 36 : c - 35); out.push(v / d); } return Float64Array.from(out); };
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
const LOOK_NEED_FULL = /* @__PURE__ */ tenths(9202, "9888=FEEEE;212221=AA=~(99b/2M,", 100);
const LOOK_NEED = /* @__PURE__ */ tenths(1842, "%%'%#%)##%#%%%%%%'%#%%%%#'#+###'%+#)##)'%##)+##%%))%%''%#'%%#$&%%%#'", 20);
export const lookNeed = (look, pixels = 0) => {
  const full = pixels > FULL_FROM, table = full ? LOOK_NEED_FULL : LOOK_NEED;
  if (look > (full ? LOOK_NEED_FULL_TOP : LOOK_NEED_TOP) + 1e-9) return 100;
  return table[Math.min(table.length - 1, Math.max(0, Math.ceil((look - LOOK_NEED_FROM) * 10 - 1e-9)))];
};

const SMALL_TEXTURE = 25;
const SMOOTH_256 = /* @__PURE__ */ tenths(24, "''%%%%%%%)%$$''%''%''+%%%%$$%%)%%$#$$$%%%%$$%$$$$%$$$##$%$##$$#$%$$%$####$$&$$%%%%%%%%%%%%%%%#$$##", 2);
const TINY_STEP = /* @__PURE__ */ {
  24: tenths(1, "################################.#$##$##$$&##&##'$%#$#*##&'%$%##$&%##&$#&#%&&&#$$$'$$$&$$%$$$$$#$$", 1),
  32: tenths(45, ")&'$%'$$$$#%$$$#$$##$$$##$$#$###$$####$#$####$##$#####$######$#####$######$#$##$##$##$#$#$###$###$", 1),
  64: tenths(94, "--')')%'%%%%%#%#%##%#%#%#%#%%##%###%####%##%#%###%#####%#####%###%#######%##%##%##%##%##%#%####$##", 2),
  128: tenths(2, "%9''#)#'%%#'%%%#'+'%%)%)%#%'%'%%%#%%%%%%%%%%%$$%%%$#$%###%$##$%$##$$#$%$##$'%%%$$%%%$$%$$$$#%$$%%%", 2),
  256: tenths(26, "'%'%%'%%%%'#'+'#'+%'#'%)#%'%%%%%%##%%%#%%%#%#%##%%#%##%##%##%##%#$$%$##$#%%%#%%%'%%%%%%#%%%#%#$$##", 2),
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

