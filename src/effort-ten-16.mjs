// SPDX-License-Identifier: MIT
import {BitWriter, packSigned} from './bits.mjs';
import {writeImageHeader} from './icc-write.mjs';
import {writeModularFrameHeader, groupLayout, groupRect, assembleCodestream, codestreamFromParts} from './frame.mjs';
import {ALPHABET, leaf, split, intervals, writeTree, writeModularHeader, writeChannelHistograms} from './modular.mjs';
import {inspectPixels} from './lossless.mjs';
import {metaTableModel} from './native-modular.mjs';
import {learnTree, weightedTrees, transformRanking} from './capture-trees.mjs';
import {writeCaptureStream} from './capture-modular-stream.mjs';
import {CAPTURE_ANS, writeCrossChannelAns, writeCrossChannelAnsWide} from './capture-ans.mjs';
import {captureDistinct, captureWeighted, captureCustomWeighted, captureCustomWeightedBins, captureCutHistogram} from './capture-kernels.mjs';
import {kernelHooks, ensured, missing} from './kernel-hooks.mjs';
import {outOfMemory} from './fault.mjs';

const COMPACT_LIMIT_9 = 4096;
const COMPACT_LIMIT_10 = 32768;
const COMPACT_RCT_SAFE = 16384;
const STREAM_KEY_LIMIT = 1 << 20;
const CHAINED = 42 * 22;

const DEFAULT_WP = [16, 10, 7, 7, 7, 0, 0, 13, 12, 12, 12];
const PRESETS_8 = [
  DEFAULT_WP,
  [8, 8, 4, 0, 3, 23, 2, 13, 12, 12, 11],
  [10, 9, 7, 0, 0, 16, 9, 13, 12, 13, 12],
  [6, 6, 3, 0, 2, 26, 4, 13, 12, 12, 11],
  [12, 10, 6, 3, 6, 12, 6, 13, 12, 12, 12],
  [14, 11, 7, 5, 7, 6, 3, 12, 12, 12, 11],
  [4, 4, 2, 0, 2, 0, 0, 14, 11, 11, 10],
  [9, 9, 5, 0, 4, 20, 6, 13, 12, 12, 12],
];
const PRESETS_16 = [
  ...PRESETS_8,
  [3, 3, 2, 1, 2, 0, 0, 13, 12, 12, 12],
  [2, 2, 1, 0, 1, 0, 0, 14, 12, 12, 11],
  [5, 5, 3, 2, 3, 4, 2, 13, 13, 12, 12],
  [20, 14, 9, 8, 9, 4, 2, 12, 12, 12, 12],
];
const WP_MAX = [31, 31, 31, 31, 31, 31, 31, 15, 15, 15, 15];
const BASE_WP_CUTS = [-160, -80, -40, -20, -10, -4, 0, 4, 10, 20, 40, 80, 160];

const FULL_PROPS = [15, 9, 10, 11, 12, 13, 14, 4, 5, 6, 7, 8, 2, 3];
const FULL_PREDS = [5, 6, 1, 2, 3, 4, 0, 7, 8, 9, 10, 11, 12, 13];
const SHIFTED_PROPS = [15, 10, 11, 12, 13, 14, 6, 7, 2, 3];
const SHIFTED_PREDS = [6, 5, 4, 1, 2, 7, 8, 9];

const OPTS_E9 = {
  nodes: 287, samples: 24576, bins: 64, clustered: true, least: 64, charge: 8,
  properties: FULL_PROPS, predictors: FULL_PREDS, referenceKinds: [0, 1, 2, 3],
};

function optsFor16(pixels, stage4b, stage4c) {
  if (!stage4b && !stage4c) return OPTS_E9;
  const scaledNodes = pixels <= 32768 ? 255 : pixels <= 262144 ? 511 : 767;
  const sampleCap = Math.min(pixels, 98304);
  if (!stage4b) {
    return {...OPTS_E9, nodes: Math.min(287, scaledNodes), samples: sampleCap, bins: 128, clustered: true, clusters: 84, leafBits: 12, histSym: 1.5, histBase: 24};
  }
  return {
    nodes: scaledNodes, samples: sampleCap, bins: 192,
    clustered: true, clusters: 96, least: 64, charge: 10,
    leafBits: 12, histSym: 1.5, histBase: 24,
    properties: FULL_PROPS, predictors: FULL_PREDS, referenceKinds: [0, 1, 2, 3],
  };
}

let zeroDistances = new Int32Array(0);
function noCopies(n) {
  if (zeroDistances.length < n) zeroDistances = new Int32Array(n);
  return zeroDistances.subarray(0, n);
}

const orderAsc = keys => Int32Array.from([...keys].sort((a, b) => a - b));
const unpackSigned = u => (u & 1) ? -((u + 1) >>> 1) : (u >>> 1);

function fillRct(planes, packed, stride, x0, y0, w, h, channels, rctType) {
  const base = rctType >= CHAINED ? rctType - CHAINED : rctType;
  (kernelHooks.rct ?? ensured().rct ?? missing())(packed, stride, x0, y0, w, h, base, channels, planes);
  if (rctType >= CHAINED && channels >= 3) {
    const p1 = planes[1], p2 = planes[2];
    planes[1] = p2;
    planes[2] = p1;
  }
}

function rctTransforms(beginC, rctType) {
  if (!rctType) return [];
  if (rctType >= CHAINED) {
    return [{type: 'rct', beginC, rctType: rctType - CHAINED}, {type: 'rct', beginC, rctType: 21}];
  }
  return [{type: 'rct', beginC, rctType}];
}

function rctCandidates(first, second, stage4c) {
  if (!stage4c) return [first];
  return [first, CHAINED + first];
}

function scaledWpCuts(planes, scale16) {
  if (!scale16) return Int32Array.from(BASE_WP_CUTS);
  let peak = 255;
  for (const p of planes) {
    const step = Math.max(1, (p.length / 4096) | 0);
    for (let i = 0; i < p.length; i += step) {
      const a = Math.abs(p[i]);
      if (a > peak) peak = a;
    }
  }
  const bits = Math.max(8, 32 - Math.clz32(peak));
  const mul = 1 << Math.max(0, bits - 9);
  return Int32Array.from(BASE_WP_CUTS, c => c * mul);
}

function wpStripCost(planes, width, wp, strips, cuts) {
  let bits = 0;
  for (const plane of planes) {
    const {bins, raw} = captureCustomWeightedBins(plane, width, plane.length / width, wp, strips, cuts);
    bits += raw;
    for (let b = 0; b < 14; b++) {
      let total = 0;
      for (let t = 0; t < 48; t++) total += bins[b * 48 + t];
      for (let t = 0; t < 48; t++) if (bins[b * 48 + t]) bits += bins[b * 48 + t] * Math.log2(total / bins[b * 48 + t]);
    }
  }
  return bits;
}

function searchWpParameters(planes, width, height, stage4b, coordinateSearch) {
  if (width < 16 || height < 16 || planes.some(p => !(p instanceof Int16Array))) return null;
  const rows = Math.min(64, height), count = Math.min(4, Math.max(1, Math.floor(height / rows))), strips = [];
  for (let k = 0; k < count; k++) {
    const y = Math.floor((height - rows) * k / Math.max(1, count - 1));
    strips.push([y, y + rows]);
  }
  const cuts = scaledWpCuts(planes, stage4b);
  const presets = stage4b ? PRESETS_16 : PRESETS_8;
  let best = DEFAULT_WP, least = Infinity;
  for (const wp of presets) {
    const bits = wpStripCost(planes, width, wp, strips, cuts);
    if (bits < least) { least = bits; best = wp; }
  }
  if (coordinateSearch) {
    best = best.slice();
    for (const step of [3, 1]) {
      for (let pass = 0, moved = true; moved && pass < 2; pass++) {
        moved = false;
        for (let i = 0; i < 11; i++) {
          for (const d of [-step, step]) {
            const val = best[i] + d;
            if (val < 0 || val > WP_MAX[i]) continue;
            const cand = best.slice();
            cand[i] = val;
            const bits = wpStripCost(planes, width, cand, strips, cuts);
            if (bits + 48 < least) { least = bits; best = cand; moved = true; }
          }
        }
      }
    }
  }
  if (best.every((v, i) => v === DEFAULT_WP[i])) return null;
  return Object.freeze({values: best, weighted: (plane, w, h) => captureCustomWeighted(plane, w, h, best)});
}

function quickResidualCost(resArr, offset) {
  const counts = new Uint32Array(64);
  let raw = 0;
  const n = resArr.length;
  for (let i = 0; i < n; i++) {
    const u = packSigned(resArr[i] - offset);
    if (u < 16) counts[u]++;
    else {
      const top = 31 - Math.clz32(u);
      const sub = (u >>> (top - 2)) & 3;
      const sym = Math.min(63, 16 + ((top - 4) << 2) + sub);
      counts[sym]++;
      raw += top - 2;
    }
  }
  let bits = raw, used = 0;
  const logN = Math.log2(n);
  for (let s = 0; s < 64; s++) {
    const c = counts[s];
    if (c) { bits += c * (logN - Math.log2(c)); used++; }
  }
  const offsetCost = offset === 0 ? 0 : 8 + Math.ceil(Math.log2(packSigned(offset) + 2));
  return bits + 3.5 * used + offsetCost;
}

function applyLeafOffsets(model) {
  if (!model || !model.tree || model.classes < 1) return model;
  const {count, classes, pieceValue, pieceContext, pieceDistance} = model;
  const counts = new Int32Array(classes);
  for (let i = 0; i < count; i++) {
    if (pieceDistance[i]) return model;
    counts[pieceContext[i]]++;
  }
  const starts = new Int32Array(classes + 1);
  for (let c = 0; c < classes; c++) starts[c + 1] = starts[c] + counts[c];
  const cursor = Int32Array.from(starts.subarray(0, classes));
  const grouped = new Int32Array(count);
  for (let i = 0; i < count; i++) grouped[cursor[pieceContext[i]]++] = unpackSigned(pieceValue[i]);
  const offsets = new Int32Array(classes);
  let anyChanged = false;
  for (let c = 0; c < classes; c++) {
    if (counts[c] < 64) continue;
    const sorted = grouped.subarray(starts[c], starts[c + 1]).sort();
    const med = sorted[sorted.length >> 1];
    const baseCost = quickResidualCost(sorted, 0);
    let bestOff = 0, bestCost = baseCost - 16;
    const candidates = new Set([med - 2, med - 1, med, med + 1, med + 2, -1, 1]);
    for (const cand of candidates) {
      if (cand === 0 || cand < -4096 || cand > 4096) continue;
      if (packSigned(sorted[0] - cand) >= STREAM_KEY_LIMIT || packSigned(sorted[sorted.length - 1] - cand) >= STREAM_KEY_LIMIT) continue;
      const cost = quickResidualCost(sorted, cand);
      if (cost < bestCost) { bestCost = cost; bestOff = cand; }
    }
    if (bestOff !== 0) { offsets[c] = bestOff; anyChanged = true; }
  }
  if (!anyChanged) return model;
  const nextValues = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    const off = offsets[pieceContext[i]];
    nextValues[i] = off ? packSigned(unpackSigned(pieceValue[i]) - off) : pieceValue[i];
  }
  const newLeaves = [];
  const cloneTree = node => {
    if (node.left) return {...node, left: cloneTree(node.left), right: cloneTree(node.right)};
    const copy = {...node, offset: (node.offset ?? 0) + offsets[node.local]};
    newLeaves.push(copy);
    return copy;
  };
  const nextTree = cloneTree(model.tree);
  return {...model, tree: nextTree, leaves: newLeaves, pieceValue: nextValues};
}

function translateShiftedTree(node, shift, refShifts, row0Ctx, cornerCtx) {
  const mapNode = n => {
    if (!n.left) return {...n};
    let cut = n.splitval;
    if (n.property === 6 || n.property === 7) cut += shift;
    else if (n.property >= 16 && ((n.property - 16) & 3) === 1) {
      const refIdx = (n.property - 16) >> 2;
      cut += refShifts[refIdx] ?? 0;
    }
    return split(n.property, cut, mapNode(n.left), mapNode(n.right));
  };
  const mapped = mapNode(node);
  const row0Leaf = Object.assign(leaf(1, 0, 1), {local: row0Ctx});
  const cornerLeaf = Object.assign(leaf(6, 0, 1), {local: cornerCtx});
  return split(2, 0, mapped, split(3, 0, row0Leaf, cornerLeaf));
}

function collectOrderedLeaves(tree) {
  const leaves = [];
  const walk = n => { if (n.left) { walk(n.left); walk(n.right); } else leaves.push(n); };
  walk(tree);
  return leaves;
}

function wide32IntervalModel(plane32, w, h) {
  const n = w * h, residuals = new Uint32Array(n), props = new Int32Array(n);
  captureWeighted(null, null, plane32, w, h, 0, undefined, residuals, props);
  const sorted = Int32Array.from(props).sort();
  const cuts = [];
  for (let b = 1; b < 16; b++) {
    const c = Math.max(-8191, Math.min(8190, sorted[Math.floor(b * n / 16)]));
    if (c < sorted[n - 1] && (!cuts.length || c > cuts[cuts.length - 1])) cuts.push(c);
  }
  const k = cuts.length + 1, TOK = 48;
  const {hist, raw} = captureCutHistogram(cuts, residuals, props);
  const cost = (hArr, rVal) => {
    let total = 0, bits = rVal, used = 0;
    for (let t = 0; t < TOK; t++) total += hArr[t];
    for (let t = 0; t < TOK; t++) if (hArr[t]) { bits += hArr[t] * Math.log2(total / hArr[t]); used++; }
    return total ? bits + 4 * used + 16 : 0;
  };
  const groups = Array.from({length: k}, (_, g) => ({h: hist.slice(g * TOK, (g + 1) * TOK), r: raw[g], cut: g < cuts.length ? cuts[g] : null}));
  for (;;) {
    let best = 0, at = -1;
    for (let g = 0; g + 1 < groups.length; g++) {
      const a = groups[g], b = groups[g + 1], merged = a.h.map((v, t) => v + b.h[t]);
      const save = cost(a.h, a.r) + cost(b.h, b.r) - cost(merged, a.r + b.r);
      if (save > best) { best = save; at = g; }
    }
    if (at < 0) break;
    const a = groups[at], b = groups[at + 1];
    groups.splice(at, 2, {h: a.h.map((v, t) => v + b.h[t]), r: a.r + b.r, cut: b.cut});
  }
  const finalCuts = groups.slice(0, -1).map(g => g.cut);
  const leaves = [];
  const tree = intervals(15, finalCuts, () => { const nd = leaf(6); nd.local = leaves.length; leaves.push(nd); return nd; });
  const contexts = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const v = props[i];
    let lo = 0, hi = finalCuts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (v > finalCuts[mid]) lo = mid + 1; else hi = mid;
    }
    contexts[i] = finalCuts.length - lo;
  }
  return {
    kind: 'smooth', tree, leaves, classes: leaves.length, width: w, height: h, stride: w, origin: 0,
    plane: plane32, minimum: 4, count: n, pieceValue: Int32Array.from(residuals), pieceDistance: noCopies(n), pieceContext: contexts,
  };
}

function build16PlaneModel(plane, w, h, baseOpts, refEntries, wp, allowOffsets) {
  const n = w * h;
  let minV = plane[0], maxV = plane[0];
  for (let i = 1; i < n; i++) {
    const v = plane[i];
    if (v < minV) minV = v;
    else if (v > maxV) maxV = v;
  }
  if (minV === 0 && maxV === 0) {
    const lf = Object.assign(leaf(0, 0, 1), {local: 0});
    return {
      model: {kind: 'smooth', tree: lf, leaves: [lf], classes: 1, width: w, height: h, stride: w, origin: 0, plane, minimum: 4, count: n, pieceValue: new Int32Array(n), pieceDistance: noCopies(n), pieceContext: new Uint8Array(n)},
      ref: {plane16: plane instanceof Int16Array ? plane : new Int16Array(n), shift: 0},
    };
  }
  if (minV >= -32768 && maxV <= 32767) {
    const p16 = plane instanceof Int16Array ? plane : Int16Array.from(plane);
    const validRefs = [];
    for (const r of refEntries) { if (!r || r.shift !== 0) break; validRefs.push(r.plane16); }
    const answer = wp ? wp.weighted(p16, w, h) : (() => {
      const residuals = new Uint32Array(n), properties = new Int32Array(n);
      captureWeighted(null, null, p16, w, h, 0, undefined, residuals, properties);
      return {residuals, properties};
    })();
    const learned = learnTree(p16, w, h, {...baseOpts, references: validRefs, wp}, answer);
    let model;
    if (learned) {
      model = {
        kind: 'smooth', tree: learned.tree, leaves: learned.leaves, classes: learned.classes,
        width: w, height: h, stride: w, origin: 0, plane: p16, minimum: 4, count: n,
        pieceValue: learned.values, pieceDistance: noCopies(n), pieceContext: learned.contexts,
      };
    } else if (wp) {
      const lf = Object.assign(leaf(6, 0, 1), {local: 0});
      model = {
        kind: 'smooth', tree: lf, leaves: [lf], classes: 1,
        width: w, height: h, stride: w, origin: 0, plane: p16, minimum: 4, count: n,
        pieceValue: Int32Array.from(answer.residuals), pieceDistance: noCopies(n), pieceContext: new Uint8Array(n),
      };
    } else {
      model = weightedTrees(p16, w, h, [0])[0];
    }
    if (allowOffsets) model = applyLeafOffsets(model);
    return {model, ref: {plane16: p16, shift: 0}};
  }
  if (maxV - minV <= 65535) {
    const shift = Math.max(maxV - 32767, Math.min(minV + 32768, (minV + maxV) >> 1));
    const p32 = plane instanceof Int32Array ? plane : Int32Array.from(plane);
    const p16 = new Int16Array(n);
    for (let i = 0; i < n; i++) p16[i] = p32[i] - shift;
    const residuals = new Uint32Array(n), properties = new Int32Array(n);
    captureWeighted(null, null, p32, w, h, 0, undefined, residuals, properties);
    const answer = {residuals, properties};
    const usableRefs = [];
    for (const r of refEntries) { if (!r) break; usableRefs.push(r); }
    const refPlanes16 = usableRefs.map(r => r.plane16);
    const refShifts = usableRefs.map(r => r.shift);
    const maxNodes = Math.min(baseOpts.nodes, 247 + Math.floor(n / 16));
    const shiftedOpts = {
      ...baseOpts,
      nodes: Math.min(maxNodes, 505),
      clustered: maxNodes > 505 || baseOpts.clustered,
      clusters: Math.min(baseOpts.clusters ?? 192, 190),
      properties: SHIFTED_PROPS,
      predictors: SHIFTED_PREDS,
      references: [],
      wp: null,
    };
    const learned = learnTree(p16, w, h, shiftedOpts, answer);
    let model;
    if (learned && learned.classes <= 252) {
      const row0Ctx = learned.classes, cornerCtx = learned.classes + 1;
      const tree = translateShiftedTree(learned.tree, shift, refShifts, row0Ctx, cornerCtx);
      const leaves = collectOrderedLeaves(tree);
      const values = Int32Array.from(learned.values);
      const contexts = Uint8Array.from(learned.contexts);
      values[0] = residuals[0];
      contexts[0] = cornerCtx;
      for (let x = 1; x < w; x++) {
        values[x] = packSigned(p32[x] - p32[x - 1]);
        contexts[x] = row0Ctx;
      }
      model = {
        kind: 'smooth', tree, leaves, classes: cornerCtx + 1,
        width: w, height: h, stride: w, origin: 0, plane: p32, minimum: 4, count: n,
        pieceValue: values, pieceDistance: noCopies(n), pieceContext: contexts,
      };
    } else {
      model = wide32IntervalModel(p32, w, h);
    }
    if (allowOffsets) model = applyLeafOffsets(model);
    return {model, ref: {plane16: p16, shift}};
  }
  const p32 = plane instanceof Int32Array ? plane : Int32Array.from(plane);
  let model = wide32IntervalModel(p32, w, h);
  if (allowOffsets) model = applyLeafOffsets(model);
  return {model, ref: null};
}

function safeWriteStream(w, models, ans, opts) {
  if (!ans) return writeCaptureStream(w, models, null, opts);
  const snapAt = w.at, snapAcc = w.acc, snapPending = w.pending;
  try {
    return writeCaptureStream(w, models, ans, opts);
  } catch (err) {
    if (err?.code !== 'JXL_MEMORY') throw err;
    w.at = snapAt; w.acc = snapAcc; w.pending = snapPending;
    return writeCaptureStream(w, models, null, opts);
  }
}

function ansConfigFor(stage4b, stage4c) {
  if (stage4b && stage4c) return {...CAPTURE_ANS, extra: writeCrossChannelAnsWide};
  if (stage4c) return {...CAPTURE_ANS, extra: writeCrossChannelAns};
  if (stage4b) return {...CAPTURE_ANS, extra: writeCrossChannelAnsWide};
  return CAPTURE_ANS;
}

function scanDistinctChannels(words, channels, colour, limit) {
  const n = words.length >> 2;
  const tables = [], indices = [];
  let maxLen = 0, allFound = true, anyFound = false;
  for (let c = 0; c < channels; c++) {
    const from = c < colour ? c : 3;
    const found = captureDistinct(words, from, limit, orderAsc, new Int16Array(n));
    if (!found) {
      tables.push(null); indices.push(null); allFound = false; continue;
    }
    const meta = metaTableModel(found.table);
    if (!meta) {
      tables.push(null); indices.push(null); allFound = false; continue;
    }
    tables.push({table: found.table, meta});
    indices.push(found.plane);
    anyFound = true;
    if (found.table.length > maxLen) maxLen = found.table.length;
  }
  return {tables, indices, maxLen, allFound, anyFound};
}

function extractRectWords(data, stride, x0, y0, gw, gh) {
  if (x0 === 0 && y0 === 0 && gw === stride) return data.subarray(0, gw * gh * 4);
  const out = new Uint16Array(gw * gh * 4);
  for (let y = 0; y < gh; y++) {
    const from = ((y0 + y) * stride + x0) * 4;
    out.set(data.subarray(from, from + gw * 4), y * gw * 4);
  }
  return out;
}

function applyRct32(words, gw, gh, channels, colour, rctType) {
  const n = gw * gh;
  const planes = Array.from({length: channels}, () => new Int32Array(n));
  if (colour !== 3 || rctType === 0) {
    for (let c = 0; c < channels; c++) {
      const from = c < colour ? c : 3;
      const dst = planes[c];
      for (let i = 0; i < n; i++) dst[i] = words[i * 4 + from];
    }
    return planes;
  }
  const base = rctType >= CHAINED ? rctType - CHAINED : rctType;
  const perm = Math.floor(base / 7), mode = base % 7, kind = mode >> 1;
  const i0 = perm % 3, i1 = (perm + 1 + Math.floor(perm / 3)) % 3, i2 = (perm + 2 - Math.floor(perm / 3)) % 3;
  const p0 = planes[0], p1 = planes[1], p2 = planes[2];
  for (let i = 0, at = 0; i < n; i++, at += 4) {
    const F = words[at + i0], S = words[at + i1], T = words[at + i2];
    if (mode === 6) {
      const co = F - T, tmp = T + (co >> 1), cg = S - tmp;
      p0[i] = tmp + (cg >> 1); p1[i] = co; p2[i] = cg;
    } else {
      p0[i] = F;
      p1[i] = kind === 1 ? S - F : kind === 2 ? S - ((F + T) >> 1) : S;
      p2[i] = (mode & 1) ? T - F : T;
    }
  }
  if (rctType >= CHAINED) {
    planes[1] = p2;
    planes[2] = p1;
  }
  if (channels === 4) {
    const pa = planes[3];
    for (let i = 0; i < n; i++) pa[i] = words[i * 4 + 3];
  }
  return planes;
}

function writeSectionFromModels(models, metaModels, transforms, wpValues, isGlobal, ansTools, tryRunsBoth = false) {
  const writeOnce = runs => {
    const w = new BitWriter(4096);
    if (isGlobal) { w.write(1, 1); w.write(1, 1); }
    safeWriteStream(w, [...metaModels, ...models], ansTools, {
      global: isGlobal,
      runs,
      transforms,
      ...(wpValues ? {weighted: wpValues} : {}),
    });
    return w.finish();
  };
  const bNoRuns = writeOnce(false);
  if (!tryRunsBoth) return bNoRuns;
  const bRuns = writeOnce(true);
  return bRuns.length < bNoRuns.length ? bRuns : bNoRuns;
}

export function encodeGroup16Candidate(rectWords, gw, gh, shape, stages, mode, globalComp = null) {
  const {channels, colour, alpha} = shape;
  const {stage4a, stage4b, stage4c, stage4d} = stages;
  const ansTools = ansConfigFor(stage4b, stage4c);
  const learnOpts = optsFor16(gw * gh, stage4b, stage4c);
  const isGlobal = Boolean(mode.isGlobal);

  if (mode.kind === 'compacted') {
    const limit = stage4a ? COMPACT_LIMIT_10 : COMPACT_LIMIT_9;
    const comp = globalComp ?? scanDistinctChannels(rectWords, channels, colour, limit);
    if (!comp.anyFound) return null;
    if (!comp.allFound) {
      if (!stage4a) return null;
      const palTransforms = [], metaModels = [], planes = [];
      let metaShift = 0;
      for (let c = 0; c < channels; c++) {
        if (comp.tables[c]) {
          palTransforms.push({type: 'palette', beginC: c + metaShift, numC: 1, nbColors: comp.tables[c].table.length, nbDeltas: 0, predictor: 0});
          metaModels.unshift(comp.tables[c].meta);
          metaShift++;
          planes.push(comp.indices[c]);
        } else {
          if (!stage4b) return null;
          const from = c < colour ? c : 3, p32 = new Int32Array(gw * gh);
          for (let i = 0; i < gw * gh; i++) p32[i] = rectWords[i * 4 + from];
          planes.push(p32);
        }
      }
      const models = [], refs = [];
      for (let c = 0; c < channels; c++) {
        const built = build16PlaneModel(planes[c], gw, gh, learnOpts, refs.slice().reverse(), null, stage4d);
        models.push(built.model);
        refs.push(built.ref);
      }
      return {
        bytes: writeSectionFromModels(models, metaModels, palTransforms, null, isGlobal, ansTools, false),
        choice: {transforms: palTransforms, wp: null},
      };
    }

    const canRct16 = colour === 3 && comp.maxLen <= COMPACT_RCT_SAFE;
    const packed = canRct16 ? new Int16Array(gw * gh * 4) : null;
    if (packed) {
      for (let i = 0; i < gw * gh; i++) {
        packed[i * 4] = comp.indices[0][i];
        packed[i * 4 + 1] = comp.indices[1][i];
        packed[i * 4 + 2] = comp.indices[2][i];
        if (alpha) packed[i * 4 + 3] = comp.indices[3][i];
      }
    }
    const ranked = packed ? transformRanking(packed, gw, gh) : [0];
    const rctList = packed ? rctCandidates(ranked[0], ranked[1], stage4c) : [0];

    const palTransforms = isGlobal || !globalComp
      ? comp.tables.map((t, c) => ({type: 'palette', beginC: 2 * c, numC: 1, nbColors: t.table.length, nbDeltas: 0, predictor: 0}))
      : [];
    const metaModels = isGlobal || !globalComp ? comp.tables.map(t => t.meta).reverse() : [];
    const rctBegin = palTransforms.length ? channels : 0;

    let bestBytes = null, bestChoice = null, winningRct = rctList[0], winningPlanes = null;
    for (const rctType of rctList) {
      const planes = Array.from({length: channels}, () => new Int16Array(gw * gh));
      if (rctType && packed) fillRct(planes, packed, gw, 0, 0, gw, gh, channels, rctType);
      else for (let c = 0; c < channels; c++) planes[c].set(comp.indices[c]);

      const models = [], refs = [];
      for (let c = 0; c < channels; c++) {
        const built = build16PlaneModel(planes[c], gw, gh, learnOpts, refs.slice().reverse(), null, stage4d);
        models.push(built.model);
        refs.push(built.ref);
      }
      const transforms = [...palTransforms, ...rctTransforms(rctBegin, rctType)];
      const bytes = writeSectionFromModels(models, metaModels, transforms, null, isGlobal, ansTools, false);
      if (!bestBytes || bytes.length < bestBytes.length) {
        bestBytes = bytes;
        bestChoice = {transforms, wp: null};
        winningRct = rctType;
        winningPlanes = planes;
      }
    }

    if (winningPlanes && (stage4b || stage4c)) {
      const customWp = searchWpParameters(winningPlanes.slice(0, colour), gw, gh, stage4b, stage4c);
      if (customWp) {
        const models = [], refs = [];
        for (let c = 0; c < channels; c++) {
          const built = build16PlaneModel(winningPlanes[c], gw, gh, learnOpts, refs.slice().reverse(), customWp, stage4d);
          models.push(built.model);
          refs.push(built.ref);
        }
        const transforms = [...palTransforms, ...rctTransforms(rctBegin, winningRct)];
        const bytes = writeSectionFromModels(models, metaModels, transforms, customWp.values, isGlobal, ansTools, false);
        if (bytes.length < bestBytes.length) {
          bestBytes = bytes;
          bestChoice = {transforms, wp: customWp.values};
        }
      }
    }
    return bestBytes ? {bytes: bestBytes, choice: bestChoice} : null;
  }

  if (mode.kind === 'full16') {
    if (!stage4b && !stage4c && !stage4d) return null;
    if (!stage4b) {
      if (colour !== 3 || alpha) return null;
      const n = gw * gh, Y = new Int16Array(n), Co = new Int16Array(n), Cg = new Int16Array(n);
      let maxY = 0, y0True = 0;
      for (let i = 0; i < n; i++) {
        const r = rectWords[i * 4], g = rectWords[i * 4 + 1], b = rectWords[i * 4 + 2];
        const co = r - b, tmp = b + (co >> 1), cg = g - tmp, luma = tmp + (cg >> 1);
        if (co < -32768 || co > 32767 || cg < -32768 || cg > 32767) return null;
        if (i === 0) y0True = luma;
        if (luma > maxY) maxY = luma;
        Co[i] = co; Cg[i] = cg; Y[i] = luma;
      }
      if (maxY > 32767) {
        for (let i = 0; i < n; i++) {
          const r = rectWords[i * 4], g = rectWords[i * 4 + 1], b = rectWords[i * 4 + 2];
          const co = r - b, tmp = b + (co >> 1), cg = g - tmp;
          Y[i] = (tmp + (cg >> 1)) - 32768;
        }
      }
      const sOpts = {...OPTS_E9, properties: maxY > 32767 ? [10, 11, 12, 13, 14, 2, 3] : FULL_PROPS, predictors: maxY > 32767 ? [5, 4, 1, 2, 7, 8, 9] : FULL_PREDS};
      let mY = build16PlaneModel(Y, gw, gh, sOpts, [], null, false).model;
      if (maxY > 32767) { const pv = Int32Array.from(mY.pieceValue); pv[0] = packSigned(y0True); mY = {...mY, pieceValue: pv}; }
      const mCo = build16PlaneModel(Co, gw, gh, OPTS_E9, maxY > 32767 ? [] : [{plane16: Y, shift: 0}], null, stage4d).model;
      const mCg = build16PlaneModel(Cg, gw, gh, OPTS_E9, maxY > 32767 ? [{plane16: Co, shift: 0}] : [{plane16: Co, shift: 0}, {plane16: Y, shift: 0}], null, stage4d).model;
      if (stage4d && maxY <= 32767) mY = applyLeafOffsets(mY);
      const transforms = [{type: 'rct', beginC: 0, rctType: 6}];
      return {bytes: writeSectionFromModels([mY, mCo, mCg], [], transforms, null, isGlobal, ansTools, false), choice: {transforms, wp: null}};
    }

    let rctList = [0];
    if (colour === 3) {
      const scaled = new Int16Array(gw * gh * 4);
      for (let i = 0; i < gw * gh * 4; i += 4) {
        scaled[i] = rectWords[i] >>> 2;
        scaled[i + 1] = rectWords[i + 1] >>> 2;
        scaled[i + 2] = rectWords[i + 2] >>> 2;
      }
      const ranked = transformRanking(scaled, gw, gh);
      rctList = stage4c ? [ranked[0], CHAINED + ranked[0]] : [ranked[0]];
    }
    let bestBytes = null, bestChoice = null;
    for (const rctType of rctList) {
      const planes32 = applyRct32(rectWords, gw, gh, channels, colour, rctType);
      const models = [], refs = [];
      for (let c = 0; c < channels; c++) {
        const built = build16PlaneModel(planes32[c], gw, gh, learnOpts, refs.slice().reverse(), null, stage4d);
        models.push(built.model);
        refs.push(built.ref);
      }
      const transforms = rctTransforms(0, rctType);
      const bytes = writeSectionFromModels(models, [], transforms, null, isGlobal, ansTools, false);
      if (!bestBytes || bytes.length < bestBytes.length) {
        bestBytes = bytes;
        bestChoice = {transforms, wp: null};
      }
    }
    return bestBytes ? {bytes: bestBytes, choice: bestChoice} : null;
  }
  return null;
}

function* buildSingleFrameCandidate(data, width, height, shape, samples, stages, shift, kind, globalComp = null, helped = false) {
  const {alpha, colour} = shape;
  const dim = 128 << shift, layout = groupLayout(width, height, dim), groups = layout.groupsX * layout.groupsY;
  const level = samples.level === 10 || samples.bitDepth > 12 || samples.exponentBits ? 10 : 5;
  const header = new BitWriter(256);
  writeImageHeader(header, width, height, colour, alpha, samples);
  writeModularFrameHeader(header, {alpha, shift});

  if (layout.single) {
    const rectWords = extractRectWords(data, width, 0, 0, width, height);
    const res = encodeGroup16Candidate(rectWords, width, height, shape, stages, {kind, isGlobal: true}, globalComp);
    if (!res) return null;
    return assembleCodestream(header, [res.bytes], level);
  }

  const ansTools = ansConfigFor(stages.stage4b, stages.stage4c);
  const global = new BitWriter(256);
  global.write(1, 1); global.write(1, 1);
  if (kind === 'compacted' && globalComp?.allFound) {
    const palTransforms = globalComp.tables.map((t, c) => ({type: 'palette', beginC: 2 * c, numC: 1, nbColors: t.table.length, nbDeltas: 0, predictor: 0}));
    const metaModels = globalComp.tables.map(t => t.meta).reverse();
    safeWriteStream(global, metaModels, ansTools, {global: true, runs: false, transforms: palTransforms});
  } else {
    writeChannelHistograms(global, writeTree(global, leaf(0)), [new Uint32Array(ALPHABET)]);
    writeModularHeader(global, {transforms: []});
  }

  const sections = [global.finish()];
  for (let i = 0; i < layout.dcGroupsX * layout.dcGroupsY + 1; i++) sections.push(new Uint8Array(0));
  const useTasks = helped && !globalComp && stages.stage4a && stages.stage4b && stages.stage4c && stages.stage4d;
  const part = kind === 'compacted' ? 0 : 1;
  const tasks = useTasks ? Array.from({length: groups}, (_, g) => {
    const [x, y, gw, gh] = groupRect(layout, width, height, g, dim);
    return {kind: 'effort-ten', data, width, height, colorSpace: 'srgb', rect: {x, y, width: gw, height: gh}, part, shape: {...shape, deep16: true}};
  }) : null;
  if (tasks) yield {offload: 'prefetch', tasks};
  for (let g = 0; g < groups; g++) {
    let res = null;
    if (tasks) {
      const remote = yield {offload: 'run', task: tasks[g]};
      if (remote?.bytes instanceof Uint8Array) res = remote;
    }
    if (!res) {
      const [x0, y0, gw, gh] = groupRect(layout, width, height, g, dim);
      const rectWords = extractRectWords(data, width, x0, y0, gw, gh);
      const subGlobal = globalComp?.allFound ? {
        ...globalComp,
        indices: globalComp.indices.map(plane => {
          const sub = new Int16Array(gw * gh);
          for (let y = 0; y < gh; y++) sub.set(plane.subarray((y0 + y) * width + x0, (y0 + y) * width + x0 + gw), y * gw);
          return sub;
        }),
      } : null;
      res = encodeGroup16Candidate(rectWords, gw, gh, shape, stages, {kind, isGlobal: false}, subGlobal);
    }
    if (!res) return null;
    sections.push(res.bytes);
    yield (g + 1) / groups;
  }
  return assembleCodestream(header, sections, level);
}

function stepTableMeta(count, step) {
  const values = new Int32Array(count), contexts = new Uint8Array(count);
  values[0] = 0; contexts[0] = 0;
  for (let i = 1; i < count; i++) { values[i] = packSigned(1); contexts[i] = 1; }
  const l0 = Object.assign(leaf(0, 0, 1), {local: 0});
  const l1 = Object.assign(leaf(1, 0, step), {local: 1});
  return {
    kind: 'smooth', tree: split(3, 0, l1, l0), leaves: [l0, l1], classes: 2,
    width: count, height: 1, stride: count, origin: 0, plane: new Int32Array(count),
    minimum: 4, count, pieceValue: values, pieceDistance: noCopies(count), pieceContext: contexts,
  };
}

function writeAddFrameHeader(w, {alpha = false, shift = 3}) {
  const extraChannels = Number(!!alpha);
  w.write(7, 0b0_00_1_00_0);
  w.writeU32([[0, 1], [0, 2], [0, 4], [0, 8]], 1);
  for (let c = 0; c < extraChannels; c++) w.writeU32([[0, 1], [0, 2], [0, 4], [0, 8]], 1);
  w.write(2, shift);
  w.write(2, 0);
  w.write(1, 0);
  for (let c = 0; c <= extraChannels; c++) {
    w.writeU32([[0, 0], [0, 1], [0, 2], [2, 3]], 1);
    w.write(2, 1);
  }
  w.write(1, 1);
  w.write(10, 0);
}

function selectBestSplitDepth(data, width, height, shape, bitDepth) {
  const maxK = Math.min(8, bitDepth - 6);
  const minK = Math.max(2, bitDepth - 14);
  if (minK > maxK) return [];
  const sampleRows = Math.min(height, 48);
  const y0 = (height - sampleRows) >> 1;
  const sw = Math.min(width, 256), x0 = (width - sw) >> 1;
  if (sw < 8 || sampleRows < 8) return [Math.min(4, maxK)];

  const scores = [];
  for (let k = minK; k <= maxK; k++) {
    const mask = (1 << k) - 1;
    let hiBits = 0, loZeroBits = 0, loDiffBits = 0;
    const count = (sampleRows - 1) * (sw - 1);
    for (let c = 0; c < shape.colour; c++) {
      const hiHist = new Map(), loVals = new Uint32Array(1 << k), loDiffs = new Map();
      for (let y = 1; y < sampleRows; y++) {
        for (let x = 1; x < sw; x++) {
          const i = ((y0 + y) * width + x0 + x) * 4 + c;
          const W = data[i - 4], N = data[i - width * 4], NW = data[i - width * 4 - 4], X = data[i];
          const wH = W >>> k, nH = N >>> k, nwH = NW >>> k, xH = X >>> k;
          const loH = Math.min(wH, nH), hiH = Math.max(wH, nH);
          const gH = Math.max(loH, Math.min(hiH, wH + nH - nwH));
          const rH = xH - gH;
          hiHist.set(rH, (hiHist.get(rH) ?? 0) + 1);
          const xL = X & mask, wL = W & mask;
          loVals[xL]++;
          const dL = xL - wL;
          loDiffs.set(dL, (loDiffs.get(dL) ?? 0) + 1);
        }
      }
      const logN = Math.log2(count);
      for (const cnt of hiHist.values()) hiBits += cnt * (logN - Math.log2(cnt));
      for (let v = 0; v < loVals.length; v++) if (loVals[v]) loZeroBits += loVals[v] * (logN - Math.log2(loVals[v]));
      for (const cnt of loDiffs.values()) loDiffBits += cnt * (logN - Math.log2(cnt));
    }
    scores.push({k, bits: hiBits + Math.min(loZeroBits, loDiffBits)});
  }
  scores.sort((a, b) => a.bits - b.bits);
  return [scores[0].k];
}

function encodeBitPlaneSplit(data, width, height, shape, samples, stages, k) {
  const {channels, colour, alpha} = shape;
  const bitDepth = samples.bitDepth;
  const hiCount = 1 << (bitDepth - k);
  if (hiCount > COMPACT_RCT_SAFE) return null;
  const step = 1 << k, mask = step - 1;
  const shift = stages.stage4c ? 3 : (width * height * channels > 2000000 ? 2 : 3);
  const dim = 128 << shift, layout = groupLayout(width, height, dim), groups = layout.groupsX * layout.groupsY;
  const level = samples.level === 10 || samples.bitDepth > 12 || samples.exponentBits ? 10 : 5;
  const ansTools = ansConfigFor(stages.stage4b, stages.stage4c);

  const hdr0 = new BitWriter(256);
  writeImageHeader(hdr0, width, height, colour, alpha, samples);
  writeModularFrameHeader(hdr0, {alpha, shift, last: false, reference: 1});

  const palTransforms = Array.from({length: channels}, (_, c) => ({
    type: 'palette', beginC: 2 * c, numC: 1, nbColors: hiCount, nbDeltas: 0, predictor: 0,
  }));
  const metaModels = Array.from({length: channels}, () => stepTableMeta(hiCount, step));

  const codeHiGroup = (x0, y0, gw, gh, isGlobal) => {
    const gn = gw * gh;
    const learnOpts = optsFor16(gn, stages.stage4b, stages.stage4c);
    const packedHi = new Int16Array(gn * 4);
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const srcAt = ((y0 + y) * width + x0 + x) * 4, dstAt = (y * gw + x) * 4;
        for (let c = 0; c < colour; c++) packedHi[dstAt + c] = data[srcAt + c] >>> k;
        if (alpha) packedHi[dstAt + 3] = data[srcAt + 3] >>> k;
      }
    }
    const ranked = colour === 3 ? transformRanking(packedHi, gw, gh) : [0];
    const rctList = colour === 3 && stages.stage4c ? [ranked[0], CHAINED + ranked[0]] : [ranked[0]];
    const pTrans = isGlobal ? palTransforms : [];
    const mModels = isGlobal ? metaModels : [];
    const rctBegin = isGlobal ? channels : 0;

    let bestSec = null;
    for (const rctType of rctList) {
      const planes = Array.from({length: channels}, () => new Int16Array(gn));
      if (rctType && colour === 3) fillRct(planes, packedHi, gw, 0, 0, gw, gh, channels, rctType);
      else {
        for (let c = 0; c < channels; c++) {
          const from = c < colour ? c : 3;
          for (let i = 0; i < gn; i++) planes[c][i] = packedHi[i * 4 + from];
        }
      }
      const wp = (stages.stage4b || stages.stage4c) ? searchWpParameters(planes.slice(0, colour), gw, gh, stages.stage4b, stages.stage4c) : null;
      const models = [], refs = [];
      for (let c = 0; c < channels; c++) {
        const built = build16PlaneModel(planes[c], gw, gh, learnOpts, refs.slice().reverse(), wp, true);
        models.push(built.model);
        refs.push(built.ref);
      }
      const transforms = [...pTrans, ...rctTransforms(rctBegin, rctType)];
      const sec = writeSectionFromModels(models, mModels, transforms, wp?.values ?? null, isGlobal, ansTools, false);
      if (!bestSec || sec.length < bestSec.length) bestSec = sec;
    }
    return bestSec;
  };

  let frame0;
  if (layout.single) {
    frame0 = assembleCodestream(hdr0, [codeHiGroup(0, 0, width, height, true)], 5);
  } else {
    const g0 = new BitWriter(512);
    g0.write(1, 1); g0.write(1, 1);
    safeWriteStream(g0, metaModels, ansTools, {global: true, runs: false, transforms: palTransforms});
    const secs0 = [g0.finish()];
    for (let i = 0; i < layout.dcGroupsX * layout.dcGroupsY + 1; i++) secs0.push(new Uint8Array(0));
    for (let g = 0; g < groups; g++) secs0.push(codeHiGroup(...groupRect(layout, width, height, g, dim), false));
    frame0 = assembleCodestream(hdr0, secs0, 5);
  }

  const hdr1 = new BitWriter(64);
  writeAddFrameHeader(hdr1, {alpha, shift});

  const codeLoGroup = (x0, y0, gw, gh, isGlobal) => {
    const gn = gw * gh;
    const learnOpts = optsFor16(gn, stages.stage4b, stages.stage4c);
    const packedLo = new Int16Array(gn * 4);
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const srcAt = ((y0 + y) * width + x0 + x) * 4, dstAt = (y * gw + x) * 4;
        for (let c = 0; c < colour; c++) packedLo[dstAt + c] = data[srcAt + c] & mask;
        if (alpha) packedLo[dstAt + 3] = data[srcAt + 3] & mask;
      }
    }
    const zeroModels = Array.from({length: channels}, (_, c) => {
      const from = c < colour ? c : 3;
      const pv = new Int32Array(gn), ctx = new Uint8Array(gn);
      for (let i = 0; i < gn; i++) pv[i] = packSigned(packedLo[i * 4 + from]);
      const lf = Object.assign(leaf(0, 0, 1), {local: 0});
      return {
        kind: 'smooth', tree: lf, leaves: [lf], classes: 1, width: gw, height: gh, stride: gw, origin: 0,
        plane: new Int16Array(gn), minimum: 4, count: gn, pieceValue: pv, pieceDistance: noCopies(gn), pieceContext: ctx,
      };
    });
    let bestSec = writeSectionFromModels(zeroModels, [], [], null, isGlobal, ansTools, true);

    const rctLo = colour === 3 ? transformRanking(packedLo, gw, gh)[0] : 0;
    const planesLo = Array.from({length: channels}, () => new Int16Array(gn));
    if (rctLo && colour === 3) fillRct(planesLo, packedLo, gw, 0, 0, gw, gh, channels, rctLo);
    else {
      for (let c = 0; c < channels; c++) {
        const from = c < colour ? c : 3;
        for (let i = 0; i < gn; i++) planesLo[c][i] = packedLo[i * 4 + from];
      }
    }
    const loOpts = {
      ...learnOpts,
      nodes: Math.min(127, learnOpts.nodes),
      predictors: [0, 5, 6, 1, 2, 3, 4],
    };
    const treeModels = [], loRefs = [];
    for (let c = 0; c < channels; c++) {
      const built = build16PlaneModel(planesLo[c], gw, gh, loOpts, loRefs.slice().reverse(), null, true);
      treeModels.push(built.model);
      loRefs.push(built.ref);
    }
    const secTree = writeSectionFromModels(treeModels, [], rctTransforms(0, rctLo), null, isGlobal, ansTools, false);
    if (secTree.length < bestSec.length) bestSec = secTree;
    return bestSec;
  };

  let frame1;
  if (layout.single) {
    frame1 = assembleCodestream(hdr1, [codeLoGroup(0, 0, width, height, true)], 5);
  } else {
    const g1 = new BitWriter(256);
    g1.write(1, 1); g1.write(1, 1);
    writeChannelHistograms(g1, writeTree(g1, leaf(0)), [new Uint32Array(ALPHABET)]);
    writeModularHeader(g1, {transforms: []});
    const secs1 = [g1.finish()];
    for (let i = 0; i < layout.dcGroupsX * layout.dcGroupsY + 1; i++) secs1.push(new Uint8Array(0));
    for (let g = 0; g < groups; g++) secs1.push(codeLoGroup(...groupRect(layout, width, height, g, dim), false));
    frame1 = assembleCodestream(hdr1, secs1, 5);
  }

  return codestreamFromParts(frame0, [frame1], level);
}

export function* effortTenGroup16(data, width, rect, part, shape) {
  const rectWords = extractRectWords(data, width, rect.x, rect.y, rect.width, rect.height);
  const stages = {stage4a: true, stage4b: true, stage4c: true, stage4d: true};
  const kind = part === 0 ? 'compacted' : 'full16';
  return encodeGroup16Candidate(rectWords, rect.width, rect.height, shape, stages, {kind, isGlobal: false}, null);
}

export function* encodeEffortTen16Steps(data, width, height, options, stages = {stage4a: true, stage4b: true, stage4c: true, stage4d: true}, helped = false) {
  const samples = options?.samples ?? null;
  if (!samples || samples.exponentBits || samples.bitDepth <= 8 || samples.bitDepth > 16) return null;
  const shape = inspectPixels(data, width, height, {samples});
  const {channels, colour} = shape;

  let best = null;
  const keep = candidate => {
    if (candidate instanceof Uint8Array && (!best || candidate.length < best.length)) best = candidate;
  };

  try {
    const limit = stages.stage4a ? COMPACT_LIMIT_10 : COMPACT_LIMIT_9;
    const globalComp = scanDistinctChannels(data.subarray(0, width * height * 4), channels, colour, limit);

    if (globalComp.anyFound) {
      keep(yield* buildSingleFrameCandidate(data, width, height, shape, samples, stages, 3, 'compacted', globalComp, helped));
    }

    if (stages.stage4a && (!globalComp.allFound || globalComp.maxLen > COMPACT_RCT_SAFE) && (width > 256 || height > 256)) {
      keep(yield* buildSingleFrameCandidate(data, width, height, shape, samples, stages, 1, 'compacted', null, helped));
    }

    if (!stages.stage4a || !globalComp.allFound || globalComp.maxLen > COMPACT_RCT_SAFE || globalComp.maxLen * 2 > width * height) {
      keep(yield* buildSingleFrameCandidate(data, width, height, shape, samples, stages, 3, 'full16', null, helped));
    }

    if (stages.stage4d && width * height >= 1024 && (!stages.stage4a || !globalComp.allFound || globalComp.maxLen > COMPACT_RCT_SAFE || globalComp.maxLen * 2 > width * height)) {
      const candidateKs = selectBestSplitDepth(data, width, height, shape, samples.bitDepth);
      for (const k of candidateKs) {
        keep(encodeBitPlaneSplit(data, width, height, shape, samples, stages, k));
      }
    }
  } catch (error) {
    if (error.code !== 'JXL_SIZE' && !outOfMemory(error)) throw error;
  }

  return best;
}
