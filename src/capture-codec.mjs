// SPDX-License-Identifier: MIT
import {unit, stage, carried, journaling, unread, PASSED, journalJoin} from './step-journal.mjs';
import {BitWriter, packSigned} from './bits.mjs';
import {captureHeld} from './turn.mjs';
import {admitOptions, admitPixels, admitSize, admitOutputSize, answer, fault, guard} from './admit.mjs';
import {abortReason} from './fault.mjs';
import {fullFrame, groupLayout, groupRect, writeHeaderFields as generalHeader, writeModularFrameHeader as generalFrame, assembleCodestream as generalAssembly} from './frame.mjs';
import {writeCaptureHeaderFields, writeCaptureFrameHeader, assembleCaptureCodestream, writeCaptureModularHeader} from './capture-headers.mjs';
import {pixelKeys, screenColumns, screenCrop, screenRegions, viewPixels, writeScreenBackground} from './screen-crop.mjs';
import {leaf, split, writeTree, writeModularHeader as generalModular} from './modular.mjs';
import {WEIGHTED_PREDICTOR, WEIGHTED_PROPERTY} from './weighted-policy.mjs';
import {kernelFail, captureFrameRows, captureCopies, captureHold, captureRelease, captureLiterals, captureScan, captureTextDelta, captureDenseTiles, treeArena, captureWeighted, captureStripMargin as stripMarginBpp, captureResidualCopies2d as has2dResidualCopies, captureWeightedLanes, captureColourGroup, captureWeightedPieces, capturePrune, captureNearestWalk, captureRowsModel, captureRowsBits, compileCaptureKernels, requireCaptureKernels, WEIGHTED_BANDS, WEIGHTED_CONTEXT} from './capture-kernels.mjs';
import {upTo, intervals, spatialLookup, LITERAL_CONFIGS, SMALL, log2x32, valueCounts, sortedCode, DISTANCE_CONFIGS, distancePrice, distanceCode, countTokens, writeChannels, learnedRuns, writeCaptureStream, letGoStreamKeys, setStreamLevel, setStreamProbe} from './capture-modular-stream.mjs';
import {capturePatches, capturePeel, fillPatches, writeAtlasFrameHeader, writeCapturePatches, writePatchedFrameHeader} from './capture-patches.mjs';
import {buildCode, writeHistograms} from './prefix.mjs';

const SMALL_FLOOR = 1 << 16, NEAREST_LIMIT = 4096, DIM = 1024, PALETTE_LIMIT = 16384, RARE_PALETTE = 8192, SMALL_PICTURE = 1 << 18;
const NEVER = 1 << 30;
export const DEFAULT_EFFORT = 3;
const L3 = {indexDepth: 24, lazyUnder: NEVER, nice: NEVER, tree: {split: 96, min: 128, nodes: 48}, prices: 4, weighted: 'sample',
  palette: 'scan', routes: 'rare', alphaPlane: 'soft', patches: 'one', floor: false, oneFrame: true, smallGroups: true, needs: [], textDelta: false,
  lane: true, channelsToo: true};
const L4 = {...L3, textDelta: false, rowCopies: true, indexRamp: true, patches: 'peel', indexDepth: 64, tree: {split: 96, min: 128, nodes: 96}, prices: 50, routes: 'all', alphaPlane: 'all', floor: true, smallGroups: false};
const L5 = {...L4, weighted: 'both', palette: 'both', rcts: [6]};
function deepLevels() {
  const L6 = {...L5, trees: 'learned', needs: ['trees'], peelLeast: 0.004};
  const L7 = {...L6, ans: true, gpu: true, treeContexts: true, needs: ['ans', 'trees']};
  const NINE = [{peelLeast: 0}, {minCopy: 5}, {glyph: 10}, {common: 32}, {minCopy: 4}, {glyph: 24}, {common: 8}, {lazyUnder: 8},
    {learnRcts: [6, 0, 1, 2, 3, 4, 5], learn: {samples: 1 << 22}}, {signs: true, tree: {split: 32, min: 32, nodes: 384}}, {morton: true},
    {channels: true}, {indexPredict: true}];
  const L8 = {...L7, also: NINE.slice(0, 4).map(delta => ({...L7, ...delta, delta}))};
  const L9 = {...L7, needs: ['ans', 'trees', 'signs'], combine: true, also: NINE.map(delta => ({...L7, ...delta, delta}))};
  return [L6, L7, L8, L9];
}
const FLOOR2 = {...L3, lane: false, channelsToo: false, textDelta: false, indexDepth: 16, lazyUnder: 32, routes: 'one', alphaPlane: 'never', patches: false};
export const LEVELS = [null,
  {...L3, lane: false, channelsToo: false, textDelta: false, indexDepth: 4, lazyUnder: 0, nice: 16, tree: {split: 96, min: 512, nodes: 16}, prices: 2, routes: 'one', alphaPlane: 'never', patches: false,
    gradient: true},
  {...L3, textDelta: false, routes: 'one', alphaPlane: 'never', patches: false},
  L3, ...((typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true || typeof __RAPIER_JXL_JPEG__ !== 'undefined' && __RAPIER_JXL_JPEG__ === true) ? [] : [L4, L5]), ...(!(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) ? deepLevels() : [])];
const L1_ANSWER = {...L3, lane: false, channelsToo: false, textDelta: false, routes: 'one', alphaPlane: 'never', patches: false, gradient: true};
export const INSTANT = {...L3, lane: false, channelsToo: false};
export const captureAnswerLevel = (effort, pixels) => effort === 1 && pixels > SMALL_PICTURE ? {[CAPTURE_LEVEL]: L1_ANSWER} : null;
let L = L3;
setStreamLevel(L3);
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
export const CAPTURE_SIZES = /* @__PURE__ */ Symbol('capture candidate sizes');
export const CAPTURE_PATCHES = Symbol('capture patches');
export const CAPTURE_PATCH_EFFORT = Symbol('capture patch effort');
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
if (typeof __RAPIER_JXL_PROBES__ === 'undefined') setStreamProbe({timed, timing: () => timing});
const writeCodecChannels = (out, models, trace) => writeChannels(out, models, trace, (typeof __RAPIER_JXL_CAPTURE_LEAN__ === 'undefined' || !__RAPIER_JXL_CAPTURE_LEAN__) && L.ans ? tools.ans : null);

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
    keys[j++] = (!(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && L.morton ? mortonKey(c) : rgbaKey(c)) * 65536 + i;
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

const TEXT_DELTA_PREDICTOR = 4;
function textDeltaCandidate(frame, width, height) {
  const stride = frame.stride ?? width, x = frame.x ?? 0, y = frame.y ?? 0;
  const built = captureTextDelta(frame.colours, frame.indices, stride, x, y, width, height);
  if (!built) return null;
  const pixels = width * height, mean = built.novel ? built.l1 / built.novel : 0;
  const hitRate = built.hits / pixels, novelRate = built.novel / pixels;
  if (!(hitRate >= 0.9 && mean <= 32 && novelRate >= 0.04) && !(mean <= 8 && novelRate >= 0.5)) return null;
  return built;
}
function deltaPaletteModel(deltas, count, channels, models, shape, predictor) {
  for (const m of models) if (m.kind === 'index' && !m.group) timed('prune', () => pruneSkewCopies(m, count));
  const uses = captureLiterals(models, count), common = [];
  let rare = 0;
  const keyOf = i => {
    const o = i * channels;
    return (deltas[o] + 256) * 65536 + (deltas[o + 1] + 256) * 256 + (deltas[o + 2] + 256);
  };
  for (let i = 0; i < count; i++) if (uses[i] >= (L.common ?? 16)) common.push(i); else if (uses[i]) rare++;
  common.sort((a, b) => uses[b] - uses[a] || keyOf(a) - keyOf(b));
  for (let lo = 4; lo < common.length; lo *= 2) {
    const hi = Math.min(common.length, lo * 2), slice = common.slice(lo, hi).sort((a, b) => keyOf(a) - keyOf(b));
    for (let j = lo; j < hi; j++) common[j] = slice[j - lo];
  }
  const keys = new Float64Array(rare);
  for (let i = 0, j = 0; i < count; i++) if (uses[i] && uses[i] < (L.common ?? 16)) keys[j++] = keyOf(i) * 65536 + i;
  keys.sort();
  const order = new Int32Array(common.length + rare), remap = new Int32Array(count);
  order.set(common);
  for (let j = 0; j < rare; j++) order[common.length + j] = keys[j] % 65536;
  const n = order.length, rows = new Int32Array(n * channels);
  for (let j = 0; j < n; j++) {
    remap[order[j]] = j;
    const o = order[j] * channels;
    for (let c = 0; c < channels; c++) rows[c * n + j] = deltas[o + c];
  }
  captureLiterals(models, count, remap);
  for (const m of models) timed('tree', () => learnContexts(m, remap, common.length, n));
  return {meta: {plane: rows, width: n, height: channels, transform: {type: 'palette', beginC: 0, numC: channels, nbColors: 0, nbDeltas: n, predictor}},
    model: channelModel(rows, n, channels, 'rows')};
}

const TREE_TOKENS = 128;

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
  if (!(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && L.signs && tools.signs) cuts.push([-1, 0], [-1, 0], [-1, 0]);
  const span = (Math.max(...cuts.map(c => c.length)) + 1) * TREE_TOKENS, arena = treeArena(count, span, cuts.length, {w, h, colours: remap.length});
  arena.bin(plane, model.stride, model.origin, model.pieceValue, model.pieceDistance, model.minimum, yBin, xBin, binOf, remap);
  const records = arena.learn(cuts, L.tree.split, L.tree.min, L.tree.nodes, model.pieceContext), leaves = [];
  let r = 0;
  const node = () => {
    const property = records[r++], cut = records[r++];
    if (property < 0) { const l = leaf(0); l.local = cut; leaves.push(l); return l; }
    const n = split(TREE_PROPERTY[property], cuts[property][cut], null, null);
    n.left = node(); n.right = node();
    return n;
  };
  model.tree = node();
  model.leaves = leaves; model.classes = leaves.length;
}

const TREE_PROPERTY = [2, 3, 7, 6, 10, 11, 12];

let lastWalk = null;
function walked(colours, order, from, walk) {
  const w = lastWalk;
  if (w && w.from === from && w.order.length === order.length && w.colours.length === colours.length && w.order.every((v, i) => v === order[i] && w.colours[v] === colours[v])) {
    walk.set(w.walk); return;
  }
  captureNearestWalk(colours, order.subarray(from), walk.subarray(from), colours[from ? order[from - 1] : order[from]]);
  lastWalk = {from, order: order.slice(), colours: colours.slice(), walk: walk.slice()};
}

function rowsBits({count, pieceValue: V, pieceDistance: D, pieceContext: C, classes}) {
  return captureRowsBits(V, D, C, count, classes, (typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || !__RAPIER_JXL_UPLOAD__) && (typeof __RAPIER_JXL_JPEG__ === 'undefined' || !__RAPIER_JXL_JPEG__));
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

function useWeighted(plane, w, h) {
  return stripMarginBpp(plane, w, h, h).chooseW;
}
function useWeightedGroup(planes, w, h) {
  if (w * h < 4096 || h < 8) return true;
  let sumM = 0;
  for (let c = 0; c < 3; c++) if (!constantPlane(planes[c])) sumM += stripMarginBpp(planes[c], w, h, 2).marginBpp;
  return sumM > 0.02;
}

function singletonFastCopies(plane, w, h) {
  const last = h - 8, positions = [last, Math.floor(2 * last / 3), Math.floor(last / 3), 0];
  let previous = -1, copies = 0, fast = 0;
  const bits = model => {
    const writer = new BitWriter(256);
    writeCaptureStream(writer, [model], null);
    return writer.bitLength;
  };
  for (const y of positions) {
    if (y === previous) continue;
    previous = y;
    const strip = plane.subarray(y * w, (y + 8) * w);
    Object.defineProperty(strip, 'constant', {value: false});
    copies += bits(channelModel(strip, w, 8, 'smooth', 1, 4, false));
    fast += bits(gradientModel(captureWeightedLanes([strip], w, 8, 4, SMALL, true)[0], strip, w, 4));
  }
  return fast < copies;
}

function smoothTree(leaves, step) {
  return intervals(10, SMOOTH_CUTS, a => intervals(11, SMOOTH_CUTS, b => {
    const node = leaf(5, 0, step);
    node.local = Math.abs(a - 3) * 4 + Math.abs(b - 3); leaves.push(node);
    return node;
  }));
}


function channelModel(plane, w, h, kind, step = 1, minimum = 3, weighted = true, stride = w, origin = 0, searched = kind === 'index', rowCopies = false) {
  if (kind === 'smooth' && !searched && constantPlane(plane)) {
    const tree = leaf(0, plane[0]); tree.local = 0;
    return {kind, tree, leaves: [tree], classes: 1, width: w, plane, minimum, count: 1, constant: true, pieceValue: Int32Array.of(0), pieceDistance: Int32Array.of(0), pieceContext: Uint8Array.of(0)};
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
    const chosen = captureRowsModel(plane, w, h, values, contexts);
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

function pruneCopies(model) {
  const {count, pieceValue: V, pieceDistance: D, plane, width: w, height: h, stride, origin, minimum} = model;
  const pruned = capturePrune(V, D, count, plane, w, h, stride, origin, minimum, (freq, top, symbols, kept, bits, lengths, distances) => {
    const whole = Math.log2(symbols), each = Math.log2(kept);
    for (let v = 0; v <= top; v++) bits[v] = freq[v] ? whole - Math.log2(freq[v]) : 0;
    for (let t = 0; t < 256; t++) { lengths[t] = lengths[t] ? whole - Math.log2(lengths[t]) : 0; distances[t] = distances[t] ? each - Math.log2(distances[t]) : 0; }
  });
  if (!pruned) return;
  model.count = pruned.count; model.pieceValue = pruned.value; model.pieceDistance = pruned.distance; model.pieceContext = new Uint8Array(pruned.count);
}

function weightedModel({count, value, distance, context}, plane, w, minimum) {
  const leaves = [], tree = intervals(WEIGHTED_PROPERTY, WEIGHTED_BANDS, band => { const node = leaf(WEIGHTED_PREDICTOR); node.local = band; leaves.push(node); return node; });
  return {kind: 'smooth', tree, leaves, classes: WEIGHTED_BANDS.length + 1, width: w, plane, minimum, count, pieceValue: value, pieceDistance: distance, pieceContext: context};
}
function gradientModel({count, value, distance, context}, plane, w, minimum) {
  const leaves = [], tree = smoothTree(leaves, 1);
  return {kind: 'smooth', tree, leaves, classes: 16, width: w, plane, minimum, count, pieceValue: value, pieceDistance: distance, pieceContext: context};
}
const constantPlane = plane => { if (plane.constant !== undefined) return plane.constant; const v0 = plane[0]; for (let i = 1; i < plane.length; i++) if (plane[i] !== v0) return false; return true; };


function samplePlane(rgba, stride, x, y, w, h, c) {
  const plane = new Int16Array(w * h);
  for (let at = 0, col = 0, p = (y * stride + x) * 4 + c, n = w * h; at < n; at++, col++, p += 4) {
    if (col === w) { col = 0; p += (stride - w) * 4; }
    plane[at] = rgba[p];
  }
  return plane;
}
const COLOUR_CHANNELS = ['green', 'blue-green', 'red-green'];

let paletteChannels = false;
function groupChannels(rgba, stride, x, y, w, h, shape, coding, single = false, mode = L.weighted, rct = -1, learn = L.learn, scanOnly = false) {
  const {maxError} = coding, onPredictor = typeof __RAPIER_JXL_PROBES__ === 'undefined' ? coding.onPredictor : null;
  const answered = !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && coding.gpu?.pixels === rgba ? coding.gpu.map : null;
  const scanned = !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && !single ? answered?.get(answerKey(x, y, w, h, 10, 'scan')) : undefined;
  const kept = !single && scanned === undefined && sized.pixels === rgba ? takeScan(`${x},${y},${w},${h}`) : undefined;
  const scan = single || ((typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || !__RAPIER_JXL_CAPTURE_PHOTO__) && !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true)) && paletteChannels ? null : scanned !== undefined ? scanned : kept !== undefined ? kept : groupScan(rgba, stride, x, y, w, h);
  if (scan) {
    const index = timed('copies', () => channelModel(scan.indices, w, h, 'index', 1, L.minCopy ?? 3)); index.group = true;
    const {meta, model} = timed('palette', () => paletteModel(scan.colours, [index], shape));
    return {transforms: [meta.transform], models: [model, index], palette: true};
  }
  if (scanOnly) return {palette: false};
  const step = 2 * maxError + 1, words = shape.colour === 3 ? pixelKeys(rgba) : null;
  let colourGroup = null;
  if (step === 1 && shape.colour === 3) {
    const rank = rct < 0 && !L.gradient && !L.learnOnly && (L.weighted === 'both' || w * h >= SMALL_FLOOR) && mode !== 'learned' && mode !== 'runs';
    colourGroup = timed('sample', () => captureColourGroup(words, stride, x, y, w, h, rct < 0 && !rank ? 10 : rct, L.weighted === 'both' ? 0 : 0.02));
    rct = colourGroup.rct;
  } else if (rct < 0) rct = 10;
  const take = name => answered?.get(answerKey(x, y, w, h, rct, name));
  const sample = c => samplePlane(rgba, stride, x, y, w, h, c);
  const models = [], lanes = [], learnedAt = [], coded = [];
  let singletonPlane = null, apart = false;
  if (step > 1) coding.stepped = true;
  const colour = (plane, channel, forceChoice = null, s = step) => {
    if (!(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && L.references) coded.push(plane);
    if (!(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && s === 1 && (mode === 'learned' || mode === 'runs') && !constantPlane(plane)) {
      const given = take(channel);
      const references = L.references ? coded.slice(0, -1).reverse() : [];
      let learned = timed('trees', () => tools.trees.model(plane, w, h, given, learn, references));
      if (!(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && learned && mode === 'runs') learned = learnedRuns(learned, w, h);
      if (learned) { onPredictor?.(channel, 'learned'); models.push(learned); learnedAt.push(models.length - 1); return true; }
    }
    if (s === 1 && (L.gradient || mode === 'lane' || forceChoice === 'lane') && !constantPlane(plane)) {
      onPredictor?.(channel, 'gradient');
      lanes.push({plane, at: models.length, weighted: 0}); models.push(null);
      return false;
    }
    const weighted = s === 1 ? (forceChoice === 'weighted' ? 1 : forceChoice === 'copies2d' || mode === 'never' || mode === 'lane' ? 0 : mode === 'always' ? 1 : timed('sample', () => useWeighted(plane, w, h))) : 0;
    if (s === 1) onPredictor?.(channel, weighted ? 'weighted' : 'gradient');
    if (s === 1 && !weighted && plane === singletonPlane && timed('sample', () => singletonFastCopies(plane, w, h))) {
      lanes.push({plane, at: models.length, weighted: 0, sampledFast: true}); models.push(null);
      return false;
    }
    if (s === 1 && weighted && !constantPlane(plane)) { lanes.push({plane, at: models.length, weighted, channel}); models.push(null); }
    else models.push(timed(weighted ? 'weighted' : 'gradient', () => channelModel(plane, w, h, 'smooth', s, 4, weighted)));
    return Boolean(weighted);
  };
  let transforms = [];
  if (shape.colour === 1) colour(sample(0), 'gray');
  else {
    const n = w * h;
    if (step === 1) {
      const planes = colourGroup.planes;
      const changing = !L.gradient && (mode === 'sample' || mode === 'apart') ? planes.filter(plane => !plane.constant) : null;
      singletonPlane = changing?.length === 1 ? changing[0] : null;
      if (changing?.length > 1) {
        const copy2d = timed('sample', () => has2dResidualCopies(planes, w, h));
        const chooseW = !copy2d && timed('sample', () => useWeightedGroup(planes, w, h));
        const fc = mode === 'apart' && !copy2d ? null : copy2d ? 'copies2d' : chooseW ? 'weighted' : 'lane';
        if (mode === 'sample' && !copy2d) apart = planes.some(plane => !plane.constant && !!timed('sample', () => useWeighted(plane, w, h)) !== chooseW);
        colour(planes[0], 'green', fc);
        colour(planes[1], 'blue-green', fc);
        colour(planes[2], 'red-green', fc);
      } else if (singletonPlane) {
        colour(planes[0], 'green', planes[0] === singletonPlane ? null : 'weighted');
        colour(planes[1], 'blue-green', planes[1] === singletonPlane ? null : 'weighted');
        colour(planes[2], 'red-green', planes[2] === singletonPlane ? null : 'weighted');
      } else {
        const greenWeighted = colour(planes[0], 'green');
        colour(planes[1], 'blue-green', greenWeighted ? 'weighted' : null);
        colour(planes[2], 'red-green', greenWeighted ? 'weighted' : null);
      }
    } else {
      const green = new Int16Array(n), blue = new Int16Array(n), red = new Int16Array(n);
      for (let at = 0, col = 0, p = y * stride + x; at < n; at++, col++, p++) {
        if (col === w) { col = 0; p += stride - w; }
        const word = words[p];
        green[at] = word >>> 8 & 255; blue[at] = word >>> 16 & 255; red[at] = word & 255;
      }
      const greenWeighted = colour(green, 'green');
      for (let i = 0; i < n; i++) { blue[i] -= green[i]; red[i] -= green[i]; }
      colour(blue, 'blue-green', greenWeighted ? 'weighted' : null);
      colour(red, 'red-green', greenWeighted ? 'weighted' : null);
    }
    transforms = [{type: 'rct', beginC: 0, rctType: step === 1 ? rct : 10}];
  }
  if (shape.alpha) colour(sample(3), 'alpha', L.gradient ? 'lane' : null, 1);
  timed('weighted', () => {
    for (const gradient of [false, true]) {
      const batch = lanes.filter(lane => !lane.weighted === gradient);
      if (!batch.length) continue;
      const answers = !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && !gradient && batch.length > 1 ? batch.map(lane => take(lane.channel)) : null;
      const pieces = batch.length > 1 || gradient && !L.gradient && (mode === 'lane' || lanes.length > 1 || batch[0].sampledFast) ? captureWeightedLanes(batch.map(lane => lane.plane), w, h, 4, SMALL, gradient, answers?.every(Boolean) ? answers : null) : null;
      batch.forEach((lane, c) => { models[lane.at] = pieces ? (gradient ? gradientModel : weightedModel)(pieces[c], lane.plane, w, 4) : channelModel(lane.plane, w, h, 'smooth', 1, 4, lane.weighted); });
    }
  });
  return {transforms, models, learnedAt, rct, apart};
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
    const {colours, first, last, seen} = facts, limit = Math.min(PALETTE_LIMIT, width * height), total = width * height;
    let indices = facts.indices ??= new Uint16Array(Math.min(total, Math.max(width * 16, 65536)));
    let count = facts.count;
    scan: for (let row = 0, at = 0; row < h; row++) {
      const need = y * width + at + width;
      if (need > indices.length) {
        const grown = new Uint16Array(Math.min(total, Math.max(need, indices.length * 2)));
        grown.set(indices); facts.indices = indices = grown;
      }
      for (let x = 0; x < width; x++, at++) {
        const key = words[at];
        let c = seen.get(key);
        if (c === undefined) {
          if (count === limit) { facts.scanning = false; break scan; }
          c = count++; seen.set(key, c); colours[c] = key; first[c] = y + row;
        }
        indices[y * width + at] = c; last[c] = y + row;
      }
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
  let facts = journaling() ? null : rowFactsOf.get(source);
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

export const capturePredictorModes = level => ((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || !__RAPIER_JXL_UPLOAD__) && (typeof __RAPIER_JXL_JPEG__ === 'undefined' || !__RAPIER_JXL_JPEG__)) && level.weighted === 'both' ? ['lane', 'always'] : [level.weighted];

export function captureGroupAlternatives(level, palette, colour, maxError, single, learned, alpha) {
  const modes = capturePredictorModes(level), choices = [];
  if (!palette) {
    for (const mode of modes.slice(1)) choices.push({mode, single, rct: 10});
    if (level.lane && !level.gradient && !modes.includes('lane') && maxError === 0) choices.push({mode: 'lane', single, rct: 10});
    if (alpha && level.weighted === 'both') choices.push({mode: 'sample', single, rct: 10});
    if (((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || !__RAPIER_JXL_UPLOAD__) && (typeof __RAPIER_JXL_JPEG__ === 'undefined' || !__RAPIER_JXL_JPEG__)) && colour !== 1 && maxError === 0)
      for (const rct of level.rcts ?? []) for (const mode of modes) choices.push({mode, single, rct});
    if (!(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && level.trees === 'learned' && learned && maxError === 0)
      if (level.learnSets) { for (const set of level.learnSets) for (const rct of set.rcts) choices.push({mode: 'learned', single, rct, learn: set.learn}); }
      else for (const rct of level.learnOnly ?? [10, ...level.learnRcts ?? []]) choices.push({mode: 'learned', single, rct});
  } else if ((level.channelsToo && maxError === 0) || ((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || !__RAPIER_JXL_UPLOAD__) && (typeof __RAPIER_JXL_JPEG__ === 'undefined' || !__RAPIER_JXL_JPEG__)) && level.palette === 'both')
    for (const mode of modes) choices.push({mode, single: true, rct: 10});
  return choices;
}

function groupSections(...args) { const steps = groupSectionsSteps(...args); let step; while (!(step = steps.next()).done); return step.value; }
function* groupSectionsSteps(write, pixels, stride, x, y, w, h, shape, coding, single = false) {
  if (((typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || !__RAPIER_JXL_CAPTURE_PHOTO__) && !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true))) paletteChannels = false;
  const planned = coding.maxError === 0 && !L.gradient && !L.needs.length;
  let best = null;
  const keep = bytes => { if (!best || bytes.length < best.length) best = bytes; };
  const deferred = !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && !!L.fixedFallback;
  const fixed = () => groupChannels(pixels, stride, x, y, w, h, shape, coding, single, capturePredictorModes(L)[0]);
  const first = deferred ? groupChannels(pixels, stride, x, y, w, h, shape, coding, single, capturePredictorModes(L)[0], 10, L.learn, true) : fixed();
  const topRct = L.weighted === 'both' ? first.rct ?? -1 : -1;
  const fallback = deferred && !first.palette;
  if (!fallback) keep(write(first, planned));
  const learnAll = ((typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || !__RAPIER_JXL_CAPTURE_PHOTO__) && !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true)) && !!L.learnSets && first.palette;
  if (((typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || !__RAPIER_JXL_CAPTURE_PHOTO__) && !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true))) paletteChannels = learnAll;
  const choices = captureGroupAlternatives(L, ((typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || !__RAPIER_JXL_CAPTURE_PHOTO__) && !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true)) && learnAll ? false : first.palette, shape.colour, coding.maxError, single, !!tools.trees, shape.alpha);
  let seen = null;
  if (first.apart && !first.palette) choices.unshift({mode: 'apart', single, rct: first.rct ?? 10});
  if (!first.palette && topRct >= 0 && topRct !== 10) {
    choices.unshift({mode: 'always', single, rct: topRct},
      {mode: 'lane', single, rct: 10}, ...(shape.alpha ? [{mode: 'sample', single, rct: topRct}] : []));
    seen = new Set(!fallback ? [`${capturePredictorModes(L)[0]}/${first.rct}/${+single}`] : []);
  }
  let tried = 0;
  yield 1 / (choices.length + 2);
  for (const choice of choices) {
    yield (++tried + 1) / (choices.length + 2);
    if (seen && choice.mode !== 'learned') {
      const key = `${choice.mode}/${choice.rct}/${+Boolean(choice.single)}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    const channels = groupChannels(pixels, stride, x, y, w, h, shape, coding, choice.single, choice.mode, choice.rct, choice.learn);
    if (!!(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) || choice.mode !== 'learned') keep(write(channels, planned));
    else {
      keep(write(channels, planned));
      if (!L.noRuns) {
        const models = channels.models.slice();
        for (const at of channels.learnedAt) models[at] = learnedRuns(models[at], w, h);
        keep(write({...channels, models}, planned));
      }
    }
  }
  if (((typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || !__RAPIER_JXL_CAPTURE_PHOTO__) && !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true))) paletteChannels = false;
  if (fallback && !best) keep(write(fixed(), planned));
  return planned ? best.finish() : best;
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
  if (!(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && shapeFloor) {
    const floored = Math.max(colour, shapeFloor.colour ?? 1), alpha = !opaque || !!shapeFloor.alpha;
    return {colour: floored, alpha, channels: floored + (alpha ? 1 : 0)};
  }
  return {colour, alpha: !opaque, channels: colour + (opaque ? 0 : 1)};
}

function rgbFrame(frame, width, height, least) {
  const {colours} = frame, keys = new Map(), remap = new Uint16Array(colours.length), rgb = [];
  const rows = captureFrameRows(frame, width, height);
  if (rows.soft() < width * height * least) return null;
  for (let i = 0; i < colours.length; i++) {
    const key = (colours[i] | 0xff000000) >>> 0;
    let j = keys.get(key);
    if (j === undefined) { j = rgb.length; keys.set(key, j); rgb.push(key); }
    remap[i] = j;
  }
  const {plane, alpha} = rows.remap(remap);
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
    else for (const rct of rcts) captureColourGroup(words, stride, x, y, w, h, rct).planes.forEach((plane, c) => add(plane, rct, COLOUR_CHANNELS[c]));
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
  if (!(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && L.indexPredict && frame && frame.predicted === undefined &&
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
  if (typeof __RAPIER_JXL_VERSION__ === 'undefined' && L.textDelta && frame && frame.predicted === undefined &&
    !frame.alpha && !shape.alpha && coding.maxError === 0 && shape.colour === 3 && frame.colours.length >= 32) {
    const delta = textDeltaCandidate(frame, width, height);
    if (delta) {
      const copy = new BitWriter(header.bytes.length);
      copy.append(header);
      const one = yield* within(captureFrameSteps(pixels, width, height, shape, coding, {...frame, predicted: false}, header, placement, pStride, px, py));
      const two = yield* under(one, captureFrameSteps(pixels, width, height, shape, coding,
        {...frame, indices: delta.indices, deltas: delta.deltas, deltaCount: delta.count, stride: width, x: 0, y: 0, predicted: 'select'},
        copy, placement, pStride, px, py));
      return least(one, two);
    }
  }
  captureRelease();
  const rows = ((typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || !__RAPIER_JXL_CAPTURE_PHOTO__) && !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true)) && !frame && isRows(pixels);
  if (rows && (pStride !== pixels.width || px || py || width !== pixels.width || height !== pixels.height)) throw fault('JXL_INTERNAL', 'A row source is written whole.');
  const dim = placement.dim ?? (frame ? DIM : rows ? rowDim(rowFactsOf.get(pixels)) : groupSize(pixels, pStride, px, py, width, height)), shift = 31 - Math.clz32(dim >> 7);
  try {
    const layout = groupLayout(width, height, dim), groups = layout.groupsX * layout.groupsY, sections = [];
    if (placement.frameHeader) placement.frameHeader(header, shift);
    else writeModularFrameHeader(header, {alpha: shape.alpha, shift, ...placement});
    let total = 0;
    const append = bytes => { total += bytes.length; admitOutputSize(total); if (total > ceiling) throw OVER; sections.push(bytes); };
    const lit = ((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || !__RAPIER_JXL_UPLOAD__) && (typeof __RAPIER_JXL_JPEG__ === 'undefined' || !__RAPIER_JXL_JPEG__)) && frame?.predicted === 'ramp' ? keyOrder(frame.colours) : !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && frame?.predicted === true ? lightOrder(frame.colours) : null;
    let indexModels = null;
    if (frame) {
      indexModels = new Array(groups);
      for (let g = 0; g < groups; g++) indexModels[g] = yield* unit('index-model', () => {
        const [x, y, w, h] = groupRect(layout, width, height, g, dim), {stride = width, x: fx = 0, y: fy = 0} = frame;
        if (((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || !__RAPIER_JXL_UPLOAD__) && (typeof __RAPIER_JXL_JPEG__ === 'undefined' || !__RAPIER_JXL_JPEG__)) && frame.predicted === 'ramp') return timed('copies', () => rampIndices(frame.indices, stride, (fy + y) * stride + fx + x, w, h, lit.remap));
        if (!(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && lit) return timed('trees', () => predictedIndices(frame.indices, stride, (fy + y) * stride + fx + x, w, h, lit.remap));
        return timed('copies', () => channelModel(frame.indices, w, h, 'index', 1, L.minCopy ?? 3, true, stride, (fy + y) * stride + fx + x));
      });
    }
    const alphaModels = frame?.alpha ? Array.from({length: groups}, (_, g) => {
      const [x, y, w, h] = groupRect(layout, width, height, g, dim);
      const plane = new Int16Array(w * h);
      for (let row = 0; row < h; row++) plane.set(frame.alpha.subarray((y + row) * width + x, (y + row) * width + x + w), row * w);
      return timed('gradient', () => channelModel(plane, w, h, 'smooth', 1, indexModels[g].minimum, false, w, 0, true));
    }) : null;
    const palette = frame ? yield* unit('palette', () => typeof __RAPIER_JXL_VERSION__ === 'undefined' && frame.predicted === 'select'
      ? {...timed('palette', () => deltaPaletteModel(frame.deltas, frame.deltaCount, shape.channels, indexModels, shape, TEXT_DELTA_PREDICTOR)), models: indexModels}
      : lit ? {...lit.palette(shape), models: indexModels}
      : {...timed('palette', () => paletteModel(frame.colours, indexModels, frame.alpha ? {colour: 3, alpha: false, channels: 3} : shape)), models: indexModels}) : null;
    if (palette) indexModels = palette.models;
    if (layout.single) {
      const stream = ({transforms, models}, planned = false) => {
        const global = new BitWriter(width * height + 256);
        placement.prefix?.(global);
        global.write(1, 1); global.write(1, 1);
        const write = timed('histograms', () => writeCodecChannels(global, planned ? models.map(m => ({...m})) : models, coding.trace));
        writeModularHeader(global, {transforms});
        return finishSection(global, write, planned);
      };
      return fits(assembleCodestream(header, [frame ? stream({transforms: [palette.meta.transform], models: [palette.model, indexModels[0], ...alphaModels ?? []]})
        : journaling() ? groupSections(stream, rows ? wholeRows(pixels) : pixels, pStride, px, py, width, height, shape, coding, true)
          : yield* groupSectionsSteps(stream, rows ? wholeRows(pixels) : pixels, pStride, px, py, width, height, shape, coding, true)]));
    }
    append(yield* unit('global', () => {
      const global = new BitWriter(1024);
      placement.prefix?.(global);
      global.write(1, 1); global.write(1, 1);
      if (frame) {
        const write = timed('histograms', () => writeCodecChannels(global, [palette.model], coding.trace));
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
    const gpu = !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && !written && !rows && coding.gpu && !frame && dim === DIM && coding.maxError === 0 && !L.gradient && width * height >= tools.gpu.pixels ? coding.gpu : null;
    const held = gpu ? new Array(groups) : null;
    let batch = null, ahead = null, band = null, bandY = -1;
    if (gpu) gpu.pixels = pixels;
    try {
      for (let g = 0; g < groups; g++) {
        if (!(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && gpu && (!batch || g >= batch.to)) {
          batch = ahead ?? (yield* askSteps(pixels, pStride, px, py, layout, width, height, shape, coding, g, held));
          ahead = batch.to < groups ? yield* askSteps(pixels, pStride, px, py, layout, width, height, shape, coding, batch.to, held) : null;
          yield* takeSteps(batch, gpu);
        }
        const [x, y, w, h] = groupRect(layout, width, height, g, dim);
        append(written ? written[g] : yield* unit('group', () => {
          const section = groupSection(w, h, coding);
          if (frame) return section({transforms: [], models: alphaModels ? [indexModels[g], alphaModels[g]] : [indexModels[g]]});
          if (!rows) return groupSections(section, pixels, pStride, px + x, py + y, w, h, shape, coding);
          if (typeof pixels.rect === 'function') {
            if (g + 1 < groups) { const [x2, y2, w2, h2] = groupRect(layout, width, height, g + 1, dim); pixels.ahead?.(y2 * width * 4, (y2 + h2) * width * 4, x2, w2); }
            return groupSections(section, pixels.rect(x, y, w, h), w, 0, 0, w, h, shape, coding);
          }
          if (y !== bandY) { band = null; band = readRows(pixels, y, h); bandY = y; }
          return groupSections(section, band, width, x, 0, w, h, shape, coding);
        }, undefined, false, true));
        if (frame) { indexModels[g] = null; if (alphaModels) alphaModels[g] = null; }
        if (!(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && gpu) { for (const key of held[g]) gpu.map.delete(key); held[g] = null; }
        yield (g + 1) / groups;
      }
    } finally { if (gpu) { gpu.map.clear(); gpu.pixels = null; } }
    return fits(assembleCodestream(header, sections, 5, journaling() && !layout.single ? journalJoin : null));
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

const groupSection = (w, h, coding) => (channels, planned = false) => {
  const out = new BitWriter(w * h + 256);
  writeModularHeader(out, {useGlobalTree: false, transforms: channels.transforms});
  const write = timed('histograms', () => writeCodecChannels(out, planned ? channels.models.map(m => ({...m})) : channels.models, coding.trace));
  return finishSection(out, write, planned);
};
function finishSection(out, write, planned) {
  const finish = () => { timed('write', write); return out.finish(); };
  return planned ? {length: Math.ceil((out.bitLength + write.bits()) / 8), finish} : finish();
}
export function captureGroupBytes(pixels, stride, {x, y, width, height}, level, shape, kit = CAPTURE_TOOLS_LEAN) {
  requireCaptureKernels();
  const outerLevel = L, outerTools = tools, coding = {maxError: 0};
  L = level; tools = kit; setStreamLevel(L);
  try { return groupSections(groupSection(width, height, coding), pixels, stride, x, y, width, height, shape, coding); }
  finally { L = outerLevel; tools = outerTools; setStreamLevel(L); if (!stepping) letGo(kit); }
}

export function captureResumeContext(level, kit, work) {
  const previous = [L, tools, timing, inner];
  L = level; tools = kit; timing = null; inner = 0; setStreamLevel(L);
  try { return work(); }
  finally { [L, tools, timing, inner] = previous; setStreamLevel(L); }
}
export {channelModel as captureChannelModel, paletteModel as capturePaletteModel,
  useWeighted as captureUseWeighted, singletonFastCopies as captureSingletonFastCopies, weightedModel as captureWeightedModel,
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
  if (((typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || !__RAPIER_JXL_CAPTURE_PHOTO__) && !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true)) && isRows(source) && !streamsRows(coding)) source = wholeRows(source);
  const words = unread(source) || ((typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || !__RAPIER_JXL_CAPTURE_PHOTO__) && !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true)) && isRows(source) ? null : pixelKeys(source);
  if (words && words.buffer === source.buffer) captureHold(words);
  try {
    const mode = coding.maxError === 0 && (!coding.base || coding.patches) ? coding.patches ?? L.patches : false;
    const peel = (typeof __RAPIER_JXL_JPEG__ === 'undefined' || !__RAPIER_JXL_JPEG__) && (typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || !__RAPIER_JXL_UPLOAD__) && mode === 'peel' ? yield* unit('peel', () => {
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

const patchLeast = effort => effort <= 3 ? 0.03 : effort <= 5 ? 0.01 : 0.005;
const patchSaving = effort => effort >= 3 ? 800 : Infinity;

function* markSteps(source, imageWidth, imageHeight, colorSpace, coding, mode) {
  const patches = mode ? yield* unit('patches', () => timed('patches', () => stepCached(stepCache?.patches, source, () => capturePatches(source, imageWidth, imageHeight, patchLeast(coding.effort), patchSaving(coding.patchEffort))))) : null;
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
  const peeled = (typeof __RAPIER_JXL_JPEG__ === 'undefined' || !__RAPIER_JXL_JPEG__) && (typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || !__RAPIER_JXL_UPLOAD__) && patches.peel;
  let scan = yield* unit('scan', () => {
    const found = scanColours(source, width, 0, 0, width, height, PALETTE_LIMIT);
    if (found && !peeled) fillPatches(found.indices, width, patches);
    return found;
  });
  const shape = shapeOf(scan ? scan.colours : pixelKeys(source), undefined, coding.base);
  const header = new BitWriter(128), atlasScan = yield* unit('atlas-scan', () => scanOf(patches.atlas, patches.width, 0, 0, patches.width, patches.height, PALETTE_LIMIT));
  writeHeaderFields(header, width, height, shape.colour, shape.alpha, {colorSpace});
  const atlas = yield* scaledSteps(captureFrameSteps(atlasScan ? null : patches.atlas, patches.width, patches.height, shape, coding, atlasScan,
    header, {frameHeader: (w, shift) => writeAtlasFrameHeader(w, shape.alpha, patches.width, patches.height, shift)}), 0, 1 / 4);
  let pixels = scan ? null : new Uint8Array(source);
  if (peeled) { pixels = patches.body; scan = patches.scan; if (scan) pixels = null; }
  else if (!scan) fillPatches(pixelKeys(pixels), width, patches);
  const body = yield* scaledSteps(captureFrameSteps(pixels, width, height, shape, coding, scan, new BitWriter(64),
    {frameHeader: (w, shift) => writePatchedFrameHeader(w, shape.alpha, shift, coding.reference ? 1 : 0), prefix: w => writeCapturePatches(w, patches, shape.alpha)}), 1 / 4, 3 / 4);
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
  if (!colours || !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && channels && colours > 1) return 'channels';
  if (base !== true && area <= SMALL_PICTURE && colours > 512 && colours * 32 <= area) {
    if (repeated === undefined) return 'repeats';
    if (repeated * 4 < area) return 'channels';
  }
  return colours * 32 > area ? area > SMALL_PICTURE ? 'channels' : 'compare' : 'palette';
}

function* pageSteps(source, imageWidth, imageHeight, colorSpace, coding) {
  const facts = ((typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || !__RAPIER_JXL_CAPTURE_PHOTO__) && !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true)) && isRows(source) ? yield* rowFacts(source) : null;
  const crop = typeof __RAPIER_JXL_VERSION__ !== 'undefined' || coding.oneFrame ? null : yield* unit('crop', () => timed('crop', () => screenCrop(source, imageWidth, imageHeight)));
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
  if (((typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || !__RAPIER_JXL_CAPTURE_PHOTO__) && !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true)) && choice === 'palette' && L.learnSets && scan.colours.length > 1) {
    const held = L.paletteBytes instanceof Uint8Array && !crop && !coding.reference ? L.paletteBytes : null;
    const palette = held ?? (yield* scaledSteps(within(routeSteps(source, imageWidth, imageHeight, colorSpace, coding, header, crop, scan)), 0, 1 / 2));
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
  const bands = typeof __RAPIER_JXL_VERSION__ !== 'undefined' || coding.oneFrame ? null : yield* unit('bands', () => screenBands(scan, width, height));
  const rare = typeof __RAPIER_JXL_VERSION__ === 'undefined' && !coding.oneFrame && coding.effort > 3 && !coding.base && (!scan || scan.colours.length > RARE_PALETTE) ? yield* unit('rare', () => timed('rare', () => rareRegions(source, imageWidth, scan, width, height, crop?.x ?? 0, crop?.y ?? 0))) : null;
  if (L.routes === 'all' || L.routes === 'rare' && width * height <= SMALL_PICTURE)
    return yield* everyRoute(source, imageWidth, imageHeight, colorSpace, coding, crop, scan, bands, rare);
  if (typeof __RAPIER_JXL_VERSION__ === 'undefined' && rare && rare.only >= 0.75) {
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
  if (typeof __RAPIER_JXL_VERSION__ === 'undefined' && bands) return yield* bandSteps(source, imageWidth, imageHeight, colorSpace, coding, header, crop, scan, bands);
  if (!scan || L.routes === 'one') return yield* pictureSteps(source, imageWidth, imageHeight, colorSpace, coding, header, null, crop, scan);
  const automatic = {};
  const best = yield* scaledSteps(within(pictureSteps(source, imageWidth, imageHeight, colorSpace, coding, header, null, crop, scan, undefined, undefined, automatic)), 0, 1 / 2);
  if (automatic.unsplit) return least(best);
  const unsplit = yield* scaledSteps(under(best, pictureSteps(source, imageWidth, imageHeight, colorSpace, coding, new BitWriter(128), null, crop, scan, false)), 1 / 2, 1 / 2);
  return least(best, unsplit);
}

function* everyRoute(source, imageWidth, imageHeight, colorSpace, coding, crop, scan, bands, rare) {
  const routes = [], automatic = {};
  if (typeof __RAPIER_JXL_VERSION__ === 'undefined' && bands) routes.push(h => bandSteps(source, imageWidth, imageHeight, colorSpace, coding, h, crop, scan, bands));
  routes.push(h => pictureSteps(source, imageWidth, imageHeight, colorSpace, coding, h, null, crop, scan, undefined, undefined, automatic),
    h => automatic.unsplit ? null : pictureSteps(source, imageWidth, imageHeight, colorSpace, coding, h, null, crop, scan, false));
  if (typeof __RAPIER_JXL_VERSION__ === 'undefined' && rare) routes.push(h => pictureSteps(source, imageWidth, imageHeight, colorSpace, coding, h, null, crop, null, rare));
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
  const dense = typeof __RAPIER_JXL_VERSION__ !== 'undefined' || scan ? new Uint8Array(tx * ty) : captureDenseTiles(words, stride, cx, cy, width, height);
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
  let partition = typeof __RAPIER_JXL_VERSION__ !== 'undefined' ? null : forced ?? (coding.oneFrame ? null : timed('partition', () => frame && screenColumns(source, imageWidth, imageHeight, view.stride, view.origin, crop) ||
    screenRegions(source, imageWidth, imageHeight, !frame, view.stride, view.origin)));
  if (typeof __RAPIER_JXL_VERSION__ === 'undefined' && partition) {
    const x0 = cx, y0 = cy, x1 = x0 + width, y1 = y0 + height;
    const regions = partition.regions.map(r => {
      const x = Math.max(r.x, x0), y = Math.max(r.y, y0);
      return {x, y, width: Math.min(r.x + r.width, x1) - x, height: Math.min(r.y + r.height, y1) - y, background: r.background ?? partition.background};
    }).filter(r => r.width > 0 && r.height > 0 && r.width < imageWidth && (forced || r.width * r.height >= 20000));
    const solid = partition.solid && regions.length === partition.regions.length && regions.every((r, i) => r.width === partition.regions[i].width && r.height === partition.regions[i].height);
    partition = regions.length && (!frame || forced || regions.some(r => r.y * 6 <= imageHeight)) ? {...partition, regions, solid} : null;
  }
  const facts = ((typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || !__RAPIER_JXL_CAPTURE_PHOTO__) && !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true)) && isRows(source) ? rowFactsOf.get(source) : null;
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
  if (typeof __RAPIER_JXL_VERSION__ !== 'undefined' || !partition) {
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
  if (((typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || !__RAPIER_JXL_CAPTURE_PHOTO__) && !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true)) && isRows(data)) {
    admitSize(width, height);
    if (data.width !== width || data.height !== height) throw fault('JXL_INPUT', 'A row source has the picture\'s width and height.');
  } else {
    admitPixels(data, width, height);
    if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray)) throw fault('JXL_INPUT', 'Captures use straight RGBA8 samples.');
  }
  const base = options[CAPTURE_BASE];
  return {colorSpace, coding: {maxError, onPredictor: typeof __RAPIER_JXL_PROBES__ === 'undefined' ? options[CAPTURE_PREDICTOR_PROBE] : null, base: base === true || base === 'reference',
    oneFrame: !!base || level.oneFrame === true, reference: base === 'reference', timing: typeof __RAPIER_JXL_PROBES__ === 'undefined' ? options[CAPTURE_TIMING] : null, trace: typeof __RAPIER_JXL_PROBES__ === 'undefined' ? options[CAPTURE_TRACE] : null, effort, level, tools, sizes: options[CAPTURE_SIZES],
    gpu: !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && options[CAPTURE_GPU] === true && level.gpu && tools.gpu ? {pixels: null, map: new Map()} : null, helpers: options[CAPTURE_HELPERS] === true,
    patches: [false, 'one', 'peel'].includes(options[CAPTURE_PATCHES]) ? options[CAPTURE_PATCHES] : undefined,
    patchEffort: options[CAPTURE_PATCH_EFFORT] ?? effort}};
}

export function captureBandShape(data, previous) {
  const {colour, alpha} = shapeOf(pixelKeys(data));
  if (!previous) return {colour, alpha};
  return {colour: Math.max(colour, previous.colour), alpha: alpha || previous.alpha};
}
function bandSetup(data, width, rows, y, imageHeight, shape, x, coding, imageWidth) {
  const whole = {...shape, channels: shape.colour + (shape.alpha ? 1 : 0)}, crop = typeof __RAPIER_JXL_VERSION__ !== 'undefined' || coding.oneFrame ? null : screenCrop(data, width, rows);
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
captureHeld(captureBusy);
export function* encodeCaptureSteps(data, width, height, options = {}) {
  idle();
  const {colorSpace, coding} = admitCapture(data, width, height, options);
  requireCaptureKernels();
  if (typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) return yield* smallestSteps({...coding, pixels: width * height}, c => captureSteps(data, width, height, colorSpace, c), true);
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
  const aborted = () => { if (options?.signal?.aborted) throw abortReason(options.signal); };
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
  if (!(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== "undefined" && __RAPIER_JXL_CAPTURE_LEAN__ === true) && !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true || typeof __RAPIER_JXL_JPEG__ !== 'undefined' && __RAPIER_JXL_JPEG__ === true) && coding.level.orders) levels.push({...coding.level, morton: true});
  if (!(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && coding.level.also) levels.push(...coding.level.also);
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
      const level = coding.maxError > 0 && levels[i].treeContexts ? {...levels[i], treeContexts: false} : levels[i];
      const candidate = {...coding, level, stepped: false, oneFrame: coding.base === true || level.oneFrame === true}, start = exactToo ? 2 * i * span : i * span;
      L = level; tools = coding.tools; setStreamLevel(L);
      const written = yield* stage('candidate', function* () {
        const file = yield* scaledSteps(guarded(run(candidate)), start, span);
        return {file, stepped: candidate.stepped};
      });
      candidate.stepped = written.stepped;
      let bytes = answer(written.file), kept = !candidate.stepped;
      if (exactToo && candidate.stepped) {
        L = levels[i]; setStreamLevel(L);
        try {
          const exact = answer(yield* stage('exact', () => scaledSteps(guarded(run({...candidate, level: levels[i], maxError: 0})), start + span, span)));
          if (exact.length <= bytes.length) { bytes = exact; kept = true; }
        } finally { L = level; setStreamLevel(L); }
      }
      sizes[i] = bytes.length;
      if (!best || bytes.length < best.length) { best = bytes; bestExact = kept; }
      if (coding.sizes && levels[i] === L3) coding.sizes.three = coding.pixels <= SMALL_FLOOR ? best.length : bytes.length;
      yield exactToo ? start + 2 * span : start + span;
      if (!(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && coding.level.combine && i === levels.length - 1 && !levels[i].combined) {
        const combined = captureCombinedLevel(coding.level, levels, sizes, own);
        if (combined) levels.push(combined);
      }
    }
  } finally { L = L3; tools = CAPTURE_TOOLS_LEAN; setStreamLevel(L); stepping = false; stepCache = outer; if (!outer) { if (holds) owed = coding.tools; else letGo(coding.tools); } }
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

import {captureLetGo} from './capture-kernels.mjs';
const KEEP = 1 << 16;
let holds = 0, owed = null;
export function holdCaptureMemory() {
  holds++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (--holds === 0 && owed && !stepping) { const kit = owed; owed = null; letGo(kit); }
  };
}
function letGo(kit) {
  letGoStreamKeys(KEEP);
  baseBuffer = null; lastWalk = null; sized.pixels = null; sized.scans.clear();
  captureLetGo(); kit?.trees?.letGo?.(KEEP);
}
