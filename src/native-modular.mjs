// SPDX-License-Identifier: MIT
import {BitWriter, packSigned} from './bits.mjs';
import {writeModularFrameHeader, groupLayout, groupRect, assembleCodestream} from './frame.mjs';
import {writeImageHeader} from './icc-write.mjs';
import {ALPHABET, leaf, split, writeTree, writeModularHeader, writeChannelHistograms} from './modular.mjs';
import {planeModel, weightedTrees, transformRanking} from './capture-trees.mjs';
import {writeCaptureStream} from './capture-modular-stream.mjs';
import {kernelHooks, ensured, missing} from './kernel-hooks.mjs';
import {captureDistinct} from './capture-kernels.mjs';
import {hostShort} from './fault.mjs';

const SHIFT_PREDICTORS = Object.freeze([5, 4, 1, 2, 7, 8, 9]);
const SHIFT_PROPERTIES = Object.freeze([10, 11, 12, 13, 14, 2, 3]);
const COMPACT_RCT_LIMIT = 32768, COMPACT_RAW_LIMIT = 32768, COMPACT_INT_LIMIT = 4096, STREAM_KEY_LIMIT = 1 << 20;

function orderKey(word, samples) {
  if (!samples.exponentBits) return word;
  if (samples.bitDepth === 32) return word < 0 ? -(word & 0x7fffffff) - 1 : word;
  return (word & 0x8000) ? -(word & 0x7fff) - 1 : word;
}

export function metaTableModel(table) {
  const n = table.length, values = new Int32Array(n), contexts = new Uint8Array(n);
  let firstNonNeg = -1;
  if (table[0] < 0) for (let i = 1; i < n; i++) if (table[i] >= 0) { firstNonNeg = i; break; }
  const step = i => i > 0 && i !== firstNonNeg ? table[i] - table[i - 1] : NaN, fits = d => d >= -0x80000000 && d <= 0x7fffffff;
  let stepOr = 0;
  for (let i = 1; i < n; i++) if (fits(step(i))) stepOr |= step(i) | 0;
  const tz = stepOr ? Math.min(30, 31 - Math.clz32(stepOr & -stepOr)) : 0, mul = 1 << tz;
  const leaves = [], runs = [];
  let negCtx = -1, posCtx = -1, classes = 0;
  for (let i = 0; i < n; i++) {
    const d = step(i), packed = fits(d) ? packSigned((d | 0) >> tz) : -1;
    if (packed >= 0 && packed < STREAM_KEY_LIMIT) {
      const pos = firstNonNeg < 0 || i > firstNonNeg, kind = pos ? 2 : 1, last = runs[runs.length - 1];
      const local = pos ? (posCtx >= 0 ? posCtx : (posCtx = classes++)) : (negCtx >= 0 ? negCtx : (negCtx = classes++));
      values[i] = packed; contexts[i] = local;
      if (last?.kind === kind && last.hi === i - 1) { last.hi = i; continue; }
      runs.push({lo: i, hi: i, kind, leaf: Object.assign(leaf(1, 0, mul), {local})});
    } else {
      contexts[i] = classes;
      runs.push({lo: i, hi: i, kind: 0, leaf: Object.assign(leaf(0, table[i], 1), {local: classes++})});
    }
    leaves.push(runs[runs.length - 1].leaf);
    if (leaves.length > 200) return null;
  }
  let tree = runs[runs.length - 1].leaf;
  for (let r = runs.length - 2; r >= 0; r--) tree = split(3, runs[r].hi, tree, runs[r].leaf);
  return {kind: 'smooth', tree, leaves, classes, width: n, height: 1, stride: n, origin: 0, plane: table, minimum: 4, count: n, pieceValue: values, pieceDistance: new Int32Array(n), pieceContext: contexts};
}

function scanCompaction(words, width, height, channels, samples) {
  const tables = [], indices = [], all = words.subarray(0, width * height * 4);
  const order = keys => Int32Array.from([...keys].sort((a, b) => orderKey(a, samples) - orderKey(b, samples)));
  let maxLen = 0;
  for (let c = 0; c < channels; c++) {
    const found = captureDistinct(all, c, samples.exponentBits ? COMPACT_RAW_LIMIT : COMPACT_INT_LIMIT, order, new Int16Array(width * height));
    if (!found) return null;
    const {table, plane} = found, meta = metaTableModel(table);
    if (!meta) return null;
    tables.push({table, meta}); indices.push(plane);
    if (table.length > maxLen) maxLen = table.length;
  }
  return {tables, indices, maxLen};
}

function fillRctInline(planes, packed, stride, x0, y0, w, h, channels, rctType) {
  (kernelHooks.rct ?? ensured().rct ?? missing())(packed, stride, x0, y0, w, h, rctType, channels, planes);
}

function safeWriteCapture(w, models, ans, opts) {
  if (!ans) return writeCaptureStream(w, models, null, opts);
  const snapAt = w.at, snapAcc = w.acc, snapPending = w.pending;
  try { return writeCaptureStream(w, models, ans, opts); }
  catch (err) {
    if (err?.code !== 'JXL_MEMORY' || hostShort(err)) throw err;
    w.at = snapAt; w.acc = snapAcc; w.pending = snapPending;
    return writeCaptureStream(w, models, null, opts);
  }
}

const OPTS_T3 = {nodes: 47, samples: 8192, bins: 32, least: 64, charge: 16, properties: [15, 9, 10, 11, 12, 13, 14, 4, 5], predictors: [5, 6, 1, 2, 3, 4, 0]};
const OPTS_T5 = {nodes: 95, samples: 16384, bins: 48, least: 64, charge: 14, properties: [15, 9, 10, 11, 12, 13, 14, 4, 5, 6, 7], predictors: [5, 6, 1, 2, 3, 4, 0, 11, 7], referenceKinds: [0, 2]};
const OPTS_T7 = {nodes: 191, samples: 16384, bins: 56, least: 64, charge: 12, properties: [15, 9, 10, 11, 12, 13, 14, 4, 5, 6, 7, 8, 2, 3], predictors: [5, 6, 1, 2, 3, 4, 0, 7, 8, 9, 10, 11, 12, 13], referenceKinds: [0, 1, 2, 3]};
const OPTS_T9 = {nodes: 287, samples: 24576, bins: 64, clustered: false, least: 64, charge: 8, properties: [15, 9, 10, 11, 12, 13, 14, 4, 5, 6, 7, 8, 2, 3], predictors: [5, 6, 1, 2, 3, 4, 0, 7, 8, 9, 10, 11, 12, 13], referenceKinds: [0, 1, 2, 3]};

function learnRungs(effort, inlineTop, ranked) {
  const rungs = [];
  rungs.push({kind: 'wp', treeKey: 'wp', rctType: inlineTop, ans: effort >= 4});
  if (effort >= 3 && (effort < 4 || ranked[0] !== inlineTop)) rungs.push({kind: 'tree', treeKey: 't3', rctType: inlineTop, ans: effort >= 4, refs: false, opts: OPTS_T3});
  if (effort >= 4) rungs.push({kind: 'tree', treeKey: 't3', rctType: ranked[0], ans: true, refs: false, opts: OPTS_T3});
  if (effort >= 5) rungs.push({kind: 'tree', treeKey: 't5', rctType: ranked[0], ans: true, refs: true, opts: OPTS_T5});
  if (effort >= 7) rungs.push({kind: 'tree', treeKey: 't7', rctType: ranked[0], ans: true, refs: true, opts: OPTS_T7});
  if (effort >= 9) rungs.push({kind: 'tree', treeKey: 't9', rctType: ranked[0], ans: true, refs: true, opts: {...OPTS_T9, clustered: true}});
  return rungs;
}

function buildModels(planes, w, h, rung) {
  if (rung.kind === 'wp') return planes.map(p => weightedTrees(p, w, h, [0])[0]);
  return planes.map((p, c) => planeModel(p, w, h, rung.opts, rung.refs && c > 0 ? planes.slice(0, c).reverse() : []));
}

function encodeCompactedFrame(words, width, height, shape, samples, effort, bestLen, deepTools) {
  const {channels, colour, alpha} = shape, shift = width * height * channels > 2000000 ? 2 : 3, dim = 128 << shift, layout = groupLayout(width, height, dim), groups = layout.groupsX * layout.groupsY;
  const level = samples.level === 10 || samples.bitDepth > 12 || samples.exponentBits ? 10 : 5;
  const comp = scanCompaction(words, width, height, channels, samples);
  if (!comp) return null;
  const canRct = colour === 3 && comp.maxLen <= COMPACT_RCT_LIMIT;
  const colourTransform = deepTools?.transform ?? null;
  let inlineTop = 0, ranked = [0, 0], packedIdx = null;
  if (canRct) {
    packedIdx = new Int16Array(width * height * 4);
    const [i0, i1, i2] = comp.indices, i3 = alpha ? comp.indices[3] : null;
    for (let i = 0, p = 0; i < width * height; i++, p += 4) { packedIdx[p] = i0[i]; packedIdx[p + 1] = i1[i]; packedIdx[p + 2] = i2[i]; if (i3) packedIdx[p + 3] = i3[i]; }
    const allRanked = transformRanking ? transformRanking(packedIdx, width, height) : [6, 10, 0];
    inlineTop = allRanked.find(t => t === 0 || t === 6 || t === 10) ?? 6;
    ranked = colourTransform ? [allRanked[0] ?? inlineTop, allRanked[1] ?? inlineTop] : [inlineTop, allRanked.filter(t => t === 0 || t === 6 || t === 10)[1] ?? inlineTop];
  }
  const paletteTransforms = comp.tables.map((t, c) => ({type: 'palette', beginC: 2 * c, numC: 1, nbColors: t.table.length, nbDeltas: 0, predictor: 0}));
  const metaModels = comp.tables.map(t => t.meta).reverse();
  const rungs = learnRungs(effort, inlineTop, ranked).map(r => r.treeKey === 't9' && width * height * channels > 1200000 ? {...r, opts: OPTS_T9} : r);
  const planeCache = new Map(), modelCache = new Map();
  const groupPlanes = (rctType, x0, y0, gw, gh) => {
    const key = rctType + ':' + x0 + ',' + y0;
    if (planeCache.has(key)) return planeCache.get(key);
    const planes = Array.from({length: channels}, () => new Int16Array(gw * gh));
    if (canRct && rctType !== 0) fillRctInline(planes, packedIdx, width, x0, y0, gw, gh, channels, rctType);
    else for (let c = 0; c < channels; c++) {
      if (x0 === 0 && y0 === 0 && gw === width && gh === height) planes[c].set(comp.indices[c]);
      else for (let y = 0; y < gh; y++) planes[c].set(comp.indices[c].subarray((y0 + y) * width + x0, (y0 + y) * width + x0 + gw), y * gw);
    }
    planeCache.set(key, planes);
    return planes;
  };
  const cachedModels = (rctType, x0, y0, gw, gh, rung) => {
    const key = rctType + ':' + x0 + ',' + y0 + ':' + rung.treeKey;
    if (modelCache.has(key)) return modelCache.get(key);
    const m = buildModels(groupPlanes(rctType, x0, y0, gw, gh), gw, gh, rung);
    modelCache.set(key, m);
    return m;
  };
  let best = null;
  for (const rung of rungs) {
    const rctType = canRct ? rung.rctType : 0;
    const ans = rung.ans ? (deepTools?.ans ?? null) : null;
    const header = new BitWriter(256);
    writeImageHeader(header, width, height, colour, alpha, samples);
    writeModularFrameHeader(header, {alpha, shift});
    if (layout.single) {
      const imgModels = cachedModels(rctType, 0, 0, width, height, rung);
      const transforms = rctType ? [...paletteTransforms, {type: 'rct', beginC: channels, rctType}] : paletteTransforms;
      const global = new BitWriter(4096);
      global.write(1, 1); global.write(1, 1);
      safeWriteCapture(global, [...metaModels, ...imgModels], ans, {global: true, runs: true, transforms});
      const bytes = assembleCodestream(header, [global.finish()], level);
      if (bytes.length < bestLen && (!best || bytes.length < best.length)) { best = bytes; bestLen = bytes.length; }
    } else {
      const global = new BitWriter(256);
      global.write(1, 1); global.write(1, 1);
      safeWriteCapture(global, metaModels, ans, {global: true, runs: false, transforms: paletteTransforms});
      const sections = [global.finish()];
      for (let i = 0; i < layout.dcGroupsX * layout.dcGroupsY + 1; i++) sections.push(new Uint8Array(0));
      let total = sections[0].length, ok = true;
      for (let g = 0; g < groups; g++) {
        const [x0, y0, gw, gh] = groupRect(layout, width, height, g, dim);
        const imgModels = cachedModels(rctType, x0, y0, gw, gh, rung);
        const w = new BitWriter(4096);
        safeWriteCapture(w, imgModels, ans, {global: false, runs: true, transforms: rctType ? [{type: 'rct', beginC: 0, rctType}] : []});
        const sec = w.finish();
        if ((total += sec.length) >= bestLen) { ok = false; break; }
        sections.push(sec);
      }
      if (ok) {
        const bytes = assembleCodestream(header, sections, level);
        if (bytes.length < bestLen && (!best || bytes.length < best.length)) { best = bytes; bestLen = bytes.length; }
      }
    }
  }
  return best;
}

function encodeShiftedUint16Frame(words, width, height, shape, samples, effort, bestLen, deepTools) {
  if (samples.exponentBits || samples.bitDepth !== 16 || shape.colour !== 3) return null;
  const {alpha, channels} = shape, shift = width * height * channels > 2000000 ? 2 : 3, dim = 128 << shift, layout = groupLayout(width, height, dim), groups = layout.groupsX * layout.groupsY;
  const rungs = [
    ...(effort >= 2 ? [{treeKey: 'u3', nodes: 47, samples: 8192, bins: 32, ans: effort >= 4}] : []),
    ...(effort >= 5 ? [{treeKey: 'u5', nodes: 95, samples: 12288, bins: 44, ans: true}] : []),
    ...(effort >= 7 ? [{treeKey: 'u7', nodes: 191, samples: 16384, bins: 56, ans: true}] : []),
    ...(effort >= 9 ? [{treeKey: 'u9', nodes: 287, samples: 24576, bins: 64, clustered: width * height * channels <= 1200000, ans: true}] : []),
  ];
  const groupModelCache = new Map();
  let best = null;
  for (const rung of rungs) {
    const ans = rung.ans ? (deepTools?.ans ?? null) : null;
    const header = new BitWriter(256);
    writeImageHeader(header, width, height, 3, alpha, samples);
    writeModularFrameHeader(header, {alpha, shift});
    const codeGroup = (x0, y0, gw, gh, isGlobal) => {
      const cacheKey = x0 + ',' + y0 + ':' + rung.treeKey;
      let models = groupModelCache.get(cacheKey);
      if (!models) {
        const n = gw * gh, Y = new Int16Array(n), Co = new Int16Array(n), Cg = new Int16Array(n), A = alpha ? new Int16Array(n) : null;
        let maxY = 0, y0True = 0, maxA = 0, a0True = 0;
        for (let y = 0, p = 0; y < gh; y++) for (let x = 0, at = ((y0 + y) * width + x0) * 4; x < gw; x++, at += 4, p++) {
          const r = words[at], g = words[at + 1], b = words[at + 2], co = r - b, tmp = b + (co >> 1), cg = g - tmp, luma = tmp + (cg >> 1);
          if (co < -32768 || co > 32767 || cg < -32768 || cg > 32767) { groupModelCache.set(cacheKey, null); return null; }
          if (p === 0) y0True = luma;
          if (luma > maxY) maxY = luma;
          Co[p] = co; Cg[p] = cg; Y[p] = luma;
          if (alpha) { const av = words[at + 3]; if (p === 0) a0True = av; if (av > maxA) maxA = av; A[p] = av; }
        }
        const shiftY = maxY > 32767, shiftA = alpha && maxA > 32767;
        if (shiftY || shiftA) for (let y = 0, p = 0; y < gh; y++) for (let x = 0, at = ((y0 + y) * width + x0) * 4; x < gw; x++, at += 4, p++) {
          if (shiftY) { const r = words[at], g = words[at + 1], b = words[at + 2], co = r - b, tmp = b + (co >> 1), cg = g - tmp; Y[p] = (tmp + (cg >> 1)) - 32768; }
          if (shiftA) A[p] = words[at + 3] - 32768;
        }
        let mY = planeModel(Y, gw, gh, {nodes: rung.nodes, samples: rung.samples, bins: rung.bins, clustered: !!rung.clustered, least: 64, charge: 14,
          properties: shiftY ? SHIFT_PROPERTIES : [15, 9, 10, 11, 12, 13, 14, 4, 5, 6, 7, 8, 2, 3],
          predictors: shiftY ? SHIFT_PREDICTORS : [5, 6, 1, 2, 3, 4, 0, 7, 8, 9, 10, 11, 12, 13]});
        if (shiftY) { const pv = Int32Array.from(mY.pieceValue); pv[0] = packSigned(y0True); mY = {...mY, pieceValue: pv}; }
        const cOpts = {nodes: rung.nodes, samples: rung.samples, bins: rung.bins, clustered: !!rung.clustered, least: 64, charge: 14,
          properties: [15, 9, 10, 11, 12, 13, 14, 4, 5, 6, 7, 8, 2, 3], predictors: [5, 6, 1, 2, 3, 4, 0, 7, 8, 9, 10, 11, 12, 13], referenceKinds: [0, 1, 2, 3]};
        const mCo = planeModel(Co, gw, gh, cOpts, shiftY ? [] : [Y]);
        const mCg = planeModel(Cg, gw, gh, cOpts, shiftY ? [Co] : [Co, Y]);
        models = [mY, mCo, mCg];
        if (alpha) {
          let mA = planeModel(A, gw, gh, {nodes: rung.nodes, samples: rung.samples, bins: rung.bins, clustered: !!rung.clustered, least: 64, charge: 14,
            properties: shiftA ? SHIFT_PROPERTIES : [15, 9, 10, 11, 12, 13, 14, 4, 5, 6, 7, 8, 2, 3],
            predictors: shiftA ? SHIFT_PREDICTORS : [5, 6, 1, 2, 3, 4, 0, 7, 8, 9, 10, 11, 12, 13]});
          if (shiftA) { const pv = Int32Array.from(mA.pieceValue); pv[0] = packSigned(a0True); mA = {...mA, pieceValue: pv}; }
          models.push(mA);
        }
        groupModelCache.set(cacheKey, models);
      }
      if (!models) return null;
      const w = new BitWriter(4096);
      if (isGlobal) { w.write(1, 1); w.write(1, 1); }
      safeWriteCapture(w, models, ans, {global: isGlobal, runs: true, transforms: [{type: 'rct', beginC: 0, rctType: 6}]});
      return w.finish();
    };
    if (layout.single) {
      const sec = codeGroup(0, 0, width, height, true);
      if (!sec) continue;
      const bytes = assembleCodestream(header, [sec], 10);
      if (bytes.length < bestLen && (!best || bytes.length < best.length)) { best = bytes; bestLen = bytes.length; }
    } else {
      const global = new BitWriter(256);
      global.write(1, 1); global.write(1, 1);
      writeChannelHistograms(global, writeTree(global, leaf(0)), [new Uint32Array(ALPHABET)]);
      writeModularHeader(global, {transforms: []});
      const sections = [global.finish()];
      for (let i = 0; i < layout.dcGroupsX * layout.dcGroupsY + 1; i++) sections.push(new Uint8Array(0));
      let total = sections[0].length, ok = true;
      for (let g = 0; g < groups; g++) {
        const sec = codeGroup(...groupRect(layout, width, height, g, dim), false);
        if (!sec || (total += sec.length) >= bestLen) { ok = false; break; }
        sections.push(sec);
      }
      if (ok) {
        const bytes = assembleCodestream(header, sections, 10);
        if (bytes.length < bestLen && (!best || bytes.length < best.length)) { best = bytes; bestLen = bytes.length; }
      }
    }
  }
  return best;
}

export function encodeNativeModular(data, width, height, samples, shape, effort, floorBytes, deepTools = null, found = {}) {
  if (effort < 2 || samples.drop || shape.palette) return floorBytes;
  if (!kernelHooks.sampled) kernelHooks.ensure?.();
  const words = samples.sampleFormat === 'float32' && data instanceof Float32Array ? new Int32Array(data.buffer, data.byteOffset, data.length) : data;
  const compacted = encodeCompactedFrame(words, width, height, shape, samples, effort, floorBytes.length, deepTools);
  if (compacted && compacted.length < floorBytes.length) { found.compacted = true; return compacted; }
  const shifted = encodeShiftedUint16Frame(words, width, height, shape, samples, effort, floorBytes.length, deepTools);
  return shifted && shifted.length < floorBytes.length ? shifted : floorBytes;
}
