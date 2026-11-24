// SPDX-License-Identifier: MIT
import {leaf, split, intervals, writeTree, RESIDUAL_CONFIG} from './modular.mjs';
import {hybridToken, priceCode, prefixCodeBits, writePrefixCode} from './prefix.mjs';
import {captureCutHistogram, capturePlaneHash, capturePlanesEqual, captureQuantize, captureResiduals, captureTreeSample, captureTreeWalk} from './capture-kernels.mjs';
import {kernelHooks, ensured, missing, declined} from './kernel-hooks.mjs';
import {BitWriter, packSigned, floorLog2} from './bits.mjs';
import {transformKeys} from './rct-search.mjs';
import {positionsOf, letGoPositions} from './sample-positions.mjs';
import {unit, carried, journaling, journalFact, FACTS, PASSED} from './step-journal.mjs';

const PROPERTIES = [15, 9, 10, 11, 12, 13, 14, 4, 5, 6, 7, 8, 2, 3];
const PREDICTORS = [5, 6, 1, 2, 3, 4, 0, 11, 7, 10, 12];
const BINS = 32, SAMPLES = 65536;
const TREE_DEVICE = typeof __RAPIER_JXL_TEN_DEVICE__ === 'undefined' || __RAPIER_JXL_TEN_DEVICE__ === true;


function weighted(plane, w, h, wp = null) {
  if ((typeof __RAPIER_JXL_EFFORT_TEN__ === 'undefined' || __RAPIER_JXL_EFFORT_TEN__ === true) && wp) return wp.weighted(plane, w, h);
  const residuals = new Uint32Array(w * h), properties = new Int32Array(w * h);
  captureResiduals(plane, w, h, residuals, properties);
  return {residuals, properties};
}

const Q = 4096, RETAIN = 256, TRAIN = /* @__PURE__ */ Object.freeze({split: 4, splitToken: 16, msb: 1, lsb: 2});
let entropyTable = new Float64Array(1);
export function nlogQ12(count) {
  if (entropyTable.length > count) return entropyTable;
  const table = new Float64Array(count + 1); table.set(entropyTable);
  for (let n = Math.max(1, entropyTable.length); n <= count; n++) {
    const exponent = 31 - Math.clz32(n);
    let value = n * (1048576 / (1 << exponent)), fraction = 0;
    for (let bit = 2048; bit; bit >>= 1) {
      value = Math.floor(value * value / 1048576);
      if (value >= 2097152) { value = Math.floor(value / 2); fraction += bit; }
    }
    table[n] = n * (exponent * Q + fraction);
  }
  return entropyTable = table;
}
const entropyQ = (hist, table) => { let sum = 0, cost = 0; for (let s = 0; s < hist.length; s++) { sum += hist[s]; cost += table[hist[s]]; } return table[sum] - cost; };
const trainRaw = s => s < 16 ? 0 : ((s - 16) >> 3) + 1;
function distinctColumns(columns) {
  const seen = new Map(), unique = [];
  for (const column of columns) {
    if (!column.cuts.length) continue;
    const values = column.indices, n = values.length, stride = Math.max(1, n >>> 6);
    let hash = column.cuts.length;
    for (let i = 0; i < n; i += stride) hash = Math.imul(hash ^ values[i], 0x9e3779b1);
    hash = Math.imul(hash ^ values[n - 1], 0x9e3779b1);
    const bucket = seen.get(hash);
    if (bucket?.some(previous => { if (previous.cuts.length !== column.cuts.length) return false; const other = previous.indices; for (let i = 0; i < n; i++) if (values[i] !== other[i]) return false; return true; })) continue;
    unique.push(column);
    if (bucket) bucket.push(column); else seen.set(hash, [column]);
  }
  return unique;
}
const ONE_TREE_BITS = /* @__PURE__ */ Int32Array.from({length: 16}, (_, predictor) => {
  const writer = new BitWriter(64);
  writeTree(writer, leaf(predictor));
  return writer.bitLength;
});
const alphabetBits = last => last ? 5 + floorLog2(last) : 1;
const headerCount = {bits: 0, write(count) { this.bits += count; }};

export function histHeaderBits(freqs) {
  const code = priceCode(freqs);
  headerCount.bits = alphabetBits(code.alphabetSize - 1);
  writePrefixCode(headerCount, code);
  return headerCount.bits;
}

const branchFreqs = /* @__PURE__ */ new Uint32Array(33);
const branchToken = [0, 0, 0];
export function branchTreeBits(property, cut, high, low) {
  const threshold = split(property, cut, null, null).splitval;
  branchFreqs.fill(0);
  branchFreqs[0] = 8;
  let extra = 0;
  for (const value of [property + 1, packSigned(threshold), high, low]) {
    hybridToken(RESIDUAL_CONFIG, value, branchToken);
    branchFreqs[branchToken[0]]++;
    extra += branchToken[1];
  }
  const used = [];
  for (let i = 0; i < branchFreqs.length; i++) if (branchFreqs[i]) used.push(i);
  return 9 + alphabetBits(used[used.length - 1]) + prefixCodeBits(branchFreqs, used) + extra;
}
const LEAF_BITS = 24, HIST_BASE = 44, HIST_SYM = 5.5, SAMPLE_BIAS = 14;
function histStats(hist, table, rawPrice) {
  let total = 0, sumT = 0, raw = 0, used = 0;
  for (let s = 0; s < hist.length; s++) if (hist[s]) used++;
  const nzSym = new Uint8Array(used), nzVal = new Uint32Array(used);
  for (let s = 0, k = 0; s < hist.length; s++) {
    const v = hist[s];
    if (!v) continue;
    total += v; sumT += table[v]; raw += v * rawPrice[s];
    nzSym[k] = s; nzVal[k++] = v;
  }
  return {total, sumT, ent: table[total] - sumT, raw, bits: table[total] - sumT + raw, used, nzSym, nzVal};
}
const makeCluster = (hist, stats) => ({freq: Uint32Array.from(hist), total: stats.total, sumT: stats.sumT, ent: stats.ent, used: stats.used, members: 1});
function addToCluster(cluster, hist, table) {
  const freq = cluster.freq;
  for (let s = 0; s < hist.length; s++) {
    const v = hist[s];
    if (!v) continue;
    const cur = freq[s];
    if (!cur) cluster.used++;
    cluster.sumT += table[cur + v] - table[cur];
    freq[s] = cur + v; cluster.total += v;
  }
  cluster.ent = table[cluster.total] - cluster.sumT; cluster.members++;
}
function removeFromCluster(cluster, hist, table) {
  const freq = cluster.freq;
  for (let s = 0; s < hist.length; s++) {
    const v = hist[s];
    if (!v) continue;
    const cur = freq[s];
    cluster.sumT += table[cur - v] - table[cur];
    freq[s] = cur - v;
    if (cur === v) cluster.used--;
    cluster.total -= v;
  }
  cluster.ent = table[cluster.total] - cluster.sumT; cluster.members--;
}
function scoreClusterProposal(st, item, prop) {
  return st.store.scoreCluster(st, item, prop, (hiPred, loPred) => {
    const key = hiPred * st.kinds + loPred;
    let bothStats = prop.pairStats?.get(key);
    if (!bothStats) {
      const hBoth = st.scratchHist, alphabet = st.alphabet;
      const hh = (!TREE_DEVICE || st.arenaMode) ? st.store.histSlotSubarray(prop.hiSlot, hiPred) : prop.high[hiPred];
      const hl = (!TREE_DEVICE || st.arenaMode) ? st.store.histSlotSubarray(prop.loSlot, loPred) : prop.low[loPred];
      for (let s = 0; s < alphabet; s++) hBoth[s] = hh[s] + hl[s];
      bothStats = histStats(hBoth, st.table, st.rawPrice);
      (prop.pairStats ||= new Map()).set(key, bothStats);
    }
    return bothStats;
  });
}
function maybeMergeClusters(st, active) {
  const {clusters, table, scale, alphabet, histBase, histSym} = st;
  for (;;) {
    let bestDelta = 0, ba = -1, bb = -1;
    for (let a = 0; a < clusters.length; a++) {
      const ca = clusters[a], fa = ca.freq;
      for (let b = a + 1; b < clusters.length; b++) {
        const cb = clusters[b], fb = cb.freq;
        let sumT = 0, used = 0;
        for (let s = 0; s < alphabet; s++) { const v = fa[s] + fb[s]; if (v) { sumT += table[v]; used++; } }
        const delta = (table[ca.total + cb.total] - sumT - ca.ent - cb.ent) * scale + (histSym * (used - ca.used - cb.used) - histBase) * Q;
        if (delta < bestDelta) { bestDelta = delta; ba = a; bb = b; }
      }
    }
    if (ba < 0) break;
    const ca = clusters[ba], cb = clusters[bb];
    for (let s = 0; s < alphabet; s++) ca.freq[s] += cb.freq[s];
    ca.total += cb.total; ca.members += cb.members; ca.used = 0; ca.sumT = 0;
    for (let s = 0; s < alphabet; s++) if (ca.freq[s]) { ca.used++; ca.sumT += table[ca.freq[s]]; }
    ca.ent = table[ca.total] - ca.sumT;
    clusters.splice(bb, 1);
    for (const it of active) if (it.cluster === bb) it.cluster = ba; else if (it.cluster > bb) it.cluster--;
    st.epoch++;
  }
}
function guardReferences(tree, predictor, nextLocal) {
  const nodes = [tree]; let references = false;
  for (const node of nodes) if (node.left) { references ||= node.property >= 16; nodes.push(node.left, node.right); }
  if (!references) return tree;
  const prune = (node, xlo = 1, xhi = Infinity, ylo = 1, yhi = Infinity) => {
    if (!node.left) return node;
    const cut = node.splitval, axis = node.property;
    if (axis === 2 && cut < ylo || axis === 3 && cut < xlo) return prune(node.left, xlo, xhi, ylo, yhi);
    if (axis === 2 && cut >= yhi || axis === 3 && cut >= xhi) return prune(node.right, xlo, xhi, ylo, yhi);
    const left = prune(node.left, axis === 3 ? cut + 1 : xlo, xhi, axis === 2 ? cut + 1 : ylo, yhi);
    const right = prune(node.right, xlo, axis === 3 ? cut : xhi, ylo, axis === 2 ? cut : yhi);
    return left === node.left && right === node.right ? node : {...node, left, right};
  };
  const edgeX = Object.assign(leaf(predictor), {local: nextLocal}), edgeY = Object.assign(leaf(predictor), {local: nextLocal + 1});
  return split(2, 0, split(3, 0, prune(tree), edgeX), edgeY);
}
const sameRecord = (best, r, columns) => best ? r !== null && columns.indexOf(best.column) === r.column && best.bin === r.bin && best.lo.selected === r.loSelected &&
  best.hi.selected === r.hiSelected && best.lo.bits === r.loBits && best.hi.bits === r.hiBits : r === null;
const releaseProposalSlots = (store, prop) => {
  if (prop && prop.loSlot !== undefined) { store.freeHistSlot(prop.loSlot); store.freeHistSlot(prop.hiSlot); prop.loSlot = prop.hiSlot = undefined; }
};
function proposeSplit(st, item, active = null) {
  const {options, candidates, count, population, store} = st, arenaMode = !TREE_DEVICE || st.arenaMode;
  const total = item.length;
  if (!st.columns.length || item.depth >= options.depth || total < 64 || item.ownBits === 0) return null;
  const retainMin = Math.max(RETAIN, count >>> 4);
  const ownKeep = count >= RETAIN && total >= retainMin;
  if (ownKeep && !item.reuseParent && active) {
    const probe = store.allocate(false);
    if (probe) store.release(probe);
    else {
      let victim = null, victimLen = total;
      for (let i = 0; i < active.length; i++) {
        const it = active[i], len = it.length;
        if (it !== item && it.handle && !it.handle.transient && len < victimLen) { victim = it; victimLen = len; }
      }
      if (victim) { store.release(victim.handle); victim.handle = null; }
    }
  }
  const keep = {save: ownKeep || (count >= RETAIN && !!item.forSibling), transient: !ownKeep && !!item.forSibling, forSibling: !!item.forSibling,
    parent: item.parent || null, sibling: item.sibling || null, reuseParent: !!item.reuseParent, handle: null};
  let best;
  if (arenaMode) {
    const clusteredActive = ((typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || !__RAPIER_JXL_CAPTURE_PHOTO__) && !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && (typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || !__RAPIER_JXL_UPLOAD__) && (typeof __RAPIER_JXL_JPEG__ === 'undefined' || !__RAPIER_JXL_JPEG__)) && st.clustered;
    const maxPrice = clusteredActive ? item.ownBits : item.ownBits - Math.max(0, Math.floor((options.charge || 0) * Q * count / population) - 1);
    best = store.proposeArena(item.offset, total, item.histSlot, item.ownBits, keep, maxPrice);
  } else {
    const members = item.ids, answer = item.device;
    best = answer === undefined || item.audit ? store.propose(members, item.hist, item.ownBits, keep)
      : answer instanceof Uint32Array ? store.finish(members, item.hist, item.ownBits, answer) : item.taken ?? store.split(members, item.hist, item.ownBits, answer);
    if (item.audit && !sameRecord(best, answer, st.columns)) st.auditFailed = true;
    else if (item.audit && item.taken) best = item.taken;
  }
  item.parent = item.sibling = null; item.forSibling = item.reuseParent = false; item.device = item.audit = item.taken = undefined;
  item.handle = keep.handle;
  if (!best || best.gain <= 0) { releaseProposalSlots(store, best); return null; }
  if (((typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || !__RAPIER_JXL_CAPTURE_PHOTO__) && !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && (typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || !__RAPIER_JXL_UPLOAD__) && (typeof __RAPIER_JXL_JPEG__ === 'undefined' || !__RAPIER_JXL_JPEG__)) && st.clustered) {
    best.pairStats = null;
    scoreClusterProposal(st, item, best);
    return best;
  }
  const hiHist = arenaMode ? store.histSlotSubarray(best.hiSlot, best.hi.selected) : best.high[best.hi.selected];
  const loHist = arenaMode ? store.histSlotSubarray(best.loSlot, best.lo.selected) : best.low[best.lo.selected];
  let ownHdr = item.ownHdr;
  if (ownHdr === undefined) {
    const ownHist = arenaMode ? store.histSlotSubarray(item.histSlot, item.choice.selected) : item.hist[item.choice.selected];
    ownHdr = item.ownHdr = histHeaderBits(ownHist);
  }
  const hiHdr = histHeaderBits(hiHist), loHdr = histHeaderBits(loHist);
  const treeDiff = branchTreeBits(best.column.property, best.column.cuts[best.bin],
    candidates[best.hi.selected], candidates[best.lo.selected]) - ONE_TREE_BITS[candidates[item.choice.selected]];
  const signal = Math.max(0, treeDiff + 8 + hiHdr + loHdr - ownHdr);
  const score = best.gain * population - (signal + options.charge) * Q * count;
  if (score <= 0) { releaseProposalSlots(store, best); return null; }
  best.hiHdr = hiHdr; best.loHdr = loHdr;
  best.score = score;
  return best;
}
function* learnSampleSteps(quantized, symbolSets, candidates, population, options) {
  const grown = yield* sampleSteps(quantized, symbolSets, candidates, population, options);
  let stands = true;
  try { yield* growSteps(grown); }
  finally { if (((typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || !__RAPIER_JXL_CAPTURE_PHOTO__) && !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && (typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || !__RAPIER_JXL_UPLOAD__) && (typeof __RAPIER_JXL_JPEG__ === 'undefined' || !__RAPIER_JXL_JPEG__)) && grown.st.samples) stands = yield* options.device(grown.st, null); }
  if (((typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || !__RAPIER_JXL_CAPTURE_PHOTO__) && !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && (typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || !__RAPIER_JXL_UPLOAD__) && (typeof __RAPIER_JXL_JPEG__ === 'undefined' || !__RAPIER_JXL_JPEG__)) && !stands) { const again = sampleTree(quantized, symbolSets, candidates, population, {...options, device: null}); growTree(again); return treeOf(again); }
  return treeOf(grown);
}
function drive(steps) { let step; while (!(step = steps.next(null)).done); return step.value; }
const sampleTree = (...args) => drive(sampleSteps(...args));
function* sampleSteps(quantized, symbolSets, candidates, population, options, saved = null) {
  const columns = distinctColumns(quantized), count = symbolSets[0].length, table = nlogQ12(count), clustered = ((typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || !__RAPIER_JXL_CAPTURE_PHOTO__) && !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && (typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || !__RAPIER_JXL_UPLOAD__) && (typeof __RAPIER_JXL_JPEG__ === 'undefined' || !__RAPIER_JXL_JPEG__)) && !!options.clustered;
  let alphabet = 1; for (const symbols of symbolSets) for (let i = 0; i < symbols.length; i++) if (symbols[i] >= alphabet) alphabet = symbols[i] + 1;
  const kinds = candidates.length, rawPrice = Float64Array.from({length: alphabet}, (_, s) => trainRaw(s) * Q);
  const reserve = quantized.some(c => c.property >= 16) ? 2 : 0, scale = population / count;
  const store = (kernelHooks.sampled ?? ensured().sampled ?? missing())(count, kinds, alphabet, columns, symbolSets, table, rawPrice);
  if (!store) throw declined('sampled');
  const device = ((typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || !__RAPIER_JXL_CAPTURE_PHOTO__) && !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && (typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || !__RAPIER_JXL_UPLOAD__) && (typeof __RAPIER_JXL_JPEG__ === 'undefined' || !__RAPIER_JXL_JPEG__)) && TREE_DEVICE && typeof options.device === 'function' && typeof store.split === 'function' ? options.device : null;
  const arenaMode = !TREE_DEVICE || !device;
  const bias = options.sampleBias ?? SAMPLE_BIAS;
  const st = {options, clustered, device, arenaMode, samples: device ? {count, kinds, alphabet, columns, symbolSets, table, rawPrice, cells: store.cells} : null, kinds, alphabet, table, rawPrice, columns, symbolSets, candidates, count, population, scale, store,
    clusters: null, maxClusters: Math.min(options.clusters ?? 192, 255 - reserve), epoch: 0,
    histBase: options.histBase ?? HIST_BASE, histSym: options.histSym ?? HIST_SYM,
    splitCost: ((options.leafBits ?? LEAF_BITS) + options.charge + bias * (1 - count / population) * scale) * Q,
    scratchHist: clustered ? new Uint32Array(alphabet) : null,
    remCluster: clustered ? {freq: new Uint32Array(alphabet), total: 0, sumT: 0, ent: 0, used: 0} : null};
  if (!(typeof __RAPIER_JXL_UNSTEPPED__ !== 'undefined' && __RAPIER_JXL_UNSTEPPED__ === true) && saved && store.initArena) {
    st.clusters = saved.clusters; st.epoch = saved.epoch;
    const restored = saved.active.map(item => ({...item, proposal: item.proposal && {...item.proposal, column: columns[item.proposal.column], k: item.proposal.column}}));
    store.initArena(options.leaves);
    store.loadArenaState(restored);
    return {...saved, st, reserve, active: restored};
  }
  const cost = hist => { let bits = entropyQ(hist, table); for (let s = 0; s < hist.length; s++) bits += hist[s] * rawPrice[s]; return bits; };
  const rootSlot = store.initArena ? store.initArena(arenaMode ? options.leaves : 1) : -1;
  const terminalHist = rootSlot < 0 ? store.rootHistograms() : null;
  const histogram = c => terminalHist ? terminalHist[c] : store.histSlotSubarray(rootSlot, c);
  let selected = 0, bits = cost(histogram(0));
  for (let c = 1; c < kinds; c++) {
    const next = cost(histogram(c));
    if (next < bits) { selected = c; bits = next; }
  }
  const predictor = candidates[selected], root = leaf(predictor);
  if (terminalHist) {
    root.local = 0;
    if (options.prefix) options.prefix.tree = null;
    return {st, reserve, active: [], root, predictor, leaves: 1, done: true};
  }
  const rootStats = clustered ? histStats(histogram(selected), table, rawPrice) : null;
  st.clusters = clustered ? [makeCluster(histogram(selected), rootStats)] : null;
  const first = {node: root, length: count, choice: {selected, bits}, ownBits: bits, curStats: rootStats, cluster: 0, depth: 0};
  if (arenaMode) { first.offset = 0; first.histSlot = rootSlot; }
  else {
    first.ids = store.readArenaMembers(0, count);
    first.hist = store.readArenaHistograms(rootSlot);
  }
  const active = [first];
  if (TREE_DEVICE && device) yield* device(st, active);
  first.proposal = proposeSplit(st, first, active);
  return {st, reserve, active, root, predictor, leaves: 1, done: false};
}
const growTree = (grown, splits) => drive(growSteps(grown, splits));
function copyTree(node, locals = null) {
  return node.left ? {...node, left: copyTree(node.left, locals), right: copyTree(node.right, locals)}
    : {...node, local: locals ? locals.get(node) : node.local};
}
function snapshotPrefix({active, root, predictor}, prefix) {
  const locals = new Map(active.map((item, i) => [item.node, i]));
  const tree = guardReferences(copyTree(root, locals), predictor, active.length);
  prefix.tree = tree.left ? tree : null;
}
function* growSteps(grown, splits = Infinity) {
  if (grown.done) return true;
  const {st, reserve, active} = grown, {options, candidates, store, clusters, table} = st, arenaMode = !TREE_DEVICE || st.arenaMode;
  const clustered = ((typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || !__RAPIER_JXL_CAPTURE_PHOTO__) && !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && (typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || !__RAPIER_JXL_UPLOAD__) && (typeof __RAPIER_JXL_JPEG__ === 'undefined' || !__RAPIER_JXL_JPEG__)) && st.clustered;
  const retainMin = Math.max(RETAIN, st.count >>> 4);
  const prefix = options.prefix;
  for (let made = 0; grown.leaves < options.leaves - reserve; made++) {
    if (prefix && prefix.tree === undefined && grown.leaves >= prefix.leaves - reserve) snapshotPrefix(grown, prefix);
    if (made === splits) return false;
    let chosen = -1;
    for (;;) {
      chosen = -1;
      for (let i = 0; i < active.length; i++) {
        const p = active[i].proposal;
        if (p && p.score > 0 && (chosen < 0 || p.score > active[chosen].proposal.score)) chosen = i;
      }
      if (chosen < 0 || !clustered || active[chosen].proposal.epoch === st.epoch) break;
      scoreClusterProposal(st, active[chosen], active[chosen].proposal);
    }
    if (prefix && prefix.tree === undefined && (chosen < 0 || active[chosen].proposal.score <= prefix.extraCharge * Q * st.count)) snapshotPrefix(grown, prefix);
    if (chosen < 0) break;
    const item = active[chosen], proposal = item.proposal;
    const highChoice = clustered ? {selected: proposal.hiChoice.pred} : proposal.hi;
    const lowChoice = clustered ? {selected: proposal.loChoice.pred} : proposal.lo;
    const left = leaf(candidates[highChoice.selected]), right = leaf(candidates[lowChoice.selected]);
    Object.assign(item.node, split(proposal.column.property, proposal.column.cuts[proposal.bin], left, right));
    const high = {node: left, choice: highChoice, ownBits: proposal.hi.bits, ownHdr: proposal.hiHdr, depth: item.depth + 1};
    const low = {node: right, choice: lowChoice, ownBits: proposal.lo.bits, ownHdr: proposal.loHdr, depth: item.depth + 1};
    const children = [high, low];
    if (arenaMode) {
      const below = store.partitionArena(item.offset, item.length, proposal.k ?? st.columns.indexOf(proposal.column), proposal.bin);
      high.offset = item.offset + below; high.length = item.length - below; high.histSlot = proposal.hiSlot;
      low.offset = item.offset; low.length = below; low.histSlot = proposal.loSlot;
    } else {
      high.ids = proposal.highIds; high.length = high.ids.length; high.hist = proposal.high;
      low.ids = proposal.lowIds; low.length = low.ids.length; low.hist = proposal.low;
    }
    if (clustered) {
      const {hiChoice, loChoice, shared} = proposal;
      const g0 = item.cluster, c0 = clusters[g0];
      let freed = -1;
      const ownSelHist = arenaMode ? store.histSlotSubarray(item.histSlot, item.choice.selected) : item.hist[item.choice.selected];
      if (c0.members === 1) freed = g0;
      else removeFromCluster(c0, ownSelHist, table);
      const alloc = (h, stats) => {
        const cl = makeCluster(h, stats);
        if (freed >= 0) { const s = freed; freed = -1; clusters[s] = cl; return s; }
        clusters.push(cl); return clusters.length - 1;
      };
      const hiSelHist = arenaMode ? store.histSlotSubarray(proposal.hiSlot, hiChoice.pred) : proposal.high[hiChoice.pred];
      const loSelHist = arenaMode ? store.histSlotSubarray(proposal.loSlot, loChoice.pred) : proposal.low[loChoice.pred];
      const hiStats = histStats(hiSelHist, table, st.rawPrice);
      const loStats = histStats(loSelHist, table, st.rawPrice);
      let gHi, gLo;
      if (shared) {
        if (hiChoice.cl === -1) { gHi = gLo = alloc(hiSelHist, hiStats); addToCluster(clusters[gHi], loSelHist, table); }
        else { gHi = gLo = hiChoice.cl; addToCluster(clusters[gHi], hiSelHist, table); addToCluster(clusters[gLo], loSelHist, table); }
      } else {
        gHi = hiChoice.cl === -1 ? alloc(hiSelHist, hiStats) : (addToCluster(clusters[hiChoice.cl], hiSelHist, table), hiChoice.cl);
        gLo = loChoice.cl === -1 ? alloc(loSelHist, loStats) : (addToCluster(clusters[loChoice.cl], loSelHist, table), loChoice.cl);
      }
      if (freed >= 0) {
        clusters.splice(freed, 1);
        if (gHi > freed) gHi--;
        if (gLo > freed) gLo--;
        for (const it of active) if (it !== item && it.cluster > freed) it.cluster--;
      }
      st.epoch++;
      high.curStats = hiStats; high.cluster = gHi;
      low.curStats = loStats; low.cluster = gLo;
    }
    if (arenaMode) { store.freeHistSlot(item.histSlot); item.histSlot = undefined; proposal.loSlot = proposal.hiSlot = undefined; }
    if (grown.leaves + 1 < options.leaves - reserve) {
      const [small, large] = high.length <= low.length ? children : [low, high];
      const smallLen = small.length, largeLen = large.length;
      if (((typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || !__RAPIER_JXL_CAPTURE_PHOTO__) && !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && (typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || !__RAPIER_JXL_UPLOAD__) && (typeof __RAPIER_JXL_JPEG__ === 'undefined' || !__RAPIER_JXL_JPEG__)) && st.device) yield* st.device(st, [small, large]);
      if (item.handle && (!arenaMode || smallLen >= 1024)) small.forSibling = true;
      small.proposal = proposeSplit(st, small, active);
      if (item.handle && large.depth < options.depth && largeLen >= 64 && large.ownBits > 0) {
        if (small.handle) {
          large.parent = item.handle; large.sibling = small.handle; large.reuseParent = true;
        } else if (arenaMode && largeLen >= 1024) {
          store.peelArena(item.handle, small.offset, smallLen, small.histSlot);
          large.parent = item.handle; large.sibling = null; large.reuseParent = true;
        }
      }
      large.proposal = proposeSplit(st, large, active);
      if (large.handle && large.handle === item.handle) item.handle = null;
      if (small.handle && (small.handle.transient || smallLen < retainMin || !small.proposal)) { store.release(small.handle); small.handle = null; }
      if (large.handle && !large.proposal) { store.release(large.handle); large.handle = null; }
    } else if (arenaMode) {
      store.freeHistSlot(children[0].histSlot); children[0].histSlot = undefined;
      store.freeHistSlot(children[1].histSlot); children[1].histSlot = undefined;
    }
    if (item.handle) { store.release(item.handle); item.handle = null; }
    active.splice(chosen, 1, ...children); grown.leaves++;
    if (clustered && (grown.leaves & 31) === 0) maybeMergeClusters(st, active);
  }
  if (prefix && prefix.tree === undefined) snapshotPrefix(grown, prefix);
  if (arenaMode) for (const it of active) { releaseProposalSlots(store, it.proposal); if (it.histSlot !== undefined) { store.freeHistSlot(it.histSlot); it.histSlot = undefined; } }
  grown.done = true;
  return true;
}
function treeState(grown) {
  if (grown.done) return {done: true, tree: treeOf(grown)};
  const {st, active, root, predictor, leaves, done} = grown, {store} = st;
  for (const item of active) if (item.handle) { store.release(item.handle); item.handle = null; }
  return {root, predictor, leaves, done, clusters: st.clusters, epoch: st.epoch, active: active.map(item => {
    const ids = store.readArenaMembers(item.offset, item.length);
    const hist = store.readArenaHistograms(item.histSlot);
    let savedProp = null;
    if (item.proposal) {
      const {pairStats, loSlot, hiSlot, hiHdr, loHdr, k, lowIds, highIds, ...rest} = item.proposal;
      savedProp = {...rest, low: store.readArenaHistograms(loSlot), high: store.readArenaHistograms(hiSlot),
        column: k ?? st.columns.indexOf(item.proposal.column)};
    }
    return {node: item.node, ids, hist, choice: item.choice, ownBits: item.ownBits, curStats: item.curStats, cluster: item.cluster, depth: item.depth, proposal: savedProp};
  })};
}
function treeOf({st, active, root, predictor}) {
  if (!active.length) return root;
  for (const item of active) if (item.handle) st.store.release(item.handle);
  if (((typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || !__RAPIER_JXL_CAPTURE_PHOTO__) && !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && (typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || !__RAPIER_JXL_UPLOAD__) && (typeof __RAPIER_JXL_JPEG__ === 'undefined' || !__RAPIER_JXL_JPEG__)) && st.clustered) {
    maybeMergeClusters(st, active);
    for (const item of active) item.node.local = item.cluster;
  } else active.forEach((item, i) => { item.node.local = i; });
  return guardReferences(root, predictor, ((typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || !__RAPIER_JXL_CAPTURE_PHOTO__) && !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && (typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || !__RAPIER_JXL_UPLOAD__) && (typeof __RAPIER_JXL_JPEG__ === 'undefined' || !__RAPIER_JXL_JPEG__)) && st.clustered ? st.clusters.length : active.length);
}
function* learnSampledSteps(plane, w, h, options = {}, answer, entry = null) {
  const {depth = 24, predictors = PREDICTORS, clusters = 192, charge = 32, leafBits, histBase, histSym} = options, sampled = sampleColumns(plane, w, h, options, answer, entry);
  let {leaves = 60} = options;
  if (!sampled) return null;
  const clustered = ((typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || !__RAPIER_JXL_CAPTURE_PHOTO__) && !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && (typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || !__RAPIER_JXL_UPLOAD__) && (typeof __RAPIER_JXL_JPEG__ === 'undefined' || !__RAPIER_JXL_JPEG__)) && (!!options.clustered || leaves > 255);
  if (!((typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || !__RAPIER_JXL_CAPTURE_PHOTO__) && !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && (typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || !__RAPIER_JXL_UPLOAD__) && (typeof __RAPIER_JXL_JPEG__ === 'undefined' || !__RAPIER_JXL_JPEG__))) leaves = Math.min(leaves, 255);
  const tree = yield* learnSampleSteps(sampled.quantized, sampled.symbolSets, predictors, w * h, {leaves, depth, clustered, clusters, charge, leafBits, histBase, histSym, device: options.device, prefix: options.prefix});
  return tree.left ? tree : null;
}
function sampleColumns(plane, w, h, {samples = SAMPLES, bins = 32, properties: wanted = PROPERTIES, predictors = PREDICTORS,
  references = [], referenceKinds = [0, 1, 2, 3], least = 4096} = {}, answer, entry = null) {
  const n = w * h;
  if (n < least) return null;
  const {residuals, properties: wp} = answer, positions = positionsOf(n, samples), m = positions.length;
  const properties = [...wanted];
  for (let r = 0; r < references.length; r++) for (const kind of referenceKinds) properties.push(16 + 4 * r + kind);
  const canShare = entry && plane instanceof Int16Array && n <= 1048576;
  if (!canShare) {
    return captureTreeSample(plane, w, h, positions, Int32Array.from(properties), Int32Array.from(predictors), residuals, wp, references, bins);
  }
  let known = entry.sampledAt.get(m);
  if (!known) entry.sampledAt.set(m, known = []);
  const missing = [...new Set(predictors)].filter(predictor => !known[predictor]);
  const sampled = captureTreeSample(plane, w, h, positions, Int32Array.from(properties), Int32Array.from(missing), residuals, wp, references, bins);
  for (let i = 0; i < missing.length; i++) known[missing[i]] = sampled.symbolSets[i];
  return {quantized: sampled.quantized, symbolSets: Array.from(predictors, predictor => known[predictor])};
}
export function* sharedTreeSteps(planes, options) {
  const {bins = 32, predictors = PREDICTORS, depth = 24, clusters = 192, charge = 32, leaves = 60, leafBits, histBase, histSym, regionSamples} = options;
  const population = planes.reduce((n, p) => n + p.w * p.h, 0);
  const sampled = planes.map(({plane, w, h, answer, references}) => captureTreeSample(plane, w, h,
    positionsOf(w * h, regionSamples ? Math.max(1, Math.round(regionSamples * (w * h) / population)) : w * h),
    Int32Array.from([...PROPERTIES, ...references.flatMap((_, r) => [0, 1, 2, 3].map(kind => 16 + 4 * r + kind))]), Int32Array.from(predictors), answer.residuals, answer.properties, references));
  const join = (arrays, Type) => { const out = new Type(arrays.reduce((n, a) => n + a.length, 0)); let at = 0; for (const a of arrays) { out.set(a, at); at += a.length; } return out; };
  const ids = join(sampled.map((s, i) => new Int32Array(s.symbolSets[0].length).fill(planes[i].id)), Int32Array);
  const quantized = [{property: 1, ...captureQuantize(ids, 256)}];
  for (let k = 0; k < sampled[0].columns.length; k++) {
    const {property} = sampled[0].columns[k], values = join(sampled.map(s => s.columns[k].values), Int32Array);
    for (const s of sampled) s.columns[k] = null;
    quantized.push({property, ...captureQuantize(values, bins)});
  }
  const symbolSets = sampled[0].symbolSets.map((_, k) => join(sampled.map(s => s.symbolSets[k]), Uint8Array));
  sampled.length = 0;
  return yield* learnSampleSteps(quantized, symbolSets, predictors, population, {leaves, depth, clustered: true, clusters, charge, leafBits, histBase, histSym, sampleBias: options.sampleBias, device: options.device});
}
export function sampleTreePrice(plane, w, h, options = {}, answer = null, references = []) {
  let allZero = true;
  for (let i = 0; i < plane.length; i++) if (plane[i] !== 0) { allZero = false; break; }
  if (allZero) return 0;
  const norm = {...normalizeLearnOptions(w, h, {...options, references, clustered: false}), clustered: false, device: null};
  answer ||= weighted(plane, w, h, norm.wp);
  const sampled = sampleColumns(plane, w, h, norm, answer);
  if (!sampled) return 0;
  const grown = sampleTree(sampled.quantized, sampled.symbolSets, norm.predictors, w * h, norm);
  growTree(grown);
  for (const item of grown.active) if (item.handle) grown.st.store.release(item.handle);
  const {scale} = grown.st;
  let bits = grown.leaves * 20 * Q;
  for (const item of grown.active) bits += item.ownBits * scale + (item.ownHdr ?? 32) * Q;
  return bits / Q;
}
export const streamTreeOf = (tree, id) => tree.left ? tree.property === 1 ? streamTreeOf(id > tree.splitval ? tree.left : tree.right, id)
  : split(tree.property, tree.splitval, streamTreeOf(tree.left, id), streamTreeOf(tree.right, id)) : tree;

const gradient = (w, n, nw) => Math.max(Math.min(w, n), Math.min(Math.max(w, n), w + n - nw));
export {rankingPositions} from './sample-positions.mjs';
export function transformRanking(rgba, width, height, samples = 32768) {
  const positions = positionsOf(width * height, samples), count = positions.length, table = nlogQ12(count);
  const gathered = samples === 32768 ? journalFact(rgba, FACTS)?.ranking?.() : null, source = gathered ?? rgba;
  const run = count * 4, planes = new Int16Array(18 * run);
  for (let k = 0; k < count; k++) {
    const i = positions[k], y = (i / width) | 0, x = i - y * width;
    const w = x ? i - 1 : y ? i - width : -1, n = y ? i - width : w, nw = x && y ? i - width - 1 : w;
    for (let j = 0; j < 4; j++) {
      const at = j === 0 ? i : j === 1 ? w : j === 2 ? n : nw;
      if (at < 0) continue;
      const p = gathered ? (k * 4 + j) * 4 : at * 4, r = source[p], g = source[p + 1], b = source[p + 2], o = k * 4 + j;
      const mr = (g + b) >> 1, mg = (r + b) >> 1, mb = (r + g) >> 1;
      planes[o] = r; planes[run + o] = g; planes[2 * run + o] = b;
      planes[4 * run + o] = r - g; planes[5 * run + o] = r - b; planes[6 * run + o] = g - r;
      planes[8 * run + o] = g - b; planes[9 * run + o] = b - r; planes[10 * run + o] = b - g;
      planes[12 * run + o] = r - mr; planes[13 * run + o] = g - mg; planes[14 * run + o] = b - mb;
      planes[15 * run + o] = mr + ((r - mr) >> 1); planes[16 * run + o] = mg + ((g - mg) >> 1); planes[17 * run + o] = mb + ((b - mb) >> 1);
    }
  }
  const prices = new Float64Array(18), hist = new Uint32Array(128);
  for (let key = 0; key < 18; key++) {
    if (key === 3 || key === 7 || key === 11) continue;
    hist.fill(0);
    let raw = 0;
    for (let o = key * run, end = o + run; o < end; o += 4) {
      const c = planes[o], w = planes[o + 1], n = planes[o + 2], nw = planes[o + 3];
      const v = packSigned(c - gradient(w, n, nw));
      if (v < 16) hist[v]++;
      else { const top = 31 - Math.clz32(v), below = v - (1 << top); hist[16 + (((top - 4) << 3) | ((below >> (top - 1)) << 2) | (below & 3))]++; raw += top - 3; }
    }
    let sum = 0, cost = 0;
    for (let s = 0; s < hist.length; s++) { sum += hist[s]; cost += table[hist[s]]; }
    prices[key] = table[sum] - cost + raw * 4096;
  }
  const ranked = Array.from({length: 42}, (_, type) => ({type, price: transformKeys(type).reduce((n, key) => n + prices[key], 0)}));
  ranked.sort((a, b) => a.price - b.price || a.type - b.type);
  return ((typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || !__RAPIER_JXL_CAPTURE_PHOTO__) && !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true)) ? Object.assign(ranked.map(entry => entry.type), {bits: ranked[0].price / 4096 / count}) : ranked.map(entry => entry.type);
}


const fitted = (nodes, w, h) => Math.min(nodes, 255 + Math.floor(w * h / 16));
function gradientPassesInt32(plane, w, h) {
  if (!(plane instanceof Int32Array || plane instanceof Uint32Array)) return false;
  for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) {
    const left = x ? plane[i - 1] : y ? plane[i - w] : 0, top = y ? plane[i - w] : left, nw = x && y ? plane[i - w - 1] : left;
    const value = left + top - nw;
    if (value !== (value | 0)) return true;
  }
  return false;
}
function normalizeLearnOptions(w, h, {nodes = 119, samples = SAMPLES, bins = BINS, properties = PROPERTIES, predictors = PREDICTORS,
  references = [], referenceKinds = [0, 1, 2, 3], least = 4096, depth = 24, charge = 32, leafBits, histBase, histSym, clustered = false, clusters = 192, wp = null, device = null} = {}) {
  nodes = fitted(nodes, w, h);
  const count = (nodes + 1) >> 1, deep = ((typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || !__RAPIER_JXL_CAPTURE_PHOTO__) && !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && (typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || !__RAPIER_JXL_UPLOAD__) && (typeof __RAPIER_JXL_JPEG__ === 'undefined' || !__RAPIER_JXL_JPEG__));
  return {nodes, leaves: deep ? count : Math.min(count, 255), depth, samples, bins, properties, predictors, references, referenceKinds, least, charge, leafBits, histBase, histSym, clustered: deep && (clustered || count > 255), clusters, wp, device};
}
export const learnTree = (...args) => drive(treeSteps(...args));
function* treeSteps(plane, w, h, raw, answer = null, entry = null, prefixEntry = null) {
  let allZero = true;
  for (let i = 0; i < plane.length; i++) if (plane[i] !== 0) { allZero = false; break; }
  if (allZero) return null;
  const options = normalizeLearnOptions(w, h, raw);
  answer ||= entry ? entry.answer : weighted(plane, w, h, options.wp);
  if (options.properties.includes(9) && gradientPassesInt32(plane, w, h)) options.properties = options.properties.filter(p => p !== 9);
  const prefixPair = prefixEntry && !journaling() && !options.clustered && !options.device &&
    options.samples === 65536 && options.bins === 128 && options.depth === 12 && w * h >= Math.max(64, options.least) &&
    Number.isSafeInteger(48 * Q * Math.min(w * h, options.samples) * (w * h));
  const makePrefix = prefixPair && options.leaves === 128 && options.charge === 2;
  const usePrefix = prefixPair && options.leaves === 64 && options.charge === 8;
  let tree, key;
  if (makePrefix || usePrefix) {
    key = JSON.stringify([options.leafBits, options.histBase, options.histSym, options.clusters,
      Array.from(options.predictors), Array.from(options.properties), Array.from(options.referenceKinds)]);
    const kept = prefixEntry.prefix;
    if (usePrefix && kept && kept.key === key && kept.references.length === options.references.length &&
        options.references.every((ref, i) => capturePlanesEqual(kept.references[i], ref))) {
      tree = kept.tree && copyTree(kept.tree);
    }
  }
  if (tree === undefined) {
    if (makePrefix) options.prefix = {leaves: 64, extraCharge: 6, tree: undefined};
    tree = yield* learnSampledSteps(plane, w, h, options, answer, entry);
    if (makePrefix && options.prefix.tree !== undefined) {
      prefixEntry.prefix = {key, references: options.references.map(r => r.slice()), tree: options.prefix.tree};
    }
  }
  const learned = tree && numbered(tree);
  return learned && {...learned, ...codePlane(tree, plane, w, h, answer.residuals, answer.properties, options.references)};
}
function numbered(tree) {
  const leaves = [], remap = new Map();
  const collect = node => {
    if (node.left) { collect(node.left); collect(node.right); return; }
    if (!remap.has(node.local)) remap.set(node.local, remap.size);
    node.local = remap.get(node.local); leaves.push(node);
  };
  collect(tree);
  return leaves.length > 1 ? {tree, leaves, classes: remap.size} : null;
}
const TREE_SPLITS = 8;
export function* learnTreeSteps(plane, w, h, raw, answer = null) {
  const {device, ...options} = normalizeLearnOptions(w, h, raw);
  if (!journaling()) return learnTree(plane, w, h, options, answer);
  const sampled = yield* unit('tree-columns', () => sampleColumns(plane, w, h, options, answer ?? weighted(plane, w, h, options.wp)));
  if (!sampled) return null;
  const grow = state => sampleTree(sampled.quantized, sampled.symbolSets, options.predictors, w * h, options, state);
  let state = null;
  do {
    const saved = yield* carried('tree-splits', () => { const grown = grow(state); growTree(grown, TREE_SPLITS); return treeState(grown); });
    if (saved !== PASSED) state = saved;
  } while (!state?.done);
  return numbered(state.tree ?? treeOf(grow(state)));
}
export function* planeTreeSteps(plane, w, h, options, references = []) {
  const none = plainAnswer(w, h), learn = learnOf(options, references, none);
  return none && learn.predictors.length < 3 ? null : yield* learnTreeSteps(plane, w, h, learn, none);
}
export function codePlane(tree, plane, w, h, residuals, wpProperty, references = []) {
  const countNodes = node => node.left ? 1 + countNodes(node.left) + countNodes(node.right) : 1;
  const flat = new Int32Array(countNodes(tree) * 4);
  let next = 0;
  const emit = node => {
    const k = next++, o = k * 4;
    if (node.left) {
      flat[o] = node.property; flat[o + 1] = node.splitval; flat[o + 2] = emit(node.left); flat[o + 3] = emit(node.right);
    } else {
      flat[o] = -1; flat[o + 1] = node.local; flat[o + 2] = node.predictor; flat[o + 3] = 0;
    }
    return k;
  };
  emit(tree);
  return captureTreeWalk(flat, plane, w, h, residuals, wpProperty, references);
}

let zeros = new Int32Array(0);
const noCopies = n => { if (zeros.length < n) zeros = new Int32Array(n); return zeros.subarray(0, n); };
const learnedPlanes = new Map(), KEPT = 256, LEAF_PREDICTORS = [5, 6, 1, 2, 3, 4, 0], SMOOTH_LEAF = 0.01, SMOOTH_PREDICTORS = [5, 1, 2, 7];
function planeKey(plane, w, h) {
  return w + 'x' + h + ':' + capturePlaneHash(plane);
}
const weightedPlanes = [], WEIGHTED_KEPT = 4, WEIGHTED_MAX_SAMPLES = 8 * 1048576;
function planeEntryOf(plane, w, h, key = planeKey(plane, w, h), wp = null, givenAnswer = null) {
  const idx = weightedPlanes.findIndex(e => e.key === key && capturePlanesEqual(e.plane, plane));
  if (idx >= 0) {
    const hit = weightedPlanes[idx];
    if (idx > 0) { weightedPlanes.splice(idx, 1); weightedPlanes.unshift(hit); }
    return hit;
  }
  const answer = givenAnswer || weighted(plane, w, h, wp);
  const entry = {key, plane: plane.slice(), answer, sampledAt: new Map()};
  weightedPlanes.unshift(entry);
  let totalSamples = 0;
  for (let i = 0; i < weightedPlanes.length; i++) totalSamples += weightedPlanes[i].plane.length;
  while (weightedPlanes.length > WEIGHTED_KEPT || (weightedPlanes.length > 1 && totalSamples > WEIGHTED_MAX_SAMPLES)) {
    totalSamples -= weightedPlanes.pop().plane.length;
  }
  return entry;
}
function weightedOf(plane, w, h, key = planeKey(plane, w, h), wp = null) {
  return planeEntryOf(plane, w, h, key, wp).answer;
}
export const learnedModel = (...args) => drive(learnedModelSteps(...args));
export function* learnedModelSteps(plane, w, h, answer = null, options = undefined, references = []) {
  if (((typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || !__RAPIER_JXL_CAPTURE_PHOTO__) && !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true)) && options?.leaf && w * h <= 4096) options = {...options, least: 64, charge: 2, ...options.small};
  const own = planeKey(plane, w, h);
  const wp = (typeof __RAPIER_JXL_EFFORT_TEN__ === 'undefined' || __RAPIER_JXL_EFFORT_TEN__ === true) ? options?.wp ?? null : null;
  const key = own + (options ? ':' + JSON.stringify(options) + (options.device ? ':device' : '') : '') + references.map(r => '|' + planeKey(r, w, h)).join('');
  let learned = learnedPlanes.get(key);
  if (learned === null && !options?.leaf) return null;
  const retain = options?.retainWeighted !== false && (Boolean(options?.retainWeighted) || (options?.samples ?? SAMPLES) >= 65536);
  const entry = retain ? planeEntryOf(plane, w, h, wp ? own + ':wp' + wp.values.join() : own, wp, answer) : null;
  answer ||= entry ? entry.answer : weighted(plane, w, h, wp);
  if (learned === undefined) {
    if (learnedPlanes.size >= KEPT) learnedPlanes.delete(learnedPlanes.keys().next().value);
    learned = yield* treeSteps(plane, w, h, references.length ? {...options, references} : options, answer, entry);
    learnedPlanes.set(key, learned && {tree: learned.tree, leaves: learned.leaves, classes: learned.classes});
  } else if (learned) {
    const {residuals, properties} = answer;
    learned = {...learned, ...codePlane(learned.tree, plane, w, h, residuals, properties, references)};
  }
  if (((typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || !__RAPIER_JXL_CAPTURE_PHOTO__) && !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true)) && !learned && options?.leaf) {
    const {residuals, properties} = answer, any = w * h <= 4096 || options.whole;
    let best = null;
    for (const predictor of options.predictors ?? (any ? LEAF_PREDICTORS : SMOOTH_PREDICTORS)) {
      const node = Object.assign(leaf(predictor), {local: 0}), coded = codePlane(node, plane, w, h, residuals, properties, references);
      const values = coded.values, first = values[0];
      let bits = 0, same = 0;
      while (same < values.length && values[same] === first) same++;
      if (same < values.length) {
        const counts = new Map();
        for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
        for (const c of counts.values()) bits -= c * Math.log2(c / values.length);
      }
      if (!best || bits < best.bits) best = {bits, tree: node, coded};
      if (!any && bits <= SMOOTH_LEAF * w * h) break;
    }
    if (any || best.bits <= SMOOTH_LEAF * w * h) learned = {tree: best.tree, leaves: [best.tree], ...best.coded};
  }
  if (!learned) return null;
  const {tree, leaves, classes = leaves.length, values, contexts} = learned, n = w * h;
  return {kind: 'smooth', tree, leaves, classes, width: w, height: h, stride: w, origin: 0, plane, minimum: 4,
    count: n, pieceValue: values, pieceDistance: noCopies(n), pieceContext: contexts};
}

export function treeModel(plane, w, h, learned = null, references = [], answer = null) {
  const leaves = learned ? learned.leaves : [Object.assign(leaf(5), {local: 0})], tree = learned ? learned.tree : leaves[0];
  const {residuals, properties} = answer || weighted(plane, w, h);
  const {values, contexts} = learned?.values ? learned : codePlane(tree, plane, w, h, residuals, properties, references);
  return {kind: 'smooth', tree, leaves, classes: learned?.classes ?? leaves.length, width: w, height: h, stride: w, origin: 0, plane, minimum: 4,
    count: w * h, pieceValue: learned?.values ? Int32Array.from(values) : values, pieceDistance: noCopies(w * h), pieceContext: contexts};
}
function mergedCuts(cuts, residuals, properties, header) {
  const k = cuts.length + 1, TOK = 48, {hist, raw} = captureCutHistogram(cuts, residuals, properties);
  const cost = (h, r) => { let total = 0, bits = r, used = 0; for (let t = 0; t < TOK; t++) total += h[t];
    for (let t = 0; t < TOK; t++) if (h[t]) { bits += h[t] * Math.log2(total / h[t]); used++; } return total ? bits + header * used + 16 : 0; };
  let groups = Array.from({length: k}, (_, g) => ({h: hist.slice(g * TOK, (g + 1) * TOK), r: raw[g], cut: g < cuts.length ? cuts[g] : null}));
  for (;;) {
    let best = 0, at = -1;
    for (let g = 0; g + 1 < groups.length; g++) {
      const a = groups[g], b = groups[g + 1], h = a.h.map((v, t) => v + b.h[t]), save = cost(a.h, a.r) + cost(b.h, b.r) - cost(h, a.r + b.r);
      if (save > best) { best = save; at = g; }
    }
    if (at < 0) break;
    const a = groups[at], b = groups[at + 1];
    groups.splice(at, 2, {h: a.h.map((v, t) => v + b.h[t]), r: a.r + b.r, cut: b.cut});
  }
  return groups.slice(0, -1).map(g => g.cut);
}
export function weightedTrees(plane, w, h, counts) {
  if (w > KERNEL_WIDTH || w * h > KERNEL_SAMPLES) {
    const none = {residuals: new Uint32Array(w * h), properties: new Int32Array(w * h)};
    return counts.map(() => treeModel(plane, w, h, null, [], none));
  }
  const answer = weightedOf(plane, w, h), props = answer.properties;
  return counts.map(count => {
    let {cuts} = captureQuantize(props, count || 16, true);
    if (!count) cuts = mergedCuts(cuts, answer.residuals, props, 4);
    const leaves = [], tree = intervals(15, cuts, () => { const node = leaf(6); node.local = leaves.length; leaves.push(node); return node; });
    return treeModel(plane, w, h, {tree, leaves}, [], answer);
  });
}
export const weightedTree = (plane, w, h, count) => weightedTrees(plane, w, h, [count])[0];
const KERNEL_WIDTH = 16384, KERNEL_SAMPLES = 1 << 20;
export const planeModelOf = (plane, w, h, learned, references = []) => treeModel(plane, w, h, learned, references, plainAnswer(w, h));
const plainAnswer = (w, h) => w > KERNEL_WIDTH || w * h > KERNEL_SAMPLES ? {residuals: new Uint32Array(w * h), properties: new Int32Array(w * h)} : null;
const learnOf = (options, references, none) => none
  ? {...options, references, predictors: options.predictors.filter(p => p !== 6), properties: options.properties.filter(p => p !== 15)} : {...options, references};
export function planeModel(plane, w, h, options, references = []) {
  const none = plainAnswer(w, h), learn = learnOf(options, references, none);
  const entry = none ? null : planeEntryOf(plane, w, h), answer = none ?? entry.answer;
  return treeModel(plane, w, h, none && learn.predictors.length < 3 ? null : learnTree(plane, w, h, learn, answer, null, entry), references, answer);
}
export function letGoTrees(keep) {
  learnedPlanes.clear(); weightedPlanes.length = 0; letGoPositions(); zeros = new Int32Array(0);
  if (entropyTable.length > keep) entropyTable = entropyTable.slice(0, keep);
}
