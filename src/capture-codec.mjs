// SPDX-License-Identifier: MIT
import {BitWriter, complete, packSigned} from './bits.mjs';
import {admitOptions, admitPixels, admitOutputSize, fault, job} from './admit.mjs';
import {SCREEN_INTEGER_CONFIGS, screenDistanceMap} from './screen-codes.mjs';
import {writeHeaderFields, writeModularFrameHeader, groupLayout, groupRect, assembleCodestream} from './frame.mjs';
import {pixelKeys, screenColumns, screenCrop, screenRegions, writeScreenBackground} from './screen-crop.mjs';
import {LZ77, leaf, split, writeTree, writeModularHeader} from './modular.mjs';
import {WEIGHTED_PREDICTOR, WEIGHTED_PROPERTY} from './weighted-policy.mjs';
import {captureCopies, captureHold, captureRelease, captureLiterals, capturePieceCounts, capturePrices, LOG_MANTISSA, captureResiduals, captureScan, treeArena, captureWeightedPieces, compileCaptureKernels, requireCaptureKernels, WEIGHTED_BANDS, WEIGHTED_CONTEXT} from './capture-kernels.mjs';
import {buildCode, canonicalCodes, compactCode, hybridToken, prefixCodeBits, uintConfig, writeHistograms, writeUintConfig} from './prefix.mjs';

const DIM = 1024, PALETTE_LIMIT = 16384, RARE_PALETTE = 8192;

export {compileCaptureKernels};
export const CAPTURE_PREDICTOR_PROBE = Symbol('capture predictor choices');
export const CAPTURE_BASE = Symbol('capture base layer');

function scanColours(rgba, stride, x0, y0, w, h, limit, rows = false) {
  limit = Math.min(limit, w * h);
  const fast = captureScan(pixelKeys(rgba), stride, x0, y0, w, h, limit, rows);
  return fast === undefined ? scanColoursScript(rgba, stride, x0, y0, w, h, limit, rows) : fast;
}
export function scanColoursScript(rgba, stride, x0, y0, w, h, limit, rows = false) {
  let size = 1024;
  while (size < limit * 2) size <<= 1;
  const keys = new Uint32Array(size), slots = new Uint16Array(size), shift = Math.clz32(size) + 1, mask = size - 1;
  const colours = new Uint32Array(limit), indices = new Uint16Array(w * h), words = pixelKeys(rgba);
  const first = rows ? new Int32Array(limit) : null, last = rows ? new Int32Array(limit) : null;
  let n = 0, previous = -1, lastIndex = 0;
  for (let i = 0, x = 0, y = 0, p = y0 * stride + x0, size = w * h; i < size; i++, x++, p++) {
    if (x === w) { x = 0; y++; p += stride - w; if (rows) previous = -1; }
    const key = words[p];
    if (key === previous) { indices[i] = lastIndex; continue; }
    if (i >= w && key === words[p - stride]) {
      indices[i] = lastIndex = indices[i - w]; previous = key;
      if (rows) last[lastIndex] = y;
      continue;
    }
    let slot = Math.imul(key, 0x9e3779b1) >>> shift;
    while (slots[slot] && keys[slot] !== key) slot = (slot + 1) & mask;
    if (!slots[slot]) {
      if (n === limit) return null;
      keys[slot] = key; colours[n] = key; slots[slot] = ++n;
      if (rows) first[n - 1] = y;
    }
    indices[i] = lastIndex = slots[slot] - 1; previous = key;
    if (rows) last[lastIndex] = y;
  }
  return {colours: colours.subarray(0, n), indices, first: first?.subarray(0, n), last: last?.subarray(0, n)};
}

const rgbaKey = c => ((c & 255) << 24 | (c >>> 8 & 255) << 16 | (c >>> 16 & 255) << 8 | c >>> 24) >>> 0;
function paletteModel(colours, models, shape, minimum) {
  const n = colours.length, uses = captureLiterals(models, n), common = [];
  let rare = 0;
  for (let i = 0; i < n; i++) if (uses[i] >= 16) common.push(i); else if (uses[i]) rare++;
  common.sort((a, b) => uses[b] - uses[a] || colours[a] - colours[b]);
  for (let lo = 4; lo < common.length; lo *= 2) {
    const hi = Math.min(common.length, lo * 2), slice = common.slice(lo, hi).sort((a, b) => rgbaKey(colours[a]) - rgbaKey(colours[b]));
    for (let j = lo; j < hi; j++) common[j] = slice[j - lo];
  }
  const keys = new Float64Array(rare);
  for (let i = 0, j = 0; i < n; i++) if (uses[i] && uses[i] < 16) {
    const c = colours[i];
    keys[j++] = rgbaKey(c) * 65536 + i;
  }
  keys.sort();
  const order = new Int32Array(common.length + rare), sorted = new Uint32Array(order.length), remap = new Int32Array(n);
  order.set(common);
  for (let j = 0; j < rare; j++) order[common.length + j] = keys[j] % 65536;
  for (let j = 0; j < order.length; j++) { sorted[j] = colours[order[j]]; remap[order[j]] = j; }
  const meta = paletteMeta(sorted, shape), model = channelModel(meta.plane, meta.width, meta.height, 'rows');
  captureLiterals(models, n, remap);
  for (const m of models) if (!m.group) learnContexts(m, remap, common.length, order.length);
  return {meta, model};
}

const TREE_TOKENS = 128, TREE_SPLIT = 96, TREE_MIN = 128, TREE_NODES = 48;
let nlog = new Float64Array(0);
function nlogTable(n) {
  if (nlog.length <= n) {
    const table = new Float64Array(Math.max(n + 1, 2 * nlog.length));
    table.set(nlog);
    for (let k = Math.max(1, nlog.length); k < table.length; k++) table[k] = k * log2x32(k);
    nlog = table;
  }
  return nlog;
}

const sampleToken = v => {
  if (v < 16) return v;
  const e = 31 - Math.clz32(v);
  return 16 + ((e - 4) << 2 | (v >> (e - 1) & 1) << 1 | v & 1);
};

function learnContexts(model, remap, common, total) {
  const w = model.width, plane = model.plane, count = model.count, h = model.height;
  const indexCuts = [];
  for (let a = 0, b = 1; a < common - 1; [a, b] = [b, a + b]) if (!indexCuts.includes(a)) indexCuts.push(a);
  if (common) indexCuts.push(common - 1);
  for (let k = 1; k < 4; k++) { const c = common + Math.floor((total - common) * k / 4) - 1; if (c > (indexCuts[indexCuts.length - 1] ?? -1)) indexCuts.push(c); }
  const spread = n => { const cuts = []; for (let k = 1; k < 16; k++) { const c = Math.floor(n * k / 16) - 1; if (c > (cuts[cuts.length - 1] ?? -1)) cuts.push(c); } return cuts; };
  const cuts = [spread(h), spread(w), indexCuts, indexCuts];
  const binsOf = (list, n) => { const bins = new Uint8Array(n); for (let v = 0, b = 0; v < n; v++) { while (b < list.length && v > list[b]) b++; bins[v] = b; } return bins; };
  const yBin = binsOf(cuts[0], h), xBin = binsOf(cuts[1], w), indexBin = binsOf(indexCuts, total), binOf = new Uint8Array(remap.length);
  for (let i = 0; i < remap.length; i++) binOf[i] = indexBin[remap[i]];
  const span = (Math.max(...cuts.map(c => c.length)) + 1) * TREE_TOKENS, arena = treeArena(count, span), {by, bx, bw, bn, tokens, order} = arena;
  pieceBins(plane, model.stride, model.origin, w, model.pieceValue, model.pieceDistance, model.minimum, count, yBin, xBin, binOf, tokens, by, bx, bw, bn, order);
  const s = {cuts, order, nlog: nlogTable(count), context: model.pieceContext, all: arena.all, counts: arena.counts,
    tally: arena.tally, part: arena.part, low: new Uint32Array(TREE_TOKENS), used: new Uint8Array(TREE_TOKENS),
    span, leaves: [], nodes: 0, split: TREE_SPLIT, min: TREE_MIN, most: TREE_NODES, cut: 0};
  model.tree = treeNode(s, 0, count);
  model.leaves = s.leaves; model.classes = s.leaves.length;
}

function pieceBins(plane, stride, origin, w, pieceValue, pieceDistance, minimum, count, yBin, xBin, binOf, tokens, by, bx, bw, bn, order) {
  for (let k = 0, x = 0, y = 0, at = origin; k < count; k++) {
    const west = x ? plane[at - 1] : y ? plane[at - stride] : -1, north = y ? plane[at - stride] : west;
    const d = pieceDistance[k], value = d ? Math.min(pieceValue[k], 16383) : pieceValue[k];
    tokens[k] = (d ? 64 : 0) + Math.min(sampleToken(value), 63);
    by[k] = yBin[y]; bx[k] = xBin[x]; bw[k] = west < 0 ? 0 : binOf[west]; bn[k] = north < 0 ? 0 : binOf[north];
    order[k] = k;
    x += d ? pieceValue[k] + minimum : 1;
    while (x >= w) { x -= w; y++; }
    at = origin + y * stride + x;
  }
}

const TREE_PROPERTY = [2, 3, 7, 6];
function treeNode(s, from, to) {
  const {all, used, order, nlog} = s, size = to - from;
  s.nodes++;
  const splits = size >= s.min && s.nodes + 2 <= s.most;
  s.tally(from, to, splits);
  let sum = 0, kinds = 0;
  for (let t = 0; t < TREE_TOKENS; t++) if (all[t]) { sum += nlog[all[t]]; used[kinds++] = t; }
  let gain = 32 * s.split, property = -1, cut = 0;
  if (splits) {
    const here = nlog[size] - sum + 160 * kinds;
    for (let p = 0; p < 4; p++) {
      const found = bestCut(s, p, size, here, sum, kinds);
      if (found > gain) { gain = found; property = p; cut = s.cut; }
    }
  }
  if (property < 0) {
    const node = leaf(0);
    node.local = s.leaves.length; s.leaves.push(node);
    for (let i = from; i < to; i++) s.context[order[i]] = node.local;
    return node;
  }
  const a = s.part(from, to, property, cut);
  const node = split(TREE_PROPERTY[property], s.cuts[property][cut], null, null);
  node.left = treeNode(s, from, a); node.right = treeNode(s, a, to);
  return node;
}

function bestCut(s, p, size, here, sum, kinds) {
  const {counts, low, all, used, nlog} = s, n = s.cuts[p].length + 1, offset = p * s.span;
  for (let u = 0; u < kinds; u++) low[used[u]] = 0;
  let best = 0, sumLow = 0, kindsLow = 0, sumHigh = sum, kindsHigh = kinds, lowSize = 0;
  for (let c = 0; c + 1 < n; c++) {
    const base = offset + c * TREE_TOKENS;
    let moved = 0;
    for (let u = 0; u < kinds; u++) {
      const t = used[u], v = counts[base + t];
      if (!v) continue;
      const a = low[t], b = all[t] - a;
      sumLow += nlog[a + v] - nlog[a]; if (!a) kindsLow++;
      sumHigh += nlog[b - v] - nlog[b]; if (b === v) kindsHigh--;
      low[t] = a + v; moved += v;
    }
    if (!moved) continue;
    lowSize += moved;
    if (lowSize === size) break;
    const saving = here - (nlog[lowSize] - sumLow + 160 * kindsLow + nlog[size - lowSize] - sumHigh + 160 * kindsHigh);
    if (saving > best) { best = saving; s.cut = c; }
  }
  return best;
}

function paletteMeta(colours, shape) {
  const n = colours.length, channels = shape.channels, rows = new Int32Array(n * channels);
  for (let c = 0; c < channels; c++) for (let i = 0; i < n; i++)
    rows[c * n + i] = (colours[i] >>> (8 * (shape.colour === 1 && c === 1 ? 3 : c))) & 255;
  return {plane: rows, width: n, height: channels, transform: {type: 'palette', beginC: 0, numC: channels, nbColors: n}};
}

const SMOOTH_CUTS = [-13, -3, -1, 0, 2, 12], SMOOTH_LEVEL = [3, 2, 1, 0, 1, 2, 3], RANGE = 32768;
const SMOOTH = new Uint8Array(2 * RANGE);
for (let v = -RANGE, k = 0; v < RANGE; v++) {
  while (k < SMOOTH_CUTS.length && v > SMOOTH_CUTS[k]) k++;
  SMOOTH[v + RANGE] = SMOOTH_LEVEL[k];
}

const upTo = n => Array.from({length: n}, (_, k) => k);
function intervals(property, cuts, child) {
  const build = (lo, hi) => {
    if (lo === hi) return child(lo);
    const mid = (lo + hi) >> 1;
    return split(property, cuts[mid], build(mid + 1, hi), build(lo, mid));
  };
  return build(0, cuts.length);
}

function predictSmooth(plane, w, h, values, contexts, step) {
  const bound = (step - 1) >> 1;
  for (let i = 0, x = 0, y = 0, size = w * h; i < size; i++, x++) {
    if (x === w) { x = 0; y++; }
    const west = x ? plane[i - 1] : y ? plane[i - w] : 0, north = y ? plane[i - w] : west,
      northWest = x && y ? plane[i - w - 1] : west;
    const low = west < north ? west : north, high = west < north ? north : west, gradient = west + north - northWest;
    const prediction = gradient < low ? low : gradient > high ? high : gradient;
    let residual = plane[i] - prediction;
    if (step > 1) {
      residual = residual >= 0 ? (residual + bound) / step | 0 : -((bound - residual) / step | 0);
      plane[i] = prediction + residual * step;
    }
    values[i] = packSigned(residual);
    contexts[i] = SMOOTH[west - northWest + RANGE] * 4 + SMOOTH[northWest - north + RANGE];
  }
}

const SAMPLE_TOKENS = 128;
function sampleCost(counts, totals, rawBits) {
  let bits = rawBits;
  for (let c = 0; c < totals.length; c++) {
    const n = totals[c];
    if (!n) continue;
    const bins = counts.subarray(c * SAMPLE_TOKENS, (c + 1) * SAMPLE_TOKENS);
    let kinds = 0;
    for (let k = 0; k < bins.length; k++) if (bins[k]) kinds++;
    bits += entropy(bins, n) + 5 * kinds;
  }
  return bits;
}
function useWeighted(plane, w, h) {
  if (w * h < 4096 || h < 8) return true;
  const rows = Math.min(8, h), last = h - rows;
  const positions = [0, Math.floor(last / 3), Math.floor(2 * last / 3), last];
  const residuals = new Uint32Array(w * rows), properties = new Int32Array(w * rows);
  const smoothCounts = new Uint32Array(16 * SAMPLE_TOKENS), weightedCounts = new Uint32Array(18 * SAMPLE_TOKENS);
  const smoothTotals = new Uint32Array(16), weightedTotals = new Uint32Array(18);
  let smoothRaw = 0, weightedRaw = 0, previous = -1;
  for (const y0 of positions) {
    if (y0 === previous) continue;
    previous = y0;
    const strip = plane.subarray(y0 * w, (y0 + rows) * w);
    captureResiduals(strip, w, rows, residuals, properties);
    for (let i = 2 * w, x = 0, end = rows * w; i < end; i++, x++) {
      if (x === w) x = 0;
      const west = x ? strip[i - 1] : strip[i - w], north = strip[i - w], northWest = x ? strip[i - w - 1] : west;
      const low = west < north ? west : north, high = west < north ? north : west, guess = west + north - northWest;
      const prediction = guess < low ? low : guess > high ? high : guess;
      const smooth = packSigned(strip[i] - prediction);
      const sc = SMOOTH[west - northWest + RANGE] * 4 + SMOOTH[northWest - north + RANGE];
      smoothCounts[sc * SAMPLE_TOKENS + sampleToken(smooth)]++; smoothTotals[sc]++;
      if (smooth >= 16) smoothRaw += 29 - Math.clz32(smooth);
      const e = properties[i], wc = WEIGHTED_CONTEXT[e < -255 ? 0 : e > 255 ? 510 : e + 255], wr = residuals[i];
      weightedCounts[wc * SAMPLE_TOKENS + sampleToken(wr)]++; weightedTotals[wc]++;
      if (wr >= 16) weightedRaw += 29 - Math.clz32(wr);
    }
  }
  return sampleCost(weightedCounts, weightedTotals, weightedRaw) <= sampleCost(smoothCounts, smoothTotals, smoothRaw);
}

function smoothTree(leaves, step) {
  return intervals(10, SMOOTH_CUTS, a => intervals(11, SMOOTH_CUTS, b => {
    const node = leaf(5, 0, step);
    node.local = SMOOTH_LEVEL[a] * 4 + SMOOTH_LEVEL[b]; leaves.push(node);
    return node;
  }));
}

const SPATIAL = new Map();
function spatialLookup(width) {
  let entry = SPATIAL.get(width);
  if (!entry) {
    const map = screenDistanceMap(width), max = Math.max(...map.keys()) + 1;
    const flags = new Uint8Array(max), codes = new Int16Array(max).fill(-1);
    for (const [d, code] of map) { flags[d] = code < 2 ? 1 : code < 12 ? 3 : code < 32 ? 5 : 7; codes[d] = code; }
    if (SPATIAL.size > 64) SPATIAL.clear();
    SPATIAL.set(width, entry = [flags, codes]);
  }
  return entry;
}

function channelModel(plane, w, h, kind, step = 1, minimum = 3, weighted = true, stride = w, origin = 0) {
  if (kind === 'smooth') {
    const v0 = plane[0]; let constant = true;
    for (let i = 1; i < plane.length; i++) if (plane[i] !== v0) { constant = false; break; }
    if (constant) {
      const tree = leaf(0, v0); tree.local = 0;
      return {kind, tree, leaves: [tree], classes: 1, width: w, plane, minimum, count: 1, pieceValue: Int32Array.of(0), pieceDistance: Int32Array.of(0), pieceContext: Uint8Array.of(0)};
    }
  }
  if (kind === 'smooth' && step === 1 && weighted) {
    const leaves = [], tree = intervals(WEIGHTED_PROPERTY, WEIGHTED_BANDS, band => { const node = leaf(WEIGHTED_PREDICTOR); node.local = band; leaves.push(node); return node; });
    const {count, value, distance, context} = captureWeightedPieces(plane, w, h, minimum);
    return {kind, tree, leaves, classes: WEIGHTED_BANDS.length + 1, width: w, plane, minimum, count, pieceValue: value, pieceDistance: distance, pieceContext: context};
  }
  const n = w * h, values = kind === 'index' ? plane : kind === 'rows' ? new Int32Array(n) : new Uint16Array(n);
  const contexts = kind === 'index' ? null : new Uint8Array(n), leaves = [], scale = kind === 'index' ? 2 : 1;
  let tree, classes = 1;
  if (kind === 'index') {
    tree = leaf(0);
  } else if (kind === 'rows') {
    classes = 3 * h;
    const byNorth = new Int32Array(n), byGradient = new Int32Array(n), counts = new Uint32Array(3 * classes * 512);
    for (let i = 0, x = 0, row = 0; i < n; i++, x++) {
      if (x === w) { x = 0; row++; }
      const west = x ? plane[i - 1] : row ? plane[i - w] : 0, north = row ? plane[i - w] : west, northWest = x && row ? plane[i - w - 1] : west;
      const gradient = Math.max(Math.min(west, north), Math.min(Math.max(west, north), west + north - northWest));
      const change = Math.abs(northWest - north), context = contexts[i] = row * 3 + (change ? change <= 8 ? 1 : 2 : 0);
      const at = context * 512, value = plane[i];
      counts[at + (values[i] = packSigned(value - west))]++;
      counts[classes * 512 + at + (byNorth[i] = packSigned(value - north))]++;
      counts[2 * classes * 512 + at + (byGradient[i] = packSigned(value - gradient))]++;
    }
    const chosen = new Uint8Array(classes);
    for (let c = 0; c < classes; c++) for (let p = 0, least = Infinity; p < 3; p++) {
      const freqs = counts.subarray((p * classes + c) * 512, (p * classes + c + 1) * 512);
      let total = 0, used = 0;
      for (let v = 0; v < 512; v++) if (freqs[v]) { total += freqs[v]; used++; }
      const bits = total ? entropy(freqs, total) + 5 * used : 0;
      if (bits < least) { least = bits; chosen[c] = p; }
    }
    for (let i = 0; i < n; i++) { const p = chosen[contexts[i]]; if (p) values[i] = p === 1 ? byNorth[i] : byGradient[i]; }
    const node = local => { const l = leaf([1, 2, 5][chosen[local]]); l.local = local; leaves.push(l); return l; };
    tree = intervals(2, upTo(h - 1), row => row ? split(11, 8, node(row * 3 + 2),
      split(11, 0, node(row * 3 + 1), split(11, -1, node(row * 3), split(11, -9, node(row * 3 + 1), node(row * 3 + 2))))) : node(0));
  } else { predictSmooth(plane, w, h, values, contexts, step); tree = smoothTree(leaves, step); classes = 16; }
  if (classes === 1) { tree.local = 0; leaves.push(tree); }
  const {count, value: pieceValue, distance: pieceDistance, context: pieceContext} = kind === 'rows'
    ? {count: n, value: values, distance: new Int32Array(n), context: contexts}
    : captureCopies(values, stride, origin, w, h, contexts, kind === 'index' ? 24 : 0, minimum, scale, spatialLookup(w)[0]);
  return {kind, tree, leaves, classes, width: w, height: h, stride, origin, plane, minimum, count, pieceValue, pieceDistance, pieceContext};
}

const LITERAL_CONFIGS = [...SCREEN_INTEGER_CONFIGS, ...[[4, 2, 1], [5, 1, 1], [5, 2, 1], [6, 1, 1], [6, 2, 1], [7, 2, 1], [5], [6], [7], [8], [9], [10], [11], [12], [13]].map(a => uintConfig(...a))];
const SMALL = 2048;
const log2x32 = x => {
  const e = 31 - Math.clz32(x);
  return 32 * e + LOG_MANTISSA[(e >= 5 ? x >>> e - 5 : x << 5 - e) & 31];
};
const entropy = (freqs, total) => {
  let bits = 0;
  const whole = log2x32(total);
  for (const n of freqs) if (n) bits += n * (whole - log2x32(n));
  return bits / 32;
};

const DISTANCE_TOKENS = 1 << 15;
const FREQS = new Uint32Array(DISTANCE_TOKENS), USED = new Uint16Array(DISTANCE_TOKENS);
let usedLen = 0;

function clearFreqs() {
  for (let i = 0; i < usedLen; i++) FREQS[USED[i]] = 0;
  usedLen = 0;
}

function valueCounts(small, large) {
  let size = large.values.length;
  for (let v = 0; v < SMALL; v++) if (small[v]) size++;
  const values = new Int32Array(size), counts = new Uint32Array(size);
  let i = 0;
  for (let v = 0; v < SMALL; v++) if (small[v]) { values[i] = v; counts[i++] = small[v]; }
  values.set(large.values, i); counts.set(large.counts, i);
  return {values, counts};
}
function mapCounts(map) {
  const values = new Int32Array(map.size), counts = new Uint32Array(map.size);
  let i = 0;
  for (const [v, n] of map) { values[i] = v; counts[i++] = n; }
  return {values, counts};
}
const NO_COUNTS = {values: new Int32Array(0), counts: new Uint32Array(0)};
const KEY = 1 << 20;
let radixScratch = new Uint32Array(0);
const radixCounts = new Uint32Array(2048);
function radixSort(keys) {
  if (radixScratch.length < keys.length) radixScratch = new Uint32Array(keys.length);
  let from = keys, to = radixScratch.subarray(0, keys.length);
  for (let shift = 0; shift < 32; shift += 11) {
    radixCounts.fill(0);
    for (let i = 0; i < from.length; i++) radixCounts[from[i] >>> shift & 2047]++;
    if (radixCounts[from[0] >>> shift & 2047] === from.length) continue;
    for (let b = 0, sum = 0; b < 2048; b++) { const c = radixCounts[b]; radixCounts[b] = sum; sum += c; }
    for (let i = 0; i < from.length; i++) { const key = from[i]; to[radixCounts[key >>> shift & 2047]++] = key; }
    [from, to] = [to, from];
  }
  if (from !== keys) keys.set(from);
}
function countKeys(sorted, histograms, field) {
  radixSort(sorted);
  for (let i = 0; i < sorted.length;) {
    const h = Math.floor(sorted[i] / KEY), end = h * KEY + KEY;
    let j = i, distinct = 0;
    while (j < sorted.length && sorted[j] < end) { const key = sorted[j]; distinct++; while (j < sorted.length && sorted[j] === key) j++; }
    const values = new Int32Array(distinct), counts = new Uint32Array(distinct);
    for (let k = 0; i < j; k++) { const key = sorted[i], from = i; while (i < j && sorted[i] === key) i++; values[k] = key - h * KEY; counts[k] = i - from; }
    histograms[h][field] = {values, counts};
  }
}
function mergeCounts(a, b) {
  if (!b.values.length) return a;
  if (!a.values.length) return b;
  const values = [], counts = [];
  for (let i = 0, j = 0; i < a.values.length || j < b.values.length;) {
    const va = i < a.values.length ? a.values[i] : Infinity, vb = j < b.values.length ? b.values[j] : Infinity;
    if (va === vb) { values.push(va); counts.push(a.counts[i++] + b.counts[j++]); }
    else if (va < vb) { values.push(va); counts.push(a.counts[i++]); }
    else { values.push(vb); counts.push(b.counts[j++]); }
  }
  return {values: Int32Array.from(values), counts: Uint32Array.from(counts)};
}
function sortedCode(freqs) {
  const used = [];
  for (let i = 0; i < freqs.length; i++) if (freqs[i]) used.push(i);
  const code = compactCode(freqs, used);
  code.codes = canonicalCodes(code.lengths);
  return code;
}
const WIDE_DISTANCES = [[8, 4, 4], [10, 4, 3], [10, 5, 4], [10, 5, 5], [12, 5, 5], [12, 6, 5], [12, 6, 6], [13, 6, 6], [14, 6, 6], [14, 7, 7]].map(a => uintConfig(...a));
const DISTANCE_CONFIGS = [...SCREEN_INTEGER_CONFIGS, ...WIDE_DISTANCES];
function distanceTokens(config, values) {
  clearFreqs();
  const token = [0, 0, 0];
  let raw = 0, top = 0, total = 0, uLen = 0;
  for (let i = 0; i < values.values.length; i++) {
    const v = values.values[i], n = values.counts[i];
    hybridToken(config, v, token);
    const s = token[0];
    if (s >= DISTANCE_TOKENS) { usedLen = uLen; return null; }
    if (!FREQS[s]) USED[uLen++] = s;
    FREQS[s] += n; raw += token[1] * n; total += n;
    if (s > top) top = s;
  }
  usedLen = uLen;
  return {raw, total, top};
}
function distancePrice(config, values) {
  const {raw} = distanceTokens(config, values), header = new BitWriter(16);
  writeUintConfig(header, config, 15);
  return raw + header.bitLength + prefixCodeBits(FREQS, USED.subarray(0, usedLen).sort());
}
function distanceCode(config, values) {
  const {top} = distanceTokens(config, values);
  return compactCode(FREQS, USED.subarray(0, usedLen).sort());
}

const CLUSTER_CONFIG = uintConfig(4, 1, 1), CLUSTER_TOKENS = 128, CLUSTER_HEADER = 48;
function clusterCost(freqs) {
  let total = 0, used = 0;
  for (let i = 0; i < CLUSTER_TOKENS; i++) if (freqs[i]) { total += freqs[i]; used++; }
  return total ? entropy(freqs, total) + 5 * used + CLUSTER_HEADER : 0;
}
function countTokens(freqs, h, config, lengthConfig, at, top) {
  const token = [0, 0, 0], add = (c, v, n, from) => { hybridToken(c, v, token); freqs[from + Math.min(token[0], top)] += n; };
  for (let v = 0; v < SMALL; v++) if (h.small[v]) add(config, v, h.small[v], 0);
  for (let i = 0; i < h.large.values.length; i++) add(config, h.large.values[i], h.large.counts[i], 0);
  for (let i = 0; i < h.lengths.values.length; i++) add(lengthConfig, h.lengths.values[i], h.lengths.counts[i], at);
  return freqs;
}
function clusterHistograms(live) {
  const n = live.length, freqs = live.map(h => countTokens(new Uint32Array(CLUSTER_TOKENS), h, CLUSTER_CONFIG, CLUSTER_CONFIG, 64, 63));
  const cost = freqs.map(clusterCost), alive = new Uint8Array(n).fill(1), parent = Int32Array.from({length: n}, (_, i) => i);
  const delta = new Float64Array(n * n), masks = freqs.map(f => {
    const mask = new Uint32Array(CLUSTER_TOKENS >> 5);
    for (let t = 0; t < CLUSTER_TOKENS; t++) if (f[t]) mask[t >> 5] |= 1 << (t & 31);
    return mask;
  });
  const gain = (a, b) => {
    const fa = freqs[a], fb = freqs[b], ma = masks[a], mb = masks[b];
    let total = 0, used = 0, bits = 0;
    for (let w = 0; w < ma.length; w++) for (let m = ma[w] | mb[w]; m; m &= m - 1) { const t = w << 5 | 31 - Math.clz32(m & -m); total += fa[t] + fb[t]; used++; }
    const whole = log2x32(total);
    for (let w = 0; w < ma.length; w++) for (let m = ma[w] | mb[w]; m; m &= m - 1) { const t = w << 5 | 31 - Math.clz32(m & -m), f = fa[t] + fb[t]; bits += f * (whole - log2x32(f)); }
    return (total ? bits / 32 + 5 * used + CLUSTER_HEADER : 0) - cost[a] - cost[b];
  };
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) delta[a * n + b] = gain(a, b);
  for (;;) {
    let best = 0, ba = -1, bb = -1;
    for (let a = 0; a < n; a++) if (alive[a]) for (let b = a + 1; b < n; b++) if (alive[b] && delta[a * n + b] < best) { best = delta[a * n + b]; ba = a; bb = b; }
    if (ba < 0) break;
    for (let t = 0; t < CLUSTER_TOKENS; t++) freqs[ba][t] += freqs[bb][t];
    for (let w = 0; w < masks[ba].length; w++) masks[ba][w] |= masks[bb][w];
    cost[ba] = clusterCost(freqs[ba]); alive[bb] = 0; parent[bb] = ba;
    const into = live[ba], from = live[bb];
    for (let v = 0; v < SMALL; v++) into.small[v] += from.small[v];
    into.large = mergeCounts(into.large, from.large); into.lengths = mergeCounts(into.lengths, from.lengths);
    into.literals += from.literals; into.copies += from.copies;
    for (let a = 0; a < n; a++) if (alive[a] && a !== ba) { const g = gain(a, ba); if (a < ba) delta[a * n + ba] = g; else delta[ba * n + a] = g; }
  }
  const of = new Int32Array(n), groups = [], slot = new Int32Array(n);
  for (let i = 0; i < n; i++) if (alive[i]) { slot[i] = groups.length; groups.push(live[i]); }
  for (let i = 0; i < n; i++) { let r = i; while (!alive[r]) r = parent[r]; of[i] = slot[r]; }
  return {groups, of};
}

function writeChannels(writer, models) {
  const ordered = writeTree(writer, intervals(0, upTo(models.length - 1), m => models[m].tree));
  let pieces = 0;
  for (const model of models) pieces += model.count;
  const histograms = [], largeKeys = new Uint32Array(pieces), lengthKeys = new Uint32Array(pieces), copyDistances = new Uint32Array(pieces);
  let larges = 0, copies = 0;
  for (const model of models) {
    model.base = histograms.length;
    const {counts, literals, others} = capturePieceCounts(model, SMALL);
    for (let c = 0; c < model.classes; c++) histograms.push({small: counts.subarray(c * SMALL, (c + 1) * SMALL), large: NO_COUNTS, lengths: NO_COUNTS, literals: literals[c], copies: 0});
    for (let i = 0; i < others.length; i++) {
      const k = others[i], h = model.base + model.pieceContext[k], target = histograms[h], value = model.pieceValue[k], d = model.pieceDistance[k];
      if (d) { lengthKeys[copies] = h * KEY + value; copyDistances[copies++] = d; target.copies++; }
      else { if (value < SMALL) target.small[value]++; else largeKeys[larges++] = h * KEY + value; target.literals++; }
    }
  }
  countKeys(largeKeys.subarray(0, larges), histograms, 'large'); countKeys(lengthKeys.subarray(0, copies), histograms, 'lengths');
  const stream = {distances: NO_COUNTS};
  countKeys(copyDistances.subarray(0, copies), [stream], 'distances');
  const {values: distanceValues, counts: distanceCounts} = stream.distances;
  let live = histograms.filter(h => h.literals + h.copies);
  const index = new Int32Array(histograms.length);
  for (let i = 0, next = 0; i < histograms.length; i++) index[i] = histograms[i].literals + histograms[i].copies ? next++ : 0;
  if (live.length > 1 && models.some(model => model.kind === 'index' && !model.group)) {
    const {groups, of} = clusterHistograms(live);
    for (let i = 0; i < histograms.length; i++) index[i] = of[index[i]];
    live = groups;
  }
  const token = [0, 0, 0], minSymbol = models.at(-1).kind === 'index' && models[0].width <= 2048 ? 224 : 512;
  const configs = live.map(h => {
    const literals = valueCounts(h.small, h.large);
    if (!h.literals) return {config: LITERAL_CONFIGS[0], top: 0};
    let largest = 0, best, wide = false;
    for (const v of literals.values) if (v > largest) largest = v;
    const candidates = [];
    for (const config of LITERAL_CONFIGS) {
      if (distanceValues.length) { hybridToken(config, largest, token); if (token[0] >= minSymbol) continue; }
      if (config.splitToken > largest) { if (wide) continue; wide = true; }
      candidates.push(config);
    }
    const prices = capturePrices(candidates, literals);
    for (let c = 0; c < candidates.length; c++) {
      const config = candidates[c], option = {config, bits: prices[c * 2], top: prices[c * 2 + 1]};
      if (!best || option.bits < best.bits) best = option;
    }
    return best;
  });
  let length = {config: LZ77.lengthConfig, bits: 0};
  if (distanceValues.length) {
    length = null;
    const costs = new Float64Array(SCREEN_INTEGER_CONFIGS.length);
    for (const h of live) if (h.copies) {
      const prices = capturePrices(SCREEN_INTEGER_CONFIGS, h.lengths);
      for (let c = 0; c < costs.length; c++) costs[c] += prices[c * 2];
    }
    for (let c = 0; c < costs.length; c++) if (!length || costs[c] < length.bits)
      length = {config: SCREEN_INTEGER_CONFIGS[c], bits: costs[c]};
  }
  const codes = live.map((h, m) => sortedCode(countTokens(new Uint32Array(h.copies ? minSymbol + 1024 : configs[m].top + 1),
    h, configs[m].config, length.config, minSymbol, Infinity)));
  let distance, sCodes = null;
  if (distanceValues.length) {
    sCodes = spatialLookup(Math.max(...models.map(model => model.width)))[1];
    const spatial = new Map(), generic = new Map(), sLen = sCodes.length;
    for (let i = 0; i < distanceValues.length; i++) {
      const d = distanceValues[i], n = distanceCounts[i], s = d < sLen && sCodes[d] >= 0 ? sCodes[d] : d + 119, g = d === 1 ? 1 : d + 119;
      spatial.set(s, (spatial.get(s) || 0) + n); generic.set(g, (generic.get(g) || 0) + n);
    }
    const ranked = [];
    for (const [kind, values] of [[true, mapCounts(spatial)], [false, mapCounts(generic)]]) {
      const prices = capturePrices(DISTANCE_CONFIGS, values, true);
      for (let c = 0; c < DISTANCE_CONFIGS.length; c++) ranked.push({config: DISTANCE_CONFIGS[c], kind, values, estimate: prices[c * 2]});
    }
    ranked.sort((a, b) => a.estimate - b.estimate);
    for (const {config, kind, values} of ranked.slice(0, 4)) {
      const bits = distancePrice(config, values);
      if (!distance || bits < distance.bits) distance = {bits, config, spatial: kind, values};
    }
    distance.code = distanceCode(distance.config, distance.values);
    distance.code.codes = canonicalCodes(distance.code.lengths);
  }
  const offset = distance ? 1 : 0, contextMap = new Uint8Array(ordered.length + offset);
  for (const model of models) for (const node of model.leaves) contextMap[node.context] = index[model.base + node.local] + offset;
  writeHistograms(writer, {
    lz77: distance ? {minSymbol: minSymbol, minLength: models[0].minimum, lengthConfig: length.config} : null,
    contextMap,
    histograms: [...(distance ? [{config: distance.config, code: distance.code}] : []),
      ...codes.map((code, m) => ({config: configs[m].config, code}))]
  });
  const fastLen = new Uint8Array(codes.length << 9), fastBits = new Uint32Array(codes.length << 9);
  for (let h = 0; h < codes.length; h++) {
    const code = codes[h], cfg = configs[h].config, base = h << 9, small = live[h].small;
    for (let v = 0; v < 512; v++) {
      if (!small[v]) continue;
      hybridToken(cfg, v, token);
      const s = token[0], l = code.lengths[s];
      if (s < code.lengths.length) { fastLen[base | v] = l + token[1]; fastBits[base | v] = code.codes[s] | (token[2] << l); }
    }
  }
  return () => {
    let bytes = writer.bytes, at = writer.at, acc = writer.acc, pending = writer.pending;
    const sLen = sCodes ? sCodes.length : 0, group = new Int32Array(8), dLengths = distance?.code.lengths, dCodes = distance?.code.codes;
    for (const model of models) {
      const mBase = model.base, pCtx = model.pieceContext, pVal = model.pieceValue, pDist = model.pieceDistance, count = model.count;
      for (let k = 0; k < count; k++) {
        const h = index[mBase + pCtx[k]], value = pVal[k], d = pDist[k];
        if (!d && value < 512) {
          if (at + 8 >= bytes.length) { writer.at = at; writer.acc = acc; writer.pending = pending; writer.grow(65536); bytes = writer.bytes; }
          const slot = (h << 9) | value;
          acc |= fastBits[slot] << pending;
          pending += fastLen[slot];
          while (pending >= 8) { bytes[at++] = acc & 255; acc >>>= 8; pending -= 8; }
        } else if (d) {
          if (at + 16 >= bytes.length) { writer.at = at; writer.acc = acc; writer.pending = pending; writer.grow(65536); bytes = writer.bytes; }
          const code = codes[h];
          hybridToken(length.config, value, token);
          let s = minSymbol + token[0];
          group[0] = code.lengths[s]; group[1] = code.codes[s]; group[2] = token[1]; group[3] = token[2];
          hybridToken(distance.config, distance.spatial ? (d < sLen && sCodes[d] >= 0 ? sCodes[d] : d + 119) : d === 1 ? 1 : d + 119, token);
          s = token[0];
          group[4] = dLengths[s]; group[5] = dCodes[s]; group[6] = token[1]; group[7] = token[2];
          for (let g = 0; g < 8; g += 2) {
            acc |= group[g + 1] << pending;
            pending += group[g];
            while (pending >= 8) { bytes[at++] = acc & 255; acc >>>= 8; pending -= 8; }
          }
        } else {
          if (at + 8 >= bytes.length) { writer.at = at; writer.acc = acc; writer.pending = pending; writer.grow(65536); bytes = writer.bytes; }
          const code = codes[h];
          hybridToken(configs[h].config, value, token);
          acc |= code.codes[token[0]] << pending;
          pending += code.lengths[token[0]];
          while (pending >= 8) { bytes[at++] = acc & 255; acc >>>= 8; pending -= 8; }
          acc |= token[2] << pending;
          pending += token[1];
          while (pending >= 8) { bytes[at++] = acc & 255; acc >>>= 8; pending -= 8; }
        }
      }
    }
    writer.at = at; writer.acc = acc; writer.pending = pending;
  };
}

function groupChannels(rgba, stride, x, y, w, h, shape, coding) {
  const {maxError, onPredictor} = coding;
  const scan = w === stride && !x && !y ? null : scanColours(rgba, stride, x, y, w, h, Math.min(PALETTE_LIMIT, (w * h) / 20 | 0));
  if (scan) {
    const index = channelModel(scan.indices, w, h, 'index', 1, 3); index.group = true;
    const {meta, model} = paletteModel(scan.colours, [index], shape);
    return {transforms: [meta.transform], models: [model, index]};
  }
  const sample = c => {
    const plane = new Int16Array(w * h);
    for (let at = 0, col = 0, p = (y * stride + x) * 4 + c, n = w * h; at < n; at++, col++, p += 4) {
      if (col === w) { col = 0; p += (stride - w) * 4; }
      plane[at] = rgba[p];
    }
    return plane;
  };
  const step = 2 * maxError + 1, models = [];
  if (step > 1) coding.stepped = true;
  const colour = (plane, channel, keepWeighted = false) => {
    const weighted = step === 1 && (keepWeighted || useWeighted(plane, w, h));
    if (step === 1) onPredictor?.(channel, weighted ? 'weighted' : 'gradient');
    models.push(channelModel(plane, w, h, 'smooth', step, 4, weighted));
    return weighted;
  };
  let transforms = [];
  if (shape.colour === 1) colour(sample(0), 'gray');
  else {
    const n = w * h, words = pixelKeys(rgba), green = new Int16Array(n), blue = new Int16Array(n), red = new Int16Array(n);
    for (let at = 0, col = 0, p = y * stride + x; at < n; at++, col++, p++) {
      if (col === w) { col = 0; p += stride - w; }
      const word = words[p];
      green[at] = word >>> 8 & 255; blue[at] = word >>> 16 & 255; red[at] = word & 255;
    }
    const greenWeighted = colour(green, 'green');
    for (let i = 0; i < n; i++) { blue[i] -= green[i]; red[i] -= green[i]; }
    colour(blue, 'blue-green', greenWeighted);
    colour(red, 'red-green', greenWeighted);
    transforms = [{type: 'rct', beginC: 0, rctType: 10}];
  }
  if (shape.alpha) {
    const alpha = sample(3), weighted = useWeighted(alpha, w, h);
    onPredictor?.('alpha', weighted ? 'weighted' : 'gradient');
    models.push(channelModel(alpha, w, h, 'smooth', 1, 4, weighted));
  }
  return {transforms, models};
}

function shapeOf(keys, margin = keys[0], rgb = false) {
  let grey = !rgb && !((margin ^ margin >>> 8) & 0xffff), opaque = margin >>> 24 === 255;
  for (let i = 0; i < keys.length && (grey || opaque); i++) {
    const key = keys[i];
    if (key >>> 24 !== 255) opaque = false;
    if ((key ^ key >>> 8) & 0xffff) grey = false;
  }
  const colour = grey ? 1 : 3;
  return {colour, alpha: !opaque, channels: colour + (opaque ? 0 : 1)};
}

function* captureFrameSteps(pixels, width, height, shape, coding, frame, header, placement) {
  captureRelease();
  const layout = groupLayout(width, height, DIM), groups = layout.groupsX * layout.groupsY, sections = [];
  writeModularFrameHeader(header, {alpha: shape.alpha, shift: 3, ...placement});
  let total = 0;
  const append = bytes => { total += bytes.length; admitOutputSize(total); sections.push(bytes); };
  const indexModels = frame ? Array.from({length: groups}, (_, g) => {
    const [x, y, w, h] = groupRect(layout, width, height, g, DIM), {stride = width, x: fx = 0, y: fy = 0} = frame;
    return channelModel(frame.indices, w, h, 'index', 1, 3, true, stride, (fy + y) * stride + fx + x);
  }) : null;
  const palette = frame ? paletteModel(frame.colours, indexModels, shape) : null;
  const global = new BitWriter(layout.single ? width * height + 256 : 1024);
  global.write(1, 1); global.write(1, 1);
  if (layout.single) {
    const {transforms, models} = frame
      ? {transforms: [palette.meta.transform], models: [palette.model, indexModels[0]]}
      : groupChannels(pixels, width, 0, 0, width, height, shape, coding);
    const write = writeChannels(global, models);
    writeModularHeader(global, {transforms});
    write();
    return assembleCodestream(header, [global.finish()]);
  }
  if (frame) {
    const write = writeChannels(global, [palette.model]);
    writeModularHeader(global, {transforms: [palette.meta.transform]});
    write();
  } else {
    writeHistograms(global, {contextMap: new Uint8Array(writeTree(global, leaf(0)).length),
      histograms: [{config: LITERAL_CONFIGS[0], code: buildCode(new Uint32Array(1))}]});
    writeModularHeader(global);
  }
  append(global.finish());
  for (let i = 0; i < layout.dcGroupsX * layout.dcGroupsY + 1; i++) sections.push(new Uint8Array(0));
  for (let g = 0; g < groups; g++) {
    const [x, y, w, h] = groupRect(layout, width, height, g, DIM), section = new BitWriter(w * h + 256);
    const channels = frame ? {transforms: [], models: [indexModels[g]]} : groupChannels(pixels, width, x, y, w, h, shape, coding);
    writeModularHeader(section, {useGlobalTree: false, transforms: channels.transforms});
    writeChannels(section, channels.models)();
    if (frame) indexModels[g] = null;
    append(section.finish());
    yield (g + 1) / groups;
  }
  return assembleCodestream(header, sections);
}

function* scaledSteps(steps, start, span) {
  let step;
  while (!(step = steps.next()).done) yield start + span * step.value;
  return step.value;
}

const MIN_BAND = 16;
function screenBands(scan, width, height) {
  if (!scan || height < 2 * MIN_BAND) return null;
  const n = scan.colours.length, {first, last} = scan;
  const starts = new Int32Array(height), ends = new Int32Array(height);
  for (let c = 0; c < n; c++) { starts[first[c]]++; ends[last[c]]++; }
  let above = 0, closed = 0, row = 0, shared = 1, side = 0;
  for (let y = 1; y <= height - MIN_BAND; y++) {
    above += starts[y - 1]; closed += ends[y - 1];
    if (y < MIN_BAND) continue;
    const both = above - closed, smaller = Math.min(above, n - closed);
    if (both * side < shared * smaller) { row = y; shared = both; side = smaller; }
  }
  return row && 10 * shared < side ? [0, row, height] : null;
}

function* captureSteps(source, imageWidth, imageHeight, colorSpace, coding) {
  const words = pixelKeys(source);
  if (words.buffer === source.buffer) captureHold(words);
  try { return yield* pageSteps(source, imageWidth, imageHeight, colorSpace, coding); }
  finally { captureRelease(); }
}

function* pageSteps(source, imageWidth, imageHeight, colorSpace, coding) {
  const crop = coding.base ? null : screenCrop(source, imageWidth, imageHeight);
  const width = crop ? crop.width : imageWidth, height = crop ? crop.height : imageHeight;
  let scan = scanColours(source, imageWidth, crop?.x ?? 0, crop?.y ?? 0, width, height, PALETTE_LIMIT, true);
  const header = new BitWriter(128);
  if (!crop && scan?.colours.length === 1) {
    const shape = shapeOf(scan.colours, undefined, coding.base);
    writeHeaderFields(header, imageWidth, imageHeight, shape.colour, shape.alpha, {colorSpace});
    writeScreenBackground(header, imageWidth, imageHeight, shape, source.subarray(0, 4), undefined, true);
    return header.finish();
  }
  if (scan && scan.colours.length * 32 > width * height) scan = null;
  const bands = coding.base ? null : screenBands(scan, width, height);
  const rare = !coding.base && scan && scan.colours.length > RARE_PALETTE ? rareRegions(scan, width, height, crop?.x ?? 0, crop?.y ?? 0) : null;
  if (rare && rare.only >= 0.75) return yield* pictureSteps(source, imageWidth, imageHeight, colorSpace, coding, header, null, crop, null, rare);
  if (!bands) return yield* pictureSteps(source, imageWidth, imageHeight, colorSpace, coding, header, null, crop, scan);
  return yield* bandSteps(source, imageWidth, imageHeight, colorSpace, coding, header, crop, scan, bands);
}

function* bandSteps(source, imageWidth, imageHeight, colorSpace, coding, header, crop, scan, bands) {
  const width = crop ? crop.width : imageWidth;
  const shape = shapeOf(scan.colours, crop ? pixelKeys(crop.background)[0] : undefined, coding.base), frames = [], count = bands.length - 1;
  writeHeaderFields(header, imageWidth, imageHeight, shape.colour, shape.alpha, {colorSpace});
  if (crop) writeScreenBackground(header, imageWidth, imageHeight, shape, crop.background);
  for (let b = 0; b < count; b++) {
    const y = bands[b], rows = bands[b + 1] - y, band = {x: crop?.x ?? 0, y: (crop?.y ?? 0) + y, shape, last: b + 1 === count};
    const view = {stride: imageWidth, origin: band.y * imageWidth + band.x}, words = pixelKeys(source);
    if (b && words.buffer === source.buffer) captureHold(words);
    frames.push(yield* scaledSteps(pictureSteps(source, width, rows, colorSpace, coding, b ? new BitWriter(64) : header, band,
      screenCrop(source, width, rows, view.stride, view.origin), {colours: scan.colours, indices: scan.indices.subarray(y * width, (y + rows) * width)},
      undefined, view), b / count, 1 / count));
  }
  return concatenate(frames);
}

function rareRegions(scan, width, height, cx, cy) {
  const TILE = 16, tx = Math.ceil(width / TILE), ty = Math.ceil(height / TILE), dense = new Uint8Array(tx * ty);
  const {colours, indices} = scan, freq = new Uint32Array(colours.length);
  for (let i = 0; i < indices.length; i++) freq[indices[i]]++;
  for (let by = 0; by < ty; by++) for (let bx = 0; bx < tx; bx++) {
    let rare = 0;
    for (let y = by * TILE, ye = Math.min(height, y + TILE); y < ye; y++)
      for (let i = y * width + bx * TILE, ie = y * width + Math.min(width, bx * TILE + TILE); i < ie; i++) if (freq[indices[i]] <= 2) rare++;
    dense[by * tx + bx] = rare > 16;
  }
  const seen = new Uint8Array(tx * ty), regions = [];
  for (let i = 0; i < tx * ty; i++) if (dense[i] && !seen[i]) {
    let x0 = tx, y0 = ty, x1 = -1, y1 = -1; const stack = [i]; seen[i] = 1;
    while (stack.length) {
      const j = stack.pop(), jx = j % tx, jy = j / tx | 0;
      x0 = Math.min(x0, jx); x1 = Math.max(x1, jx); y0 = Math.min(y0, jy); y1 = Math.max(y1, jy);
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const nx = jx + dx, ny = jy + dy, k = ny * tx + nx;
        if (nx >= 0 && ny >= 0 && nx < tx && ny < ty && dense[k] && !seen[k]) { seen[k] = 1; stack.push(k); }
      }
    }
    const x = x0 * TILE, y = y0 * TILE, w = Math.min(width, (x1 + 1) * TILE) - x, h = Math.min(height, (y1 + 1) * TILE) - y;
    if (w * h >= 4096 && w * h * 2 <= width * height) regions.push({x, y, width: w, height: h});
  }
  for (let merged = true; merged;) {
    merged = false;
    for (let a = 0; a < regions.length && !merged; a++) for (let b = a + 1; b < regions.length && !merged; b++) {
      const p = regions[a], q = regions[b], top = Math.max(p.y, q.y), bottom = Math.min(p.y + p.height, q.y + q.height);
      if ((bottom - top) * 2 < Math.min(p.height, q.height)) continue;
      const x = Math.min(p.x, q.x), y = Math.min(p.y, q.y);
      regions[a] = {x, y, width: Math.max(p.x + p.width, q.x + q.width) - x, height: Math.max(p.y + p.height, q.y + q.height) - y};
      regions.splice(b, 1); merged = true;
    }
  }
  if (!regions.length) return null;
  const inside = new Uint8Array(width * height), outside = new Uint8Array(colours.length);
  for (const r of regions) for (let y = r.y; y < r.y + r.height; y++) inside.fill(1, y * width + r.x, y * width + r.x + r.width);
  for (let i = 0; i < indices.length; i++) if (!inside[i]) outside[indices[i]] = 1;
  let only = 0;
  for (let c = 0; c < colours.length; c++) only += 1 - outside[c];
  for (const r of regions) {
    const border = new Map();
    for (let xx = r.x; xx < r.x + r.width; xx++) for (const yy of [r.y, r.y + r.height - 1]) { const k = indices[yy * width + xx]; border.set(k, (border.get(k) || 0) + 1); }
    let most = 0, index = 0;
    for (const [k, n] of border) if (n > most) { most = n; index = k; }
    r.background = colours[index]; r.x += cx; r.y += cy;
  }
  return {regions, background: regions[0].background, solid: false, only: only / colours.length};
}

let baseBuffer = null;
function basePlane(n) {
  if (n > 1 << 21) return new Uint16Array(n);
  if (!baseBuffer || baseBuffer.length < n) baseBuffer = new Uint16Array(Math.max(n, 1 << 20));
  return baseBuffer.subarray(0, n);
}

function viewPixels(source, {stride, origin}, width, height) {
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) { const at = (origin + y * stride) * 4; out.set(source.subarray(at, at + width * 4), y * width * 4); }
  return out;
}

function concatenate(frames) {
  let length = 0;
  for (const f of frames) length += f.length;
  admitOutputSize(length);
  const out = new Uint8Array(length);
  for (let i = 0, at = 0; i < frames.length; at += frames[i++].length) out.set(frames[i], at);
  return out;
}

function* pictureSteps(source, imageWidth, imageHeight, colorSpace, coding, header, band, crop, scan, forced, view = {stride: imageWidth, origin: 0}) {
  const width = crop ? crop.width : imageWidth, height = crop ? crop.height : imageHeight;
  const frame = band && crop && scan ? {colours: scan.colours, indices: scan.indices, stride: imageWidth, x: crop.x, y: crop.y} : scan;
  const fStride = frame?.stride ?? width, fx = frame?.x ?? 0, fy = frame?.y ?? 0;
  const pixels = !crop ? source : frame ? null : crop.data;
  const at = r => band ? {...r, x: r.x + band.x, y: r.y + band.y} : r, whole = {x: 0, y: 0, width: imageWidth, height: imageHeight};
  const bandCrop = band && !band.fullCanvas ? at(whole) : undefined;
  const final = !band || band.last;
  let partition = forced ?? (coding.base ? null : frame && screenColumns(source, imageWidth, imageHeight, view.stride, view.origin, crop) ||
    screenRegions(source, imageWidth, imageHeight, !frame, view.stride, view.origin));
  if (partition) {
    const x0 = crop?.x ?? 0, y0 = crop?.y ?? 0, x1 = x0 + width, y1 = y0 + height;
    const regions = partition.regions.map(r => {
      const x = Math.max(r.x, x0), y = Math.max(r.y, y0);
      return {x, y, width: Math.min(r.x + r.width, x1) - x, height: Math.min(r.y + r.height, y1) - y, background: r.background ?? partition.background};
    }).filter(r => r.width > 0 && r.height > 0 && r.width < imageWidth && (forced || r.width * r.height >= 20000));
    const solid = partition.solid && regions.length === partition.regions.length && regions.every((r, i) => r.width === partition.regions[i].width && r.height === partition.regions[i].height);
    partition = regions.length && (!frame || forced || regions.some(r => r.y * 6 <= imageHeight)) ? {...partition, regions, solid} : null;
  }
  const shape = band ? band.shape : shapeOf(frame ? frame.colours : pixelKeys(partition ? source : pixels), crop ? pixelKeys(crop.background)[0] : undefined, coding.base);
  if (!band) writeHeaderFields(header, imageWidth, imageHeight, shape.colour, shape.alpha, {colorSpace});
  if (!partition) {
    if (crop) writeScreenBackground(header, imageWidth, imageHeight, shape, crop.background, bandCrop);
    const placement = crop ? {crop: at({x: crop.x, y: crop.y, width, height})} : bandCrop ? {crop: bandCrop} : {};
    return yield* captureFrameSteps(pixels, width, height, shape, coding, frame, header, final ? placement : {...placement, last: false, reference: 1});
  }
  const {regions, background} = partition, frames = [];
  let body = source, base;
  const blank = fill => { for (const r of regions) for (let y = r.y; y < r.y + r.height; y++) fill(y * imageWidth + r.x, y * imageWidth + r.x + r.width); };
  const backgroundIndex = frame ? frame.colours.indexOf(background) : -1,
    marginIndex = crop ? frame ? frame.colours.indexOf(pixelKeys(crop.background)[0]) : -1 : backgroundIndex;
  if (backgroundIndex >= 0 && marginIndex >= 0) {
    const indices = basePlane(imageWidth * imageHeight), cx = crop?.x ?? 0, cy = crop?.y ?? 0;
    const margin = (from, to) => { if (to > from) indices.fill(marginIndex, from, to); };
    margin(0, cy * imageWidth);
    for (let y = 0; y < height; y++) {
      const row = (y + cy) * imageWidth;
      margin(row, row + cx);
      indices.set(frame.indices.subarray((fy + y) * fStride + fx, (fy + y) * fStride + fx + width), row + cx);
      margin(row + cx + width, row + imageWidth);
    }
    margin((cy + height) * imageWidth, imageWidth * imageHeight);
    blank((from, to) => indices.fill(backgroundIndex, from, to));
    base = {colours: frame.colours, indices};
  } else {
    if (view.origin || view.stride !== imageWidth) body = source = viewPixels(source, view, imageWidth, imageHeight);
    const allSolid = partition.solid;
    for (const r of regions) r.local = scanColours(source, imageWidth, r.x, r.y, r.width, r.height, Math.min(PALETTE_LIMIT, (r.width * r.height) / 20 | 0));
    if (allSolid) {
      base = {colours: Uint32Array.of(background)};
    } else {
      body = Uint8Array.from(source);
      for (const reg of regions) {
        const bg = reg.background ?? background, [r, g, b, a] = [0, 8, 16, 24].map(shift => bg >>> shift & 255);
        for (let y = reg.y; y < reg.y + reg.height; y++) for (let p = (y * imageWidth + reg.x) * 4, to = p + reg.width * 4; p < to; p += 4) { body[p] = r; body[p + 1] = g; body[p + 2] = b; body[p + 3] = a; }
      }
      base = scanColours(body, imageWidth, 0, 0, imageWidth, imageHeight, PALETTE_LIMIT);
    }
  }
  const count = regions.length + 1, solidBase = base && base.colours.length === 1;
  if (solidBase) {
    const c0 = base.colours[0];
    writeScreenBackground(header, imageWidth, imageHeight, shape, Uint8Array.of(c0 & 255, c0 >>> 8 & 255, c0 >>> 16 & 255, c0 >>> 24 & 255), bandCrop);
  } else {
    frames.push(yield* scaledSteps(captureFrameSteps(body, imageWidth, imageHeight, shape, coding, base, header,
      {...bandCrop && {crop: bandCrop}, last: false, reference: 1}), 0, 1 / count));
  }
  for (let i = 0; i < regions.length; i++) {
    const r = regions[i], placement = {crop: at(r), last: final && i + 1 === regions.length, reference: 1};
    let part = null, local;
    if (frame) local = {colours: frame.colours, indices: frame.indices, stride: fStride, x: fx + r.x - (crop?.x ?? 0), y: fy + r.y - (crop?.y ?? 0)};
    else {
      local = r.local;
      if (!local) {
        part = new Uint8Array(r.width * r.height * 4);
        for (let y = 0; y < r.height; y++) part.set(source.subarray(((r.y + y) * imageWidth + r.x) * 4, ((r.y + y) * imageWidth + r.x + r.width) * 4), y * r.width * 4);
      }
    }
    frames.push(yield* scaledSteps(captureFrameSteps(part, r.width, r.height, shape, coding, local, i === 0 && solidBase ? header : new BitWriter(64), placement), (i + 1) / count, 1 / count));
  }
  return concatenate(frames);
}

export function admitCapture(data, width, height, options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw fault('JXL_INPUT', 'Capture options are an object.');
  const maxError = options.maxError ?? 0;
  if (!Number.isInteger(maxError) || maxError < 0 || maxError > 8)
    throw fault('JXL_INPUT', 'maxError is a whole number from 0 to 8. Zero preserves every sample.');
  const {colorSpace} = admitOptions({colorSpace: options.colorSpace});
  admitPixels(data, width, height);
  if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray)) throw fault('JXL_INPUT', 'Captures use straight RGBA8 samples.');
  return {colorSpace, coding: {maxError, onPredictor: options[CAPTURE_PREDICTOR_PROBE], base: options[CAPTURE_BASE] === true}};
}

export function captureBandShape(data, previous) {
  const {colour, alpha} = shapeOf(pixelKeys(data));
  if (!previous) return {colour, alpha};
  return {colour: Math.max(colour, previous.colour), alpha: alpha || previous.alpha};
}
export function captureBand(data, width, rows, {y, imageHeight, shape, ...options}) {
  const {colorSpace, coding} = admitCapture(data, width, rows, options);
  requireCaptureKernels();
  const header = new BitWriter(y ? 64 : 128), whole = {...shape, channels: shape.colour + (shape.alpha ? 1 : 0)};
  if (!y) writeHeaderFields(header, width, imageHeight, whole.colour, whole.alpha, {colorSpace});
  let scan = scanColours(data, width, 0, 0, width, rows, PALETTE_LIMIT, true);
  if (scan && scan.colours.length * 32 > width * rows) scan = null;
  return complete(job(pictureSteps(data, width, rows, colorSpace, coding, header, {x: 0, y, shape: whole, last: y + rows === imageHeight, fullCanvas: !y && rows === imageHeight},
    screenCrop(data, width, rows), scan)));
}

export function encodeCaptureBytes(data, width, height, options = {}) {
  const aborted = () => { if (options?.signal?.aborted) throw fault('JXL_ABORTED', 'JPEG XL encoding was canceled.'); };
  aborted();
  const {colorSpace, coding} = admitCapture(data, width, height, options);
  requireCaptureKernels();
  let bytes = complete(job(captureSteps(data, width, height, colorSpace, coding)));
  if (coding.stepped) {
    const exact = complete(job(captureSteps(data, width, height, colorSpace, {...coding, maxError: 0})));
    if (exact.length <= bytes.length) bytes = exact;
  }
  aborted();
  return bytes;
}

