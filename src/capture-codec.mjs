// SPDX-License-Identifier: MIT
import {BitWriter, complete} from './bits.mjs';
import {admitOptions, admitPixels, admitOutputSize, fault, job} from './admit.mjs';
import {SCREEN_INTEGER_CONFIGS, screenDistanceMap} from './screen-codes.mjs';
import {writeImageHeader, writeModularFrameHeader, groupLayout, groupRect, assembleCodestream} from './frame.mjs';
import {pixelKeys, screenColumns, screenCrop, screenRegions, writeScreenBackground} from './screen-crop.mjs';
import {LZ77, leaf, split, writeTree, writeModularHeader} from './modular.mjs';
import {WEIGHTED_PREDICTOR, WEIGHTED_PROPERTY, codeWeighted} from './weighted.mjs';
import {buildCode, canonicalCodes, hybridToken, priceCode, uintConfig, writeHistograms, writeHybrid, writePrefixCode, writeUintConfig} from './prefix.mjs';

const DIM = 1024, PALETTE_LIMIT = 16384;

function scanColours(rgba, stride, x0, y0, w, h, limit, rows = false) {
  limit = Math.min(limit, w * h);
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
  const n = colours.length, uses = new Uint32Array(n), common = [];
  for (const model of models) for (let k = 0; k < model.count; k++) if (!model.pieceDistance[k]) uses[model.pieceValue[k] >> 1]++;
  let rare = 0;
  for (let i = 0; i < n; i++) if (uses[i] >= 16) common.push(i); else if (uses[i]) rare++;
  common.sort((a, b) => uses[b] - uses[a] || colours[a] - colours[b]);
  for (let lo = 8; lo < common.length; lo += 1 << (31 - Math.clz32(lo) - 2)) {
    const hi = Math.min(common.length, lo + (1 << (31 - Math.clz32(lo) - 2))), slice = common.slice(lo, hi).sort((a, b) => rgbaKey(colours[a]) - rgbaKey(colours[b]));
    for (let j = lo; j < hi; j++) common[j] = slice[j - lo];
  }
  const keys = new Float64Array(rare);
  for (let i = 0, j = 0; i < n; i++) if (uses[i] && uses[i] < 16) {
    const c = colours[i];
    keys[j++] = rgbaKey(c) * 65536 + i;
  }
  keys.sort();
  const order = new Int32Array(common.length + rare), sorted = new Uint32Array(order.length);
  order.set(common);
  for (let j = 0; j < rare; j++) order[common.length + j] = keys[j] % 65536;
  for (let j = 0; j < order.length; j++) sorted[j] = colours[order[j]];
  const meta = paletteMeta(sorted, shape), best = {order, meta, model: channelModel(meta.plane, meta.width, meta.height, 'rows', 1, minimum)};
  const remap = new Int32Array(n);
  for (let j = 0; j < best.order.length; j++) remap[best.order[j]] = j;
  for (const model of models) {
    for (let k = 0; k < model.count; k++) if (!model.pieceDistance[k]) model.pieceValue[k] = remap[model.pieceValue[k] >> 1] * 2;
    if (!model.group) learnContexts(model, remap, common.length, best.order.length);
  }
  return best;
}

const TREE_TOKENS = 128, TREE_SPLIT = 160, TREE_MIN = 256, TREE_NODES = 32;
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

function learnContexts(model, remap, common, total) {
  const w = model.width, plane = model.plane, count = model.count, h = Math.ceil(plane.length / w);
  const indexCuts = [];
  for (let a = 0, b = 1; a < common - 1; [a, b] = [b, a + b]) if (!indexCuts.includes(a)) indexCuts.push(a);
  if (common) indexCuts.push(common - 1);
  for (let k = 1; k < 4; k++) { const c = common + Math.floor((total - common) * k / 4) - 1; if (c > (indexCuts[indexCuts.length - 1] ?? -1)) indexCuts.push(c); }
  const spread = n => { const cuts = []; for (let k = 1; k < 8; k++) { const c = Math.floor(n * k / 8) - 1; if (c > (cuts[cuts.length - 1] ?? -1)) cuts.push(c); } return cuts; };
  const cuts = [spread(h), spread(w), indexCuts, indexCuts];
  const binsOf = (list, n) => { const bins = new Uint8Array(n); for (let v = 0, b = 0; v < n; v++) { while (b < list.length && v > list[b]) b++; bins[v] = b; } return bins; };
  const yBin = binsOf(cuts[0], h), xBin = binsOf(cuts[1], w), indexBin = binsOf(indexCuts, total), binOf = new Uint8Array(remap.length);
  for (let i = 0; i < remap.length; i++) binOf[i] = indexBin[remap[i]];
  const by = new Uint8Array(count), bx = new Uint8Array(count), bw = new Uint8Array(count), bn = new Uint8Array(count), tokens = new Uint8Array(count);
  pieceBins(plane, w, model.pieceValue, model.pieceDistance, model.minimum, count, yBin, xBin, binOf, tokens, by, bx, bw, bn);
  const order = new Int32Array(count), span = (Math.max(...cuts.map(c => c.length)) + 1) * TREE_TOKENS;
  for (let k = 0; k < count; k++) order[k] = k;
  const s = {cuts, by, bx, bw, bn, tokens, order, scratch: new Int32Array(count), nlog: nlogTable(count), context: model.pieceContext,
    all: new Uint32Array(TREE_TOKENS), low: new Uint32Array(TREE_TOKENS), used: new Uint8Array(TREE_TOKENS),
    span, counts: new Uint32Array(4 * span), leaves: [], nodes: 0,
    split: TREE_SPLIT, min: TREE_MIN, most: TREE_NODES, cut: 0};
  model.tree = treeNode(s, 0, count);
  model.leaves = s.leaves; model.classes = s.leaves.length;
}

function pieceBins(plane, w, pieceValue, pieceDistance, minimum, count, yBin, xBin, binOf, tokens, by, bx, bw, bn) {
  for (let k = 0, x = 0, y = 0, at = 0; k < count; k++) {
    const west = x ? plane[at - 1] : y ? plane[at - w] : -1, north = y ? plane[at - w] : west;
    const d = pieceDistance[k], value = d ? Math.min(pieceValue[k], 16383) : pieceValue[k];
    const e = 31 - Math.clz32(value), token = value < 16 ? value : 16 + ((e - 4) << 2 | (value >> (e - 1) & 1) << 1 | value & 1);
    tokens[k] = (d ? 64 : 0) + Math.min(token, 63);
    by[k] = yBin[y]; bx[k] = xBin[x]; bw[k] = west < 0 ? 0 : binOf[west]; bn[k] = north < 0 ? 0 : binOf[north];
    const step = d ? pieceValue[k] + minimum : 1;
    at += step; x += step;
    while (x >= w) { x -= w; y++; }
  }
}

const TREE_PROPERTY = [2, 3, 7, 6];
function treeNode(s, from, to) {
  const {all, used, order, tokens, nlog} = s, size = to - from;
  s.nodes++;
  all.fill(0);
  for (let i = from; i < to; i++) all[tokens[order[i]]]++;
  let sum = 0, kinds = 0;
  for (let t = 0; t < TREE_TOKENS; t++) if (all[t]) { sum += nlog[all[t]]; used[kinds++] = t; }
  let gain = 32 * s.split, property = -1, cut = 0;
  if (size >= s.min && s.nodes + 2 <= s.most) {
    const here = nlog[size] - sum + 160 * kinds, counts = s.counts, span = s.span, b0 = s.by, b1 = s.bx, b2 = s.bw, b3 = s.bn;
    counts.fill(0);
    for (let i = from; i < to; i++) {
      const k = order[i], t = tokens[k];
      counts[b0[k] * TREE_TOKENS + t]++; counts[span + b1[k] * TREE_TOKENS + t]++;
      counts[2 * span + b2[k] * TREE_TOKENS + t]++; counts[3 * span + b3[k] * TREE_TOKENS + t]++;
    }
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
  const bin = property === 0 ? s.by : property === 1 ? s.bx : property === 2 ? s.bw : s.bn, scratch = s.scratch;
  let a = from, b = 0;
  for (let i = from; i < to; i++) { const k = order[i]; if (bin[k] > cut) order[a++] = k; else scratch[b++] = k; }
  order.set(scratch.subarray(0, b), a);
  const node = split(TREE_PROPERTY[property], s.cuts[property][cut], null, null);
  node.left = treeNode(s, from, a); node.right = treeNode(s, a, to);
  return node;
}

function bestCut(s, p, size, here, sum, kinds) {
  const {counts, low, all, used, nlog} = s, n = s.cuts[p].length + 1, offset = p * s.span;
  low.fill(0);
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
  for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) {
    const west = x ? plane[i - 1] : y ? plane[i - w] : 0, north = y ? plane[i - w] : west,
      northWest = x && y ? plane[i - w - 1] : west;
    const low = west < north ? west : north, high = west < north ? north : west, gradient = west + north - northWest;
    const prediction = gradient < low ? low : gradient > high ? high : gradient;
    let residual = plane[i] - prediction;
    if (step > 1) {
      residual = residual >= 0 ? (residual + bound) / step | 0 : -((bound - residual) / step | 0);
      plane[i] = prediction + residual * step;
    }
    values[i] = residual >= 0 ? residual * 2 : -residual * 2 - 1;
    contexts[i] = SMOOTH[west - northWest + RANGE] * 4 + SMOOTH[northWest - north + RANGE];
  }
}

const WEIGHTED_BANDS = [-200, -100, -50, -25, -12, -6, -3, -1, 0, 2, 4, 7, 13, 26, 51, 101, 201];
const WEIGHTED_CONTEXT = Uint8Array.from({length: 511}, (_, i) => WEIGHTED_BANDS.filter(cut => cut < i - 255).length);

function smoothTree(leaves, step) {
  return intervals(10, SMOOTH_CUTS, a => intervals(11, SMOOTH_CUTS, b => {
    const node = leaf(5, 0, step);
    node.local = SMOOTH_LEVEL[a] * 4 + SMOOTH_LEVEL[b]; leaves.push(node);
    return node;
  }));
}

const copyHash = (values, i) => (Math.imul(values[i] + 1, 0x1e35a7bd) ^ Math.imul(values[i + 1] + 1, 0x6c8e9cf5) ^ Math.imul(values[i + 2] + 1, 0x2c1b3c6d)) >>> 16;

function matchLength(values, previous, from, n) {
  let k = 3;
  while (from + k < n && values[previous + k] === values[from + k]) k++;
  return k;
}

function copyProbe(s, previous, recent = false) {
  const values = s.values, at = s.at, length = s.length;
  if (previous < 0 || values[previous] !== values[at] || values[previous + 1] !== values[at + 1] || values[previous + 2] !== values[at + 2]) return;
  if (length && values[previous + length - 1] !== values[at + length - 1]) return;
  const d = at - previous, slot = d & 63;
  let k;
  if (s.endDistance[slot] === d && s.endFrom[slot] <= at && s.endAt[slot] - at > 3) k = s.endAt[slot] - at;
  else { k = matchLength(values, previous, at, s.n); s.endDistance[slot] = d; s.endFrom[slot] = at; s.endAt[slot] = at + k; }
  const cost = d < s.spatial.length && s.spatial[d] ? 2 : Math.max(2, 31 - Math.clz32(d) - (recent ? 4 : 0));
  if (6 * k - cost > 6 * length - s.lengthCost) { s.length = k; s.distance = d; s.lengthCost = cost; }
}

function remember(recent, d) {
  let i = 0;
  while (i < recent.length - 1 && recent[i] !== d) i++;
  for (; i > 0; i--) recent[i] = recent[i - 1];
  recent[0] = d;
}

function copyFind(s, position) {
  const {values, n, width, depth, heads, chain} = s;
  const at = s.at = position;
  s.length = 0; s.distance = 0; s.lengthCost = 0;
  if (at + s.minimum > n) return 0;
  if (depth) for (let i = s.inserted; i < at; i++) { const h = copyHash(values, i); chain[i] = heads[h]; heads[h] = i; }
  if (depth && s.inserted < at) s.inserted = at;
  if (at) copyProbe(s, at - 1);
  if (at >= width && at + s.length < n) copyProbe(s, at - width);
  if (depth) {
    const v = values[at], recent = s.recent;
    for (let i = 0; i < recent.length && s.length < 256; i++) {
      const r = recent[i];
      if (r > 1 && r !== width && r <= at && values[at - r] === v) copyProbe(s, at - r, true);
    }
  }
  if (depth) for (let p = heads[copyHash(values, at)], d = 0; p >= 0 && d < depth && at + s.length < n && s.length < 256; p = chain[p], d++) copyProbe(s, p);
  return s.length >= s.minimum ? s.length : 0;
}

function runCopies(values, out) {
  for (let i = 0, n = values.length; i < n;) {
    if (!i || values[i] !== values[i - 1]) { literal(out, i++); continue; }
    let k = 1;
    while (i + k < n && values[i + k] === values[i - 1]) k++;
    if (k >= 16) { copied(out, i, k, 1); i += k; } else for (const end = i + k; i < end;) literal(out, i++);
  }
}

function pieces(values, contexts, n, minimum, scale) {
  const size = Math.min(n, 4096);
  return {values, contexts, n, minimum, scale, value: new Int32Array(size), distance: new Int32Array(size), context: new Uint8Array(size), count: 0};
}
function grow(out) {
  const size = Math.min(out.n, out.count * 2), value = new Int32Array(size), distance = new Int32Array(size), context = new Uint8Array(size);
  value.set(out.value); distance.set(out.distance); context.set(out.context);
  out.value = value; out.distance = distance; out.context = context;
}
function literal(out, at) {
  if (out.count === out.value.length) grow(out);
  const k = out.count++;
  out.context[k] = out.contexts[at]; out.value[k] = out.values[at] * out.scale; out.distance[k] = 0;
}
function copied(out, at, length, distance) {
  if (out.count === out.value.length) grow(out);
  const k = out.count++;
  out.context[k] = out.contexts[at]; out.value[k] = length - out.minimum; out.distance[k] = distance;
}

const SPATIAL = new Map();
function spatialFlags(width) {
  let flags = SPATIAL.get(width);
  if (!flags) {
    const near = [...screenDistanceMap(width).keys()];
    flags = new Uint8Array(Math.max(...near) + 1);
    for (const d of near) flags[d] = 1;
    if (SPATIAL.size > 64) SPATIAL.clear();
    SPATIAL.set(width, flags);
  }
  return flags;
}

function captureCopies(values, width, depth, minimum, out) {
  const n = values.length, s = {values, n, width, depth, minimum, spatial: spatialFlags(width), heads: depth ? new Int32Array(65536).fill(-1) : null,
    chain: depth ? new Int32Array(n) : null, inserted: 0, at: 0, length: 0, distance: 0, lengthCost: 0, recent: new Int32Array(16),
    endDistance: new Int32Array(64), endFrom: new Int32Array(64), endAt: new Int32Array(64)};
  let position = 0, copy = copyFind(s, 0), from = s.distance, fromCost = s.lengthCost;
  while (position < n) {
    if (copy) {
      const next = depth ? copyFind(s, position + 1) : 0;
      if (next && 6 * next - s.lengthCost > 6 * copy - fromCost + 3) { literal(out, position++); copy = next; from = s.distance; fromCost = s.lengthCost; continue; }
      copied(out, position, copy, from);
      if (depth) remember(s.recent, from);
      if (copy > 64) { copyFind(s, position + 8); s.inserted = position + copy - 3; }
      position += copy;
    } else literal(out, position++);
    copy = copyFind(s, position); from = s.distance; fromCost = s.lengthCost;
  }
}

function channelModel(plane, w, h, kind, step = 1, minimum = kind === 'index' ? 3 : 4) {
  const n = w * h, values = kind === 'index' ? plane instanceof Int32Array ? plane : Int32Array.from(plane) : new Int32Array(n);
  const contexts = new Uint8Array(n), leaves = [], scale = kind === 'index' ? 2 : 1;
  let tree, classes = 1;
  if (kind === 'index') {
    tree = leaf(0);
  } else if (kind === 'rows') {
    classes = 3 * h;
    const byNorth = new Int32Array(n), byGradient = new Int32Array(n), counts = new Uint32Array(3 * classes * 512);
    const zigzag = r => r >= 0 ? r * 2 : -r * 2 - 1;
    for (let i = 0, x = 0, row = 0; i < n; i++, x++) {
      if (x === w) { x = 0; row++; }
      const west = x ? plane[i - 1] : row ? plane[i - w] : 0, north = row ? plane[i - w] : west, northWest = x && row ? plane[i - w - 1] : west;
      const gradient = Math.max(Math.min(west, north), Math.min(Math.max(west, north), west + north - northWest));
      const change = Math.abs(northWest - north), context = contexts[i] = row * 3 + (change ? change <= 8 ? 1 : 2 : 0);
      const at = context * 512, value = plane[i];
      counts[at + (values[i] = zigzag(value - west))]++;
      counts[classes * 512 + at + (byNorth[i] = zigzag(value - north))]++;
      counts[2 * classes * 512 + at + (byGradient[i] = zigzag(value - gradient))]++;
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
  } else if (step === 1) {
    const errors = new Int32Array(n);
    codeWeighted(null, null, plane, w, h, 0, undefined, new Uint32Array(values.buffer), errors);
    for (let i = 0; i < n; i++) { const e = errors[i]; contexts[i] = WEIGHTED_CONTEXT[e < -255 ? 0 : e > 255 ? 510 : e + 255]; }
    tree = intervals(WEIGHTED_PROPERTY, WEIGHTED_BANDS, band => { const node = leaf(WEIGHTED_PREDICTOR); node.local = band; leaves.push(node); return node; });
    classes = WEIGHTED_BANDS.length + 1;
  } else { predictSmooth(plane, w, h, values, contexts, step); tree = smoothTree(leaves, step); classes = 16; }
  if (classes === 1) { tree.local = 0; leaves.push(tree); }
  const out = pieces(values, contexts, n, minimum, scale);
  if (kind === 'smooth' && step === 1) runCopies(values, out);
  else captureCopies(values, w, kind === 'index' ? 12 : 0, minimum, out);
  const {count, value: pieceValue, distance: pieceDistance, context: pieceContext} = out;
  return {kind, tree, leaves, classes, width: w, plane, minimum, count, pieceValue, pieceDistance, pieceContext};
}

const LITERAL_CONFIGS = [...SCREEN_INTEGER_CONFIGS, ...[5, 6, 7, 8, 9, 10, 11, 12, 13].map(n => uintConfig(n))];
const SMALL = 64;
const MAX_MIN_SYMBOL = 512;
const LOG_MANTISSA = Uint8Array.of(0, 1, 3, 4, 5, 7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 22, 23, 24, 25, 26, 27, 27, 28, 29, 30, 31, 31);
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
function valueCounts(small, large) {
  let size = large.size;
  for (let v = 0; v < SMALL; v++) if (small[v]) size++;
  const values = new Int32Array(size), counts = new Uint32Array(size);
  let i = 0;
  for (let v = 0; v < SMALL; v++) if (small[v]) { values[i] = v; counts[i++] = small[v]; }
  for (const [v, n] of large) { values[i] = v; counts[i++] = n; }
  return {values, counts};
}
function tokenPrice(config, {values, counts}, out) {
  const freqs = out.freqs, {split, msb, lsb, splitToken} = config, low = (1 << lsb) - 1;
  freqs.fill(0, 0, out.top === undefined ? freqs.length : out.top + 1);
  let raw = 0, top = 0, total = 0, used = 0;
  for (let i = 0; i < values.length; i++) {
    const value = values[i], n = counts[i];
    let token = value;
    if (value >= splitToken) {
      const e = 31 - Math.clz32(value), below = value - (1 << e);
      token = splitToken + (((e - split) << (msb + lsb)) | ((below >> (e - msb)) << lsb) | (below & low));
      raw += (e - msb - lsb) * n;
    }
    if (!freqs[token]) used++;
    freqs[token] += n; total += n;
    if (token > top) top = token;
  }
  out.top = top; out.total = total;
  out.bits = total ? entropy(freqs.subarray(0, top + 1), total) + raw + 5 * used : 0;
  return out;
}

const WIDE_DISTANCES = [uintConfig(8, 4, 4), uintConfig(10, 4, 3), uintConfig(10, 5, 4), uintConfig(10, 5, 5), uintConfig(12, 5, 5)];
const DISTANCE_CONFIGS = [...SCREEN_INTEGER_CONFIGS, ...WIDE_DISTANCES];
const DISTANCE_TOKENS = 1 << 15;
function distanceTokens(config, values, out) {
  const token = [0, 0, 0], freqs = out.freqs;
  let raw = 0, top = 0, total = 0;
  freqs.fill(0, 0, out.top === undefined ? freqs.length : out.top + 1);
  for (let i = 0; i < values.values.length; i++) {
    const v = values.values[i], n = values.counts[i];
    hybridToken(config, v, token);
    if (token[0] >= DISTANCE_TOKENS) { out.top = top; return null; }
    freqs[token[0]] += n; raw += token[1] * n; total += n;
    if (token[0] > top) top = token[0];
  }
  out.top = top;
  return {raw, total, top};
}
function distanceEstimate(config, values, out) {
  const counted = distanceTokens(config, values, out);
  if (!counted) return Infinity;
  const freqs = out.freqs, whole = log2x32(counted.total);
  let bits = 0, header = 0, gap = 0;
  for (let i = 0; i <= counted.top; i++) {
    const n = freqs[i];
    if (!n) { gap++; continue; }
    bits += n * (whole - log2x32(n));
    header += 4 + (gap ? gap < 3 ? 3 * gap : 6 : 0); gap = 0;
  }
  return bits / 32 + counted.raw + header;
}
function distancePrice(config, values, out) {
  const {raw, top} = distanceTokens(config, values, out), freqs = out.freqs;
  const code = priceCode(freqs.subarray(0, top + 1)), header = new BitWriter(256);
  writeUintConfig(header, config, 15); writePrefixCode(header, code);
  let bits = raw + header.bitLength;
  for (let i = 0; i <= top; i++) bits += freqs[i] * code.lengths[i];
  return {bits, code};
}

const CLUSTER_CONFIG = uintConfig(4, 1, 1), CLUSTER_TOKENS = 128, CLUSTER_HEADER = 128;
function clusterCost(freqs) {
  let total = 0, used = 0;
  for (let i = 0; i < CLUSTER_TOKENS; i++) if (freqs[i]) { total += freqs[i]; used++; }
  return total ? entropy(freqs, total) + 5 * used + CLUSTER_HEADER : 0;
}
function countTokens(freqs, h, config, lengthConfig, at, top) {
  const token = [0, 0, 0], add = (c, v, n, from) => { hybridToken(c, v, token); freqs[from + Math.min(token[0], top)] += n; };
  for (let v = 0; v < SMALL; v++) if (h.small[v]) add(config, v, h.small[v], 0);
  for (const [v, n] of h.large) add(config, v, n, 0);
  for (const [v, n] of h.lengths) add(lengthConfig, v, n, at);
  return freqs;
}
function clusterHistograms(live) {
  const n = live.length, freqs = live.map(h => countTokens(new Uint32Array(CLUSTER_TOKENS), h, CLUSTER_CONFIG, CLUSTER_CONFIG, 64, 63));
  const cost = freqs.map(clusterCost), alive = new Uint8Array(n).fill(1), parent = Int32Array.from({length: n}, (_, i) => i);
  const both = new Uint32Array(CLUSTER_TOKENS), delta = new Float64Array(n * n);
  const gain = (a, b) => { for (let t = 0; t < CLUSTER_TOKENS; t++) both[t] = freqs[a][t] + freqs[b][t]; return clusterCost(both) - cost[a] - cost[b]; };
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) delta[a * n + b] = gain(a, b);
  for (;;) {
    let best = 0, ba = -1, bb = -1;
    for (let a = 0; a < n; a++) if (alive[a]) for (let b = a + 1; b < n; b++) if (alive[b] && delta[a * n + b] < best) { best = delta[a * n + b]; ba = a; bb = b; }
    if (ba < 0) break;
    for (let t = 0; t < CLUSTER_TOKENS; t++) freqs[ba][t] += freqs[bb][t];
    cost[ba] = clusterCost(freqs[ba]); alive[bb] = 0; parent[bb] = ba;
    const into = live[ba], from = live[bb];
    for (let v = 0; v < SMALL; v++) into.small[v] += from.small[v];
    for (const [v, c] of from.large) into.large.set(v, (into.large.get(v) || 0) + c);
    for (const [v, c] of from.lengths) into.lengths.set(v, (into.lengths.get(v) || 0) + c);
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
  const histograms = [], distances = new Map();
  for (const model of models) {
    model.base = histograms.length;
    for (let c = 0; c < model.classes; c++) histograms.push({small: new Uint32Array(SMALL), large: new Map(), lengths: new Map(), literals: 0, copies: 0});
    for (let k = 0; k < model.count; k++) {
      const target = histograms[model.base + model.pieceContext[k]], value = model.pieceValue[k], d = model.pieceDistance[k];
      if (d) { target.lengths.set(value, (target.lengths.get(value) || 0) + 1); target.copies++; distances.set(d, (distances.get(d) || 0) + 1); }
      else { if (value < SMALL) target.small[value]++; else target.large.set(value, (target.large.get(value) || 0) + 1); target.literals++; }
    }
  }
  let live = histograms.filter(h => h.literals + h.copies);
  const index = new Int32Array(histograms.length);
  for (let i = 0, next = 0; i < histograms.length; i++) index[i] = histograms[i].literals + histograms[i].copies ? next++ : 0;
  if (live.length > 1 && models.some(model => model.kind === 'index' && !model.group)) {
    const {groups, of} = clusterHistograms(live);
    for (let i = 0; i < histograms.length; i++) index[i] = of[index[i]];
    live = groups;
  }
  const scratch = {freqs: new Uint32Array(DISTANCE_TOKENS)}, none = new Uint32Array(SMALL), token = [0, 0, 0];
  for (const h of live) {
    const literals = valueCounts(h.small, h.large);
    h.lengthCounts = valueCounts(none, h.lengths);
    let largest = 0;
    for (const v of literals.values) if (v > largest) largest = v;
    h.options = h.literals ? LITERAL_CONFIGS.map(config => {
      if (distances.size) { hybridToken(config, largest, token); if (token[0] >= MAX_MIN_SYMBOL) return {config, bits: Infinity, top: token[0]}; }
      const {bits, top} = tokenPrice(config, literals, scratch);
      return {config, bits, top};
    }) : [{config: LITERAL_CONFIGS[0], bits: 0, top: 0}];
  }
  let length = {config: LZ77.lengthConfig, bits: 0};
  if (distances.size) {
    length = null;
    for (const config of SCREEN_INTEGER_CONFIGS) {
      let bits = 0;
      for (const h of live) if (h.copies) bits += tokenPrice(config, h.lengthCounts, scratch).bits;
      if (!length || bits < length.bits) length = {config, bits};
    }
  }
  let choice;
  for (const minSymbol of distances.size ? [224, MAX_MIN_SYMBOL] : [224]) {
    let bits = 0;
    const configs = live.map(h => {
      let best;
      for (const option of h.options) if ((!distances.size || option.top < minSymbol) && (!best || option.bits < best.bits)) best = option;
      if (best) bits += best.bits;
      return best;
    });
    if (configs.every(Boolean) && (!choice || bits + minSymbol / 64 < choice.bits)) choice = {minSymbol, configs, bits: bits + minSymbol / 64};
  }
  const codes = live.map((h, m) => buildCode(countTokens(new Uint32Array(Math.max(choice.configs[m].top + 1, choice.minSymbol + 1024)),
    h, choice.configs[m].config, length.config, choice.minSymbol, Infinity)));
  let distance;
  const map = distances.size ? screenDistanceMap(Math.max(...models.map(model => model.width))) : null;
  if (map) {
    const spatial = new Map(), generic = new Map();
    for (const [d, n] of distances) {
      const s = map.get(d) ?? d + 119, g = d === 1 ? 1 : d + 119;
      spatial.set(s, (spatial.get(s) || 0) + n); generic.set(g, (generic.get(g) || 0) + n);
    }
    const ranked = [];
    for (const [kind, values] of [[true, valueCounts(none, spatial)], [false, valueCounts(none, generic)]]) for (const config of DISTANCE_CONFIGS)
      ranked.push({config, kind, values, estimate: distanceEstimate(config, values, scratch)});
    ranked.sort((a, b) => a.estimate - b.estimate);
    for (const {config, kind, values} of ranked.slice(0, 2)) {
      const priced = distancePrice(config, values, scratch);
      if (!distance || priced.bits < distance.bits) distance = {...priced, config, spatial: kind};
    }
    distance.code.codes = canonicalCodes(distance.code.lengths);
  }
  const offset = distance ? 1 : 0, contextMap = new Uint8Array(ordered.length + offset);
  for (const model of models) for (const node of model.leaves) contextMap[node.context] = index[model.base + node.local] + offset;
  writeHistograms(writer, {
    lz77: distance ? {minSymbol: choice.minSymbol, minLength: models[0].minimum, lengthConfig: length.config} : null,
    contextMap,
    histograms: [...(distance ? [{config: distance.config, code: distance.code}] : []),
      ...codes.map((code, m) => ({config: choice.configs[m].config, code}))]
  });
  return () => {
    for (const model of models) for (let k = 0; k < model.count; k++) {
      const h = index[model.base + model.pieceContext[k]], value = model.pieceValue[k], d = model.pieceDistance[k];
      if (d) {
        writeHybrid(writer, codes[h], length.config, value, choice.minSymbol);
        writeHybrid(writer, distance.code, distance.config, distance.spatial ? (map.get(d) ?? d + 119) : d === 1 ? 1 : d + 119);
      } else writeHybrid(writer, codes[h], choice.configs[h].config, value);
    }
  };
}

function groupChannels(rgba, stride, x, y, w, h, shape, {maxError}) {
  const scan = scanColours(rgba, stride, x, y, w, h, Math.min(PALETTE_LIMIT, (w * h) >> 3));
  if (scan) {
    const index = channelModel(scan.indices, w, h, 'index', 1, 3); index.group = true;
    const {meta, model} = paletteModel(scan.colours, [index], shape, 3);
    return {transforms: [meta.transform], models: [model, index]};
  }
  const sample = c => {
    const plane = new Int32Array(w * h);
    for (let row = 0, at = 0; row < h; row++) for (let p = ((y + row) * stride + x) * 4 + c, end = p + w * 4; p < end; p += 4) plane[at++] = rgba[p];
    return plane;
  };
  const step = 2 * maxError + 1, models = [];
  let transforms = [];
  if (shape.colour === 1) models.push(channelModel(sample(0), w, h, 'smooth', step));
  else {
    const green = sample(1);
    models.push(channelModel(green, w, h, 'smooth', step));
    for (const c of [2, 0]) {
      const plane = sample(c);
      for (let i = 0; i < plane.length; i++) plane[i] -= green[i];
      models.push(channelModel(plane, w, h, 'smooth', step));
    }
    transforms = [{type: 'rct', beginC: 0, rctType: 10}];
  }
  if (shape.alpha) models.push(channelModel(sample(3), w, h, 'smooth'));
  return {transforms, models};
}

function shapeOf(keys, margin = keys[0]) {
  let grey = !((margin ^ margin >>> 8) & 0xffff), opaque = margin >>> 24 === 255;
  for (let i = 0; i < keys.length && (grey || opaque); i++) {
    const key = keys[i];
    if (key >>> 24 !== 255) opaque = false;
    if ((key ^ key >>> 8) & 0xffff) grey = false;
  }
  const colour = grey ? 1 : 3;
  return {colour, alpha: !opaque, channels: colour + (opaque ? 0 : 1)};
}

function* captureFrameSteps(pixels, width, height, shape, coding, frame, header, placement) {
  const layout = groupLayout(width, height, DIM), groups = layout.groupsX * layout.groupsY, sections = [];
  writeModularFrameHeader(header, {alpha: shape.alpha, shift: 3, ...placement});
  let total = 0;
  const append = bytes => { total += bytes.length; admitOutputSize(total); sections.push(bytes); };
  const indexModels = frame ? Array.from({length: groups}, (_, g) => {
    const [x, y, w, h] = groupRect(layout, width, height, g, DIM), indices = new Int32Array(w * h);
    const {stride = width, x: fx = 0, y: fy = 0} = frame;
    for (let row = 0, p = (fy + y) * stride + fx + x; row < h; row++, p += stride) indices.set(frame.indices.subarray(p, p + w), row * w);
    return channelModel(indices, w, h, 'index', 1, 3);
  }) : null;
  const palette = frame ? paletteModel(frame.colours, indexModels, shape, layout.single ? 3 : 4) : null;
  const global = new BitWriter(1024);
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
  const crop = screenCrop(source, imageWidth, imageHeight);
  const width = crop ? crop.width : imageWidth, height = crop ? crop.height : imageHeight;
  const scan = scanColours(source, imageWidth, crop?.x ?? 0, crop?.y ?? 0, width, height, PALETTE_LIMIT, true), bands = screenBands(scan, width, height);
  const header = new BitWriter(128);
  if (!bands) return yield* pictureSteps(source, imageWidth, imageHeight, colorSpace, coding, header, null, crop, scan);
  const shape = shapeOf(scan.colours, crop ? pixelKeys(crop.background)[0] : undefined), frames = [], count = bands.length - 1;
  writeImageHeader(header, imageWidth, imageHeight, shape.colour, shape.alpha, {colorSpace});
  if (crop) writeScreenBackground(header, imageWidth, imageHeight, shape, crop.background);
  for (let b = 0; b < count; b++) {
    const y = bands[b], rows = bands[b + 1] - y, band = {x: crop?.x ?? 0, y: (crop?.y ?? 0) + y, shape, last: b + 1 === count};
    const part = crop && width !== imageWidth ? crop.data.subarray(y * width * 4, (y + rows) * width * 4)
      : source.subarray(((crop?.y ?? 0) + y) * imageWidth * 4, ((crop?.y ?? 0) + y + rows) * imageWidth * 4);
    frames.push(yield* scaledSteps(pictureSteps(part, width, rows, colorSpace, coding, b ? new BitWriter(64) : header, band,
      screenCrop(part, width, rows), {colours: scan.colours, indices: scan.indices.subarray(y * width, (y + rows) * width)}), b / count, 1 / count));
  }
  return concatenate(frames);
}

function concatenate(frames) {
  let length = 0;
  for (const f of frames) length += f.length;
  admitOutputSize(length);
  const out = new Uint8Array(length);
  for (let i = 0, at = 0; i < frames.length; at += frames[i++].length) out.set(frames[i], at);
  return out;
}

function* pictureSteps(source, imageWidth, imageHeight, colorSpace, coding, header, band, crop, scan) {
  const width = crop ? crop.width : imageWidth, height = crop ? crop.height : imageHeight;
  let frame = scan;
  if (band && crop && scan) {
    const indices = new Uint16Array(width * height);
    for (let y = 0; y < height; y++) indices.set(scan.indices.subarray((crop.y + y) * imageWidth + crop.x, (crop.y + y) * imageWidth + crop.x + width), y * width);
    frame = {colours: scan.colours, indices};
  }
  const pixels = !crop ? source : frame ? null : crop.data;
  const at = r => band ? {...r, x: r.x + band.x, y: r.y + band.y} : r, whole = {x: 0, y: 0, width: imageWidth, height: imageHeight};
  const final = !band || band.last;
  let partition = frame && screenColumns(source, imageWidth, imageHeight) || screenRegions(source, imageWidth, imageHeight);
  if (partition) {
    const x0 = crop?.x ?? 0, y0 = crop?.y ?? 0, x1 = x0 + width, y1 = y0 + height;
    const regions = partition.regions.map(r => {
      const x = Math.max(r.x, x0), y = Math.max(r.y, y0);
      return {x, y, width: Math.min(r.x + r.width, x1) - x, height: Math.min(r.y + r.height, y1) - y};
    }).filter(r => r.width > 0 && r.height > 0 && r.width < imageWidth && r.width * r.height >= 20000);
    partition = regions.length ? {...partition, regions} : null;
  }
  const shape = band ? band.shape : shapeOf(frame ? frame.colours : pixelKeys(partition ? source : pixels), crop ? pixelKeys(crop.background)[0] : undefined);
  if (!band) writeImageHeader(header, imageWidth, imageHeight, shape.colour, shape.alpha, {colorSpace});
  if (!partition) {
    if (crop) writeScreenBackground(header, imageWidth, imageHeight, shape, crop.background, band && at(whole));
    const placement = crop ? {crop: at({x: crop.x, y: crop.y, width, height})} : band ? {crop: at(whole)} : {};
    return yield* captureFrameSteps(pixels, width, height, shape, coding, frame, header, final ? placement : {...placement, last: false, reference: 1});
  }
  const {regions, background} = partition, frames = [];
  let body = source, base;
  const blank = fill => { for (const r of regions) for (let y = r.y; y < r.y + r.height; y++) fill(y * imageWidth + r.x, y * imageWidth + r.x + r.width); };
  const backgroundIndex = frame ? frame.colours.indexOf(background) : -1,
    marginIndex = crop ? frame ? frame.colours.indexOf(pixelKeys(crop.background)[0]) : -1 : backgroundIndex;
  if (backgroundIndex >= 0 && marginIndex >= 0) {
    const indices = new Uint16Array(imageWidth * imageHeight).fill(marginIndex), cx = crop?.x ?? 0, cy = crop?.y ?? 0;
    for (let y = 0; y < height; y++) indices.set(frame.indices.subarray(y * width, (y + 1) * width), (y + cy) * imageWidth + cx);
    blank((from, to) => indices.fill(backgroundIndex, from, to));
    base = {colours: frame.colours, indices};
  } else {
    body = Uint8Array.from(source);
    const [r, g, b, a] = [0, 8, 16, 24].map(shift => background >>> shift & 255);
    blank((from, to) => { for (let p = 4 * from; p < 4 * to; p += 4) { body[p] = r; body[p + 1] = g; body[p + 2] = b; body[p + 3] = a; } });
    base = scanColours(body, imageWidth, 0, 0, imageWidth, imageHeight, PALETTE_LIMIT);
  }
  const count = regions.length + 1;
  frames.push(yield* scaledSteps(captureFrameSteps(body, imageWidth, imageHeight, shape, coding, base, header,
    {...band && {crop: at(whole)}, last: false, reference: 1}), 0, 1 / count));
  for (let i = 0; i < regions.length; i++) {
    const r = regions[i], placement = {crop: at(r), last: final && i + 1 === regions.length, reference: 1};
    let part = null, local;
    if (frame) local = {colours: frame.colours, indices: frame.indices, stride: width, x: r.x - (crop?.x ?? 0), y: r.y - (crop?.y ?? 0)};
    else {
      part = new Uint8Array(r.width * r.height * 4);
      for (let y = 0; y < r.height; y++) part.set(source.subarray(((r.y + y) * imageWidth + r.x) * 4, ((r.y + y) * imageWidth + r.x + r.width) * 4), y * r.width * 4);
      local = scanColours(part, r.width, 0, 0, r.width, r.height, PALETTE_LIMIT);
    }
    frames.push(yield* scaledSteps(captureFrameSteps(part, r.width, r.height, shape, coding, local, new BitWriter(64), placement), (i + 1) / count, 1 / count));
  }
  return concatenate(frames);
}

function admitCapture(data, width, height, options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw fault('JXL_INPUT', 'Capture options are an object.');
  const maxError = options.maxError ?? 0;
  if (!Number.isInteger(maxError) || maxError < 0 || maxError > 8)
    throw fault('JXL_INPUT', 'maxError is a whole number from 0 to 8. Zero preserves every sample.');
  const {colorSpace} = admitOptions({colorSpace: options.colorSpace});
  admitPixels(data, width, height);
  if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray)) throw fault('JXL_INPUT', 'Captures use straight RGBA8 samples.');
  return {colorSpace, coding: {maxError}};
}

export function encodeCaptureBytes(data, width, height, options = {}) {
  const aborted = () => { if (options?.signal?.aborted) throw fault('JXL_ABORTED', 'JPEG XL encoding was canceled.'); };
  aborted();
  const {colorSpace, coding} = admitCapture(data, width, height, options);
  const bytes = complete(job(captureSteps(data, width, height, colorSpace, coding)));
  aborted();
  return bytes;
}
