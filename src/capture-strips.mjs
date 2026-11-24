// SPDX-License-Identifier: MIT
import {BitWriter, packSigned} from './bits.mjs';
import {groupLayout, groupRect, writeModularFrameHeader, assembleCodestream} from './frame.mjs';
import {intervals, split, writeTree, writeModularHeader} from './modular.mjs';
import {
  captureColourGroup, captureColourChain, captureCustomWeighted, captureCustomWeightedBins,
  captureResiduals, captureScanColours, captureTreeWalkHist, captureAnsWrite, capturePrices, requireCaptureKernels,
} from './capture-kernels.mjs';
import {sharedTreeSteps, sampleTreePrice, streamTreeOf, codePlane, letGoTrees} from './capture-trees.mjs';
import {captureAnsTokens, writeCaptureAns, writeSharedAns} from './capture-ans.mjs';
import {ANS_FIT, mergeCounts as joined, valueCounts} from './capture-modular-stream.mjs';
import {shapeHistogram, reverseAlias, writeModularAnsHeader, SYMBOL_BITS} from './ans-core.mjs';
import {hybridToken, writeUintConfig} from './prefix.mjs';
import {writeSmallestContextMap} from './context-map.mjs';
import {forwardRct, captureGroupBytes} from './capture-codec.mjs';
import {pixelKeys} from './screen-crop.mjs';
import {steerForestGroup} from './search-models.mjs';

const streamId = (dcGroups, g) => 1 + 3 * dcGroups + 17 + g;
const ROUNDS = 3;
export const REGION_DIM = 512, FOREST_DIM = 1024, CHAINED_RCT = 42 * 22;

export const FOREST_PREDICTORS = /* @__PURE__ */ Object.freeze([5, 3, 6, 1, 2, 4, 7, 8, 9, 10, 11, 12, 13, 0]);
const MID10_PREDICTORS = /* @__PURE__ */ Object.freeze([5, 3, 6, 1, 2, 4, 7, 12, 13, 0]);
const FAST_WP_AXES = /* @__PURE__ */ Object.freeze([0, 1, 3, 5, 6, 7, 8, 10]);
const DEFAULT_WP = [16, 10, 7, 7, 7, 0, 0, 13, 12, 12, 12];
const WP_PRESETS = [
  DEFAULT_WP,
  [8, 8, 4, 0, 3, 23, 2, 13, 12, 12, 11],
  [10, 9, 7, 0, 0, 16, 9, 13, 12, 13, 12],
  [6, 6, 3, 0, 2, 26, 4, 13, 12, 12, 11],
  [12, 10, 6, 3, 6, 12, 6, 13, 12, 12, 12],
  [14, 11, 7, 5, 7, 6, 3, 12, 12, 12, 11],
  [4, 4, 2, 0, 2, 0, 0, 14, 11, 11, 10],
  [9, 9, 5, 0, 4, 20, 6, 13, 12, 12, 12],
  [5, 5, 2, 0, 2, 18, 6, 10, 13, 13, 12],
  [7, 7, 3, 1, 3, 22, 8, 11, 13, 13, 12],
];
const WP_MAX = [31, 31, 31, 31, 31, 31, 31, 15, 15, 15, 15];
const SP = [0, 0, 0];

export function* stripFramesSteps({pixels, width, height, shape, header, dim, shift, sections, choices, helped}, options) {
  const whole = groupLayout(width, height, dim), first = 2 + whole.dcGroupsX * whole.dcGroupsY, words = pixelKeys(pixels);
  const tiles = Math.ceil(whole.groupsX / (options.span ?? 3)), span = Math.ceil(whole.groupsX / tiles);
  const strips = Array.from({length: whole.groupsY * tiles}, (_, at) => {
    const row = Math.floor(at / tiles), col = at % tiles * span, y = row * dim, h = Math.min(dim, height - y);
    const x0 = col * dim, w0 = Math.min(span * dim, width - x0), layout = groupLayout(w0, h, dim);
    const groups = Array.from({length: layout.groupsX}, (_, g) => {
      const [x, , w] = groupRect(layout, w0, h, g, dim), index = row * whole.groupsX + col + g, choice = choices[index];
      return {x: x0 + x, y, w, h, own: sections[first + index], id: streamId(layout.dcGroupsX * layout.dcGroupsY, g), transforms: choice?.transforms, wp: choice?.wp ?? null};
    });
    const able = groups.filter(group => group.transforms);
    return {x: x0, y, w: w0, h, layout, groups, kept: able, best: null, least: sections[0].length + ownBytes(groups)};
  });
  let open = strips.filter(strip => strip.kept.length);
  for (let round = 0; round < ROUNDS && open.length; round++) {
    const asks = open.flatMap(strip => [0, 1, 2].map(channel => ({groups: strip.kept.map(plain), channel})));
    const given = helped ? yield {stripTrees: {asks}} : null;
    const next = [];
    for (let s = 0; s < open.length; s++) {
      const strip = open[s], coded = new Map(strip.kept.map(group => [group, codedOf(words, width, group)]));
      const trees = [];
      for (let channel = 0; channel < 3; channel++) trees.push(given?.[s * 3 + channel] ?? (yield* treeSteps(strip.kept, coded, channel, options)));
      const written = sharedSection(strip.kept, coded, trees, options);
      if (!written) continue;
      const total = written.global.length + [...written.sections.values()].reduce((n, b) => n + b.length, 0) + ownBytes(strip.groups.filter(group => !written.sections.has(group)));
      if (total < strip.least) { strip.least = total; strip.best = written; strip.trees = trees; }
      const kept = strip.kept.filter(group => written.sections.get(group).length < group.own.length);
      if (kept.length && kept.length < strip.kept.length) { strip.kept = kept; next.push(strip); }
      yield (round + (s + 1) / open.length) / ROUNDS;
    }
    open = next;
  }
  if (!strips.some(strip => strip.best)) return null;
  const top = new BitWriter(header.bitLength + 64);
  top.append(header);
  const one = oneFrame(strips, {pixels, width, header: top, shape, shift, sections, whole, first, tiles, span, words}, options);
  const frames = strips.map(({x, y, w, h, layout, groups, best}, at) => {
    const out = at ? new BitWriter(64) : header, last = at + 1 === strips.length;
    writeModularFrameHeader(out, {alpha: shape.alpha, shift, crop: {x, y, width: w, height: h}, canvas: {width, height}, last, reference: last ? 0 : 1});
    return assembleCodestream(out, [best?.global ?? sections[0], ...Array.from({length: layout.dcGroupsX * layout.dcGroupsY + 1}, () => new Uint8Array(0)),
      ...groups.map(group => best?.sections.get(group) ?? group.own)]);
  });
  const file = new Uint8Array(frames.reduce((n, f) => n + f.length, 0));
  frames.reduce((at, f) => { file.set(f, at); return at + f.length; }, 0);
  return one && one.length <= file.length ? one : file;
}

function oneFrame(strips, {width, header, shape, shift, sections, whole, first, tiles, span, words}, options) {
  const dc = whole.dcGroupsX * whole.dcGroupsY, forests = [[], [], []], offsets = [0, 0, 0], cuts = [], kept = [], coded = new Map(), at = new Map();
  const moved = (n, delta, offset) => n.left ? split(n.property, n.property === 1 ? n.splitval + delta : n.splitval, moved(n.left, delta, offset), moved(n.right, delta, offset)) : {...n, local: n.local + offset};
  const leaves = n => n.left ? Math.max(leaves(n.left), leaves(n.right)) : n.local + 1;
  strips.forEach((strip, k) => {
    if (!strip.best) return;
    const base = Math.floor(k / tiles) * whole.groupsX + k % tiles * span;
    const delta = streamId(dc, base) - streamId(strip.layout.dcGroupsX * strip.layout.dcGroupsY, 0);
    for (let c = 0; c < 3; c++) { forests[c].push(moved(strip.trees[c], delta, offsets[c])); offsets[c] += leaves(strip.trees[c]); }
    cuts.push(streamId(dc, base + strip.groups.length - 1));
    strip.groups.forEach((group, g) => {
      if (!strip.best.sections.has(group)) return;
      const shared = {...group, id: group.id + delta};
      kept.push(shared); coded.set(shared, codedOf(words, width, group)); at.set(base + g, shared);
    });
  });
  cuts.pop();
  const written = sharedSection(kept, coded, forests.map(trees => intervals(1, cuts, i => trees[i])), options);
  if (!written) return null;
  writeModularFrameHeader(header, {alpha: shape.alpha, shift});
  return assembleCodestream(header, [written.global, ...sections.slice(1, first),
    ...Array.from({length: whole.groupsX * whole.groupsY}, (_, i) => at.has(i) ? written.sections.get(at.get(i)) : sections[first + i])]);
}
const ownBytes = groups => groups.reduce((n, group) => n + group.own.length, 0);
const plain = ({x, y, w, h, id, transforms, wp}) => ({x, y, w, h, id, transforms, wp});

export function* stripTreeSteps(pixels, stride, groups, channel, options) {
  requireCaptureKernels();
  const words = pixelKeys(pixels);
  return yield* treeSteps(groups, new Map(groups.map(group => [group, codedOf(words, stride, group, channel)])), channel, options);
}

function groupSpans(groups, maxSpan) {
  if (groups <= maxSpan) return [[0, groups]];
  const count = Math.min(Math.floor(groups / 2), Math.ceil(groups / maxSpan));
  return Array.from({length: count}, (_, i) => [Math.floor(i * groups / count), Math.floor((i + 1) * groups / count)]);
}

export function regionBands(width, height, dim = REGION_DIM) {
  const whole = groupLayout(width, height, dim);
  const ySpans = whole.groupsY === 1 ? [[0, 1]] : groupSpans(whole.groupsY, 2);
  const xSpans = whole.groupsX === 1 ? [[0, 1]] : groupSpans(whole.groupsX, 5);
  return ySpans.map(([gy0, gy1]) => {
    const y0 = gy0 * dim, y1 = Math.min(height, gy1 * dim), h = y1 - y0;
    const regions = xSpans.map(([gx0, gx1]) => {
      const x0 = gx0 * dim, x1 = Math.min(width, gx1 * dim);
      return {x: x0, y: y0, width: x1 - x0, height: h};
    });
    return {y: y0, height: h, regions};
  });
}

export const rctTransforms = rct => rct >= CHAINED_RCT
  ? [{type: 'rct', beginC: 0, rctType: rct - CHAINED_RCT}, {type: 'rct', beginC: 0, rctType: 21}]
  : [{type: 'rct', beginC: 0, rctType: rct}];

export function unpackRctPlanes(words, stride, x, y, w, h, rct) {
  const chain = rct >= CHAINED_RCT ? [rct - CHAINED_RCT, 21] : [rct];
  return captureColourChain(words, stride, x, y, w, h, chain);
}

const PROBE_PREDICTORS = /* @__PURE__ */ Object.freeze([5, 3, 6, 1, 2, 4, 13, 0]);
export function scoreGroupCandidate(words, stride, x, y, w, h, rct, wp) {
  const planes = unpackRctPlanes(words, stride, x, y, w, h, rct);
  const own = wp ? {values: wp, weighted: (plane, pw, ph) => captureCustomWeighted(plane, pw, ph, wp)} : null;
  let bits = wp ? 16 : 0;
  for (let c = 0; c < 3; c++) {
    bits += sampleTreePrice(planes[c], w, h, {
      samples: 16384, nodes: 191, bins: 64, charge: 8, predictors: PROBE_PREDICTORS, wp: own,
    }, null, planes.slice(0, c).reverse());
  }
  return bits;
}

export function fallbackGlobalSection() {
  const global = new BitWriter(64);
  global.write(1, 1); global.write(1, 0);
  writeModularHeader(global);
  global.write(16, 0); global.write(16, 0x13);
  return global.finish();
}

export function* regionSectionsSteps(pixels, width, height, choices, options) {
  requireCaptureKernels();
  const dim = REGION_DIM, layout = groupLayout(width, height, dim), count = layout.groupsX * layout.groupsY;
  const dcGroups = layout.dcGroupsX * layout.dcGroupsY, words = pixelKeys(pixels);
  let chosen = choices[0];
  if (choices.length > 1) {
    const mid = count >> 1, [mx, my, mw, mh] = groupRect(layout, width, height, mid, dim);
    let least = Infinity;
    for (const cand of choices) {
      const bits = scoreGroupCandidate(words, width, mx, my, mw, mh, cand.rct, cand.wp, options.predictors);
      if (bits < least) { least = bits; chosen = cand; }
    }
  }
  const transforms = rctTransforms(chosen.rct), groups = [], coded = new Map();
  for (let g = 0; g < count; g++) {
    const [gx, gy, gw, gh] = groupRect(layout, width, height, g, dim);
    let own = null;
    if (options.fallbackLevel && options.kit) {
      const limit = Math.min(256, (gw * gh / 32) | 0);
      if (limit > 0 && captureScanColours(pixels, width, gx, gy, gw, gh, limit)) {
        own = captureGroupBytes(pixels, width, {x: gx, y: gy, width: gw, height: gh}, options.fallbackLevel, options.shape, options.kit);
      }
    }
    const grp = {x: gx, y: gy, w: gw, h: gh, own, id: streamId(dcGroups, g), transforms, wp: chosen.wp};
    groups.push(grp);
    coded.set(grp, codedOf(words, width, grp));
  }
  try {
    const trees = [];
    for (let channel = 0; channel < 3; channel++) trees.push(yield* treeSteps(groups, coded, channel, options));
    const best = sharedSection(groups, coded, trees, options);
    if (!best) {
      if (groups.every(grp => grp.own)) return {global: fallbackGlobalSection(), sections: groups.map(grp => grp.own)};
      return null;
    }
    return {
      global: best.global,
      sections: groups.map(grp => {
        const shared = best.sections.get(grp);
        return grp.own && (!shared || grp.own.length <= shared.length) ? grp.own : shared;
      }),
    };
  } finally {
    coded.clear();
    letGoTrees(1 << 16);
  }
}

export function candidateChainsFromRanking(ranked) {
  const seen = new Set(), out = [];
  const add = chain => { const k = chain.join(','); if (!seen.has(k)) { seen.add(k); out.push(chain); } };
  for (const r of ranked.slice(0, 3)) {
    add([r]);
    if (r % 7 === 6) add([r - 1]);
    else if (r % 7 === 5) add([r + 1]);
    add([r, 21]);
    if (r % 7 === 3 || r % 7 === 6) {
      const opp = (r + 21) % 42;
      add([opp]); add([opp, 21]);
    }
    if (r % 7 === 6) { add([r, 9, 14]); add([r, 15, 7]); }
  }
  add([11, 23]); add([18, 16]); add([4, 23]);
  return out;
}

function wpBitsMasked(planes, width, wp, strips) {
  let bits = 0;
  for (let c = 0; c < 3; c++) {
    const plane = planes[c];
    const {bins, raw} = captureCustomWeightedBins(plane, width, plane.length / width, wp, strips);
    bits += raw * 0.85;
    for (let b = 0; b < 14; b++) {
      const wt = (b <= 1 || b >= 12) ? 0.35 : 1.0;
      let total = 0;
      for (let t = 0; t < 48; t++) total += bins[b * 48 + t];
      for (let t = 0; t < 48; t++) if (bins[b * 48 + t]) bits += wt * bins[b * 48 + t] * Math.log2(total / bins[b * 48 + t]);
    }
  }
  return bits;
}

export function optimizeGroupWp(planes, w, h, presetIdxs = null, fast = false) {
  const rowCap = fast ? 48 : 64, maxStrips = fast ? 2 : 4;
  const rows = Math.min(rowCap, h), count = Math.min(maxStrips, Math.max(1, Math.floor(h / rows))), strips = [];
  for (let k = 0; k < count; k++) {
    const y = Math.floor((h - rows) * k / Math.max(1, count - 1));
    strips.push([y, y + rows]);
  }
  let best = DEFAULT_WP, least = Infinity;
  const presets = presetIdxs ? presetIdxs.map(idx => WP_PRESETS[idx]) : WP_PRESETS;
  for (const wp of presets) {
    const b = wpBitsMasked(planes, w, wp, strips);
    if (b < least) { least = b; best = wp; }
  }
  best = best.slice();
  if (fast) {
    const movedAxes = [];
    for (const i of FAST_WP_AXES) {
      let improved = false;
      for (const d of [-2, 2]) {
        const val = best[i] + d;
        if (val < 0 || val > WP_MAX[i]) continue;
        const cand = best.slice(); cand[i] = val;
        const b = wpBitsMasked(planes, w, cand, strips);
        if (b < least) { least = b; best = cand; improved = true; }
      }
      if (improved) movedAxes.push(i);
    }
    for (const i of movedAxes) {
      for (const d of [-1, 1]) {
        const val = best[i] + d;
        if (val < 0 || val > WP_MAX[i]) continue;
        const cand = best.slice(); cand[i] = val;
        const b = wpBitsMasked(planes, w, cand, strips);
        if (b < least) { least = b; best = cand; }
      }
    }
    return best.every((v, i) => v === DEFAULT_WP[i]) ? null : best;
  }
  for (const step of [3, 1]) {
    for (let pass = 0, moved = true; moved && pass < 2; pass++) {
      moved = false;
      for (let i = 0; i < 11; i++) {
        for (const d of [-step, step]) {
          const val = best[i] + d;
          if (val < 0 || val > WP_MAX[i]) continue;
          const cand = best.slice(); cand[i] = val;
          const b = wpBitsMasked(planes, w, cand, strips);
          if (b < least) { least = b; best = cand; moved = true; }
        }
      }
    }
  }
  return best.every((v, i) => v === DEFAULT_WP[i]) ? null : best;
}

export function probeForestGroup(pixels, w, h, cands, shape, fallbackLevel, ranked = null) {
  requireCaptureKernels();
  let own = null, flatOwn = false;
  if (fallbackLevel) {
    const limit = Math.min(256, Math.floor(w * h / 32));
    if (limit > 0) {
      const cols = captureScanColours(pixels, w, h, limit);
      if (cols) {
        own = captureGroupBytes(pixels, w, {x: 0, y: 0, width: w, height: h}, fallbackLevel, shape, {ans: {tokens: captureAnsTokens, write: writeCaptureAns}});
        if (cols.length <= 4 && own) flatOwn = true;
      }
    }
  }
  if (flatOwn) return {flatOwn: true, own, rctRanking: [], chain: cands[0], chainKey: cands[0].join(','), wp: null, spanMode: 'mid10'};
  const plan = steerForestGroup(pixels, w, h, cands, ranked);
  const words = pixelKeys(pixels);
  const p0 = captureColourChain(words, w, 0, 0, w, h, cands[0]);
  const rows = Math.min(plan.fastWp ? 48 : 64, h), midY = Math.floor((h - rows) / 2), strips = [[midY, midY + rows]];
  let seedWp = DEFAULT_WP, bestW = Infinity;
  const seedList = plan.fullSearch ? WP_PRESETS.slice(0, 6) : plan.wpPresets.slice(0, 3).map(idx => WP_PRESETS[idx]);
  for (const wp of seedList) {
    const b = wpBitsMasked(p0, w, wp, strips);
    if (b < bestW) { bestW = b; seedWp = wp; }
  }
  const wpObj = seedWp === DEFAULT_WP ? null : {values: seedWp, weighted: (pl, pw, ph) => captureCustomWeighted(pl, pw, ph, seedWp)};
  const priceChain = chain => {
    const planes = captureColourChain(words, w, 0, 0, w, h, chain);
    let bits = (chain.length - 1) * 8;
    const probeOpts = plan.fullSearch
      ? {samples: 12288, nodes: 159, bins: 64, charge: 8, predictors: FOREST_PREDICTORS, wp: wpObj}
      : {samples: 8192, nodes: 127, bins: 64, charge: 8, predictors: PROBE_PREDICTORS, wp: wpObj};
    for (let c = 0; c < 3; c++) bits += sampleTreePrice(planes[c], w, h, probeOpts, null, planes.slice(0, c).reverse());
    return {chain, key: chain.join(','), bits};
  };
  const rctRanking = plan.primaryChains.map(priceChain).sort((a, b) => a.bits - b.bits);
  if (!plan.fullSearch && plan.expandChains.length && rctRanking.length > 1 &&
      (rctRanking[1].bits - rctRanking[0].bits) < rctRanking[0].bits * 0.0018) {
    for (const chain of plan.expandChains) rctRanking.push(priceChain(chain));
    rctRanking.sort((a, b) => a.bits - b.bits);
  }
  const chain = rctRanking[0].chain;
  const wp = optimizeGroupWp(captureColourChain(words, w, 0, 0, w, h, chain), w, h, null, plan.fastWp);
  letGoTrees(1 << 16);
  return {flatOwn: false, own, rctRanking, chain, chainKey: rctRanking[0].key, wp, spanMode: plan.spanMode, wpPresets: plan.fastWp ? plan.wpPresets : null, fastWp: plan.fastWp};
}

function flattenSpanTree(tree) {
  const nodes = [];
  const emit = n => {
    const idx = nodes.length >> 2;
    nodes.push(0, 0, 0, 0);
    if (n.left) {
      nodes[idx * 4] = n.property; nodes[idx * 4 + 1] = n.splitval;
      nodes[idx * 4 + 2] = emit(n.left); nodes[idx * 4 + 3] = emit(n.right);
    } else {
      nodes[idx * 4] = -1; nodes[idx * 4 + 1] = n.spanLid; nodes[idx * 4 + 2] = n.predictor;
    }
    return idx;
  };
  emit(tree);
  return Int32Array.from(nodes);
}

export function* learnForestSpanSteps(groupSlices, chain, options) {
  requireCaptureKernels();
  const coded = groupSlices.map(({pixels, w, h, id, wp}) => {
    const words = pixelKeys(pixels);
    const planes = captureColourChain(words, w, 0, 0, w, h, chain);
    const answers = planes.map(pl => wp ? captureCustomWeighted(pl, w, h, wp) : residualsOf(pl, w, h));
    return {w, h, id, planes, answers};
  });
  const regionArea = coded.reduce((sum, g) => sum + g.w * g.h, 0);
  try {
    const trees = [], channelUnits = [];
    for (let c = 0; c < 3; c++) {
      const mid10 = options?.spanMode === 'mid10';
      const tree = yield* sharedTreeSteps(coded.map(g => ({
        plane: g.planes[c], w: g.w, h: g.h, answer: g.answers[c], references: g.planes.slice(0, c).reverse(), id: g.id,
      })), {
        predictors: mid10 ? MID10_PREDICTORS : FOREST_PREDICTORS,
        bins: mid10 ? 192 : 255,
        regionSamples: regionArea,
        leaves: options.leaves ?? 6144,
        clusters: 255,
        charge: options.charge ?? 8,
        leafBits: options.leafBits ?? 12,
        histSym: 1.5,
        histBase: 24,
        sampleBias: 0,
        device: options.device,
      });
      let numLeaves = 0;
      const numberLeaves = n => {
        if (n.left) { numberLeaves(n.left); numberLeaves(n.right); }
        else n.spanLid = numLeaves++;
      };
      numberLeaves(tree);
      const hSmall = new Uint32Array(numLeaves * 256);
      const hLarge = Array.from({length: numLeaves}, () => new Map());
      for (const g of coded) {
        const flat = flattenSpanTree(streamTreeOf(tree, g.id));
        captureTreeWalkHist(flat, numLeaves, g.planes[c], g.w, g.h, g.answers[c].residuals, g.answers[c].properties, g.planes.slice(0, c).reverse(), hSmall, hLarge);
      }
      const units = new Array(numLeaves);
      for (let lid = 0; lid < numLeaves; lid++) {
        const mp = hLarge[lid], lKeys = mp.size ? Int32Array.from(mp.keys()).sort() : new Int32Array(0);
        const lCounts = mp.size ? Uint32Array.from(lKeys, k => mp.get(k)) : new Uint32Array(0);
        const vc = valueCounts(hSmall.subarray(lid * 256, (lid + 1) * 256), {values: lKeys, counts: lCounts});
        units[lid] = vc.values.length > 0
          ? {...vc, constant: vc.values.length === 1 && vc.values[0] === 0}
          : null;
      }
      trees.push(tree);
      channelUnits.push(units);
    }
    return {trees, channelUnits};
  } finally {
    coded.length = 0;
    letGoTrees(1 << 16);
  }
}

const PRE_CFG_8 = /* @__PURE__ */ (() => ANS_FIT.find(c => c.split === 3 && c.msb === 1 && c.lsb === 1))();
const LOG2_VAL = /* @__PURE__ */ Float64Array.from({length: 4096}, (_, v) => Math.log2(v + 2));
const NLOG2 = /* @__PURE__ */ Float64Array.from({length: 131072}, (_, k) => k > 1 ? k * Math.log2(k) : 0);
const nlog2 = k => k < 131072 ? NLOG2[k] : k * Math.log2(k);

function clusterModelStrong(literals, trials = 8) {
  const ranked = [];
  for (let at = 0; at < ANS_FIT.length; at += 64) {
    const some = ANS_FIT.slice(at, at + 64), prices = capturePrices(some, literals);
    for (let c = 0; c < some.length; c++) if (prices[c * 2 + 1] < 256) ranked.push({config: some[c], estimate: prices[c * 2]});
  }
  ranked.sort((a, b) => a.estimate - b.estimate);
  let best = null;
  for (const {config} of ranked.slice(0, trials)) {
    const freqs = new Uint32Array(256);
    let extra = 0;
    for (let i = 0; i < literals.values.length; i++) {
      hybridToken(config, literals.values[i], SP);
      freqs[SP[0]] += literals.counts[i];
      extra += SP[1] * literals.counts[i];
    }
    const shape = shapeHistogram(freqs, true);
    if (!shape) continue;
    const w = new BitWriter(8); writeUintConfig(w, config, 8);
    const bits = w.bitLength + shape.bits + extra;
    if (!best || bits < best.bits) best = {config, shape, bits};
  }
  return best;
}

function preTokens8(literals) {
  const freqs = new Uint32Array(64);
  let raw = 0;
  for (let i = 0; i < literals.values.length; i++) {
    hybridToken(PRE_CFG_8, literals.values[i], SP);
    freqs[Math.min(63, SP[0])] += literals.counts[i];
    raw += SP[1] * literals.counts[i];
  }
  return {freqs, raw};
}

function preBits8(freqs, raw) {
  let total = 0, used = 0, sumNlog = 0;
  for (let s = 0; s < 64; s++) {
    const c = freqs[s];
    if (c) { total += c; sumNlog += nlog2(c); used++; }
  }
  if (!total) return 0;
  return raw + nlog2(total) - sumNlog + 46 + 4.2 * used;
}

function valueBitsTable(model, cap = 1024) {
  const table = new Float64Array(cap), counts = model.shape.counts;
  for (let v = 0; v < cap; v++) {
    hybridToken(model.config, v, SP);
    const c = SP[0] < counts.length ? counts[SP[0]] : 0;
    table[v] = SP[0] > 255 ? Infinity : (c ? SYMBOL_BITS[c] : 13.5) + SP[1];
  }
  return {table, cap, config: model.config, counts};
}

function scoreUnitUnderTable(values, counts, vt, least) {
  let bits = 0;
  const {table, cap, config, counts: shCounts} = vt;
  for (let k = 0; k < values.length; k++) {
    const v = values[k];
    let b;
    if (v < cap) b = table[v];
    else {
      hybridToken(config, v, SP);
      const c = SP[0] < shCounts.length ? shCounts[SP[0]] : 0;
      b = SP[0] > 255 ? Infinity : (c ? SYMBOL_BITS[c] : 13.5) + SP[1];
    }
    bits += counts[k] * b;
    if (bits >= least) return bits;
  }
  return bits;
}

function bisectMicroClusters(units, maxMicro = 1536) {
  const U = units.length;
  if (U <= maxMicro) {
    return units.map((literals, i) => ({members: [i], literals, constant: Boolean(literals.constant), ...preTokens8(literals)}));
  }
  const f0 = new Float64Array(U), f1 = new Float64Array(U), f2 = new Float64Array(U);
  const f3 = new Float64Array(U), f4 = new Float64Array(U), f5 = new Float64Array(U);
  const constIds = [], varIds = [];
  for (let i = 0; i < U; i++) {
    const u = units[i];
    if (u.constant) { constIds.push(i); continue; }
    varIds.push(i);
    let tot = 0, c0 = 0, c1 = 0, c2 = 0, c3 = 0, s1 = 0, s2 = 0;
    const {values, counts} = u;
    for (let k = 0; k < values.length; k++) {
      const v = values[k], c = counts[k];
      tot += c;
      if (v === 0) c0 += c;
      else if (v === 1) c1 += c;
      else if (v <= 5) c2 += c;
      else if (v <= 15) c3 += c;
      const lv = v < 4096 ? LOG2_VAL[v] : Math.log2(v + 2);
      s1 += c * lv; s2 += c * lv * lv;
    }
    const inv = 1 / (tot || 1), mean = s1 * inv;
    f0[i] = (c0 * inv) * 2.5; f1[i] = (c1 * inv) * 2.0;
    f2[i] = (c2 * inv) * 1.5; f3[i] = (c3 * inv) * 1.5;
    f4[i] = mean; f5[i] = Math.sqrt(Math.max(0, s2 * inv - mean * mean));
  }
  const target = maxMicro - (constIds.length ? 1 : 0);
  const clusterVar = ids => {
    const n = ids.length;
    if (n <= 1) return {ids, sse: 0, dim: 0};
    let m0 = 0, m1 = 0, m2 = 0, m3 = 0, m4 = 0, m5 = 0;
    for (let j = 0; j < n; j++) {
      const id = ids[j];
      m0 += f0[id]; m1 += f1[id]; m2 += f2[id]; m3 += f3[id]; m4 += f4[id]; m5 += f5[id];
    }
    m0 /= n; m1 /= n; m2 /= n; m3 /= n; m4 /= n; m5 /= n;
    const v = [0, 0, 0, 0, 0, 0];
    for (let j = 0; j < n; j++) {
      const id = ids[j];
      v[0] += (f0[id] - m0) ** 2; v[1] += (f1[id] - m1) ** 2; v[2] += (f2[id] - m2) ** 2;
      v[3] += (f3[id] - m3) ** 2; v[4] += (f4[id] - m4) ** 2; v[5] += (f5[id] - m5) ** 2;
    }
    let bestD = 0;
    for (let d = 1; d < 6; d++) if (v[d] > v[bestD]) bestD = d;
    return {ids, sse: v[0] + v[1] + v[2] + v[3] + v[4] + v[5], dim: bestD};
  };
  const feats = [f0, f1, f2, f3, f4, f5];
  const buckets = varIds.length ? [clusterVar(varIds)] : [];
  while (buckets.length < target) {
    let pick = -1, bestSse = 0;
    for (let b = 0; b < buckets.length; b++) if (buckets[b].ids.length > 1 && buckets[b].sse > bestSse) { bestSse = buckets[b].sse; pick = b; }
    if (pick < 0) break;
    const {ids, dim} = buckets[pick], n = ids.length, fd = feats[dim];
    let minI = ids[0], maxI = ids[0];
    for (let j = 1; j < n; j++) { const id = ids[j]; if (fd[id] < fd[minI]) minI = id; if (fd[id] > fd[maxI]) maxI = id; }
    let a0 = f0[minI], a1 = f1[minI], a2 = f2[minI], a3 = f3[minI], a4 = f4[minI], a5 = f5[minI];
    let b0 = f0[maxI], b1 = f1[maxI], b2 = f2[maxI], b3 = f3[maxI], b4 = f4[maxI], b5 = f5[maxI];
    let left = [], right = [];
    for (let it = 0; it < 4; it++) {
      left = []; right = [];
      let la0 = 0, la1 = 0, la2 = 0, la3 = 0, la4 = 0, la5 = 0;
      let rb0 = 0, rb1 = 0, rb2 = 0, rb3 = 0, rb4 = 0, rb5 = 0;
      for (let j = 0; j < n; j++) {
        const id = ids[j];
        const da = (f0[id] - a0) ** 2 + (f1[id] - a1) ** 2 + (f2[id] - a2) ** 2 + (f3[id] - a3) ** 2 + (f4[id] - a4) ** 2 + (f5[id] - a5) ** 2;
        const db = (f0[id] - b0) ** 2 + (f1[id] - b1) ** 2 + (f2[id] - b2) ** 2 + (f3[id] - b3) ** 2 + (f4[id] - b4) ** 2 + (f5[id] - b5) ** 2;
        if (da <= db) { left.push(id); la0 += f0[id]; la1 += f1[id]; la2 += f2[id]; la3 += f3[id]; la4 += f4[id]; la5 += f5[id]; }
        else { right.push(id); rb0 += f0[id]; rb1 += f1[id]; rb2 += f2[id]; rb3 += f3[id]; rb4 += f4[id]; rb5 += f5[id]; }
      }
      if (!left.length || !right.length) {
        const sorted = ids.slice().sort((x, y) => fd[x] - fd[y] || x - y);
        const mid = sorted.length >> 1;
        left = sorted.slice(0, mid); right = sorted.slice(mid);
        break;
      }
      const il = 1 / left.length, ir = 1 / right.length;
      a0 = la0 * il; a1 = la1 * il; a2 = la2 * il; a3 = la3 * il; a4 = la4 * il; a5 = la5 * il;
      b0 = rb0 * ir; b1 = rb1 * ir; b2 = rb2 * ir; b3 = rb3 * ir; b4 = rb4 * ir; b5 = rb5 * ir;
    }
    buckets[pick] = clusterVar(left);
    buckets.push(clusterVar(right));
  }
  const out = [];
  if (constIds.length) {
    let lits = units[constIds[0]];
    for (let i = 1; i < constIds.length; i++) lits = joined(lits, units[constIds[i]]);
    out.push({members: constIds, literals: lits, constant: true, ...preTokens8(lits)});
  }
  for (const {ids} of buckets) {
    let lits = units[ids[0]];
    for (let i = 1; i < ids.length; i++) lits = joined(lits, units[ids[i]]);
    out.push({members: ids, literals: lits, constant: false, ...preTokens8(lits)});
  }
  return out;
}

export function bucketedLeafClusters(units, limit = 255, seedBuckets = 320, passes = 6, trials = 8) {
  const U = units.length;
  if (!U) return null;
  let groups = bisectMicroClusters(units, 1536);
  for (const g of groups) g.pre = preBits8(g.freqs, g.raw);
  const scratch = new Uint32Array(64);
  const merged = (a, b) => {
    if (a.constant !== b.constant) return Infinity;
    for (let s = 0; s < 64; s++) scratch[s] = a.freqs[s] + b.freqs[s];
    return preBits8(scratch, a.raw + b.raw) - a.pre - b.pre;
  };
  if (groups.length > seedBuckets) {
    const G = groups.length, alive = new Uint8Array(G).fill(1), near = new Int32Array(G).fill(-1), gain = new Float64Array(G);
    const nearest = a => {
      near[a] = -1; gain[a] = Infinity;
      for (let b = a + 1; b < G; b++) if (alive[b]) { const d = merged(groups[a], groups[b]); if (d < gain[a]) { gain[a] = d; near[a] = b; } }
    };
    for (let a = 0; a < G; a++) nearest(a);
    for (let left = G; left > seedBuckets; left--) {
      let a = -1;
      for (let i = 0; i < G; i++) if (alive[i] && near[i] >= 0 && (a < 0 || gain[i] < gain[a])) a = i;
      if (a < 0) break;
      const b = near[a], ga = groups[a], gb = groups[b];
      for (let s = 0; s < 64; s++) ga.freqs[s] += gb.freqs[s];
      ga.raw += gb.raw; ga.pre = preBits8(ga.freqs, ga.raw); ga.members.push(...gb.members);
      ga.literals = joined(ga.literals, gb.literals); alive[b] = 0;
      nearest(a);
      for (let i = 0; i < G; i++) if (alive[i] && i !== a && (near[i] === a || near[i] === b)) nearest(i);
        else if (alive[i] && i < a) { const d = merged(groups[i], ga); if (d < gain[i]) { gain[i] = d; near[i] = a; } }
    }
    groups = groups.filter((_, i) => alive[i]);
  }
  for (const g of groups) { g.model = clusterModelStrong(g.literals, trials); if (!g.model) return null; }
  const rises = new Map(), priced = new Map();
  let uid = 0;
  for (const g of groups) g.uid = uid++;
  const risen = (a, b) => {
    const key = a.uid * 1048576 + b.uid;
    let r = rises.get(key);
    if (r === undefined) { r = merged(a, b); rises.set(key, r); }
    return r;
  };
  while (groups.length > 1) {
    const pairs = [];
    for (let a = 0; a < groups.length; a++) for (let b = a + 1; b < groups.length; b++) if (groups[a].constant === groups[b].constant) {
      const rise = risen(groups[a], groups[b]);
      if (pairs.length === 9 && !(rise < pairs[8][0])) continue;
      let at = pairs.length === 9 ? 8 : pairs.length;
      while (at > 0 && rise < pairs[at - 1][0]) { pairs[at] = pairs[at - 1]; at--; }
      pairs[at] = [rise, a, b];
    }
    let best = groups.length > limit ? Infinity : 0, take = null;
    for (const [, a, b] of pairs) {
      const key = groups[a].uid * 1048576 + groups[b].uid;
      let found = priced.get(key);
      if (!found) {
        const literals = joined(groups[a].literals, groups[b].literals), model = clusterModelStrong(literals, trials);
        found = {literals, model, delta: model ? model.bits - groups[a].model.bits - groups[b].model.bits - 3.2 : Infinity};
        priced.set(key, found);
      }
      if (found.delta < best) { best = found.delta; take = [a, b, found]; }
    }
    if (!take) break;
    const [a, b, {literals, model}] = take, ga = groups[a], gb = groups[b];
    for (let s = 0; s < 64; s++) ga.freqs[s] += gb.freqs[s];
    ga.raw += gb.raw; ga.pre = preBits8(ga.freqs, ga.raw); ga.members.push(...gb.members);
    ga.literals = literals; ga.model = model; ga.uid = uid++;
    groups.splice(b, 1);
  }
  let of = new Int32Array(U);
  groups.forEach((g, c) => { for (const m of g.members) of[m] = c; });
  let models = groups.map(g => ({...g.model, constant: g.constant}));
  for (let pass = 0; pass < passes && models.length > 1; pass++) {
    const vts = models.map(m => valueBitsTable(m, 1024));
    let moved = 0;
    for (let i = 0; i < U; i++) {
      const {values, counts, constant} = units[i], isConst = Boolean(constant);
      let to = of[i];
      let least = models[to]?.constant === isConst ? scoreUnitUnderTable(values, counts, vts[to], Infinity) - 0.25 : Infinity;
      for (let c = 0; c < vts.length; c++) {
        if (c === to || models[c].constant !== isConst) continue;
        const bits = scoreUnitUnderTable(values, counts, vts[c], least);
        if (bits < least) { least = bits; to = c; }
      }
      if (to !== of[i]) { moved++; of[i] = to; }
    }
    if (!moved) break;
    const sums = models.map(() => null);
    for (let i = 0; i < U; i++) sums[of[i]] = sums[of[i]] ? joined(sums[of[i]], units[i]) : units[i];
    const remap = new Int32Array(models.length).fill(-1), next = [];
    for (let c = 0; c < sums.length; c++) if (sums[c]) {
      const model = clusterModelStrong(sums[c], trials);
      if (!model) return null;
      remap[c] = next.length; next.push({...model, constant: models[c].constant});
    }
    of = of.map(c => remap[c]);
    models = next;
  }
  return {of, configs: models.map(m => m.config)};
}

export function writeTreeAns(w, root) {
  const wPrefix = new BitWriter(4096);
  const leaves = writeTree(wPrefix, root, true);
  const queue = [root], tokens = [], ctxs = [];
  for (const node of queue) {
    if (node.left) {
      tokens.push(node.property + 1, packSigned(node.splitval));
      ctxs.push(1, 0);
      queue.push(node.left, node.right);
    } else {
      const mulLog = node.multiplier === 1 ? 0 : 31 - Math.clz32(node.multiplier & -node.multiplier);
      tokens.push(0, node.predictor, packSigned(node.offset ?? 0), mulLog, (node.multiplier >> mulLog) - 1);
      ctxs.push(1, 2, 3, 3, 3);
    }
  }
  const map6 = Uint8Array.of(0, 1, 2, 3, 3, 3);
  const nTok = tokens.length, pv = Int32Array.from(tokens), pc = Uint8Array.from(ctxs), pd = new Int32Array(nTok);
  const model = {count: nTok, classes: 4, base: 0, pieceValue: pv, pieceDistance: pd, pieceContext: pc};
  const configs = [];
  for (let h = 0; h < 4; h++) {
    const mp = new Map();
    for (let i = 0; i < nTok; i++) if (pc[i] === h) mp.set(pv[i], (mp.get(pv[i]) ?? 0) + 1);
    const lits = {values: Int32Array.from(mp.keys()), counts: Uint32Array.from(mp.values())};
    const prices = capturePrices(ANS_FIT.slice(0, 64), lits);
    const ranked = [];
    for (let c = 0; c < Math.min(64, ANS_FIT.length); c++) if (prices[c * 2 + 1] < 256) ranked.push({cfg: ANS_FIT[c], est: prices[c * 2]});
    ranked.sort((a, b) => a.est - b.est);
    let bestCfg = null, bestBits = Infinity;
    for (const {cfg} of ranked.slice(0, 4)) {
      const freqs = new Uint32Array(256);
      let extra = 0;
      for (let i = 0; i < lits.values.length; i++) {
        hybridToken(cfg, lits.values[i], SP);
        freqs[SP[0]] += lits.counts[i];
        extra += SP[1] * lits.counts[i];
      }
      const sh = shapeHistogram(freqs, true);
      if (!sh) continue;
      const cw = new BitWriter(8); writeUintConfig(cw, cfg, 8);
      const b = cw.bitLength + sh.bits + extra;
      if (b < bestBits) { bestBits = b; bestCfg = cfg; }
    }
    if (!bestCfg) { w.append(wPrefix); return leaves; }
    configs.push(bestCfg);
  }
  const ansToks = captureAnsTokens([model], Int32Array.of(0, 1, 2, 3), configs, null, 4, nTok);
  if (ansToks) {
    const wAns = new BitWriter(4096), wData = new BitWriter(4096);
    if (writeCaptureAns(wAns, wData, {lz77: null, contextMap: map6, configs, headerAware: true, mapWriter: writeSmallestContextMap}, ansToks)) {
      wAns.append(wData);
      if (wAns.bitLength < wPrefix.bitLength) { w.append(wAns); return leaves; }
    }
  }
  w.append(wPrefix);
  return leaves;
}

export function shapeGlobalForestAns(header, contextMap, configs, freqs) {
  let largest = 0;
  for (const f of freqs) for (let s = 255; s > largest; s--) if (f[s]) { largest = s; break; }
  let logAlphabet = Math.max(5, 32 - Math.clz32(largest));
  for (const c of configs) if (c.split > logAlphabet) logAlphabet = c.split;
  if (logAlphabet > 8) return null;
  const shapes = [], shapeCounts = [];
  for (const f of freqs) {
    const shape = shapeHistogram(f, true);
    if (!shape) return null;
    shapes.push({...shape, ...reverseAlias(shape.counts, logAlphabet)});
    shapeCounts.push(shape.counts);
  }
  writeModularAnsHeader(header, null, contextMap, logAlphabet, configs, shapes, writeSmallestContextMap);
  return {shapes, shapeCounts, logAlphabet};
}

let zeros = new Int32Array(0);
const rebuildShapes = (shapeCounts, logAlphabet) => shapeCounts.map(counts => ({counts, ...reverseAlias(counts, logAlphabet)}));

export function encodeForestGroupSection(pixels, w, h, payload) {
  requireCaptureKernels();
  const {id, chain, wp, trees, configs, shapeCounts, logAlphabet, shapes: directShapes, single, contextMap} = payload;
  const words = pixelKeys(pixels);
  const planes = captureColourChain(words, w, 0, 0, w, h, chain);
  const n = w * h, H = configs.length;
  if (zeros.length < n) zeros = new Int32Array(n);
  const identityIndex = Int32Array.from({length: H}, (_, i) => i);
  const models = planes.map((pl, c) => {
    const answer = wp ? captureCustomWeighted(pl, w, h, wp) : residualsOf(pl, w, h);
    const walked = codePlane(streamTreeOf(trees[c], id), pl, w, h, answer.residuals, answer.properties, planes.slice(0, c).reverse());
    return {count: n, classes: H, base: 0, pieceValue: walked.values, pieceDistance: zeros, pieceContext: walked.contexts};
  });
  const tokens = captureAnsTokens(models, identityIndex, configs, null, H, 3 * n);
  if (!tokens) return null;
  if (single) {
    const ansHeader = new BitWriter(1024), dataW = new BitWriter(n + 256);
    if (!writeCaptureAns(ansHeader, dataW, {lz77: null, contextMap, configs, headerAware: true, mapWriter: writeSmallestContextMap}, tokens)) return null;
    return {ansHeader, dataW};
  }
  const shapes = directShapes ?? rebuildShapes(shapeCounts, logAlphabet);
  const transforms = chain.map(rctType => ({type: 'rct', beginC: 0, rctType}));
  const secW = new BitWriter(n + 256);
  writeModularHeader(secW, {useGlobalTree: true, transforms, weighted: wp});
  if (captureAnsWrite(secW, tokens, shapes) === false) return null;
  return {bytes: secW.finish()};
}

function codedOf(words, stride, {x, y, w, h, transforms, wp}, channel = 2) {
  const chain = transforms.map(t => t.rctType);
  const planes = captureColourChain(words, stride, x, y, w, h, chain);
  const answers = planes.map((plane, c) => c > channel ? null : wp ? captureCustomWeighted(plane, w, h, wp) : residualsOf(plane, w, h));
  return {planes, answers};
}
function residualsOf(plane, w, h) {
  const residuals = new Uint32Array(w * h), properties = new Int32Array(w * h);
  captureResiduals(plane, w, h, residuals, properties);
  return {residuals, properties};
}
const treeSteps = (groups, coded, channel, options) => sharedTreeSteps(groups.map(group => {
  const {planes, answers} = coded.get(group);
  return {plane: planes[channel], w: group.w, h: group.h, answer: answers[channel], references: planes.slice(0, channel).reverse(), id: group.id};
}), options);

function sharedSection(groups, coded, trees, options) {
  const classes = [], bases = [], contextOf = new Map();
  for (const tree of trees) {
    const base = bases.length ? bases.at(-1) + classes.at(-1) : 0;
    let most = 0;
    const walk = n => { if (n.left) { walk(n.left); walk(n.right); } else { contextOf.set(n, base + n.local); most = Math.max(most, n.local + 1); } };
    walk(tree); bases.push(base); classes.push(most);
  }
  const contexts = bases[2] + classes[2];
  const global = new BitWriter(1 << 16);
  global.write(1, 1); global.write(1, 1);
  const root = intervals(0, [0, 1], c => trees[c]);
  const rawLeaves = options.treeContexts ? writeTreeAns(global, root) : writeTree(global, root, false);
  const leaves = rawLeaves.map(leaf => contextOf.get(leaf));
  const sections = groups.map(group => {
    const {planes, answers} = coded.get(group), n = group.w * group.h;
    if (zeros.length < n) zeros = new Int32Array(n);
    const models = planes.map((plane, c) => {
      const walked = codePlane(streamTreeOf(trees[c], group.id), plane, group.w, group.h, answers[c].residuals, answers[c].properties, planes.slice(0, c).reverse());
      return {count: n, classes: classes[c], base: bases[c], pieceValue: walked.values, pieceDistance: zeros, pieceContext: walked.contexts};
    });
    return {models, writer: () => { const out = new BitWriter(n + 256); writeModularHeader(out, {useGlobalTree: true, transforms: group.transforms, weighted: group.wp}); return out; }};
  });
  const ans = writeSharedAns(sections, contexts, leaves);
  if (!ans) return null;
  global.append(ans.header);
  writeModularHeader(global);
  global.write(16, 0); global.write(16, 0x13);
  return {global: global.finish(), sections: new Map(groups.map((group, i) => [group, ans.sections[i].finish()]))};
}
