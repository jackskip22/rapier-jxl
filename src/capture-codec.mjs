// SPDX-License-Identifier: MIT
import {unit, stage, carried, journaling, unread, PASSED} from './step-journal.mjs';
import {BitWriter, packSigned} from './bits.mjs';
import {admitOptions, admitPixels, admitSize, admitOutputSize, answer, fault, guard} from './admit.mjs';
import {SCREEN_INTEGER_CONFIGS, screenDistanceMap} from './screen-codes.mjs';
import {fullFrame, groupLayout, groupRect, writeHeaderFields as generalHeader, writeModularFrameHeader as generalFrame, assembleCodestream as generalAssembly} from './frame.mjs';
import {writeCaptureHeaderFields, writeCaptureFrameHeader, assembleCaptureCodestream, writeCaptureModularHeader} from './capture-headers.mjs';
import {pixelKeys, screenColumns, screenCrop, screenRegions, viewPixels, writeScreenBackground} from './screen-crop.mjs';
import {LZ77, leaf, split, writeTree, writeModularHeader as generalModular} from './modular.mjs';
import {WEIGHTED_PREDICTOR, WEIGHTED_PROPERTY} from './weighted-policy.mjs';
import {kernelFail, captureCopies, captureHold, captureRelease, captureLiterals, captureTokens, capturePieceCounts, capturePrices, LOG_MANTISSA, captureScan, captureDenseTiles, treeArena, captureWeighted, captureWeightedLanes, captureWeightedPieces, compileCaptureKernels, requireCaptureKernels, WEIGHTED_BANDS, WEIGHTED_CONTEXT} from './capture-kernels.mjs';
import {capturePatches, capturePeel, fillPatches, writeAtlasFrameHeader, writeCapturePatches, writePatchedFrameHeader} from './capture-patches.mjs';
import {buildCode, canonicalCodes, compactCode, hybridToken, prefixCodeBits, uintConfig, writeHistograms, writeUintConfig} from './prefix.mjs';

const SMALL_FLOOR = 1 << 16, NEAREST_LIMIT = 4096, DIM = 1024, PALETTE_LIMIT = 16384, RARE_PALETTE = 8192, SMALL_PICTURE = 1 << 18;
const NEVER = 1 << 30;
export const DEFAULT_EFFORT = 3;
const L3 = {indexDepth: 24, lazyUnder: NEVER, nice: NEVER, tree: {split: 96, min: 128, nodes: 48}, prices: 4, weighted: 'sample',
  palette: 'scan', routes: 'rare', alphaPlane: 'soft', patches: 'one', floor: false, oneFrame: true, smallGroups: true, needs: []};
const L4 = {...L3, rowCopies: true, indexRamp: true, patches: 'peel', indexDepth: 64, tree: {split: 96, min: 128, nodes: 96}, prices: 50, routes: 'all', alphaPlane: 'all', floor: true, smallGroups: false};
const L5 = {...L4, weighted: 'both', palette: 'both', rcts: [6]};
function deepLevels() {
  const L6 = {...L5, trees: 'learned', needs: ['trees']};
  const L7 = {...L6, ans: true, gpu: true, needs: ['ans', 'trees']};
  const NINE = [{peelLeast: 0}, {minCopy: 5}, {glyph: 10}, {common: 32}, {minCopy: 4}, {glyph: 24}, {common: 8}, {lazyUnder: 8},
    {learnRcts: [6, 0, 1, 2, 3, 4, 5], learn: {samples: 1 << 22}}, {signs: true, tree: {split: 32, min: 32, nodes: 384}}, {morton: true},
    {channels: true}, {indexPredict: true}];
  const L8 = {...L7, also: NINE.slice(0, 4).map(delta => ({...L7, ...delta, delta}))};
  const L9 = {...L7, needs: ['ans', 'trees', 'signs'], combine: true, also: NINE.map(delta => ({...L7, ...delta, delta}))};
  return [L6, L7, L8, L9];
}
const FLOOR2 = {...L3, indexDepth: 16, lazyUnder: 32, routes: 'one', alphaPlane: 'never', patches: false};
export const LEVELS = [null,
  {...L3, indexDepth: 4, lazyUnder: 0, nice: 16, tree: {split: 96, min: 512, nodes: 16}, prices: 2, routes: 'one', alphaPlane: 'never', patches: false,
    gradient: true},
  {...L3, routes: 'one', alphaPlane: 'never', patches: false},
  L3, ...((typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true || typeof __RAPIER_JXL_JPEG__ !== 'undefined' && __RAPIER_JXL_JPEG__ === true) ? [] : [L4, L5]), ...((typeof __RAPIER_JXL_CAPTURE_DEEP__ === 'undefined' || __RAPIER_JXL_CAPTURE_DEEP__) && !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) ? deepLevels() : [])];
const L1_ANSWER = {...L3, routes: 'one', alphaPlane: 'never', patches: false, gradient: true};
export const captureAnswerLevel = (effort, pixels) => effort === 1 && pixels > SMALL_PICTURE ? {[CAPTURE_LEVEL]: L1_ANSWER} : null;
let L = L3;
let shapeFloor = null;
export const CAPTURE_TOOLS = Symbol('capture tools');
export const CAPTURE_TOOLS_LEAN = Object.freeze({top: 5, next: 'rapier-jxl/capture-complete'});
let tools = CAPTURE_TOOLS_LEAN;
const writeHeaderFields = typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true ? writeCaptureHeaderFields : generalHeader;
const writeModularFrameHeader = typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true ? writeCaptureFrameHeader : generalFrame;
const writeModularHeader = typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true ? writeCaptureModularHeader : generalModular;
const assembleCodestream = typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true ? assembleCaptureCodestream : generalAssembly;

export {compileCaptureKernels};
export const CAPTURE_PREDICTOR_PROBE = /* @__PURE__ */ Symbol('capture predictor choices');
export const CAPTURE_BASE = Symbol('capture base layer');
export const CAPTURE_FLOOR = /* @__PURE__ */ Symbol('capture channel floor');
export const CAPTURE_PATCHES = Symbol('capture patches');
export const CAPTURE_TIMING = /* @__PURE__ */ Symbol('capture stage timing');
export const CAPTURE_HELPERS = Symbol('capture helpers');
export const CAPTURE_GPU = /* @__PURE__ */ Symbol('capture gpu');
export const CAPTURE_TRACE = /* @__PURE__ */ Symbol('capture byte trace');
export const CAPTURE_LEVEL = Symbol('capture level');
let timing = null, inner = 0;
function timed(stage, work) {
  if (typeof __RAPIER_JXL_PROBES__ !== 'undefined' || !timing) return work();
  const t0 = performance.now(), outer = inner;
  inner = 0;
  try { return work(); } finally {
    const spent = performance.now() - t0;
    timing[stage] = (timing[stage] || 0) + spent - inner; inner = outer + spent;
  }
}

function scanColours(rgba, stride, x0, y0, w, h, limit, rows = false, blank = null) {
  if (limit === 0) return null;
  const scan = captureScan(pixelKeys(rgba), stride, x0, y0, w, h, Math.min(limit, w * h), rows, blank);
  if (scan === undefined) throw kernelFail();
  return scan;
}
const spreadBits = v => { v &= 255; v = (v | v << 8) & 0x00f00f; v = (v | v << 4) & 0x0c30c3; return (v | v << 2) & 0x249249; };
const mortonKey = c => ((c >>> 24) * 16777216 + (spreadBits(c) << 2 | spreadBits(c >>> 8) << 1 | spreadBits(c >>> 16))) >>> 0;
const rgbaKey = c => ((c & 255) << 24 | (c >>> 8 & 255) << 16 | (c >>> 16 & 255) << 8 | c >>> 24) >>> 0;
export function captureSkewEligible(freq, total) {
  const sorted = freq.slice().sort(), n = freq.length;
  let top8 = 0;
  for (let i = Math.max(0, n - 8); i < n; i++) top8 += sorted[i];
  return !(top8 * 4 < total * 3 || sorted[n - 1] * 20 > total * 13);
}
export function captureSkewBits(freq, total, bits, from, to) {
  const whole = log2x32(total);
  for (let i = from; i < to; i++) if (freq[i]) bits[i] = Math.max(32, whole - log2x32(freq[i]));
}
export function captureSkewCopyCost(d, w) {
  const codes = spatialLookup(w)[1], spatial = d < codes.length && codes[d] >= 0;
  return 32 * (d === 1 || d === w ? 6 : spatial ? 10 : 7 + 31 - Math.clz32(d + 119)) + 32;
}

function pruneSkewCopies(model, n) {
  const {plane, stride, origin, width: w, height: h, minimum, count, pieceValue: V, pieceDistance: D} = model, total = w * h;
  let copies = 0;
  for (let k = 0; k < count; k++) if (D[k]) copies++;
  if (copies * 16 < total) return;
  const freq = new Uint32Array(n);
  for (let y = 0, row = origin; y < h; y++, row += stride) for (let x = 0; x < w; x++) freq[plane[row + x]]++;
  if (!captureSkewEligible(freq, total)) return;
  const bits = new Uint16Array(n);
  captureSkewBits(freq, total, bits, 0, n);
  const expand = new Uint8Array(count);
  let expanded = 0, kept = 0;
  for (let k = 0, x = 0, y = 0; k < count; k++) {
    const d = D[k];
    if (!d) { if (++x === w) { x = 0; y++; } continue; }
    const len = V[k] + minimum, copy = captureSkewCopyCost(d, w);
    let literal = 0;
    for (let j = 0, cx = x, i = origin + y * stride + x; j < len && literal <= copy; j++) {
      literal += bits[plane[i]];
      if (++cx === w) { cx = 0; i += stride - w + 1; } else i++;
    }
    if (literal <= copy) { expand[k] = 1; expanded += len - 1; } else kept++;
    x += len; while (x >= w) { x -= w; y++; }
  }
  if (!expanded) return;
  if (kept * 64 < copies) expand.fill(1);
  let size = 0;
  for (let k = 0; k < count; k++) size += D[k] && expand[k] ? V[k] + minimum : 1;
  const value = new Int32Array(size), distance = new Int32Array(size);
  for (let k = 0, j = 0, p = 0; k < count; k++) {
    if (D[k] && expand[k]) {
      for (let e = p + V[k] + minimum; p < e; p++) value[j++] = 2 * plane[origin + (p / w | 0) * stride + p % w];
      continue;
    }
    value[j] = V[k]; distance[j++] = D[k]; p += D[k] ? V[k] + minimum : 1;
  }
  model.count = size; model.pieceValue = value; model.pieceDistance = distance; model.pieceContext = new Uint8Array(size);
}

function paletteModel(colours, models, shape) {
  for (const m of models) if (m.kind === 'index' && !m.group) timed('prune', () => pruneSkewCopies(m, colours.length));
  const n = colours.length, uses = captureLiterals(models, n), common = [];
  let rare = 0;
  for (let i = 0; i < n; i++) if (uses[i] >= (L.common ?? 16)) common.push(i); else if (uses[i]) rare++;
  common.sort((a, b) => uses[b] - uses[a] || colours[a] - colours[b]);
  for (let lo = 4; lo < common.length; lo *= 2) {
    const hi = Math.min(common.length, lo * 2), slice = common.slice(lo, hi).sort((a, b) => rgbaKey(colours[a]) - rgbaKey(colours[b]));
    for (let j = lo; j < hi; j++) common[j] = slice[j - lo];
  }
  const keys = new Float64Array(rare);
  for (let i = 0, j = 0; i < n; i++) if (uses[i] && uses[i] < (L.common ?? 16)) {
    const c = colours[i];
    keys[j++] = ((typeof __RAPIER_JXL_CAPTURE_DEEP__ === 'undefined' || __RAPIER_JXL_CAPTURE_DEEP__) && !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && L.morton ? mortonKey(c) : rgbaKey(c)) * 65536 + i;
  }
  keys.sort();
  const order = new Int32Array(common.length + rare), sorted = new Uint32Array(order.length), remap = new Int32Array(n);
  order.set(common);
  for (let j = 0; j < rare; j++) order[common.length + j] = keys[j] % 65536;
  for (let j = 0; j < order.length; j++) { sorted[j] = colours[order[j]]; remap[order[j]] = j; }
  const rows = m => ((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || !__RAPIER_JXL_UPLOAD__) && (typeof __RAPIER_JXL_JPEG__ === 'undefined' || !__RAPIER_JXL_JPEG__)) && L.rowCopies ? channelModel(m.plane, m.width, m.height, 'rows', 1, models[0]?.minimum ?? 3, true, m.width, 0, false, true)
    : channelModel(m.plane, m.width, m.height, 'rows');
  let meta = paletteMeta(sorted, shape), model = rows(meta);
  if (rare >= 16 && rare >= 2 * common.length && rare <= NEAREST_LIMIT) {
    const from = common.length, walk = order.slice();
    walked(colours, order, from, walk);
    const path = new Uint32Array(walk.length);
    for (let j = 0; j < walk.length; j++) path[j] = colours[walk[j]];
    const other = paletteMeta(path, shape), otherModel = rows(other);
    if (rowsBits(otherModel) < rowsBits(model)) {
      meta = other; model = otherModel;
      for (let j = 0; j < walk.length; j++) { order[j] = walk[j]; remap[walk[j]] = j; }
    }
  }
  captureLiterals(models, n, remap);
  for (const m of models) timed('tree', () => learnContexts(m, remap, common.length, order.length));
  return {meta, model};
}

const TREE_TOKENS = 128;
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
  if ((typeof __RAPIER_JXL_CAPTURE_DEEP__ === 'undefined' || __RAPIER_JXL_CAPTURE_DEEP__) && !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && L.signs && tools.signs) cuts.push([-1, 0], [-1, 0], [-1, 0]);
  const span = (Math.max(...cuts.map(c => c.length)) + 1) * TREE_TOKENS, arena = (typeof __RAPIER_JXL_CAPTURE_DEEP__ === 'undefined' || __RAPIER_JXL_CAPTURE_DEEP__) && !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && cuts.length > 4 ? tools.signs.arena(count, span, cuts.length) : treeArena(count, span), {by, bx, bw, bn, tokens, order} = arena;
  pieceBins(plane, model.stride, model.origin, w, model.pieceValue, model.pieceDistance, model.minimum, count, yBin, xBin, binOf, tokens, by, bx, bw, bn, order);
  if ((typeof __RAPIER_JXL_CAPTURE_DEEP__ === 'undefined' || __RAPIER_JXL_CAPTURE_DEEP__) && !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && cuts.length > 4) tools.signs.bins(plane, model.stride, model.origin, w, model.pieceValue, model.pieceDistance, model.minimum, count, remap, arena.bins);
  const s = {cuts, order, nlog: nlogTable(count), context: model.pieceContext, all: arena.all, counts: arena.counts,
    tally: arena.tally, part: arena.part, low: new Uint32Array(TREE_TOKENS), used: new Uint8Array(TREE_TOKENS),
    span, leaves: [], nodes: 0, split: L.tree.split, min: L.tree.min, most: L.tree.nodes, cut: 0};
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

const TREE_PROPERTY = [2, 3, 7, 6, 10, 11, 12];
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
    for (let p = 0; p < s.cuts.length; p++) {
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

let lastWalk = null;
function walked(colours, order, from, walk) {
  const w = lastWalk;
  if (w && w.from === from && w.order.length === order.length && w.colours.length === colours.length && w.order.every((v, i) => v === order[i] && w.colours[v] === colours[v])) {
    walk.set(w.walk); return;
  }
  nearestWalk(colours, order.subarray(from), walk.subarray(from), colours[from ? order[from - 1] : order[from]]);
  lastWalk = {from, order: order.slice(), colours: colours.slice(), walk: walk.slice()};
}

function nearestWalk(colours, left, out, start) {
  const state = captureNearestStart(colours, left, start);
  captureNearestRange(state, left, out, left.length);
}
export function captureNearestStart(colours, left, start) {
  const m = left.length, cells = new Int32Array(4097), cellOf = new Int32Array(m), byCell = new Int32Array(m), at = new Int32Array(m);
  const r = new Int32Array(m), g = new Int32Array(m), b = new Int32Array(m), a = new Int32Array(m);
  for (let k = 0; k < m; k++) {
    const c = colours[left[k]];
    r[k] = c & 255; g[k] = c >>> 8 & 255; b[k] = c >>> 16 & 255; a[k] = c >>> 24;
    cellOf[k] = (r[k] >> 4) << 8 | (g[k] >> 4) << 4 | b[k] >> 4; cells[cellOf[k] + 1]++;
  }
  for (let i = 0; i < 4096; i++) cells[i + 1] += cells[i];
  const ends = cells.slice(0, 4096);
  for (let k = 0; k < m; k++) { at[k] = ends[cellOf[k]]; byCell[ends[cellOf[k]]++] = k; }
  return {cells, cellOf, byCell, at, r, g, b, a, ends, next: 0, last: start};
}
export function captureNearestRange(state, left, out, through) {
  const {cells, cellOf, byCell, at, r, g, b, a, ends} = state;
  let ar = state.last & 255, ag = state.last >>> 8 & 255, ab = state.last >>> 16 & 255, aa = state.last >>> 24;
  for (let j = state.next; j < through; j++) {
    let best = -1, d = 1 << 30;
    const cr = ar >> 4, cg = ag >> 4, cb = ab >> 4;
    for (let ring = 0; ring < 16; ring++) {
      for (let x = Math.max(0, cr - ring); x <= Math.min(15, cr + ring); x++) for (let y = Math.max(0, cg - ring); y <= Math.min(15, cg + ring); y++) {
        const edge = Math.abs(x - cr) === ring || Math.abs(y - cg) === ring;
        for (let z = cb - ring; z <= cb + ring; z += edge || !ring ? 1 : 2 * ring) {
          if (z < 0 || z > 15) continue;
          const cell = x << 8 | y << 4 | z;
          for (let i = cells[cell], e = ends[cell]; i < e; i++) {
            const k = byCell[i], t = Math.abs(ar - r[k]) + Math.abs(ag - g[k]) + Math.abs(ab - b[k]) + Math.abs(aa - a[k]);
            if (t < d || t === d && k < best) { d = t; best = k; }
          }
        }
      }
      if (best >= 0 && d <= ring * 16) break;
    }
    const cell = cellOf[best], last = --ends[cell], moved = byCell[last];
    byCell[at[best]] = moved; at[moved] = at[best]; byCell[last] = best; at[best] = last;
    out[j] = left[best]; ar = r[best]; ag = g[best]; ab = b[best]; aa = a[best];
  }
  state.next = through;
  state.last = (ar | ag << 8 | ab << 16 | aa << 24) >>> 0;
}

function rowsBits({count, pieceValue: V, pieceDistance: D, pieceContext: C, classes}) {
  const counts = new Uint32Array(classes * 512);
  let bits = 0;
  for (let i = 0; i < count; i++) if (((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || !__RAPIER_JXL_UPLOAD__) && (typeof __RAPIER_JXL_JPEG__ === 'undefined' || !__RAPIER_JXL_JPEG__)) && D[i]) bits += 10 + pieceBits(V[i]) + 31 - Math.clz32(D[i] + 1); else counts[C[i] * 512 + V[i]]++;
  for (let c = 0; c < classes; c++) bits += entropy(counts.subarray(c * 512, c * 512 + 512));
  return bits;
}
function rowsPieces(values, w, h, contexts, classes, minimum) {
  const n = w * h, plain = {count: n, value: values, distance: new Int32Array(n), context: contexts};
  const c = captureCopies(Uint16Array.from(values), w, 0, w, h, contexts, L.indexDepth, minimum, 1, spatialLookup(w)[0], L.lazyUnder, L.nice);
  const bits = p => rowsBits({count: p.count, pieceValue: p.value, pieceDistance: p.distance, pieceContext: p.context, classes});
  return bits(c) + 32 < bits(plain) ? c : plain;
}
function paletteMeta(colours, shape) {
  const n = colours.length, channels = shape.channels, rows = new Int32Array(n * channels);
  for (let c = 0; c < channels; c++) for (let i = 0; i < n; i++)
    rows[c * n + i] = (colours[i] >>> (8 * (shape.colour === 1 && c === 1 ? 3 : c))) & 255;
  return {plane: rows, width: n, height: channels, transform: {type: 'palette', beginC: 0, numC: channels, nbColors: n}};
}

const SMOOTH_CUTS = [-13, -3, -1, 0, 2, 12];
function smoothBin(value) {
  const magnitude = Math.abs(value);
  return (magnitude > 0) + (magnitude > 2) + (magnitude > 12);
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
    contexts[i] = smoothBin(west - northWest) * 4 + smoothBin(northWest - north);
  }
}

const SAMPLE_TOKENS = 128;
function sampleCost(counts, classes, bits) {
  for (let c = 0; c < classes; c++) bits += entropy(counts.subarray(c * SAMPLE_TOKENS, (c + 1) * SAMPLE_TOKENS));
  return bits;
}
function useWeighted(plane, w, h) {
  if (w * h < 4096 || h < 8) return 1;
  const rows = 8, last = h - rows, end = rows * w;
  const positions = [last, Math.floor(2 * last / 3), Math.floor(last / 3), 0];
  const smoothCounts = new Uint32Array(16 * SAMPLE_TOKENS), weightedCounts = new Uint32Array(18 * SAMPLE_TOKENS);
  let smoothRaw = 0, weightedRaw = 0, previous = -1;
  for (const y0 of positions) {
    if (y0 === previous) continue;
    previous = y0;
    const strip = plane.subarray(y0 * w, (y0 + rows) * w);
    const {residuals, properties, values, contexts} = captureWeighted(null, null, strip, w, rows, 0, undefined, null, null, y0 ? 2 : h);
    for (let i = 2 * w; i < end; i++) {
      const smooth = values[i];
      smoothCounts[contexts[i] * SAMPLE_TOKENS + sampleToken(smooth)]++;
      if (smooth >= 16) smoothRaw += 29 - Math.clz32(smooth);
      const e = properties[i], wr = residuals[i];
      weightedCounts[WEIGHTED_CONTEXT[e < -255 ? 0 : e > 255 ? 510 : e + 255] * SAMPLE_TOKENS + sampleToken(wr)]++;
      if (wr >= 16) weightedRaw += 29 - Math.clz32(wr);
    }
  }
  return sampleCost(weightedCounts, 18, weightedRaw) <= sampleCost(smoothCounts, 16, smoothRaw) ? 2 : 0;
}

function smoothTree(leaves, step) {
  return intervals(10, SMOOTH_CUTS, a => intervals(11, SMOOTH_CUTS, b => {
    const node = leaf(5, 0, step);
    node.local = Math.abs(a - 3) * 4 + Math.abs(b - 3); leaves.push(node);
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

function channelModel(plane, w, h, kind, step = 1, minimum = 3, weighted = true, stride = w, origin = 0, searched = kind === 'index', rowCopies = false) {
  if (kind === 'smooth' && !searched && constantPlane(plane)) {
    const tree = leaf(0, plane[0]); tree.local = 0;
    return {kind, tree, leaves: [tree], classes: 1, width: w, plane, minimum, count: 1, pieceValue: Int32Array.of(0), pieceDistance: Int32Array.of(0), pieceContext: Uint8Array.of(0)};
  }
  if (kind === 'smooth' && step === 1 && weighted) {
    return weightedModel(captureWeightedPieces(plane, w, h, minimum, weighted === 2 ? 8 : 0), plane, w, minimum);
  }
  const fastSmooth = kind === 'smooth' && step === 1;
  const n = w * h, values = kind === 'index' || fastSmooth ? plane : kind === 'rows' ? new Int32Array(n) : new Uint16Array(n);
  const contexts = kind === 'index' || fastSmooth ? null : new Uint8Array(n), leaves = [], scale = kind === 'index' ? 2 : 1;
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
      const bits = entropy(counts.subarray((p * classes + c) * 512, (p * classes + c + 1) * 512));
      if (bits < least) { least = bits; chosen[c] = p; }
    }
    for (let i = 0; i < n; i++) { const p = chosen[contexts[i]]; if (p) values[i] = p === 1 ? byNorth[i] : byGradient[i]; }
    const node = local => { const l = leaf([1, 2, 5][chosen[local]]); l.local = local; leaves.push(l); return l; };
    tree = intervals(2, upTo(h - 1), row => row ? split(11, 8, node(row * 3 + 2),
      split(11, 0, node(row * 3 + 1), split(11, -1, node(row * 3), split(11, -9, node(row * 3 + 1), node(row * 3 + 2))))) : node(0));
  } else { if (!fastSmooth) predictSmooth(plane, w, h, values, contexts, step); tree = smoothTree(leaves, step); classes = 16; }
  if (classes === 1) { tree.local = 0; leaves.push(tree); }
  const {count, value: pieceValue, distance: pieceDistance, context: pieceContext} = kind === 'rows'
    ? ((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || !__RAPIER_JXL_UPLOAD__) && (typeof __RAPIER_JXL_JPEG__ === 'undefined' || !__RAPIER_JXL_JPEG__)) && rowCopies ? rowsPieces(values, w, h, contexts, classes, minimum) : {count: n, value: values, distance: new Int32Array(n), context: contexts}
    : captureCopies(values, stride, origin, w, h, contexts, searched ? L.indexDepth : 0, minimum, scale, spatialLookup(w)[0], L.lazyUnder, L.nice);
  const model = {kind, tree, leaves, classes, width: w, height: h, stride, origin, plane, minimum, count, pieceValue, pieceDistance, pieceContext};
  if (kind === 'index' && searched) timed('prune', () => pruneCopies(model));
  return model;
}

const pieceBits = v => v < 16 ? 0 : 29 - Math.clz32(v);
const pieceToken = v => v < 16 ? v : 16 + ((29 - Math.clz32(v)) << 2 | (v >> (29 - Math.clz32(v)) & 2) | v & 1);
function pruneCopies(model) {
  const {count, pieceValue: V, pieceDistance: D, plane, width: w, stride, origin, minimum} = model;
  let copies = 0;
  for (let k = 0; k < count; k++) if (D[k]) copies++;
  if (copies < 1000) return;
  const at = new Int32Array(copies);
  let top = 0, scale = 0;
  for (let k = 0, p = 0, c = 0; k < count; k++) {
    if (D[k]) { at[c++] = p; p += V[k] + minimum; continue; }
    if (!scale && V[k]) scale = V[k] === plane[origin + (p / w | 0) * stride + p % w] ? 1 : 2;
    if (V[k] > top) top = V[k];
    p++;
  }
  scale ||= 2;
  const keep = new Uint8Array(count).fill(1), freq = new Uint32Array(top + 1), bits = new Float64Array(top + 1), literals = new Uint32Array(top + 1);
  let literalCount = 0;
  for (let k = 0; k < count; k++) if (!D[k]) { literals[V[k]]++; literalCount++; }
  for (let pass = 0; pass < 2; pass++) {
    const lengths = new Float64Array(256), distances = new Float64Array(256);
    freq.set(literals);
    let symbols = literalCount, kept = 0;
    for (let k = 0, c = 0; k < count; k++) {
      if (!D[k]) continue;
      if (keep[k]) { lengths[pieceToken(V[k])]++; distances[pieceToken(D[k])]++; symbols++; kept++; }
      else {
        for (let y = at[c] / w | 0, x = at[c] % w, i = origin + y * stride + x, n = V[k] + minimum; n > 0; n--) {
          freq[scale * plane[i]]++;
          if (++x === w) { x = 0; i = origin + ++y * stride; } else i++;
        }
        symbols += V[k] + minimum;
      }
      c++;
    }
    if (!kept) break;
    const whole = Math.log2(symbols), each = Math.log2(kept);
    for (let v = 0; v <= top; v++) bits[v] = freq[v] ? whole - Math.log2(freq[v]) : 0;
    for (let t = 0; t < 256; t++) { lengths[t] = lengths[t] ? whole - Math.log2(lengths[t]) : 0; distances[t] = distances[t] ? each - Math.log2(distances[t]) : 0; }
    let changed = false;
    for (let k = 0, c = 0; k < count; k++) {
      if (!D[k]) continue;
      if (keep[k]) {
        const cost = lengths[pieceToken(V[k])] + pieceBits(V[k]) + distances[pieceToken(D[k])] + pieceBits(D[k]);
        let literal = 0;
        for (let y = at[c] / w | 0, x = at[c] % w, i = origin + y * stride + x, n = V[k] + minimum; n > 0 && literal < cost; n--) {
          literal += bits[scale * plane[i]];
          if (++x === w) { x = 0; i = origin + ++y * stride; } else i++;
        }
        if (literal < cost) { keep[k] = 0; changed = true; }
      }
      c++;
    }
    if (!changed) break;
  }
  let total = 0;
  for (let k = 0; k < count; k++) total += D[k] && !keep[k] ? V[k] + minimum : 1;
  if (total === count) return;
  const value = new Int32Array(total), distance = new Int32Array(total);
  let j = 0;
  for (let k = 0, c = 0; k < count; k++) {
    if (!D[k]) { value[j++] = V[k]; continue; }
    if (keep[k]) { value[j] = V[k]; distance[j++] = D[k]; }
    else for (let y = at[c] / w | 0, x = at[c] % w, i = origin + y * stride + x, n = V[k] + minimum; n > 0; n--) {
      value[j++] = scale * plane[i];
      if (++x === w) { x = 0; i = origin + ++y * stride; } else i++;
    }
    c++;
  }
  model.count = total; model.pieceValue = value; model.pieceDistance = distance; model.pieceContext = new Uint8Array(total);
}

function weightedModel({count, value, distance, context, counts}, plane, w, minimum) {
  const leaves = [], tree = intervals(WEIGHTED_PROPERTY, WEIGHTED_BANDS, band => { const node = leaf(WEIGHTED_PREDICTOR); node.local = band; leaves.push(node); return node; });
  return {kind: 'smooth', tree, leaves, classes: WEIGHTED_BANDS.length + 1, width: w, plane, minimum, count, pieceValue: value, pieceDistance: distance, pieceContext: context, pieceCounts: counts};
}
function gradientModel({count, value, distance, context, counts}, plane, w, minimum) {
  const leaves = [], tree = smoothTree(leaves, 1);
  return {kind: 'smooth', tree, leaves, classes: 16, width: w, plane, minimum, count, pieceValue: value, pieceDistance: distance, pieceContext: context, pieceCounts: counts};
}
const constantPlane = plane => { const v0 = plane[0]; for (let i = 1; i < plane.length; i++) if (plane[i] !== v0) return false; return true; };

const LITERAL_CONFIGS = [...SCREEN_INTEGER_CONFIGS, ...[[4, 2, 1], [5, 1, 1], [5, 2, 1], [6, 1, 1], [6, 2, 1], [7, 2, 1], [5], [6], [7], [8], [9], [10], [11], [12], [13]].map(a => uintConfig(...a))];
const ANS_FIT = [];
for (let split = 0; split <= 8; split++) for (let msb = 0; msb <= split; msb++) for (let lsb = 0; msb + lsb <= split; lsb++) ANS_FIT.push(uintConfig(split, msb, lsb));
const SMALL = 512;
const log2x32 = x => {
  const e = 31 - Math.clz32(x);
  return 32 * e + LOG_MANTISSA[(e >= 5 ? x >>> e - 5 : x << 5 - e) & 31];
};
function entropy(freqs, header = 0) {
  let total = 0, used = 0, bits = 0;
  for (const n of freqs) if (n) { total += n; used++; }
  if (!total) return 0;
  const whole = log2x32(total);
  for (const n of freqs) if (n) bits += n * (whole - log2x32(n));
  return bits / 32 + 5 * used + header;
}

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
  let raw = 0, uLen = 0;
  for (let i = 0; i < values.values.length; i++) {
    const v = values.values[i], n = values.counts[i];
    hybridToken(config, v, token);
    const s = token[0];
    if (s >= DISTANCE_TOKENS) { usedLen = uLen; return null; }
    if (!FREQS[s]) USED[uLen++] = s;
    FREQS[s] += n; raw += token[1] * n;
  }
  usedLen = uLen;
  return [raw, USED.subarray(0, uLen).sort()];
}
function distancePrice(config, values) {
  const tokens = distanceTokens(config, values);
  if (!tokens) return Infinity;
  const header = new BitWriter(16);
  writeUintConfig(header, config, 15);
  return tokens[0] + header.bitLength + prefixCodeBits(FREQS, tokens[1]);
}
function distanceCode(config, values) {
  return compactCode(FREQS, distanceTokens(config, values)[1]);
}

const CLUSTER_CONFIG = uintConfig(4, 1, 1), CLUSTER_TOKENS = 128, CLUSTER_HEADER = 48;
const clusterCost = freqs => entropy(freqs, CLUSTER_HEADER);
function countTokens(freqs, h, config, lengthConfig, at, top) {
  const token = [0, 0, 0], add = (c, v, n, from) => { hybridToken(c, v, token); freqs[from + Math.min(token[0], top)] += n; };
  for (let v = 0; v < SMALL; v++) if (h.small[v]) add(config, v, h.small[v], 0);
  for (let i = 0; i < h.large.values.length; i++) add(config, h.large.values[i], h.large.counts[i], 0);
  for (let i = 0; i < h.lengths.values.length; i++) add(lengthConfig, h.lengths.values[i], h.lengths.counts[i], at);
  return freqs;
}
function clusterHistograms(live, limit = Infinity) {
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
  for (let count = n; ; count--) {
    let best = count > limit ? Infinity : 0, ba = -1, bb = -1;
    for (let a = 0; a < n; a++) if (alive[a]) for (let b = a + 1; b < n; b++) if (alive[b] && delta[a * n + b] < best) { best = delta[a * n + b]; ba = a; bb = b; }
    if (ba < 0) break;
    for (let t = 0; t < CLUSTER_TOKENS; t++) freqs[ba][t] += freqs[bb][t];
    for (let w = 0; w < masks[ba].length; w++) masks[ba][w] |= masks[bb][w];
    cost[ba] = clusterCost(freqs[ba]); alive[bb] = 0; parent[bb] = ba;
    const into = live[ba], from = live[bb];
    if (!into.merged) { into.small = Uint32Array.from(into.small); into.merged = true; }
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

const pieceKeys = [new Uint32Array(0), new Uint32Array(0), new Uint32Array(0)];
const keySpace = (k, used, more) => {
  if (pieceKeys[k].length < used + more) { const grown = new Uint32Array(Math.max(used + more, pieceKeys[k].length * 2)); grown.set(pieceKeys[k].subarray(0, used)); pieceKeys[k] = grown; }
  return pieceKeys[k];
};
function writeChannels(writer, models, trace, ansTools = (typeof __RAPIER_JXL_CAPTURE_LEAN__ === 'undefined' || !__RAPIER_JXL_CAPTURE_LEAN__) && L.ans ? tools.ans : null, own = false) {
  const start = typeof __RAPIER_JXL_PROBES__ === 'undefined' ? writer.bitLength : 0;
  const ordered = writeTree(writer, intervals(0, upTo(models.length - 1), m => models[m].tree));
  let pieces = 0;
  if (typeof __RAPIER_JXL_PROBES__ === 'undefined') for (const model of models) pieces += model.count;
  const histograms = [];
  let larges = 0, copies = 0, [largeKeys, lengthKeys, copyDistances] = pieceKeys;
  for (const model of models) {
    model.base = histograms.length;
    const {counts, literals, others} = model.pieceCounts ?? capturePieceCounts(model, SMALL);
    largeKeys = keySpace(0, larges, others.length); lengthKeys = keySpace(1, copies, others.length); copyDistances = keySpace(2, copies, others.length);
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
  if (!(typeof __RAPIER_JXL_JPEG__ !== 'undefined' && __RAPIER_JXL_JPEG__ === true) && live.length > 1 && (live.length > 255 || models.some(model => model.kind === 'index' && !model.group))) {
    const {groups, of} = clusterHistograms(live, 255 - (distanceValues.length ? 1 : 0));
    for (let i = 0; i < histograms.length; i++) index[i] = of[index[i]];
    live = groups;
  }
  const token = [0, 0, 0], minSymbol = models.some(model => model.kind === 'index') && models[0].width <= 2048 ? 224 : 512;
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
  if (typeof __RAPIER_JXL_PROBES__ === 'undefined' && timing) timing.pieces = (timing.pieces || 0) + pieces;
  let distance, sCodes = null;
  if (distanceValues.length) timed('distance', () => {
    sCodes = spatialLookup(Math.max(...models.map(model => model.width)))[1];
    const sLen = sCodes.length, spatial = new Int32Array(distanceValues.length), generic = new Int32Array(distanceValues.length);
    for (let i = 0; i < distanceValues.length; i++) {
      const d = distanceValues[i];
      spatial[i] = d < sLen && sCodes[d] >= 0 ? sCodes[d] : d + 119; generic[i] = d === 1 ? 1 : d + 119;
    }
    const ranked = [];
    for (const [kind, values] of [[true, {values: spatial, counts: distanceCounts}], [false, {values: generic, counts: distanceCounts}]]) {
      const prices = capturePrices(DISTANCE_CONFIGS, values, true);
      for (let c = 0; c < DISTANCE_CONFIGS.length; c++) ranked.push({config: DISTANCE_CONFIGS[c], kind, values, estimate: prices[c * 2]});
    }
    ranked.sort((a, b) => a.estimate - b.estimate);
    for (const {config, kind, values} of ranked.slice(0, L.prices)) {
      const bits = distancePrice(config, values);
      if (!distance || bits < distance.bits) distance = {bits, config, spatial: kind, values};
    }
    distance.code = distanceCode(distance.config, distance.values);
    distance.code.codes = canonicalCodes(distance.code.lengths);
  });
  const offset = distance ? 1 : 0, contextMap = new Uint8Array(ordered.length + offset);
  for (const model of models) for (const node of model.leaves) contextMap[node.context] = index[model.base + node.local] + offset;
  const lz77 = distance ? {minSymbol: minSymbol, minLength: (models.find(m => m.kind !== 'rows') ?? models[0]).minimum, lengthConfig: length.config} : null;
  const copy = distance ? {lengthConfig: length.config, distanceConfig: distance.config, code: distance.code, minSymbol, spatial: distance.spatial, sCodes} : null;
  const prefixHeader = new BitWriter(1024);
  writeHistograms(prefixHeader, {lz77, contextMap,
    histograms: [...(distance ? [{config: distance.config, code: distance.code}] : []),
      ...codes.map((code, m) => ({config: configs[m].config, code}))]
  });
  let ans = null;
  if ((typeof __RAPIER_JXL_CAPTURE_LEAN__ === 'undefined' || !__RAPIER_JXL_CAPTURE_LEAN__) && ansTools) timed('ans', () => {
    const ansCopy = copy && {...copy, distanceConfig: ansTools.distanceConfig(distance.values), lengthConfig: ansTools.lengthConfig(live, 256 - minSymbol)};
    if (copy && !(ansCopy.distanceConfig && ansCopy.lengthConfig)) return;
    const retry = ((typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || !__RAPIER_JXL_CAPTURE_PHOTO__) && (typeof __RAPIER_JXL_CAPTURE_DEEP__ === 'undefined' || __RAPIER_JXL_CAPTURE_DEEP__)) && !!L.learnSets && !own;
    const fitted = () => live.map((h, m) => {
      if (!h.literals) return configs[m].config;
      const literals = valueCounts(h.small, h.large);
      let best = null, bits = Infinity, largest = 0;
      if (retry) for (const v of literals.values) if (v > largest) largest = v;
      for (let at = 0; at < ANS_FIT.length; at += 64) {
        const some = ANS_FIT.slice(at, at + 64), prices = capturePrices(some, literals);
        for (let c = 0; c < some.length; c++) if (prices[c * 2] < bits && !(retry && (hybridToken(some[c], largest, token), token[0] > 255))) { bits = prices[c * 2]; best = some[c]; }
      }
      return best;
    });
    let ansConfigs = own ? fitted() : configs.map(c => c.config), tokens = ansTools.tokens(models, index, ansConfigs, ansCopy, codes.length);
    if (retry && (!tokens || ansConfigs.some(c => c.split > 8))) tokens = ansTools.tokens(models, index, ansConfigs = fitted(), ansCopy, codes.length);
    if (!tokens) return;
    const written = (cfgs, tk) => {
      const header = new BitWriter(1024), data = new BitWriter(tk.n + 64);
      const all = [...(distance ? [ansCopy.distanceConfig] : []), ...cfgs];
      return ansTools.write(header, data, {lz77: lz77 && {...lz77, lengthConfig: ansCopy.lengthConfig}, contextMap, configs: all}, tk) ? {header, data} : null;
    };
    ans = written(ansConfigs, tokens);
    if (retry && pieces <= 3 * 4096) {
      const other = fitted(), tk = ansTools.tokens(models, index, other, ansCopy, codes.length), second = tk && written(other, tk);
      if (second && (!ans || second.header.bitLength + second.data.bitLength < ans.header.bitLength + ans.data.bitLength)) ans = second;
    }
  });
  let fastLen = null, fastBits = null;
  const prefixWrite = target => {
    if (!fastLen) {
      fastLen = new Uint8Array(codes.length << 9); fastBits = new Uint32Array(codes.length << 9);
      for (let h = 0; h < codes.length; h++) {
        const code = codes[h], cfg = configs[h].config, base = h << 9, small = live[h].small;
        for (let v = 0; v < 512; v++) {
          if (!small[v]) continue;
          hybridToken(cfg, v, token);
          const s = token[0], l = code.lengths[s];
          if (s < code.lengths.length) { fastLen[base | v] = l + token[1]; fastBits[base | v] = code.codes[s] | (token[2] << l); }
        }
      }
    }
    return captureTokens(target, models, index, codes, configs.map(c => c.config), fastBits, fastLen, copy);
  };
  if ((typeof __RAPIER_JXL_CAPTURE_LEAN__ === 'undefined' || !__RAPIER_JXL_CAPTURE_LEAN__) && ans) {
    let prefixBits = 0;
    for (let m = 0; m < live.length; m++) {
      const h = live[m], code = codes[m], config = configs[m].config;
      for (let v = 0; v < SMALL; v++) if (h.small[v]) { hybridToken(config, v, token); prefixBits += h.small[v] * (code.lengths[token[0]] + token[1]); }
      for (let i = 0; i < h.large.values.length; i++) { hybridToken(config, h.large.values[i], token); prefixBits += h.large.counts[i] * (code.lengths[token[0]] + token[1]); }
      for (let i = 0; i < h.lengths.values.length; i++) { hybridToken(length.config, h.lengths.values[i], token); prefixBits += h.lengths.counts[i] * (code.lengths[minSymbol + token[0]] + token[1]); }
    }
    if (distance) for (let i = 0, {values, counts} = distance.values; i < values.length; i++) { hybridToken(distance.config, values[i], token); prefixBits += counts[i] * (distance.code.lengths[token[0]] + token[1]); }
    if (ans.header.bitLength + ans.data.bitLength > (own || ((typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || !__RAPIER_JXL_CAPTURE_PHOTO__) && (typeof __RAPIER_JXL_CAPTURE_DEEP__ === 'undefined' || __RAPIER_JXL_CAPTURE_DEEP__)) && L.learnSets ? 1 : 0.99) * (prefixHeader.bitLength + prefixBits)) ans = null;
  }
  writer.append(ans ? ans.header : prefixHeader);
  if (typeof __RAPIER_JXL_PROBES__ === 'undefined' && trace) {
    let literalBits = 0, lengthBits = 0, literals = 0, copies = 0;
    for (let m = 0; m < live.length; m++) {
      const h = live[m], code = codes[m], config = configs[m].config;
      const bits = (c, v, n, at) => { hybridToken(c, v, token); return n * (code.lengths[at + token[0]] + token[1]); };
      for (let v = 0; v < SMALL; v++) if (h.small[v]) literalBits += bits(config, v, h.small[v], 0);
      for (let i = 0; i < h.large.values.length; i++) literalBits += bits(config, h.large.values[i], h.large.counts[i], 0);
      for (let i = 0; i < h.lengths.values.length; i++) lengthBits += bits(length.config, h.lengths.values[i], h.lengths.counts[i], minSymbol);
      literals += h.literals; copies += h.copies;
    }
    trace.push({kinds: models.map(m => m.kind + (m.group ? '/group' : '')).join('+'), pieces, literals, copies, classes: histograms.length,
      codes: live.length, headerBits: writer.bitLength - start, literalBits, lengthBits, distanceBits: distance ? distance.bits : 0, ans: Boolean(ans)});
  }
  if (ans) return () => writer.append(ans.data);
  return () => prefixWrite(writer);
}

export const runModels = models => models.some(model => model.pieceValue.some(v => v > 65535)) ? null
  : models.map(model => model.count > 1 && model.width <= 16384 && model.count <= 1 << 20 ? learnedRuns(model, model.width, model.height) : model);
export function writeCaptureStream(writer, models, ans = null, {transforms = [], global = false, runs = false} = {}) {
  const write = (target, chosen) => {
    if (typeof __RAPIER_JXL_JPEG__ !== 'undefined' && __RAPIER_JXL_JPEG__ === true || !global) writeModularHeader(target, {useGlobalTree: false, transforms});
    const data = writeChannels(target, chosen, null, ans, true);
    if (!(typeof __RAPIER_JXL_JPEG__ !== 'undefined' && __RAPIER_JXL_JPEG__ === true) && global) writeModularHeader(target, {transforms});
    data();
  };
  const withRuns = !(typeof __RAPIER_JXL_JPEG__ !== 'undefined' && __RAPIER_JXL_JPEG__ === true) && runs && runModels(models);
  if (!withRuns) { write(writer, models); return; }
  const plain = new BitWriter(256), copied = new BitWriter(256);
  write(plain, models);
  write(copied, withRuns);
  writer.append(copied.bitLength < plain.bitLength ? copied : plain);
}

function samplePlane(rgba, stride, x, y, w, h, c) {
  const plane = new Int16Array(w * h);
  for (let at = 0, col = 0, p = (y * stride + x) * 4 + c, n = w * h; at < n; at++, col++, p += 4) {
    if (col === w) { col = 0; p += (stride - w) * 4; }
    plane[at] = rgba[p];
  }
  return plane;
}
function exactPlanes(words, stride, x, y, w, h, rct, rgba = null) {
  const n = w * h, green = new Int16Array(n), blue = new Int16Array(n), red = new Int16Array(n);
  if ((typeof __RAPIER_JXL_CAPTURE_DEEP__ === 'undefined' || __RAPIER_JXL_CAPTURE_DEEP__) && rct !== 10 && rct !== 6) {
    tools.transform(rct, 3).fill([green, blue, red], rgba, stride, x, y, w, h);
    return [green, blue, red];
  }
  if (rct !== 10) {
    for (let at = 0, col = 0, p = y * stride + x; at < n; at++, col++, p++) {
      if (col === w) { col = 0; p += stride - w; }
      const word = words[p], r = word & 255, g = word >>> 8 & 255, co = r - (word >>> 16 & 255), tmp = (word >>> 16 & 255) + (co >> 1), cg = g - tmp;
      green[at] = tmp + (cg >> 1); blue[at] = co; red[at] = cg;
    }
  } else {
    for (let at = 0, col = 0, p = y * stride + x; at < n; at++, col++, p++) {
      if (col === w) { col = 0; p += stride - w; }
      const word = words[p], g = word >>> 8 & 255;
      green[at] = g; blue[at] = (word >>> 16 & 255) - g; red[at] = (word & 255) - g;
    }
  }
  return [green, blue, red];
}
const COLOUR_CHANNELS = ['green', 'blue-green', 'red-green'];

let paletteChannels = false;
function groupChannels(rgba, stride, x, y, w, h, shape, coding, single = false, mode = L.weighted, rct = 10, learn = L.learn, scanOnly = false) {
  const {maxError} = coding, onPredictor = typeof __RAPIER_JXL_PROBES__ === 'undefined' ? coding.onPredictor : null;
  const answered = (typeof __RAPIER_JXL_CAPTURE_DEEP__ === 'undefined' || __RAPIER_JXL_CAPTURE_DEEP__) && !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && coding.gpu?.pixels === rgba ? coding.gpu.map : null;
  const take = name => answered?.get(answerKey(x, y, w, h, rct, name));
  const scanned = (typeof __RAPIER_JXL_CAPTURE_DEEP__ === 'undefined' || __RAPIER_JXL_CAPTURE_DEEP__) && !single ? take('scan') : undefined;
  const kept = !single && scanned === undefined && sized.pixels === rgba ? takeScan(`${x},${y},${w},${h}`) : undefined;
  const scan = single || ((typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || !__RAPIER_JXL_CAPTURE_PHOTO__) && (typeof __RAPIER_JXL_CAPTURE_DEEP__ === 'undefined' || __RAPIER_JXL_CAPTURE_DEEP__)) && paletteChannels ? null : scanned !== undefined ? scanned : kept !== undefined ? kept : groupScan(rgba, stride, x, y, w, h);
  if (scan) {
    const index = timed('copies', () => channelModel(scan.indices, w, h, 'index', 1, L.minCopy ?? 3)); index.group = true;
    const {meta, model} = timed('palette', () => paletteModel(scan.colours, [index], shape));
    return {transforms: [meta.transform], models: [model, index], palette: true};
  }
  if (scanOnly) return {palette: false};
  const sample = c => samplePlane(rgba, stride, x, y, w, h, c);
  const step = 2 * maxError + 1, models = [], lanes = [], learnedAt = [], coded = [];
  if (step > 1) coding.stepped = true;
  const colour = (plane, channel, keepWeighted = false, s = step) => {
    if ((typeof __RAPIER_JXL_CAPTURE_DEEP__ === 'undefined' || __RAPIER_JXL_CAPTURE_DEEP__) && L.references) coded.push(plane);
    if ((typeof __RAPIER_JXL_CAPTURE_DEEP__ === 'undefined' || __RAPIER_JXL_CAPTURE_DEEP__) && s === 1 && (mode === 'learned' || mode === 'runs') && !constantPlane(plane)) {
      const given = take(channel);
      const references = L.references ? coded.slice(0, -1).reverse() : [];
      let learned = timed('trees', () => tools.trees.model(plane, w, h, given, learn, references));
      if (!(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && learned && mode === 'runs') learned = learnedRuns(learned, w, h);
      if (learned) { onPredictor?.(channel, 'learned'); models.push(learned); learnedAt.push(models.length - 1); return true; }
    }
    if (s === 1 && L.gradient && !constantPlane(plane)) { onPredictor?.(channel, 'gradient'); lanes.push({plane, at: models.length, weighted: 0}); models.push(null); return false; }
    const weighted = s === 1 ? (keepWeighted ? 1 : mode === 'never' ? 0 : mode === 'always' ? 1 : timed('sample', () => useWeighted(plane, w, h))) : 0;
    if (s === 1) onPredictor?.(channel, weighted ? 'weighted' : 'gradient');
    if (s === 1 && weighted && !constantPlane(plane)) { lanes.push({plane, at: models.length, weighted, channel}); models.push(null); }
    else models.push(timed(weighted ? 'weighted' : 'gradient', () => channelModel(plane, w, h, 'smooth', s, 4, weighted)));
    return Boolean(weighted);
  };
  let transforms = [];
  if (shape.colour === 1) colour(sample(0), 'gray');
  else {
    const n = w * h, words = pixelKeys(rgba);
    if (step === 1) {
      const [green, blue, red] = exactPlanes(words, stride, x, y, w, h, rct, rgba);
      const greenWeighted = colour(green, 'green');
      colour(blue, 'blue-green', greenWeighted);
      colour(red, 'red-green', greenWeighted);
    } else {
      const green = new Int16Array(n), blue = new Int16Array(n), red = new Int16Array(n);
      for (let at = 0, col = 0, p = y * stride + x; at < n; at++, col++, p++) {
        if (col === w) { col = 0; p += stride - w; }
        const word = words[p];
        green[at] = word >>> 8 & 255; blue[at] = word >>> 16 & 255; red[at] = word & 255;
      }
      const greenWeighted = colour(green, 'green');
      for (let i = 0; i < n; i++) { blue[i] -= green[i]; red[i] -= green[i]; }
      colour(blue, 'blue-green', greenWeighted);
      colour(red, 'red-green', greenWeighted);
    }
    transforms = [{type: 'rct', beginC: 0, rctType: step === 1 ? rct : 10}];
  }
  if (shape.alpha) colour(sample(3), 'alpha', false, 1);
  timed('weighted', () => {
    const gradient = Boolean(L.gradient), answers = (typeof __RAPIER_JXL_CAPTURE_DEEP__ === 'undefined' || __RAPIER_JXL_CAPTURE_DEEP__) && !gradient && lanes.length > 1 ? lanes.map(lane => take(lane.channel)) : null;
    const pieces = lanes.length > 1 ? captureWeightedLanes(lanes.map(lane => lane.plane), w, h, 4, SMALL, gradient, answers?.every(Boolean) ? answers : null) : null;
    lanes.forEach((lane, c) => { models[lane.at] = pieces ? (gradient ? gradientModel : weightedModel)(pieces[c], lane.plane, w, 4) : channelModel(lane.plane, w, h, 'smooth', 1, 4, lane.weighted); });
  });
  return {transforms, models, learnedAt};
}
function learnedRuns(learned, w, h) {
  return timed('copies', () => {
    const c = captureCopies(Uint16Array.from(learned.pieceValue), w, 0, w, h, learned.pieceContext, 0, 4, 1, spatialLookup(w)[0]);
    return {...learned, count: c.count, pieceValue: c.value, pieceDistance: c.distance, pieceContext: c.context};
  });
}

const SMALL_DIM = 256;
export const captureGroupThreshold = (dim, fits, groups) => dim === DIM ? 2 * fits > groups : 4 * fits >= 3 * groups;
const sized = {pixels: null, scans: new Map()};
const takeScan = key => { const scan = sized.scans.get(key); sized.scans.delete(key); return scan; };
let stepCache = null;
const stepCached = (map, key, read) => {
  if (!stepCache || journaling()) return read();
  if (map.has(key)) return map.get(key);
  const value = read();
  map.set(key, value);
  return value;
};
const scanOf = (rgba, stride, x, y, w, h, limit) => {
  if (!stepCache || journaling()) return scanColours(rgba, stride, x, y, w, h, limit);
  let byRect = stepCache.scans.get(rgba);
  if (!byRect) stepCache.scans.set(rgba, byRect = new Map());
  return stepCached(byRect, `${stride}:${x},${y},${w},${h},${limit}`, () => scanColours(rgba, stride, x, y, w, h, limit));
};
const groupScan = (rgba, stride, x, y, w, h) => timed('scan', () => scanOf(rgba, stride, x, y, w, h, Math.min(PALETTE_LIMIT, (w * h) / 20 | 0)));
export const captureGroupCache = () => ({pixels: sized.pixels !== null, scans: sized.scans.size});
const isRows = source => source !== null && typeof source === 'object' && typeof source.rows === 'function';
const ROW_BAND = DIM;
function readRows(source, y, count) {
  const rows = source.rows(y, count);
  if (!(rows instanceof Uint8Array || rows instanceof Uint8ClampedArray) || rows.length !== count * source.width * 4)
    throw fault('JXL_INPUT', 'A row source answers RGBA8 rows of its width.');
  return rows;
}
const wholeOf = new WeakMap();
function wholeRows(source) {
  let whole = wholeOf.get(source);
  if (!whole) wholeOf.set(source, whole = readRows(source, 0, source.height));
  return whole;
}
const streamsRows = coding => coding.oneFrame && !coding.base && coding.effort <= 3 && !(coding.maxError === 0 ? coding.patches ?? coding.level.patches : false);
export function captureRowFacts(width, height) {
  return {width, height, count: 0, colours: new Uint32Array(PALETTE_LIMIT), first: new Int32Array(PALETTE_LIMIT),
    last: new Int32Array(PALETTE_LIMIT), seen: new Map(), indices: null, scanning: true, margin: 0, grey: true, opaque: true,
    fits: groupLayout(width, height, DIM).single ? null : [0, 0]};
}
export function captureRowBand(facts, rows, y) {
  const {width, height} = facts, words = pixelKeys(rows), h = words.length / width;
  if (!y) {
    const m = facts.margin = words[0];
    facts.grey = !((m ^ m >>> 8) & 0xffff); facts.opaque = m >>> 24 === 255;
  }
  for (let i = 0; i < words.length && (facts.grey || facts.opaque); i++) {
    const key = words[i];
    if (key >>> 24 !== 255) facts.opaque = false;
    if ((key ^ key >>> 8) & 0xffff) facts.grey = false;
  }
  if (facts.scanning) {
    const {colours, first, last, seen} = facts, limit = Math.min(PALETTE_LIMIT, width * height);
    const indices = facts.indices ??= new Uint16Array(width * height);
    let count = facts.count;
    scan: for (let row = 0, at = 0; row < h; row++) for (let x = 0; x < width; x++, at++) {
      const key = words[at];
      let c = seen.get(key);
      if (c === undefined) {
        if (count === limit) { facts.scanning = false; break scan; }
        c = count++; seen.set(key, c); colours[c] = key; first[c] = y + row;
      }
      indices[y * width + at] = c; last[c] = y + row;
    }
    facts.count = count;
    if (!facts.scanning) { facts.indices = null; facts.seen = null; }
  }
  if (facts.fits) [DIM, SMALL_DIM].forEach((dim, k) => {
    const layout = groupLayout(width, height, dim);
    for (let g = 0; g < layout.groupsX * layout.groupsY; g++) {
      const [gx, gy, gw, gh] = groupRect(layout, width, height, g, dim);
      if (gy < y || gy >= y + h) continue;
      if (timed('scan', () => scanColours(rows, width, gx, gy - y, gw, gh, Math.min(PALETTE_LIMIT, (gw * gh) / 20 | 0)))) facts.fits[k]++;
    }
  });
}
const rowFactsOf = new WeakMap();
const seenOf = facts => facts.scanning ? new Map(Array.from(facts.colours.subarray(0, facts.count), (key, c) => [key, c])) : null;
function* rowFacts(source) {
  let facts = rowFactsOf.get(source);
  if (facts) return facts;
  if (journaling()) {
    facts = yield* stage('row-facts', function* () {
      let saved = null;
      for (let y = 0; y < source.height; y += ROW_BAND) {
        const from = saved, band = yield* carried('row-band', () => {
          const next = from ? {...from, colours: from.colours.slice(), first: from.first.slice(), last: from.last.slice(),
            indices: from.indices?.slice() ?? null, fits: from.fits?.slice() ?? null, seen: seenOf(from)} : captureRowFacts(source.width, source.height);
          captureRowBand(next, readRows(source, y, Math.min(ROW_BAND, source.height - y)), y);
          return {...next, seen: null};
        });
        if (band !== PASSED) saved = band;
        yield 0;
      }
      return saved;
    });
    facts = {...facts, seen: seenOf(facts)};
  } else {
    facts = captureRowFacts(source.width, source.height);
    for (let y = 0; y < source.height; y += ROW_BAND) {
      captureRowBand(facts, readRows(source, y, Math.min(ROW_BAND, source.height - y)), y);
      yield 0;
    }
  }
  rowFactsOf.set(source, facts);
  return facts;
}
const rowScan = facts => facts.scanning ? {colours: facts.colours.slice(0, facts.count), indices: facts.indices,
  first: facts.first.slice(0, facts.count), last: facts.last.slice(0, facts.count)} : null;
function rowDim({width, height, fits}) {
  if (!L.smallGroups || !fits) return DIM;
  const groups = dim => { const layout = groupLayout(width, height, dim); return layout.single ? 0 : layout.groupsX * layout.groupsY; };
  if (groups(DIM) && captureGroupThreshold(DIM, fits[0], groups(DIM))) return DIM;
  if (groups(SMALL_DIM) && captureGroupThreshold(SMALL_DIM, fits[1], groups(SMALL_DIM))) return SMALL_DIM;
  return DIM;
}

function groupSize(pixels, stride, px, py, width, height) {
  sized.pixels = null; sized.scans.clear();
  if (!L.smallGroups || groupLayout(width, height, DIM).single) return DIM;
  sized.pixels = pixels;
  const fit = (dim, enough) => {
    const layout = groupLayout(width, height, dim), groups = layout.groupsX * layout.groupsY;
    if (layout.single) return false;
    let fits = 0;
    for (let g = 0; g < groups; g++) {
      const [x, y, w, h] = groupRect(layout, width, height, g, dim);
      const scan = groupScan(pixels, stride, px + x, py + y, w, h);
      sized.scans.set(`${px + x},${py + y},${w},${h}`, scan);
      if (scan) fits++;
      if (enough(fits, g + 1, groups)) return true;
      if (!enough(fits + groups - g - 1, groups, groups)) return false;
    }
    return false;
  };
  const most = (fits, seen, groups) => captureGroupThreshold(DIM, fits, groups), nearlyAll = (fits, seen, groups) => captureGroupThreshold(SMALL_DIM, fits, groups);
  captureHold(pixelKeys(pixels));
  try {
    if (fit(DIM, most)) return DIM;
    sized.scans.clear();
    if (fit(SMALL_DIM, nearlyAll)) return SMALL_DIM;
    sized.pixels = null; sized.scans.clear();
    return DIM;
  } catch (error) { sized.pixels = null; sized.scans.clear(); throw error; } finally { captureRelease(); }
}

export const capturePredictorModes = level => ((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || !__RAPIER_JXL_UPLOAD__) && (typeof __RAPIER_JXL_JPEG__ === 'undefined' || !__RAPIER_JXL_JPEG__)) && level.weighted === 'both' ? ['never', 'always'] : [level.weighted];

export function captureGroupAlternatives(level, palette, colour, maxError, single, learned) {
  const modes = capturePredictorModes(level), choices = [];
  if (!palette) {
    for (const mode of modes.slice(1)) choices.push({mode, single, rct: 10});
    if (((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || !__RAPIER_JXL_UPLOAD__) && (typeof __RAPIER_JXL_JPEG__ === 'undefined' || !__RAPIER_JXL_JPEG__)) && colour !== 1 && maxError === 0)
      for (const rct of level.rcts ?? []) for (const mode of modes) choices.push({mode, single, rct});
    if ((typeof __RAPIER_JXL_CAPTURE_DEEP__ === 'undefined' || __RAPIER_JXL_CAPTURE_DEEP__) && level.trees === 'learned' && learned && maxError === 0)
      if (level.learnSets) { for (const set of level.learnSets) for (const rct of set.rcts) choices.push({mode: 'learned', single, rct, learn: set.learn}); }
      else for (const rct of level.learnOnly ?? [10, ...level.learnRcts ?? []]) choices.push({mode: 'learned', single, rct});
  } else if (((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || !__RAPIER_JXL_UPLOAD__) && (typeof __RAPIER_JXL_JPEG__ === 'undefined' || !__RAPIER_JXL_JPEG__)) && level.palette === 'both')
    for (const mode of modes) choices.push({mode, single: true, rct: 10});
  return choices;
}

function groupSections(write, pixels, stride, x, y, w, h, shape, coding, single = false) {
  if (((typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || !__RAPIER_JXL_CAPTURE_PHOTO__) && (typeof __RAPIER_JXL_CAPTURE_DEEP__ === 'undefined' || __RAPIER_JXL_CAPTURE_DEEP__))) paletteChannels = false;
  let best = null;
  const keep = bytes => { if (!best || bytes.length < best.length) best = bytes; };
  const deferred = (typeof __RAPIER_JXL_CAPTURE_DEEP__ === 'undefined' || __RAPIER_JXL_CAPTURE_DEEP__) && !!L.fixedFallback;
  const fixed = () => groupChannels(pixels, stride, x, y, w, h, shape, coding, single, capturePredictorModes(L)[0]);
  const first = deferred ? groupChannels(pixels, stride, x, y, w, h, shape, coding, single, capturePredictorModes(L)[0], 10, L.learn, true) : fixed();
  const fallback = deferred && !first.palette;
  if (!fallback) keep(write(first));
  const learnAll = ((typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || !__RAPIER_JXL_CAPTURE_PHOTO__) && (typeof __RAPIER_JXL_CAPTURE_DEEP__ === 'undefined' || __RAPIER_JXL_CAPTURE_DEEP__)) && !!L.learnSets && first.palette;
  if (((typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || !__RAPIER_JXL_CAPTURE_PHOTO__) && (typeof __RAPIER_JXL_CAPTURE_DEEP__ === 'undefined' || __RAPIER_JXL_CAPTURE_DEEP__))) paletteChannels = learnAll;
  for (const choice of captureGroupAlternatives(L, ((typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || !__RAPIER_JXL_CAPTURE_PHOTO__) && (typeof __RAPIER_JXL_CAPTURE_DEEP__ === 'undefined' || __RAPIER_JXL_CAPTURE_DEEP__)) && learnAll ? false : first.palette, shape.colour, coding.maxError, single, !!tools.trees)) {
    const channels = groupChannels(pixels, stride, x, y, w, h, shape, coding, choice.single, choice.mode, choice.rct, choice.learn);
    if (!(typeof __RAPIER_JXL_CAPTURE_DEEP__ === 'undefined' || __RAPIER_JXL_CAPTURE_DEEP__) || choice.mode !== 'learned') keep(write(channels));
    else {
      keep(write(channels));
      if (!L.noRuns) {
        const models = channels.models.slice();
        for (const at of channels.learnedAt) models[at] = learnedRuns(models[at], w, h);
        keep(write({...channels, models}));
      }
    }
  }
  if (((typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || !__RAPIER_JXL_CAPTURE_PHOTO__) && (typeof __RAPIER_JXL_CAPTURE_DEEP__ === 'undefined' || __RAPIER_JXL_CAPTURE_DEEP__))) paletteChannels = false;
  if (fallback && !best) keep(write(fixed()));
  return best;
}

function shapeOf(keys, margin = keys[0], rgb = false, width = keys.length, height = 1, stride = width, origin = 0) {
  let grey = !rgb && !((margin ^ margin >>> 8) & 0xffff), opaque = margin >>> 24 === 255;
  for (let y = 0; y < height && (grey || opaque); y++) {
    for (let i = origin + y * stride, end = i + width; i < end && (grey || opaque); i++) {
      const key = keys[i];
      if (key >>> 24 !== 255) opaque = false;
      if ((key ^ key >>> 8) & 0xffff) grey = false;
    }
  }
  return shapeFrom(grey, opaque);
}
function shapeFrom(grey, opaque) {
  const colour = grey ? 1 : 3;
  if (((typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || !__RAPIER_JXL_CAPTURE_PHOTO__) && (typeof __RAPIER_JXL_CAPTURE_DEEP__ === 'undefined' || __RAPIER_JXL_CAPTURE_DEEP__)) && shapeFloor) {
    const floored = Math.max(colour, shapeFloor.colour ?? 1), alpha = !opaque || !!shapeFloor.alpha;
    return {colour: floored, alpha, channels: floored + (alpha ? 1 : 0)};
  }
  return {colour, alpha: !opaque, channels: colour + (opaque ? 0 : 1)};
}

function rgbFrame(frame, width, height, least) {
  const {colours, indices, stride = width, x: fx = 0, y: fy = 0} = frame, keys = new Map(), remap = new Uint16Array(colours.length), rgb = [];
  let soft = 0;
  for (let y = 0; y < height; y++) for (let i = (fy + y) * stride + fx, e = i + width; i < e; i++) soft += (colours[indices[i]] >>> 24) % 255 > 0;
  if (soft < width * height * least) return null;
  for (let i = 0; i < colours.length; i++) {
    const key = (colours[i] | 0xff000000) >>> 0;
    let j = keys.get(key);
    if (j === undefined) { j = rgb.length; keys.set(key, j); rgb.push(key); }
    remap[i] = j;
  }
  const n = width * height, plane = new Uint16Array(n), alpha = new Int16Array(n);
  for (let y = 0, at = 0; y < height; y++) for (let x = 0, i = (fy + y) * stride + fx; x < width; x++, at++, i++) {
    const v = indices[i]; plane[at] = remap[v]; alpha[at] = colours[v] >>> 24;
  }
  return {colours: Uint32Array.from(rgb), indices: plane, alpha};
}

const answerKey = (x, y, w, h, rct, name) => COLOUR_CHANNELS.includes(name) ? `${x},${y},${w},${h},${rct},${name}` : `${x},${y},${w},${h},${name}`;
const GPU_SAMPLES = 1 << 22;
function* askSteps(pixels, stride, px, py, layout, width, height, shape, coding, from, held) {
  const gpu = coding.gpu, groups = layout.groupsX * layout.groupsY, rcts = [10, ...L.rcts ?? []], words = pixelKeys(pixels);
  const planes = [], asked = [];
  let g = from;
  for (let samples = 0; g < groups; g++) {
    const [gx, gy, w, h] = groupRect(layout, width, height, g, DIM), x = px + gx, y = py + gy;
    const need = w * h * ((shape.colour === 1 ? 1 : 3 * rcts.length) + (shape.alpha ? 1 : 0));
    if (g > from && samples + need > GPU_SAMPLES) break;
    samples += need;
    const scan = timed('scan', () => scanColours(pixels, stride, x, y, w, h, Math.min(PALETTE_LIMIT, (w * h) / 20 | 0)));
    const own = held[g] = [answerKey(x, y, w, h, 10, 'scan')];
    gpu.map.set(own[0], scan);
    if (scan) continue;
    const add = (plane, rct, name) => {
      if (constantPlane(plane)) return;
      const key = answerKey(x, y, w, h, rct, name);
      planes.push({plane, width: w, height: h}); asked.push(key); own.push(key);
    };
    if (shape.colour === 1) add(samplePlane(pixels, stride, x, y, w, h, 0), 10, 'gray');
    else for (const rct of rcts) exactPlanes(words, stride, x, y, w, h, rct, pixels).forEach((plane, c) => add(plane, rct, COLOUR_CHANNELS[c]));
    if (shape.alpha) add(samplePlane(pixels, stride, x, y, w, h, 3), 10, 'alpha');
  }
  return {to: g, asked, handle: planes.length ? yield {gpu: {kind: 'weighted', planes}, ahead: true} : null};
}
function* takeSteps({asked, handle}, gpu) {
  const given = typeof handle?.then === 'function' ? yield {await: handle} : handle;
  if (Array.isArray(given) && given.length === asked.length) asked.forEach((key, i) => gpu.map.set(key, given[i]));
}

function lightOrder(colours) {
  const n = colours.length, key = c => ((c & 255) * 299 + (c >>> 8 & 255) * 587 + (c >>> 16 & 255) * 114) * 256 + (c >>> 24);
  const order = Array.from({length: n}, (_, i) => i).sort((a, b) => key(colours[a]) - key(colours[b]) || a - b);
  const remap = new Int32Array(n), sorted = new Uint32Array(n);
  order.forEach((from, to) => { remap[from] = to; sorted[to] = colours[from]; });
  return {remap, palette: shape => { const meta = paletteMeta(sorted, shape); return {meta, model: channelModel(meta.plane, meta.width, meta.height, 'rows')}; }};
}
function keyOrder(colours) {
  const n = colours.length, order = Array.from({length: n}, (_, i) => i).sort((a, b) => colours[a] - colours[b]);
  const remap = new Int32Array(n), sorted = new Uint32Array(n);
  order.forEach((from, to) => { remap[from] = to; sorted[to] = colours[from]; });
  return {remap, palette: shape => { const meta = paletteMeta(sorted, shape);
    return {meta, model: channelModel(meta.plane, meta.width, meta.height, 'rows', 1, L.minCopy ?? 3, true, meta.width, 0, false, true)}; }};
}
function rampIndices(indices, stride, origin, w, h, remap) {
  const plane = new Int16Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) plane[y * w + x] = remap[indices[origin + y * stride + x]];
  return channelModel(plane, w, h, 'smooth', 1, L.minCopy ?? 3, false, w, 0, true);
}
function predictedIndices(indices, stride, origin, w, h, remap) {
  const plane = new Int16Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) plane[y * w + x] = remap[indices[origin + y * stride + x]];
  const learned = tools.trees.model(plane, w, h);
  if (!learned) return channelModel(plane, w, h, 'smooth', 1, 4, 1);
  const c = captureCopies(Uint16Array.from(learned.pieceValue), w, 0, w, h, learned.pieceContext, 0, 4, 1, spatialLookup(w)[0]);
  return {...learned, count: c.count, pieceValue: c.value, pieceDistance: c.distance, pieceContext: c.context};
}

function* captureFrameSteps(pixels, width, height, shape, coding, frame, header, placement, pStride = width, px = 0, py = 0) {
  const written = yield* stage('frame', function* () {
    const file = yield* frameSteps(pixels, width, height, shape, coding, frame, header, placement, pStride, px, py);
    return {file, header: {bytes: header.bytes, at: header.at, acc: header.acc, pending: header.pending}};
  });
  Object.assign(header, written.header);
  return written.file;
}
function* frameSteps(pixels, width, height, shape, coding, frame, header, placement, pStride = width, px = 0, py = 0) {
  if (L.alphaPlane !== 'never' && frame && frame.alpha === undefined && shape.alpha && shape.colour === 3) {
    const rgb = rgbFrame(frame, width, height, L.alphaPlane === 'soft' ? 1 / 8 : 0), copy = new BitWriter(header.bytes.length);
    copy.append(header);
    const one = yield* within(captureFrameSteps(pixels, width, height, shape, coding, {...frame, alpha: null}, header, placement, pStride, px, py));
    if (!rgb) return least(one);
    const two = yield* under(one, captureFrameSteps(pixels, width, height, shape, coding, rgb, copy, placement, pStride, px, py));
    return least(one, two);
  }
  if ((typeof __RAPIER_JXL_CAPTURE_DEEP__ === 'undefined' || __RAPIER_JXL_CAPTURE_DEEP__) && !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && L.indexPredict && frame && frame.predicted === undefined &&
    !frame.alpha && coding.maxError === 0 && tools.trees && frame.colours.length > 2) {
    const copy = new BitWriter(header.bytes.length);
    copy.append(header);
    const one = yield* within(captureFrameSteps(pixels, width, height, shape, coding, {...frame, predicted: false}, header, placement, pStride, px, py));
    const two = yield* under(one, captureFrameSteps(pixels, width, height, shape, coding, {...frame, predicted: true}, copy, placement, pStride, px, py));
    return least(one, two);
  }
  if (((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || !__RAPIER_JXL_UPLOAD__) && (typeof __RAPIER_JXL_JPEG__ === 'undefined' || !__RAPIER_JXL_JPEG__)) && L.indexRamp && frame && frame.predicted === undefined &&
    !frame.alpha && coding.maxError === 0 && frame.colours.length >= 256) {
    const copy = new BitWriter(header.bytes.length);
    copy.append(header);
    const one = yield* within(captureFrameSteps(pixels, width, height, shape, coding, {...frame, predicted: false}, header, placement, pStride, px, py));
    const two = yield* under(one, captureFrameSteps(pixels, width, height, shape, coding, {...frame, predicted: 'ramp'}, copy, placement, pStride, px, py));
    return least(one, two);
  }
  captureRelease();
  const rows = ((typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || !__RAPIER_JXL_CAPTURE_PHOTO__) && (typeof __RAPIER_JXL_CAPTURE_DEEP__ === 'undefined' || __RAPIER_JXL_CAPTURE_DEEP__)) && !frame && isRows(pixels);
  if (rows && (pStride !== pixels.width || px || py || width !== pixels.width || height !== pixels.height)) throw fault('JXL_INTERNAL', 'A row source is written whole.');
  const dim = placement.dim ?? (frame ? DIM : rows ? rowDim(rowFactsOf.get(pixels)) : groupSize(pixels, pStride, px, py, width, height)), shift = 31 - Math.clz32(dim >> 7);
  try {
    const layout = groupLayout(width, height, dim), groups = layout.groupsX * layout.groupsY, sections = [];
    if (placement.frameHeader) placement.frameHeader(header, shift);
    else writeModularFrameHeader(header, {alpha: shape.alpha, shift, ...placement});
    let total = 0;
    const append = bytes => { total += bytes.length; admitOutputSize(total); if (total > ceiling) throw OVER; sections.push(bytes); };
    const lit = ((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || !__RAPIER_JXL_UPLOAD__) && (typeof __RAPIER_JXL_JPEG__ === 'undefined' || !__RAPIER_JXL_JPEG__)) && frame?.predicted === 'ramp' ? keyOrder(frame.colours) : (typeof __RAPIER_JXL_CAPTURE_DEEP__ === 'undefined' || __RAPIER_JXL_CAPTURE_DEEP__) && !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && frame?.predicted ? lightOrder(frame.colours) : null;
    let indexModels = null;
    if (frame) {
      indexModels = new Array(groups);
      for (let g = 0; g < groups; g++) indexModels[g] = yield* unit('index-model', () => {
        const [x, y, w, h] = groupRect(layout, width, height, g, dim), {stride = width, x: fx = 0, y: fy = 0} = frame;
        if (((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || !__RAPIER_JXL_UPLOAD__) && (typeof __RAPIER_JXL_JPEG__ === 'undefined' || !__RAPIER_JXL_JPEG__)) && frame.predicted === 'ramp') return timed('copies', () => rampIndices(frame.indices, stride, (fy + y) * stride + fx + x, w, h, lit.remap));
        if ((typeof __RAPIER_JXL_CAPTURE_DEEP__ === 'undefined' || __RAPIER_JXL_CAPTURE_DEEP__) && !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && lit) return timed('trees', () => predictedIndices(frame.indices, stride, (fy + y) * stride + fx + x, w, h, lit.remap));
        return timed('copies', () => channelModel(frame.indices, w, h, 'index', 1, L.minCopy ?? 3, true, stride, (fy + y) * stride + fx + x));
      });
    }
    const alphaModels = frame?.alpha ? Array.from({length: groups}, (_, g) => {
      const [x, y, w, h] = groupRect(layout, width, height, g, dim);
      const plane = new Int16Array(w * h);
      for (let row = 0; row < h; row++) plane.set(frame.alpha.subarray((y + row) * width + x, (y + row) * width + x + w), row * w);
      return timed('gradient', () => channelModel(plane, w, h, 'smooth', 1, 3, false, w, 0, true));
    }) : null;
    const palette = frame ? yield* unit('palette', () => lit ? {...lit.palette(shape), models: indexModels}
      : {...timed('palette', () => paletteModel(frame.colours, indexModels, frame.alpha ? {colour: 3, alpha: false, channels: 3} : shape)), models: indexModels}) : null;
    if (palette) indexModels = palette.models;
    if (layout.single) {
      const stream = ({transforms, models}) => {
        const global = new BitWriter(width * height + 256);
        placement.prefix?.(global);
        global.write(1, 1); global.write(1, 1);
        const write = timed('histograms', () => writeChannels(global, models, coding.trace));
        writeModularHeader(global, {transforms});
        timed('write', write);
        return global.finish();
      };
      return fits(assembleCodestream(header, [frame ? stream({transforms: [palette.meta.transform], models: [palette.model, indexModels[0], ...alphaModels ?? []]})
        : groupSections(stream, rows ? wholeRows(pixels) : pixels, pStride, px, py, width, height, shape, coding, true)]));
    }
    append(yield* unit('global', () => {
      const global = new BitWriter(1024);
      placement.prefix?.(global);
      global.write(1, 1); global.write(1, 1);
      if (frame) {
        const write = timed('histograms', () => writeChannels(global, [palette.model], coding.trace));
        writeModularHeader(global, {transforms: [palette.meta.transform]});
        timed('write', write);
      } else {
        writeHistograms(global, {contextMap: new Uint8Array(writeTree(global, leaf(0)).length),
          histograms: [{config: LITERAL_CONFIGS[0], code: buildCode(new Uint32Array(1))}]});
        writeModularHeader(global);
      }
      return global.finish();
    }));
    for (let i = 0; i < layout.dcGroupsX * layout.dcGroupsY + 1; i++) sections.push(new Uint8Array(0));
    let written = null;
    if (!(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && !rows && helped(coding, frame, groups) && dim === DIM) {
      const rects = frameRects(width, height, px, py), kept = coding.kept;
      if (kept?.pixels === pixels && kept.level === L && rects.every(r => kept.map.has(rectKey(r)))) written = rects.map(r => kept.map.get(rectKey(r)));
      else written = yield* groupSteps(pixels, pStride, rects, shape);
    }
    const gpu = (typeof __RAPIER_JXL_CAPTURE_DEEP__ === 'undefined' || __RAPIER_JXL_CAPTURE_DEEP__) && !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && !written && !rows && coding.gpu && !frame && dim === DIM && coding.maxError === 0 && !L.gradient && width * height >= tools.gpu.pixels ? coding.gpu : null;
    const held = gpu ? new Array(groups) : null;
    let batch = null, ahead = null, band = null, bandY = -1;
    if (gpu) gpu.pixels = pixels;
    try {
      for (let g = 0; g < groups; g++) {
        if ((typeof __RAPIER_JXL_CAPTURE_DEEP__ === 'undefined' || __RAPIER_JXL_CAPTURE_DEEP__) && !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && gpu && (!batch || g >= batch.to)) {
          batch = ahead ?? (yield* askSteps(pixels, pStride, px, py, layout, width, height, shape, coding, g, held));
          ahead = batch.to < groups ? yield* askSteps(pixels, pStride, px, py, layout, width, height, shape, coding, batch.to, held) : null;
          yield* takeSteps(batch, gpu);
        }
        const [x, y, w, h] = groupRect(layout, width, height, g, dim);
        append(written ? written[g] : yield* unit('group', () => {
          const section = groupSection(w, h, coding);
          if (frame) return section({transforms: [], models: alphaModels ? [indexModels[g], alphaModels[g]] : [indexModels[g]]});
          if (!rows) return groupSections(section, pixels, pStride, px + x, py + y, w, h, shape, coding);
          if (y !== bandY) { band = null; band = readRows(pixels, y, h); bandY = y; }
          return groupSections(section, band, width, x, 0, w, h, shape, coding);
        }));
        if (frame) { indexModels[g] = null; if (alphaModels) alphaModels[g] = null; }
        if ((typeof __RAPIER_JXL_CAPTURE_DEEP__ === 'undefined' || __RAPIER_JXL_CAPTURE_DEEP__) && !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && gpu) { for (const key of held[g]) gpu.map.delete(key); held[g] = null; }
        yield (g + 1) / groups;
      }
    } finally { if (gpu) { gpu.map.clear(); gpu.pixels = null; } }
    return fits(assembleCodestream(header, sections));
  } finally { sized.pixels = null; sized.scans.clear(); }
}

const helped = (coding, frame, groups) => coding.helpers && !frame && coding.maxError === 0 && !coding.trace && groups > 1;
const rectKey = r => `${r.x},${r.y},${r.width},${r.height}`;
function frameRects(width, height, px, py) {
  const layout = groupLayout(width, height, DIM);
  return Array.from({length: layout.groupsX * layout.groupsY}, (_, g) => {
    const [x, y, w, h] = groupRect(layout, width, height, g, DIM);
    return {x: px + x, y: py + y, width: w, height: h};
  });
}
function* groupSteps(pixels, stride, rects, shape) {
  const given = yield {groups: {pixels, stride, rects, level: L, shape}};
  return Array.isArray(given) && given.length === rects.length && given.every(bytes => bytes instanceof Uint8Array) ? given : null;
}

const groupSection = (w, h, coding) => channels => {
  const out = new BitWriter(w * h + 256);
  writeModularHeader(out, {useGlobalTree: false, transforms: channels.transforms});
  timed('write', timed('histograms', () => writeChannels(out, channels.models, coding.trace)));
  return out.finish();
};
export function captureGroupBytes(pixels, stride, {x, y, width, height}, level, shape, kit = CAPTURE_TOOLS_LEAN) {
  requireCaptureKernels();
  const outerLevel = L, outerTools = tools, coding = {maxError: 0};
  L = level; tools = kit;
  try { return groupSections(groupSection(width, height, coding), pixels, stride, x, y, width, height, shape, coding); }
  finally { L = outerLevel; tools = outerTools; }
}

export function captureResumeContext(level, kit, work) {
  const previous = [L, tools, timing, inner];
  L = level; tools = kit; timing = null; inner = 0;
  try { return work(); }
  finally { [L, tools, timing, inner] = previous; }
}
export {channelModel as captureChannelModel, paletteModel as capturePaletteModel,
  useWeighted as captureUseWeighted, weightedModel as captureWeightedModel,
  gradientModel as captureGradientModel, pruneCopies as capturePruneCopies};
export {LITERAL_CONFIGS, DISTANCE_CONFIGS, valueCounts, countTokens, sortedCode, distancePrice, distanceCode, spatialLookup, intervals};
export {paletteMeta as capturePaletteMeta, rowsBits as captureRowsBits};

function* scaledSteps(steps, start, span) {
  let step, reply;
  try {
    while (!(step = steps.next(reply)).done) {
      if (typeof step.value === 'number') { yield start + span * step.value; reply = undefined; }
      else reply = yield step.value;
    }
  } finally { if (!step?.done) steps.return(); }
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
  const t0 = typeof __RAPIER_JXL_PROBES__ === 'undefined' && coding.timing ? performance.now() : 0;
  if (typeof __RAPIER_JXL_PROBES__ === 'undefined') { timing = coding.timing ?? null; inner = 0; }
  if (((typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || !__RAPIER_JXL_CAPTURE_PHOTO__) && (typeof __RAPIER_JXL_CAPTURE_DEEP__ === 'undefined' || __RAPIER_JXL_CAPTURE_DEEP__)) && isRows(source) && !streamsRows(coding)) source = wholeRows(source);
  const words = unread(source) || ((typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || !__RAPIER_JXL_CAPTURE_PHOTO__) && (typeof __RAPIER_JXL_CAPTURE_DEEP__ === 'undefined' || __RAPIER_JXL_CAPTURE_DEEP__)) && isRows(source) ? null : pixelKeys(source);
  if (words && words.buffer === source.buffer) captureHold(words);
  try {
    const mode = coding.maxError === 0 && !coding.base ? coding.patches ?? L.patches : false;
    const peel = ((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || !__RAPIER_JXL_UPLOAD__) && (typeof __RAPIER_JXL_JPEG__ === 'undefined' || !__RAPIER_JXL_JPEG__)) && mode === 'peel' ? yield* unit('peel', () => {
      const found = timed('patches', () => capturePeel(source, imageWidth, imageHeight, L.peelLeast ?? 0.03, L.glyph));
      if (found) found.scan = scanColours(found.body, imageWidth, 0, 0, imageWidth, imageHeight, PALETTE_LIMIT);
      return found;
    }) : null;
    if (!peel) return yield* markSteps(source, imageWidth, imageHeight, colorSpace, coding, mode);
    const peeled = yield* scaledSteps(patchedSteps(source, imageWidth, imageHeight, colorSpace, coding, peel), 0, 1 / 2);
    const outer = ceiling;
    ceiling = peeled.length;
    try {
      const other = yield* scaledSteps(within(markSteps(source, imageWidth, imageHeight, colorSpace, coding, mode)), 1 / 2, 1 / 2);
      return other && other.length <= peeled.length ? other : peeled;
    } finally { ceiling = outer; }
  } finally {
    captureRelease();
    if (typeof __RAPIER_JXL_PROBES__ === 'undefined' && timing) { timing.total = (timing.total || 0) + performance.now() - t0; timing = null; }
  }
}

function* markSteps(source, imageWidth, imageHeight, colorSpace, coding, mode) {
  const patches = mode ? yield* unit('patches', () => timed('patches', () => stepCached(stepCache?.patches, source, () => capturePatches(source, imageWidth, imageHeight, 0.03)))) : null;
  if (!patches) return yield* pageSteps(source, imageWidth, imageHeight, colorSpace, coding);
  const alone = imageWidth * imageHeight > SMALL_PICTURE && patches.cover >= 0.045 && (yield* unit('one-palette', () => stepCached(stepCache?.onePalette, source, () => onePalette(source, imageWidth, imageHeight))));
  if (alone && patches.cover < 2 * patches.width * patches.height / (imageWidth * imageHeight))
    return yield* pageSteps(source, imageWidth, imageHeight, colorSpace, coding);
  const patched = yield* scaledSteps(within(patchedSteps(source, imageWidth, imageHeight, colorSpace, coding, patches)), 0, alone ? 1 : 1 / 2);
  if (!patched) return yield* pageSteps(source, imageWidth, imageHeight, colorSpace, coding);
  if (alone && patches.dictionary <= patched.length * 4) return patched;
  const outer = ceiling;
  ceiling = patched.length;
  try {
    const plain = yield* scaledSteps(within(pageSteps(source, imageWidth, imageHeight, colorSpace, coding)), 1 / 2, 1 / 2);
    return plain && plain.length <= patched.length ? plain : patched;
  } finally { ceiling = outer; }
}

function onePalette(source, width, height) {
  const {x = 0, y = 0, width: w = width, height: h = height} = screenCrop(source, width, height) ?? {};
  const scan = scanColours(source, width, x, y, w, h, PALETTE_LIMIT, true);
  return !(!scan || scan.colours.length * 32 > w * h || screenBands(scan, w, h) ||
    scan.colours.length > RARE_PALETTE && rareRegions(source, width, scan, w, h, x, y)?.only >= 0.75);
}

function* patchedSteps(source, width, height, colorSpace, coding, patches) {
  const peeled = ((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || !__RAPIER_JXL_UPLOAD__) && (typeof __RAPIER_JXL_JPEG__ === 'undefined' || !__RAPIER_JXL_JPEG__)) && patches.peel;
  let scan = yield* unit('scan', () => {
    const found = scanColours(source, width, 0, 0, width, height, PALETTE_LIMIT);
    if (found && !peeled) fillPatches(found.indices, width, patches);
    return found;
  });
  const shape = shapeOf(scan ? scan.colours : pixelKeys(source));
  const header = new BitWriter(128), atlasScan = yield* unit('atlas-scan', () => scanOf(patches.atlas, patches.width, 0, 0, patches.width, patches.height, PALETTE_LIMIT));
  writeHeaderFields(header, width, height, shape.colour, shape.alpha, {colorSpace});
  const atlas = yield* scaledSteps(captureFrameSteps(atlasScan ? null : patches.atlas, patches.width, patches.height, shape, coding, atlasScan,
    header, {frameHeader: (w, shift) => writeAtlasFrameHeader(w, shape.alpha, patches.width, patches.height, shift)}), 0, 1 / 4);
  let pixels = scan ? null : new Uint8Array(source);
  if (peeled) { pixels = patches.body; scan = patches.scan; if (scan) pixels = null; }
  else if (!scan) fillPatches(pixelKeys(pixels), width, patches);
  const body = yield* scaledSteps(captureFrameSteps(pixels, width, height, shape, coding, scan, new BitWriter(64),
    {frameHeader: (w, shift) => writePatchedFrameHeader(w, shape.alpha, shift), prefix: w => writeCapturePatches(w, patches, shape.alpha)}), 1 / 4, 3 / 4);
  return concatenate([atlas, body]);
}

function* atlasSteps(atlas, width, height, imageWidth, imageHeight, colorSpace, coding, dim) {
  const scan = scanOf(atlas, width, 0, 0, width, height, PALETTE_LIMIT);
  const shape = shapeOf(scan ? scan.colours : pixelKeys(atlas), undefined, true), header = new BitWriter(128);
  writeHeaderFields(header, imageWidth, imageHeight, 3, false, {colorSpace});
  return yield* captureFrameSteps(scan ? null : atlas, width, height, shape, coding, scan, header,
    {frameHeader: (w, shift) => writeAtlasFrameHeader(w, false, width, height, shift), ...dim && {dim}});
}

export function capturePaletteChoice(colours, area, base, channels, repeated) {
  if (!colours || (typeof __RAPIER_JXL_CAPTURE_DEEP__ === 'undefined' || __RAPIER_JXL_CAPTURE_DEEP__) && channels && colours > 1) return 'channels';
  if (base !== true && area <= SMALL_PICTURE && colours > 512 && colours * 32 <= area) {
    if (repeated === undefined) return 'repeats';
    if (repeated * 4 < area) return 'channels';
  }
  return colours * 32 > area ? area > SMALL_PICTURE ? 'channels' : 'compare' : 'palette';
}

function* pageSteps(source, imageWidth, imageHeight, colorSpace, coding) {
  const facts = ((typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || !__RAPIER_JXL_CAPTURE_PHOTO__) && (typeof __RAPIER_JXL_CAPTURE_DEEP__ === 'undefined' || __RAPIER_JXL_CAPTURE_DEEP__)) && isRows(source) ? yield* rowFacts(source) : null;
  const crop = coding.oneFrame ? null : yield* unit('crop', () => timed('crop', () => screenCrop(source, imageWidth, imageHeight)));
  const width = crop ? crop.width : imageWidth, height = crop ? crop.height : imageHeight;
  let scan = facts ? rowScan(facts) : yield* unit('scan', () => timed('scan', () => scanColours(source, imageWidth, crop?.x ?? 0, crop?.y ?? 0, width, height, PALETTE_LIMIT, true)));
  const header = new BitWriter(128);
  if (!crop && !coding.reference && scan?.colours.length === 1) {
    const shape = shapeOf(scan.colours, undefined, coding.base);
    writeHeaderFields(header, imageWidth, imageHeight, shape.colour, shape.alpha, {colorSpace});
    const m = facts?.margin;
    writeScreenBackground(header, imageWidth, imageHeight, shape, facts ? Uint8Array.of(m & 255, m >>> 8 & 255, m >>> 16 & 255, m >>> 24) : source.subarray(0, 4), undefined, true);
    return header.finish();
  }
  let choice = capturePaletteChoice(scan?.colours.length ?? 0, width * height, coding.base, L.channels);
  if (choice === 'repeats') choice = capturePaletteChoice(scan.colours.length, width * height, coding.base, L.channels, yield* unit('repeats', () => repeats(scan.indices, width)));
  if (choice === 'channels') scan = null;
  if (((typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || !__RAPIER_JXL_CAPTURE_PHOTO__) && (typeof __RAPIER_JXL_CAPTURE_DEEP__ === 'undefined' || __RAPIER_JXL_CAPTURE_DEEP__)) && choice === 'palette' && L.learnSets && scan.colours.length > 1) {
    const palette = yield* scaledSteps(within(routeSteps(source, imageWidth, imageHeight, colorSpace, coding, header, crop, scan)), 0, 1 / 2);
    return least(palette, palette && L.estimate >= L.gate * palette.length ? null
      : yield* scaledSteps(under(palette, routeSteps(source, imageWidth, imageHeight, colorSpace, coding, new BitWriter(128), crop, null)), 1 / 2, 1 / 2));
  }
  if (choice === 'compare') {
    const channels = yield* scaledSteps(within(routeSteps(source, imageWidth, imageHeight, colorSpace, coding, header, crop, null)), 0, 1 / 2);
    const palette = yield* scaledSteps(under(channels, routeSteps(source, imageWidth, imageHeight, colorSpace, coding, new BitWriter(128), crop, scan)), 1 / 2, 1 / 2);
    return least(channels, palette);
  }
  return yield* routeSteps(source, imageWidth, imageHeight, colorSpace, coding, header, crop, scan);
}

function repeats(indices, width) {
  const n = indices.length, last = new Int32Array(1 << 16);
  let same = 0;
  for (let i = 0; i < n; i++) {
    const x = i % width;
    if (x && indices[i] === indices[i - 1] || i >= width && indices[i] === indices[i - width]) { same++; continue; }
    if (i + 4 > n) continue;
    const a = indices[i], b = indices[i + 1], c = indices[i + 2], d = indices[i + 3];
    const h = Math.imul(a ^ Math.imul(b, 0x9e3779b1) ^ Math.imul(c, 0x85ebca77) ^ Math.imul(d, 0xc2b2ae3d), 0x27d4eb2f) >>> 16, j = last[h] - 1;
    if (j >= 0 && indices[j] === a && indices[j + 1] === b && indices[j + 2] === c && indices[j + 3] === d) same++;
    last[h] = i + 1;
  }
  return same;
}

function* routeSteps(source, imageWidth, imageHeight, colorSpace, coding, header, crop, scan) {
  const width = crop ? crop.width : imageWidth, height = crop ? crop.height : imageHeight;
  const bands = coding.oneFrame ? null : yield* unit('bands', () => screenBands(scan, width, height));
  const rare = !coding.oneFrame && coding.effort > 3 && !coding.base && (!scan || scan.colours.length > RARE_PALETTE) ? yield* unit('rare', () => timed('rare', () => rareRegions(source, imageWidth, scan, width, height, crop?.x ?? 0, crop?.y ?? 0))) : null;
  if (L.routes === 'all' || L.routes === 'rare' && width * height <= SMALL_PICTURE)
    return yield* everyRoute(source, imageWidth, imageHeight, colorSpace, coding, crop, scan, bands, rare);
  if (rare && rare.only >= 0.75) {
    if (scan) return yield* pictureSteps(source, imageWidth, imageHeight, colorSpace, coding, header, null, crop, null, rare);
    if (L.routes === 'one') return yield* pictureSteps(source, imageWidth, imageHeight, colorSpace, coding, header, null, crop, null);
    if (rare.regions.length >= 6) return yield* pictureSteps(source, imageWidth, imageHeight, colorSpace, coding, header, null, crop, null, rare);
    const automatic = {};
    const first = yield* scaledSteps(within(pictureSteps(source, imageWidth, imageHeight, colorSpace, coding, header, null, crop, null, undefined, undefined, automatic)), 0, 1 / 3);
    let second = null;
    if (!automatic.unsplit) second = yield* scaledSteps(under(first, pictureSteps(source, imageWidth, imageHeight, colorSpace, coding, new BitWriter(128), null, crop, null, false)), 1 / 3, 1 / 3);
    else yield 2 / 3;
    const third = yield* scaledSteps(under(second && (!first || second.length < first.length) ? second : first, pictureSteps(source, imageWidth, imageHeight, colorSpace, coding, new BitWriter(128), null, crop, null, rare)), 2 / 3, 1 / 3);
    return least(first, second, third);
  }
  if (bands) return yield* bandSteps(source, imageWidth, imageHeight, colorSpace, coding, header, crop, scan, bands);
  if (!scan || L.routes === 'one') return yield* pictureSteps(source, imageWidth, imageHeight, colorSpace, coding, header, null, crop, scan);
  const automatic = {};
  const best = yield* scaledSteps(within(pictureSteps(source, imageWidth, imageHeight, colorSpace, coding, header, null, crop, scan, undefined, undefined, automatic)), 0, 1 / 2);
  if (automatic.unsplit) return least(best);
  const unsplit = yield* scaledSteps(under(best, pictureSteps(source, imageWidth, imageHeight, colorSpace, coding, new BitWriter(128), null, crop, scan, false)), 1 / 2, 1 / 2);
  return least(best, unsplit);
}

function* everyRoute(source, imageWidth, imageHeight, colorSpace, coding, crop, scan, bands, rare) {
  const routes = [], automatic = {};
  if (bands) routes.push(h => bandSteps(source, imageWidth, imageHeight, colorSpace, coding, h, crop, scan, bands));
  routes.push(h => pictureSteps(source, imageWidth, imageHeight, colorSpace, coding, h, null, crop, scan, undefined, undefined, automatic),
    h => automatic.unsplit ? null : pictureSteps(source, imageWidth, imageHeight, colorSpace, coding, h, null, crop, scan, false));
  if (rare) routes.push(h => pictureSteps(source, imageWidth, imageHeight, colorSpace, coding, h, null, crop, null, rare));
  let best = null;
  for (let i = 0; i < routes.length; i++) {
    const steps = routes[i](new BitWriter(128));
    if (!steps) continue;
    const candidate = yield* scaledSteps(under(best, steps), i / routes.length, 1 / routes.length);
    if (candidate && (!best || candidate.length < best.length)) best = candidate;
  }
  return least(best);
}

function* bandSteps(source, imageWidth, imageHeight, colorSpace, coding, header, crop, scan, bands) {
  const width = crop ? crop.width : imageWidth;
  const shape = shapeOf(scan.colours, crop ? pixelKeys(crop.background)[0] : undefined, coding.base), frames = [], count = bands.length - 1;
  writeHeaderFields(header, imageWidth, imageHeight, shape.colour, shape.alpha, {colorSpace});
  if (crop) writeScreenBackground(header, imageWidth, imageHeight, shape, crop.background);
  for (let b = 0; b < count; b++) {
    const y = bands[b], rows = bands[b + 1] - y, band = {x: crop?.x ?? 0, y: (crop?.y ?? 0) + y, shape, last: b + 1 === count, canvas: {width: imageWidth, height: imageHeight}};
    const view = {stride: imageWidth, origin: band.y * imageWidth + band.x}, words = pixelKeys(source);
    if (b && words.buffer === source.buffer) captureHold(words);
    frames.push(yield* scaledSteps(pictureSteps(source, width, rows, colorSpace, coding, b ? new BitWriter(64) : header, band,
      timed('crop', () => screenCrop(source, width, rows, view.stride, view.origin)), {colours: scan.colours, indices: scan.indices.subarray(y * width, (y + rows) * width)},
      undefined, view), b / count, 1 / count));
  }
  return concatenate(frames);
}

function rareRegions(source, stride, scan, width, height, cx, cy) {
  if (width * height < 4096) return null;
  const TILE = 16, tx = Math.ceil(width / TILE), ty = Math.ceil(height / TILE), words = pixelKeys(source);
  const dense = scan ? new Uint8Array(tx * ty) : captureDenseTiles(words, stride, cx, cy, width, height);
  if (scan) {
    const {colours, indices} = scan, freq = new Uint32Array(colours.length), rareColour = new Uint8Array(colours.length);
    let run = indices[0], length = 0;
    for (let i = 0; i < indices.length; i++) { const v = indices[i]; if (v === run) length++; else { freq[run] += length; run = v; length = 1; } }
    freq[run] += length;
    for (let c = 0; c < colours.length; c++) rareColour[c] = freq[c] <= 2 ? 1 : 0;
    for (let by = 0; by < ty; by++) for (let bx = 0; bx < tx; bx++) {
      let rare = 0;
      for (let y = by * TILE, ye = Math.min(height, y + TILE); y < ye; y++)
        for (let i = y * width + bx * TILE, ie = y * width + Math.min(width, bx * TILE + TILE); i < ie; i++) rare += rareColour[indices[i]];
      dense[by * tx + bx] = rare > 16;
    }
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
  let area = 0;
  for (const r of regions) area += r.width * r.height;
  if (!regions.length || !scan && area * 2 > width * height) return null;
  let only = 1;
  if (scan) {
    const {colours, indices} = scan, outside = new Uint8Array(colours.length), n = colours.length;
    let seen = 0;
    for (let y = 0; y < height; y++) {
      const spans = regions.filter(r => y >= r.y && y < r.y + r.height).sort((a, b) => a.x - b.x);
      for (let x = 0, k = 0; x < width; k++) {
        const end = k < spans.length ? Math.max(x, spans[k].x) : width;
        for (let i = y * width + x, ie = y * width + end; i < ie; i++) {
          const c = indices[i];
          if (!outside[c]) { outside[c] = 1; if (++seen * 4 > n) return null; }
        }
        if (k >= spans.length) break;
        x = Math.max(end, spans[k].x + spans[k].width);
      }
    }
    only = (n - seen) / n;
  }
  for (const r of regions) {
    const border = new Map(), rx = cx + r.x, ry = cy + r.y;
    for (let xx = rx; xx < rx + r.width; xx++) for (const yy of [ry, ry + r.height - 1]) { const k = words[yy * stride + xx]; border.set(k, (border.get(k) || 0) + 1); }
    let most = 0, best = words[ry * stride + rx];
    for (const [k, n] of border) if (n > most) { most = n; best = k; }
    r.background = best; r.x = rx; r.y = ry;
  }
  return {regions, background: regions[0].background, solid: false, only};
}

let baseBuffer = null;
function basePlane(n) {
  if (n > 1 << 21) return new Uint16Array(n);
  if (!baseBuffer || baseBuffer.length < n) baseBuffer = new Uint16Array(Math.max(n, 1 << 20));
  return baseBuffer.subarray(0, n);
}

let ceiling = Infinity;
const OVER = Symbol('over the patched file');
function* within(steps) {
  try { return yield* steps; } catch (error) { if (error === OVER) return null; throw error; }
}
function* under(best, steps) {
  const outer = ceiling;
  if (best) ceiling = Math.min(outer, best.length);
  try { return yield* within(steps); } finally { ceiling = outer; }
}
function least(...files) {
  let best = null;
  for (const file of files) if (file && (!best || file.length < best.length)) best = file;
  if (!best) throw OVER;
  return best;
}
const fits = bytes => { if (bytes.length > ceiling) throw OVER; return bytes; };

function concatenate(frames) {
  let length = 0;
  for (const f of frames) length += f.length;
  admitOutputSize(length);
  const out = new Uint8Array(length);
  for (let i = 0, at = 0; i < frames.length; at += frames[i++].length) out.set(frames[i], at);
  return fits(out);
}

function* pictureSteps(source, imageWidth, imageHeight, colorSpace, coding, header, band, crop, scan, forced, view = {stride: imageWidth, origin: 0}, automatic) {
  const width = crop ? crop.width : imageWidth, height = crop ? crop.height : imageHeight;
  const frame = band && crop && scan ? {colours: scan.colours, indices: scan.indices, stride: imageWidth, x: crop.x, y: crop.y} : scan;
  const fStride = frame?.stride ?? width, fx = frame?.x ?? 0, fy = frame?.y ?? 0;
  const vStride = view.stride, vx = view.origin % vStride, vy = (view.origin / vStride) | 0;
  const cx = crop?.x ?? 0, cy = crop?.y ?? 0;
  const at = r => band ? {...r, x: r.x + band.x, y: r.y + band.y} : r, whole = {x: 0, y: 0, width: imageWidth, height: imageHeight};
  const canvas = band?.canvas ?? {width: imageWidth, height: imageHeight}, bandCrop = band && !fullFrame(at(whole), canvas) ? at(whole) : undefined;
  const final = !band || band.last;
  let partition = forced ?? (coding.oneFrame ? null : timed('partition', () => frame && screenColumns(source, imageWidth, imageHeight, view.stride, view.origin, crop) ||
    screenRegions(source, imageWidth, imageHeight, !frame, view.stride, view.origin)));
  if (partition) {
    const x0 = cx, y0 = cy, x1 = x0 + width, y1 = y0 + height;
    const regions = partition.regions.map(r => {
      const x = Math.max(r.x, x0), y = Math.max(r.y, y0);
      return {x, y, width: Math.min(r.x + r.width, x1) - x, height: Math.min(r.y + r.height, y1) - y, background: r.background ?? partition.background};
    }).filter(r => r.width > 0 && r.height > 0 && r.width < imageWidth && (forced || r.width * r.height >= 20000));
    const solid = partition.solid && regions.length === partition.regions.length && regions.every((r, i) => r.width === partition.regions[i].width && r.height === partition.regions[i].height);
    partition = regions.length && (!frame || forced || regions.some(r => r.y * 6 <= imageHeight)) ? {...partition, regions, solid} : null;
  }
  const facts = ((typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || !__RAPIER_JXL_CAPTURE_PHOTO__) && (typeof __RAPIER_JXL_CAPTURE_DEEP__ === 'undefined' || __RAPIER_JXL_CAPTURE_DEEP__)) && isRows(source) ? rowFactsOf.get(source) : null;
  const shape = band ? band.shape : frame ? shapeOf(frame.colours, crop ? pixelKeys(crop.background)[0] : undefined, coding.base)
    : facts ? shapeFrom(!coding.base && facts.grey, facts.opaque) : shapeOf(pixelKeys(source), crop ? pixelKeys(crop.background)[0] : undefined, coding.base,
      partition ? imageWidth : width, partition ? imageHeight : height, vStride,
      partition ? view.origin : (vy + cy) * vStride + vx + cx);
  if (!band) writeHeaderFields(header, imageWidth, imageHeight, shape.colour, shape.alpha, {colorSpace});
  const unsplit = () => {
    if (crop) writeScreenBackground(header, imageWidth, imageHeight, shape, crop.background, bandCrop, false, canvas);
    const placement = crop ? {crop: at({x: cx, y: cy, width, height}), canvas} : bandCrop ? {crop: bandCrop, canvas} : {};
    return captureFrameSteps(frame ? null : source, width, height, shape, coding, frame, header,
      final && !coding.reference ? placement : {...placement, last: false, reference: 1}, vStride, vx + cx, vy + cy);
  };
  if (!partition) {
    if (automatic) automatic.unsplit = true;
    return yield* unsplit();
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
    if (view.origin || view.stride !== imageWidth) body = source = viewPixels(source, imageWidth, imageHeight, view.stride, view.origin);
    const allSolid = partition.solid;
    for (const r of regions) r.local = timed('scan', () => scanColours(source, imageWidth, r.x, r.y, r.width, r.height, Math.min(PALETTE_LIMIT, (r.width * r.height) / 20 | 0)));
    if (allSolid) {
      base = {colours: Uint32Array.of(background)};
    } else {
      captureRelease();
      const fills = regions.map(r => ({...r, fill: r.background ?? background}));
      base = timed('scan', () => scanColours(source, imageWidth, 0, 0, imageWidth, imageHeight, PALETTE_LIMIT, false, fills));
      body = base ? null : blanked(source, regions, imageWidth, background);
    }
  }
  const asked = frame || !!(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) ? [] : regions.filter(r => !r.local).flatMap(r => helped(coding, null, frameRects(r.width, r.height, 0, 0).length) ? frameRects(r.width, r.height, r.x, r.y) : []);
  if (asked.length) {
    const given = yield* groupSteps(source, imageWidth, asked, shape);
    if (given) coding.kept = {pixels: source, level: L, map: new Map(asked.map((r, i) => [rectKey(r), given[i]]))};
  }
  const count = regions.length + 1, solidBase = base && base.colours.length === 1;
  if (solidBase) {
    const c0 = base.colours[0];
    writeScreenBackground(header, imageWidth, imageHeight, shape, Uint8Array.of(c0 & 255, c0 >>> 8 & 255, c0 >>> 16 & 255, c0 >>> 24 & 255), bandCrop, false, canvas);
  } else {
    if (!base && forced) return yield* unsplit();
    frames.push(yield* scaledSteps(captureFrameSteps(body, imageWidth, imageHeight, shape, coding, base, header,
      {...bandCrop && {crop: bandCrop, canvas}, last: false, reference: 1}), 0, 1 / count));
  }
  body = base = null;
  for (let i = 0; i < regions.length; i++) {
    const r = regions[i], placement = {crop: at(r), canvas, last: final && !coding.reference && i + 1 === regions.length, reference: 1};
    const local = frame ? {colours: frame.colours, indices: frame.indices, stride: fStride, x: fx + r.x - cx, y: fy + r.y - cy} : r.local;
    frames.push(yield* scaledSteps(captureFrameSteps(local ? null : source, r.width, r.height, shape, coding, local,
      i === 0 && solidBase ? header : new BitWriter(64), placement, imageWidth, r.x, r.y), (i + 1) / count, 1 / count));
    r.local = null;
  }
  coding.kept = null;
  return concatenate(frames);
}

function blanked(source, regions, imageWidth, background) {
  const body = Uint8Array.from(source), words = pixelKeys(body);
  for (const reg of regions) for (let y = reg.y; y < reg.y + reg.height; y++)
    words.fill(reg.background ?? background, y * imageWidth + reg.x, y * imageWidth + reg.x + reg.width);
  return body;
}
export function admitCapture(data, width, height, options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw fault('JXL_INPUT', 'Capture options are an object.');
  const maxError = options.maxError ?? 0;
  if (!Number.isInteger(maxError) || maxError < 0 || maxError > 8)
    throw fault('JXL_INPUT', 'maxError is a whole number from 0 to 8.');
  const tools = options[CAPTURE_TOOLS] ?? CAPTURE_TOOLS_LEAN, effort = options.effort ?? DEFAULT_EFFORT;
  if (!Number.isInteger(effort) || effort < 1 || effort > 9) throw fault('JXL_INPUT', 'effort is a whole number from 1 to 9; 3 is the default.');
  const level = options[CAPTURE_LEVEL] ?? LEVELS[effort];
  if (effort > tools.top || level.needs.some(tool => !tools[tool]))
    throw fault('JXL_UNSUPPORTED', `Capture effort ${effort} is ${tools.next}'s; this module carries efforts 1-${tools.top}.`);
  const {colorSpace} = admitOptions({colorSpace: options.colorSpace});
  if (((typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || !__RAPIER_JXL_CAPTURE_PHOTO__) && (typeof __RAPIER_JXL_CAPTURE_DEEP__ === 'undefined' || __RAPIER_JXL_CAPTURE_DEEP__)) && isRows(data)) {
    admitSize(width, height);
    if (data.width !== width || data.height !== height) throw fault('JXL_INPUT', 'A row source has the picture\'s width and height.');
  } else {
    admitPixels(data, width, height);
    if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray)) throw fault('JXL_INPUT', 'Captures use straight RGBA8 samples.');
  }
  const base = options[CAPTURE_BASE];
  return {colorSpace, coding: {maxError, onPredictor: typeof __RAPIER_JXL_PROBES__ === 'undefined' ? options[CAPTURE_PREDICTOR_PROBE] : null, base: base === true || base === 'reference',
    oneFrame: !!base || level.oneFrame === true, reference: base === 'reference', timing: typeof __RAPIER_JXL_PROBES__ === 'undefined' ? options[CAPTURE_TIMING] : null, trace: typeof __RAPIER_JXL_PROBES__ === 'undefined' ? options[CAPTURE_TRACE] : null, effort, level, tools,
    gpu: (typeof __RAPIER_JXL_CAPTURE_DEEP__ === 'undefined' || __RAPIER_JXL_CAPTURE_DEEP__) && !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && options[CAPTURE_GPU] === true && level.gpu && tools.gpu ? {pixels: null, map: new Map()} : null, helpers: options[CAPTURE_HELPERS] === true,
    patches: [false, 'one', 'peel'].includes(options[CAPTURE_PATCHES]) ? options[CAPTURE_PATCHES] : undefined}};
}

export function captureBandShape(data, previous) {
  const {colour, alpha} = shapeOf(pixelKeys(data));
  if (!previous) return {colour, alpha};
  return {colour: Math.max(colour, previous.colour), alpha: alpha || previous.alpha};
}
function bandSetup(data, width, rows, y, imageHeight, shape, x, coding, imageWidth) {
  const whole = {...shape, channels: shape.colour + (shape.alpha ? 1 : 0)}, crop = coding.oneFrame ? null : screenCrop(data, width, rows);
  let scan = scanColours(data, width, 0, 0, width, rows, PALETTE_LIMIT, true);
  if (scan && scan.colours.length * 32 > width * rows) scan = null;
  return {whole, crop, scan, band: {x, y, shape: whole, last: y + rows === imageHeight, canvas: {width: imageWidth, height: imageHeight}}};
}
export function captureBand(data, width, rows, options) {
  return drain(captureBandSteps(data, width, rows, options));
}

let stepping = false;
const idle = () => { if (stepping) throw fault('JXL_INTERNAL', 'A capture is already running; the next waits.'); };
export const captureBusy = () => stepping;
export function* encodeCaptureSteps(data, width, height, options = {}) {
  idle();
  const {colorSpace, coding} = admitCapture(data, width, height, options);
  requireCaptureKernels();
  if (!((typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || !__RAPIER_JXL_CAPTURE_PHOTO__) && (typeof __RAPIER_JXL_CAPTURE_DEEP__ === 'undefined' || __RAPIER_JXL_CAPTURE_DEEP__))) return yield* smallestSteps({...coding, pixels: width * height}, c => captureSteps(data, width, height, colorSpace, c), true);
  shapeFloor = options[CAPTURE_FLOOR] ?? null;
  try { return yield* smallestSteps({...coding, pixels: width * height}, c => captureSteps(data, width, height, colorSpace, c), true); }
  finally { shapeFloor = null; }
}
export function* encodeAtlasSteps(atlas, width, height, imageWidth, imageHeight, options = {}, dim = undefined) {
  idle();
  const {colorSpace, coding} = admitCapture(atlas, width, height, options);
  requireCaptureKernels();
  const level = coding.tools.trees && coding.level.trees !== 'learned' ? {...coding.level, trees: 'learned'} : coding.level;
  return yield* smallestSteps({...coding, level, pixels: width * height}, c => atlasSteps(atlas, width, height, imageWidth, imageHeight, colorSpace, c, dim), false);
}
export function* captureBandSteps(data, width, rows, {y, imageHeight, imageWidth = width, shape, x = 0, header: withHeader = true, ...options}) {
  idle();
  const {colorSpace, coding} = admitCapture(data, width, rows, options);
  requireCaptureKernels();
  const {whole, crop, scan, band} = bandSetup(data, width, rows, y, imageHeight, shape, x, coding, imageWidth);
  return yield* smallestSteps(coding, c => {
    const header = new BitWriter(y ? 64 : 128);
    if (!y && withHeader) writeHeaderFields(header, imageWidth, imageHeight, whole.colour, whole.alpha, {colorSpace});
    return pictureSteps(data, width, rows, colorSpace, c, header, band, crop, scan);
  }, false);
}

export function encodeCaptureBytes(data, width, height, options = {}) {
  const aborted = () => { if (options?.signal?.aborted) throw fault('JXL_ABORTED', 'JPEG XL encoding was canceled.'); };
  aborted();
  const bytes = drain(encodeCaptureSteps(data, width, height, options), aborted);
  aborted();
  return bytes;
}
function drain(steps, check = () => {}) {
  try {
    let step;
    while (!(step = steps.next()).done) check();
    return step.value;
  } finally { steps.return(); }
}

export function captureCandidateLevels(coding) {
  const levels = ((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || !__RAPIER_JXL_UPLOAD__) && (typeof __RAPIER_JXL_JPEG__ === 'undefined' || !__RAPIER_JXL_JPEG__)) && coding.level.floor ? [FLOOR2, L3, coding.level] : [coding.level];
  if (coding.pixels <= SMALL_FLOOR && coding.effort === 3) levels.unshift(FLOOR2);
  if (!(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true || typeof __RAPIER_JXL_JPEG__ !== 'undefined' && __RAPIER_JXL_JPEG__ === true) && coding.level.orders) levels.push({...coding.level, morton: true});
  if ((typeof __RAPIER_JXL_CAPTURE_DEEP__ === 'undefined' || __RAPIER_JXL_CAPTURE_DEEP__) && !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && coding.level.also) levels.push(...coding.level.also);
  return {levels, own: levels.indexOf(coding.level)};
}

export function captureCombinedLevel(level, levels, sizes, own) {
  const won = levels.map((candidate, k) => ({level: candidate, size: sizes[k]}))
    .filter(c => c.level.delta && c.size < sizes[own]).sort((a, b) => b.size - a.size);
  return won.length > 1 ? {...level, ...Object.assign({}, ...won.map(c => c.level.delta)), also: undefined, combine: false, combined: true} : null;
}

function* smallestSteps(coding, run, exactToo) {
  let best = null, bestExact = false;
  stepping = true;
  const outer = stepCache;
  stepCache = {patches: new Map(), onePalette: new Map(), scans: new Map()};
  try {
    const {levels, own} = captureCandidateLevels(coding);
    const span = 1 / (levels.length + (coding.level.combine ? 1 : 0)) / (exactToo ? 2 : 1), sizes = [];
    for (let i = 0; i < levels.length; i++) {
      const candidate = {...coding, level: levels[i], stepped: false, oneFrame: coding.base === true || levels[i].oneFrame === true}, start = exactToo ? 2 * i * span : i * span;
      L = levels[i]; tools = coding.tools;
      const written = yield* stage('candidate', function* () {
        const file = yield* scaledSteps(guarded(run(candidate)), start, span);
        return {file, stepped: candidate.stepped};
      });
      candidate.stepped = written.stepped;
      let bytes = answer(written.file), kept = !candidate.stepped;
      if (exactToo && candidate.stepped) {
        const exact = answer(yield* stage('exact', () => scaledSteps(guarded(run({...candidate, maxError: 0})), start + span, span)));
        if (exact.length <= bytes.length) { bytes = exact; kept = true; }
      }
      sizes[i] = bytes.length;
      if (!best || bytes.length < best.length) { best = bytes; bestExact = kept; }
      yield exactToo ? start + 2 * span : start + span;
      if ((typeof __RAPIER_JXL_CAPTURE_DEEP__ === 'undefined' || __RAPIER_JXL_CAPTURE_DEEP__) && !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && coding.level.combine && i === levels.length - 1 && !levels[i].combined) {
        const combined = captureCombinedLevel(coding.level, levels, sizes, own);
        if (combined) levels.push(combined);
      }
    }
  } finally { L = L3; tools = CAPTURE_TOOLS_LEAN; stepping = false; stepCache = outer; }
  if (bestExact) markCaptureExact(best);
  return best;
}
const exactFiles = new WeakSet();
export const markCaptureExact = bytes => { exactFiles.add(bytes); return bytes; };
export const captureExact = bytes => exactFiles.has(bytes);
function* guarded(steps) {
  let step, reply;
  try { while (!(step = guard(() => steps.next(reply))).done) reply = yield step.value; }
  finally { if (!step?.done) steps.return(); }
  return step.value;
}


export {spatialLookup as captureCopySpatial};
