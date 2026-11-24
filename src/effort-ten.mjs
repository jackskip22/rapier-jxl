// SPDX-License-Identifier: MIT
import {BitWriter} from './bits.mjs';
import {admitOptions, admitOutputSize} from './admit.mjs';
import {admitSampleFormat} from './admit-samples.mjs';
import {exactSignal, signalSpace} from './color-signal.mjs';
import {writeImageHeader} from './icc-write.mjs';
import {groupLayout, groupRect, writeModularFrameHeader, assembleCodestream} from './frame.mjs';
import {intervals, writeModularHeader} from './modular.mjs';
import {inspectPixelsSteps, iccShape, shapeFloors} from './lossless.mjs';
import {losslessLevel, losslessSets, rankingOf, losslessCapture, NOISE, retained} from './effort-job.mjs';
import {writeCrossChannelAns, CAPTURE_TOOLS_COMPLETE} from './capture-ans.mjs';
import {captureGroupSteps, captureStillShape} from './capture-codec.mjs';
import {
  stripFramesSteps, stripTreeSteps, REGION_DIM, FOREST_DIM, regionSectionsSteps,
  candidateChainsFromRanking, optimizeGroupWp, probeForestGroup, learnForestSpanSteps,
  bucketedLeafClusters, writeTreeAns, shapeGlobalForestAns, encodeForestGroupSection, fallbackGlobalSection,
} from './capture-strips.mjs';
import {captureColourChain, captureCustomWeighted, captureCustomWeightedBins, captureScanColours} from './capture-kernels.mjs';
import {letGoTrees, streamTreeOf} from './capture-trees.mjs';
import {hybridToken} from './prefix.mjs';
import {pixelKeys} from './screen-crop.mjs';
import {offloading} from './offload.mjs';
import {deviceNodes} from './tree-device.mjs';
import {encodeEffortTen16Steps, effortTenGroup16} from './effort-ten-16.mjs';
import {steerTenSmallPhoto, isForcedFullSearch} from './search-models.mjs';

const TOOLS = /* @__PURE__ */ Object.freeze({ansExtra: writeCrossChannelAns,
  ...((typeof __RAPIER_JXL_TEN_DEVICE__ === 'undefined' || __RAPIER_JXL_TEN_DEVICE__ === true) && {deviceTrees: deviceNodes})});

const DEFAULT_WP = [16, 10, 7, 7, 7, 0, 0, 13, 12, 12, 12];
const PRESETS = [DEFAULT_WP, [8, 8, 4, 0, 3, 23, 2, 13, 12, 12, 11], [10, 9, 7, 0, 0, 16, 9, 13, 12, 13, 12],
  [6, 6, 3, 0, 2, 26, 4, 13, 12, 12, 11], [12, 10, 6, 3, 6, 12, 6, 13, 12, 12, 12], [14, 11, 7, 5, 7, 6, 3, 12, 12, 12, 11],
  [4, 4, 2, 0, 2, 0, 0, 14, 11, 11, 10], [9, 9, 5, 0, 4, 20, 6, 13, 12, 12, 12]];

function wpBits(planes, width, wp, strips) {
  let bits = 0;
  for (const plane of planes) {
    const {bins, raw} = captureCustomWeightedBins(plane, width, plane.length / width, wp, strips);
    bits += raw;
    for (let b = 0; b < 14; b++) {
      let total = 0;
      for (let t = 0; t < 48; t++) total += bins[b * 48 + t];
      for (let t = 0; t < 48; t++) if (bins[b * 48 + t]) bits += bins[b * 48 + t] * Math.log2(total / bins[b * 48 + t]);
    }
  }
  return bits;
}

function cheapest(planes, width, strips) {
  let best = null, least = Infinity;
  for (const wp of PRESETS) { const bits = wpBits(planes, width, wp, strips); if (bits < least) { least = bits; best = wp; } }
  return [best, least];
}

function chosenWeighted(data, width, height) {
  const step = Math.max(32, Math.ceil(height / 16)), spans = [];
  let rows = 0;
  for (let y = 0; y < height; y += step) { const top = Math.max(0, y - 4), end = Math.min(height, y + 32); spans.push([top, y, end, rows]); rows += end - top; }
  const n = rows * width, planes = [new Int16Array(n), new Int16Array(n), new Int16Array(n)], strips = [];
  let flat = true;
  for (const [top, y, end, at] of spans) {
    for (let r = top, o = at * width; r < end; r++) for (let x = 0, i = r * width * 4; x < width; x++, o++, i += 4) {
      const g = data[i + 1]; planes[0][o] = g; planes[1][o] = data[i + 2] - g; planes[2][o] = data[i] - g;
      flat &&= data[i] === data[0] && g === data[1] && data[i + 2] === data[2];
    }
    strips.push([at + y - top, at + end - top]);
  }
  if (flat) return [];
  const [best] = cheapest(planes, width, strips);
  return [...new Set([best, PRESETS[3], PRESETS[1]])].filter(wp => wp !== DEFAULT_WP);
}

const WP_MAX = [31, 31, 31, 31, 31, 31, 31, 15, 15, 15, 15];
function groupWeighted(planes, width, height) {
  const rows = Math.min(64, height), count = Math.min(4, Math.max(1, Math.floor(height / rows))), strips = [];
  for (let k = 0; k < count; k++) { const y = Math.floor((height - rows) * k / Math.max(1, count - 1)); strips.push([y, y + rows]); }
  let [best, least] = cheapest(planes, width, strips);
  best = best.slice();
  for (const step of [3, 1]) for (let pass = 0, moved = true; moved && pass < 3; pass++) {
    moved = false;
    for (let i = 0; i < 11; i++) for (const d of [-step, step]) {
      const value = best[i] + d;
      if (value < 0 || value > WP_MAX[i]) continue;
      const wp = best.slice(); wp[i] = value;
      const bits = wpBits(planes, width, wp, strips);
      if (bits < least) { least = bits; best = wp; moved = true; }
    }
  }
  return best.every((value, i) => value === DEFAULT_WP[i]) ? null : ownWeighted(best);
}
const ownWeighted = values => Object.freeze({values, weighted: (plane, w, h) => captureCustomWeighted(plane, w, h, values)});

const GROUP = 1048576, REGIONAL_MIN_PIXELS = 262144;
const CHAINED = 42 * 22;
function rcts(first, second) {
  const out = [first], add = r => { if (r >= 0 && r < 42 && !out.includes(r) && out.length < 3) out.push(r); };
  if (first % 7 === 6) add(first - 1);
  else if (first % 7 === 5) add(first + 1);
  const partner = out[1];
  if (second !== undefined) add(second);
  if (first % 7 === 3 || first % 7 === 6) add((first + 21) % 42);
  return [...out, CHAINED + first, ...partner === undefined ? [] : [CHAINED + partner]];
}
const tuned = set => Object.freeze({...set, learn: Object.freeze({...set.learn, bins: 255, leafBits: 12, histSym: 1.5, histBase: 24})});

function slicePixels(data, stride, x, y, w, h) {
  if (x === 0 && w === stride) return data.slice(y * stride * 4, (y + h) * stride * 4);
  const out = new Uint8Array(w * h * 4);
  for (let r = 0; r < h; r++) out.set(data.subarray(((y + r) * stride + x) * 4, ((y + r) * stride + x + w) * 4), r * w * 4);
  return out;
}

function withProfileHeader(bytes, width, height, space) {
  const colour = space.colorChannels ?? 3;
  for (const alpha of [false, true]) {
    const plain = new BitWriter(64);
    writeImageHeader(plain, width, height, colour, alpha, {colorSpace: 'srgb'});
    const head = plain.finish();
    if (head.length >= bytes.length || head.some((byte, i) => byte !== bytes[i])) continue;
    const profiled = new BitWriter(1024);
    writeImageHeader(profiled, width, height, colour, alpha, {colorSpace: space});
    const out = profiled.finish(), file = new Uint8Array(out.length + bytes.length - head.length);
    file.set(out); file.set(bytes.subarray(head.length), out.length);
    return file;
  }
  return null;
}

function regionOptionsFor(shape, fallbackLevel = null) {
  return {
    ...tuned(losslessSets(9, [6, 6])[0]).learn,
    device: TOOLS.deviceTrees,
    shape: shape ?? {colour: 3, alpha: false, channels: 3},
    fallbackLevel,
    kit: CAPTURE_TOOLS_COMPLETE,
    treeContexts: true,
  };
}

const levels = /* @__PURE__ */ new WeakMap(), WIDE_PALETTE = 4096;
function* tenLevel(data, width, height, colorSpace) {
  const key = `${width}x${height}:${typeof colorSpace === 'string' ? colorSpace : 'profile'}${isForcedFullSearch() ? ':full' : ''}`, kept = levels.get(data);
  if (kept?.key === key) return kept;
  const shape = yield* inspectPixelsSteps(data, width, height);
  const colours = shape.palette ? 0 : captureScanColours(data, width, height, 16384)?.length ?? 0;
  if (colours > WIDE_PALETTE && colours * 32 <= width * height) { const made = {key, widePalette: true}; levels.set(data, made); return made; }
  const [ranked, estimate, pixels] = yield* rankingOf(data, width, height, shape, colorSpace), nine = losslessLevel(9, ranked, estimate, pixels);
  const noise = estimate !== undefined && estimate * 8 >= 16 * pixels && pixels > 65536;
  if (!noise && pixels > REGIONAL_MIN_PIXELS && (width > REGION_DIM || height > REGION_DIM) && shape.colour === 3 && !shape.alpha && !shape.palette) {
    const cands = candidateChainsFromRanking(ranked);
    const made = {
      key,
      forest: true,
      cands,
      ranked,
      shape: {colour: 3, alpha: false, channels: 3},
      fallbackLevel: losslessLevel(3, ranked, estimate, pixels),
      level: Object.freeze({...nine, ...TOOLS}),
      parts: [],
      searched: false,
    };
    levels.set(data, made);
    return made;
  }
  const sets = noise ? [...losslessSets(9, ranked), NOISE] : pixels > 4096 ? [tuned(losslessSets(9, ranked)[0]), losslessSets(9, ranked)[0]] : nine.learnSets;
  const allRcts = noise || pixels <= 4096 ? null : rcts(ranked[0], ranked[1]);
  const smallSteer = !noise && pixels > 65536 && shape.colour === 3 && !shape.alpha && !shape.palette
    ? steerTenSmallPhoto(data, width, height, allRcts, candidateChainsFromRanking(ranked), ranked)
    : null;
  const chosenRcts = smallSteer ? smallSteer.rcts : allRcts;
  const partnered = retained(noise || pixels <= 4096 ? sets.map(set => Object.freeze({...set, rcts: [...new Set(set.rcts.flatMap(r => r % 7 === 6 && r > 0 ? [r, r - 1] : [r]))]}))
    : sets.map(set => Object.freeze({...set, rcts: chosenRcts, learn: Object.freeze({...set.learn, samples: GROUP})})));
  const allWps = shape.colour === 3 && width >= 16 && height >= 16 ? weightedFor(data, width, height) : [];
  const wps = smallSteer ? allWps.slice(0, 1) : allWps;
  const searched = allWps.length > 0;
  const tried = searched && !noise && pixels > 4096 ? partnered.slice(0, 1) : partnered;
  const parts = [tried, ...wps.map(values => { const own = ownWeighted(values); return tried.map(set => Object.freeze({...set, learn: Object.freeze({...set.learn, wp: own})})); })];
  const strips = !noise && pixels > 4096 && shape.colour === 3 ? Object.freeze({steps: stripFramesSteps, learn: Object.freeze({...partnered[0].learn, leaves: 16384, clusters: 255})}) : null;
  const level = Object.freeze({
    ...nine,
    learnSets: parts.flat(),
    ...TOOLS,
    largerGroups: true,
    ...(smallSteer && estimate !== undefined && estimate >= 0.78 * pixels && {forceLargeDim: true}),
    strips,
    ...(searched && {groupWp: groupWeighted, groupWpSets: smallSteer ? tried : partnered}),
  });
  const made = {key, level, parts, searched};
  levels.set(data, made);
  return made;
}
const partsOf = ({parts, searched}) => parts.length + (searched ? 1 : 0);

const streamId = (dcGroups, g) => 1 + 3 * dcGroups + 17 + g;
const PROBE_BATCH = 6, SPAN_BATCH = 4, SECTION_BATCH = 6, MAX_SPAN_GROUPS = 3, MAX_SPAN_PIXELS = 3200000;
const SP = [0, 0, 0];

function* encodeForestCandidateSteps(data, width, height, colorSpace, groups, layout, helped, progressBase, progressSpan) {
  const numGroups = groups.length, dc = layout.dcGroupsX * layout.dcGroupsY, single = layout.single;
  const activeGroups = groups.filter(g => !g.flatOwn);
  if (!activeGroups.length) {
    const out = new BitWriter(256);
    writeImageHeader(out, width, height, 3, false, {colorSpace: typeof colorSpace === 'object' ? 'srgb' : colorSpace});
    writeModularFrameHeader(out, {alpha: false, shift: 3, last: true});
    const sections = single ? [groups[0].own] : [
      fallbackGlobalSection(),
      ...Array.from({length: dc + 1}, () => new Uint8Array(0)),
      ...groups.map(g => g.own),
    ];
    const file = assembleCodestream(out, sections);
    admitOutputSize(file.length);
    return typeof colorSpace === 'object' ? withProfileHeader(file, width, height, colorSpace) : file;
  }

  const spans = [];
  for (let i = 0; i < activeGroups.length;) {
    const span = [activeGroups[i]];
    let area = activeGroups[i].w * activeGroups[i].h;
    const targetKey = activeGroups[i].chainKey;
    while (i + span.length < activeGroups.length && span.length < MAX_SPAN_GROUPS) {
      const nxt = activeGroups[i + span.length];
      if (area + nxt.w * nxt.h > MAX_SPAN_PIXELS) break;
      if (nxt.chainKey === targetKey) {
        span.push(nxt);
        area += nxt.w * nxt.h;
      } else {
        const alt = nxt.rctRanking.find(r => r.key === targetKey);
        if (alt && alt.bits <= nxt.rctRanking[0].bits * 1.0012) {
          nxt.chain = span[0].chain;
          nxt.chainKey = targetKey;
          const words = pixelKeys(slicePixels(data, width, nxt.x, nxt.y, nxt.w, nxt.h));
          nxt.wp = optimizeGroupWp(captureColourChain(words, nxt.w, 0, 0, nxt.w, nxt.h, nxt.chain), nxt.w, nxt.h, nxt.wpPresets ?? null, Boolean(nxt.fastWp));
          span.push(nxt);
          area += nxt.w * nxt.h;
        } else break;
      }
    }
    spans.push(span);
    i += span.length;
  }

  const spanTrees = [[], [], []], spanCuts = [];
  const allLeafNodes = [], activeLids = [], units = [];
  const learnOpts = {leaves: 6144, charge: 8, leafBits: 12, device: TOOLS.deviceTrees};

  for (let s0 = 0; s0 < spans.length; s0 += SPAN_BATCH) {
    const s1 = Math.min(spans.length, s0 + SPAN_BATCH);
    let helperReplies = null;
    if (helped && spans.length > 1) {
      const tasks = [];
      for (let s = s0; s < s1; s++) {
        const sp = spans[s], spanMode = sp.some(g => g.spanMode === 'all14') ? 'all14' : 'mid10';
        tasks.push({
          kind: 'effort-ten',
          width: sp[0].w,
          height: sp[0].h,
          colorSpace: 'srgb',
          rect: {stage: 'forest-span', s, groups: sp.map(g => g.g)},
          part: 0,
          shape: {colour: 3, alpha: false, channels: 3},
          payload: {
            stage: 'forest-span',
            chain: sp[0].chain,
            spanMode,
            groupSlices: sp.map(g => ({pixels: slicePixels(data, width, g.x, g.y, g.w, g.h), w: g.w, h: g.h, id: g.id, wp: g.wp})),
          },
        });
      }
      yield {offload: 'prefetch', tasks};
      helperReplies = [];
      for (let k = 0; k < tasks.length; k++) {
        const task = tasks[k];
        tasks[k] = null;
        helperReplies.push(yield {offload: 'run', task});
      }
    }
    for (let s = s0; s < s1; s++) {
      const sp = spans[s];
      let learned = helperReplies?.[s - s0];
      if (!learned?.trees) {
        const spanMode = sp.some(g => g.spanMode === 'all14') ? 'all14' : 'mid10';
        const slices = sp.map(g => ({pixels: slicePixels(data, width, g.x, g.y, g.w, g.h), w: g.w, h: g.h, id: g.id, wp: g.wp}));
        learned = yield* learnForestSpanSteps(slices, sp[0].chain, {...learnOpts, spanMode});
      }
      if (!learned?.trees) return null;
      for (let c = 0; c < 3; c++) {
        const tree = learned.trees[c], chUnits = learned.channelUnits[c];
        let localIdx = 0;
        const collect = n => {
          if (n.left) { collect(n.left); collect(n.right); }
          else {
            const lid = allLeafNodes.length, u = chUnits[localIdx++];
            n.leafId = lid;
            allLeafNodes.push(n);
            if (u) { activeLids.push(lid); units.push(u); }
          }
        };
        collect(tree);
        spanTrees[c].push(tree);
      }
      if (s + 1 < spans.length) spanCuts.push(sp[sp.length - 1].id);
      if (helperReplies) helperReplies[s - s0] = null;
      const frac = progressBase + progressSpan * (0.65 * ((s + 1) / spans.length));
      if (yield frac) return null;
    }
  }

  const L = allLeafNodes.length;
  const clusters = bucketedLeafClusters(units, 255, 320, 6, 8);
  if (!clusters) return null;
  const fullOf = new Int32Array(L);
  activeLids.forEach((lid, uIdx) => { fullOf[lid] = clusters.of[uIdx]; });

  const channelRoots = [0, 1, 2].map(c => spans.length === 1 ? spanTrees[c][0] : intervals(1, spanCuts, i => spanTrees[c][i]));
  const root = intervals(0, [0, 1], c => channelRoots[c]);
  const global = new BitWriter(65536);
  global.write(1, 1); global.write(1, 1);
  const orderedLeaves = writeTreeAns(global, root);

  const remap = new Int32Array(clusters.configs.length).fill(-1), order = [];
  const contextMap = Uint8Array.from(orderedLeaves, lf => {
    const g = fullOf[lf.leafId];
    if (remap[g] < 0) { remap[g] = order.length; order.push(g); }
    return remap[g];
  });
  const configs = order.map(g => clusters.configs[g]);
  const H = configs.length;
  for (let lid = 0; lid < L; lid++) allLeafNodes[lid].local = Math.max(0, remap[fullOf[lid]]);

  if (single) {
    const grp = groups[0];
    const pixels = slicePixels(data, width, grp.x, grp.y, grp.w, grp.h);
    const enc = encodeForestGroupSection(pixels, grp.w, grp.h, {
      id: 0, chain: grp.chain, wp: grp.wp, trees: [spanTrees[0][0], spanTrees[1][0], spanTrees[2][0]],
      configs, single: true, contextMap,
    });
    if (!enc) return grp.own ?? null;
    const transforms = grp.chain.map(rctType => ({type: 'rct', beginC: 0, rctType}));
    global.append(enc.ansHeader);
    writeModularHeader(global, {useGlobalTree: true, transforms, weighted: grp.wp});
    global.append(enc.dataW);
    const out = new BitWriter(256);
    writeImageHeader(out, width, height, 3, false, {colorSpace: typeof colorSpace === 'object' ? 'srgb' : colorSpace});
    writeModularFrameHeader(out, {alpha: false, shift: 3, last: true});
    let file = assembleCodestream(out, [global.finish()]);
    if (grp.own) {
      const ownOut = new BitWriter(256);
      writeImageHeader(ownOut, width, height, 3, false, {colorSpace: typeof colorSpace === 'object' ? 'srgb' : colorSpace});
      writeModularFrameHeader(ownOut, {alpha: false, shift: 3, last: true});
      const ownFile = assembleCodestream(ownOut, [grp.own]);
      if (ownFile.length <= file.length) file = ownFile;
    }
    admitOutputSize(file.length);
    if (yield progressBase + progressSpan) return file;
    return typeof colorSpace === 'object' ? withProfileHeader(file, width, height, colorSpace) : file;
  }

  const freqs = Array.from({length: H}, () => new Uint32Array(256));
  for (let uIdx = 0; uIdx < units.length; uIdx++) {
    const lid = activeLids[uIdx], h = allLeafNodes[lid].local, cfg = configs[h];
    const {values, counts} = units[uIdx], f = freqs[h];
    for (let k = 0; k < values.length; k++) {
      hybridToken(cfg, values[k], SP);
      f[SP[0]] += counts[k];
    }
  }
  const ansHeader = new BitWriter(1024);
  const shaped = shapeGlobalForestAns(ansHeader, contextMap, configs, freqs);
  if (!shaped) return null;
  global.append(ansHeader);
  writeModularHeader(global);
  global.write(16, 0); global.write(16, 0x13);
  const globalBytes = global.finish();
  let totalBytes = globalBytes.length;
  admitOutputSize(totalBytes);

  const spanOfGroup = new Int32Array(numGroups).fill(-1);
  spans.forEach((sp, sIdx) => { for (const g of sp) spanOfGroup[g.g] = sIdx; });

  const sectionBytes = new Array(numGroups);
  for (let g0 = 0; g0 < numGroups; g0 += SECTION_BATCH) {
    const g1 = Math.min(numGroups, g0 + SECTION_BATCH);
    let helperSecs = null;
    if (helped) {
      const tasks = [];
      for (let g = g0; g < g1; g++) {
        const grp = groups[g], sIdx = spanOfGroup[g];
        if (sIdx < 0) { tasks.push(null); continue; }
        const treesForGroup = [0, 1, 2].map(c => streamTreeOf(spanTrees[c][sIdx], grp.id));
        tasks.push({
          kind: 'effort-ten',
          pixels: slicePixels(data, width, grp.x, grp.y, grp.w, grp.h),
          width: grp.w,
          height: grp.h,
          colorSpace: 'srgb',
          rect: {stage: 'forest-section', g},
          part: 0,
          shape: {colour: 3, alpha: false, channels: 3},
          payload: {
            stage: 'forest-section',
            id: grp.id,
            chain: grp.chain,
            wp: grp.wp,
            trees: treesForGroup,
            configs,
            shapeCounts: shaped.shapeCounts,
            logAlphabet: shaped.logAlphabet,
            single: false,
          },
        });
      }
      const realTasks = tasks.filter(Boolean);
      if (realTasks.length) yield {offload: 'prefetch', tasks: realTasks};
      helperSecs = [];
      for (let k = 0; k < tasks.length; k++) {
        const task = tasks[k];
        tasks[k] = null;
        helperSecs.push(task ? (yield {offload: 'run', task}) : null);
      }
    }
    for (let g = g0; g < g1; g++) {
      const grp = groups[g], sIdx = spanOfGroup[g];
      if (sIdx < 0) {
        sectionBytes[g] = grp.own;
      } else {
        let sec = helperSecs?.[g - g0]?.bytes;
        if (!(sec instanceof Uint8Array)) {
          const pixels = slicePixels(data, width, grp.x, grp.y, grp.w, grp.h);
          const treesForGroup = [0, 1, 2].map(c => streamTreeOf(spanTrees[c][sIdx], grp.id));
          sec = encodeForestGroupSection(pixels, grp.w, grp.h, {
            id: grp.id, chain: grp.chain, wp: grp.wp, trees: treesForGroup,
            configs, shapes: shaped.shapes, single: false,
          })?.bytes;
        }
        if (!(sec instanceof Uint8Array)) {
          if (grp.own) sec = grp.own;
          else return null;
        } else if (grp.own && grp.own.length <= sec.length) {
          sec = grp.own;
        }
        sectionBytes[g] = sec;
      }
      totalBytes += sectionBytes[g].length;
      admitOutputSize(totalBytes);
      if (helperSecs) helperSecs[g - g0] = null;
    }
    const frac = progressBase + progressSpan * (0.65 + 0.35 * (g1 / numGroups));
    if (yield frac) return null;
  }

  const out = new BitWriter(256);
  writeImageHeader(out, width, height, 3, false, {colorSpace: typeof colorSpace === 'object' ? 'srgb' : colorSpace});
  writeModularFrameHeader(out, {alpha: false, shift: 3, last: true});
  const file = assembleCodestream(out, [
    globalBytes,
    ...Array.from({length: dc + 1}, () => new Uint8Array(0)),
    ...sectionBytes,
  ]);
  admitOutputSize(file.length);
  return typeof colorSpace === 'object' ? withProfileHeader(file, width, height, colorSpace) : file;
}

function* forestFileSteps(data, width, height, colorSpace, made, helped) {
  const dim = FOREST_DIM, layout = groupLayout(width, height, dim), numGroups = layout.groupsX * layout.groupsY;
  const dc = layout.dcGroupsX * layout.dcGroupsY, single = layout.single;

  const groups = new Array(numGroups);
  for (let g0 = 0; g0 < numGroups; g0 += PROBE_BATCH) {
    const g1 = Math.min(numGroups, g0 + PROBE_BATCH);
    let probedBatch = null;
    if (helped && numGroups > 1) {
      const tasks = [];
      for (let g = g0; g < g1; g++) {
        const [gx, gy, gw, gh] = groupRect(layout, width, height, g, dim);
        tasks.push({
          kind: 'effort-ten',
          pixels: slicePixels(data, width, gx, gy, gw, gh),
          width: gw,
          height: gh,
          colorSpace: 'srgb',
          rect: {stage: 'forest-probe', g},
          part: 0,
          shape: made.shape,
          payload: {stage: 'forest-probe', cands: made.cands, fallbackRank: made.ranked.slice(0, 2), ranked: Array.from(made.ranked.slice(0, 3))},
        });
      }
      yield {offload: 'prefetch', tasks};
      probedBatch = [];
      for (let k = 0; k < tasks.length; k++) {
        const task = tasks[k];
        tasks[k] = null;
        probedBatch.push(yield {offload: 'run', task});
      }
    }
    for (let g = g0; g < g1; g++) {
      const [gx, gy, gw, gh] = groupRect(layout, width, height, g, dim);
      let probed = probedBatch?.[g - g0];
      if (!probed?.chain) {
        probed = probeForestGroup(slicePixels(data, width, gx, gy, gw, gh), gw, gh, made.cands, made.shape, made.fallbackLevel, made.ranked.slice(0, 3));
      }
      groups[g] = {
        g, x: gx, y: gy, w: gw, h: gh,
        id: single ? 0 : streamId(dc, g),
        ...probed,
      };
      if (probedBatch) probedBatch[g - g0] = null;
    }
    if (yield 0.15 * (g1 / numGroups)) return null;
  }

  const tryRunnerUp = single && width * height <= 524288 && !groups[0].flatOwn;
  const altEntry = tryRunnerUp
    ? groups[0].rctRanking.slice(1).find(r => r.chain[0] % 7 !== groups[0].chain[0] % 7 && r.bits <= groups[0].rctRanking[0].bits * 1.0005)
    : null;

  const firstFile = yield* encodeForestCandidateSteps(data, width, height, colorSpace, groups, layout, helped, 0.15, altEntry ? 0.45 : 0.85);
  if (!altEntry) return firstFile;

  const g0 = groups[0];
  const words = pixelKeys(slicePixels(data, width, g0.x, g0.y, g0.w, g0.h));
  const altWp = optimizeGroupWp(captureColourChain(words, g0.w, 0, 0, g0.w, g0.h, altEntry.chain), g0.w, g0.h, null, Boolean(g0.fastWp));
  const altGroup = {...g0, chain: altEntry.chain, chainKey: altEntry.key, wp: altWp};
  const secondFile = yield* encodeForestCandidateSteps(data, width, height, colorSpace, [altGroup], layout, helped, 0.60, 0.40);
  if (!firstFile) return secondFile;
  if (!secondFile) return firstFile;
  return secondFile.length < firstFile.length ? secondFile : firstFile;
}

export function* effortTenFile(data, width, height, colorSpace, helped = false) {
  const made = yield* tenLevel(data, width, height, colorSpace);
  if (made.widePalette) return null;
  if (made.forest) return yield* forestFileSteps(data, width, height, colorSpace, made, Boolean(helped));
  return yield* losslessCapture(data, width, height, colorSpace, helped ? Object.freeze({...made.level, groupTasks: true}) : made.level);
}

export function* effortTenGroup(data, width, height, colorSpace, rect, part, shape, payload) {
  if (payload?.stage === 'forest-probe') {
    const fallbackLevel = losslessLevel(3, payload.fallbackRank, undefined, width * height);
    return probeForestGroup(data, width, height, payload.cands, shape ?? {colour: 3, alpha: false, channels: 3}, fallbackLevel, payload.ranked ?? null);
  }
  if (payload?.stage === 'forest-span') {
    return yield* learnForestSpanSteps(payload.groupSlices, payload.chain, {leaves: 6144, charge: 8, leafBits: 12, spanMode: payload.spanMode, device: TOOLS.deviceTrees});
  }
  if (payload?.stage === 'forest-section') {
    return encodeForestGroupSection(data, width, height, payload);
  }
  if (rect?.choices) {
    const fallbackLevel = losslessLevel(3, [rect.choices[0].rct % 42, 6], undefined, width * height);
    return yield* regionSectionsSteps(data, width, height, rect.choices, regionOptionsFor(shape, fallbackLevel));
  }
  if (shape?.deep16 || data instanceof Uint16Array) return yield* effortTenGroup16(data, width, rect, part, shape);
  if (shape && rect?.choices) shapeFloors.set(data, shape);
  const made = yield* tenLevel(data, width, height, colorSpace), {level, parts} = made;
  if (made.widePalette || made.forest || part >= partsOf(made)) return null;
  const own = part < parts.length ? Object.freeze({...level, learnSets: parts[part], groupWp: undefined})
    : Object.freeze({...level, learnSets: parts[0], groupWpOnly: true});
  return yield* captureGroupSteps(data, width, rect, own, shape, CAPTURE_TOOLS_COMPLETE);
}

function* groupTasks(data, width, height, colorSpace, ask, count) {
  const tasks = ask.rects.flatMap(rect => Array.from({length: count}, (_, part) => ({kind: 'effort-ten', data, width, height, colorSpace, rect, part, shape: ask.shape})));
  yield {offload: 'prefetch', tasks};
  const sections = [], choices = [];
  for (let r = 0; r < ask.rects.length; r++) {
    let best = null;
    for (let part = 0; part < count; part++) {
      const written = yield {offload: 'run', task: tasks[r * count + part]};
      if (!(written?.bytes instanceof Uint8Array)) return null;
      if (!best || written.bytes.length < best.bytes.length) best = written;
    }
    sections.push(best.bytes); choices.push(best.choice);
  }
  return Object.assign(sections, {choices});
}

export function* effortTenTree(data, width, height, colorSpace, groups, channel) {
  const {level} = yield* tenLevel(data, width, height, colorSpace);
  if (!level?.strips) return null;
  return yield* stripTreeSteps(data, width, groups, channel, {...level.strips.learn, treeContexts: level.treeContexts});
}

function* treeTasks(data, width, height, colorSpace, {asks}) {
  const tasks = asks.map(({groups, channel}) => ({kind: 'effort-ten-tree', data, width, height, colorSpace, groups, channel}));
  yield {offload: 'prefetch', tasks};
  const trees = [];
  for (const task of tasks) {
    const tree = yield {offload: 'run', task};
    if (!tree) return null;
    trees.push(tree);
  }
  return trees;
}

function tenRects(width, height) {
  if (width <= 1024 && height <= 1024) return [{x: 0, y: 0, width, height, single: true}];
  const rects = [];
  for (let y = 0; y < height; y += 1024) for (let x = 0; x < width; x += 1024) rects.push({x, y, width: Math.min(1024, width - x), height: Math.min(1024, height - y)});
  return rects;
}

const fitted = /* @__PURE__ */ new WeakMap();
const weightedFor = (data, width, height) => {
  const kept = fitted.get(data);
  if (kept && kept.width === width && kept.height === height) return kept.wps;
  const wps = chosenWeighted(data, width, height);
  fitted.set(data, {width, height, wps});
  return wps;
};

export function effortTenAhead(data, width, height, options) {
  if (!offloading() || !(data instanceof Uint8Array || data instanceof Uint8ClampedArray) || width < 16 || height < 16) return null;
  if (width * height > 65536) return null;
  const samples = admitSampleFormat(data, options), colorSpace = samples.native8 && !samples.iccSpace ? admitOptions(options).colorSpace : null;
  if (typeof colorSpace !== 'string') return null;
  const count = 2 + weightedFor(data, width, height).length, shape = captureStillShape(data, width, height, shapeFloors.get(data));
  return tenRects(width, height).flatMap(rect => Array.from({length: count}, (_, part) => ({kind: 'effort-ten', data, width, height, colorSpace, rect, part, shape})));
}

export function* effortTenSteps(data, width, height, options) {
  if (data instanceof Uint16Array) {
    const samples = admitSampleFormat(data, options);
    if (samples.exponentBits || samples.bitDepth <= 8 || samples.bitDepth > 16 || samples.icc) return null;
    return yield* encodeEffortTen16Steps(data, width, height, {...options, samples}, undefined, offloading());
  }
  if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray)) return null;
  const samples = admitSampleFormat(data, options);
  if (!samples.native8 && !samples.iccSpace && !exactSignal(samples)) return null;
  const colorSpace = samples.iccSpace ?? (samples.native8 ? admitOptions(options).colorSpace : signalSpace(samples));
  const forestEligible = width * height > REGIONAL_MIN_PIXELS && (width > REGION_DIM || height > REGION_DIM);
  const helped = offloading() && (forestEligible ? (typeof colorSpace === 'string' || Boolean(samples.iccSpace)) : !samples.iccSpace && typeof colorSpace === 'string');
  const run = function* () {
    const steps = effortTenFile(data, width, height, colorSpace, helped);
    let step, reply;
    try {
      while (!(step = steps.next(reply)).done) {
        const ask = step.value?.groups;
        reply = ask ? yield* groupTasks(data, width, height, colorSpace, ask, partsOf(yield* tenLevel(data, width, height, colorSpace)))
          : step.value?.stripTrees ? yield* treeTasks(data, width, height, colorSpace, step.value.stripTrees) : yield step.value;
      }
    } finally { if (!step?.done) steps.return?.(); }
    return step.value;
  };
  try { return yield* (samples.iccSpace ? iccShape(data, samples.iccSpace, run()) : run()); }
  catch (error) { if (error.code !== 'JXL_SIZE') throw error; return null; }
}
