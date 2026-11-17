// SPDX-License-Identifier: MIT
import {leaf, split, writeTree, writeChannelHistograms, ALPHABET, RESIDUAL_CONFIG} from './modular.mjs';
import {captureCutHistogram, captureResiduals, captureTreeSample, captureTreeWalk} from './capture-kernels.mjs';
import {kernelHooks, ensured, missing, declined} from './kernel-hooks.mjs';
import {BitWriter, packSigned} from './bits.mjs';
import {transformKeys} from './rct-search.mjs';
import {unit, carried, journaling, journalFact, FACTS, PASSED} from './step-journal.mjs';

const PROPERTIES = [15, 9, 10, 11, 12, 13, 14, 4, 5, 6, 7, 8, 2, 3];
const PREDICTORS = [5, 6, 1, 2, 3, 4, 0, 11, 7, 10, 12];
const BINS = 32, SAMPLES = 65536;


function weighted(plane, w, h) {
  const residuals = new Uint32Array(w * h), properties = new Int32Array(w * h);
  captureResiduals(plane, w, h, residuals, properties);
  return {residuals, properties};
}

const Q = 4096, RETAIN = 256, TRAIN = Object.freeze({split: 4, splitToken: 16, msb: 1, lsb: 2});
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
function positionsOf(length, cap) {
  const count = Math.min(length, cap), positions = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const lo = Math.floor(i * length / count), hi = Math.floor((i + 1) * length / count);
    let hash = Math.imul(i + 1, 0x9e3779b1); hash ^= hash >>> 16; hash = Math.imul(hash, 0x85ebca6b); hash ^= hash >>> 13;
    positions[i] = lo + (hash >>> 0) % (hi - lo);
  }
  return positions;
}
const trainRaw = s => s < 16 ? 0 : ((s - 16) >> 3) + 1;
function quantize(values, bins) {
  const length = values.length;
  let low = values[0], high = values[0];
  for (let i = 1; i < length; i++) { const v = values[i]; if (v < low) low = v; else if (v > high) high = v; }
  const span = high - low + 1, cuts = [], indices = new Uint8Array(length);
  if (span > Math.max(256, length * 4)) {
    const sorted = values.slice().sort();
    for (let b = 1; b < bins; b++) { const cut = sorted[Math.floor(b * length / bins) - 1]; if (cut < sorted[length - 1] && (!cuts.length || cut > cuts[cuts.length - 1])) cuts.push(cut); }
    for (let i = 0; i < length; i++) { let lo = 0, hi = cuts.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (values[i] > cuts[mid]) lo = mid + 1; else hi = mid; } indices[i] = lo; }
    return {cuts, indices};
  }
  const counts = new Uint32Array(span);
  for (let i = 0; i < length; i++) counts[values[i] - low]++;
  let at = 0, seen = counts[0];
  for (let b = 1; b < bins; b++) {
    const rank = Math.floor(b * length / bins) - 1;
    if (rank < 0) continue;
    while (seen <= rank) seen += counts[++at];
    const cut = low + at;
    if (cut < high && (!cuts.length || cut > cuts[cuts.length - 1])) cuts.push(cut);
  }
  const binOf = new Uint8Array(span);
  for (let o = 0, k = 0; o < span; o++) { while (k < cuts.length && cuts[k] < low + o) k++; binOf[o] = k; }
  for (let i = 0; i < length; i++) indices[i] = binOf[values[i] - low];
  return {cuts, indices};
}
function distinctColumns(columns) {
  const seen = new Map(), unique = [];
  for (const column of columns) {
    if (!column.cuts.length) continue;
    const values = column.indices;
    let hash = 0;
    for (let i = 0; i < values.length; i++) hash = Math.imul(hash ^ values[i], 0x9e3779b1);
    const bucket = seen.get(hash);
    if (bucket?.some(previous => { if (previous.cuts.length !== column.cuts.length) return false; const other = previous.indices; for (let i = 0; i < values.length; i++) if (values[i] !== other[i]) return false; return true; })) continue;
    unique.push(column);
    if (bucket) bucket.push(column); else seen.set(hash, [column]);
  }
  return unique;
}
function histogramsOf(ids, symbolSets, alphabet, kinds) {
  const out = new Array(kinds), n = ids.length;
  for (let c = 0; c < kinds; c++) { const hist = new Uint32Array(alphabet), symbols = symbolSets[c]; for (let i = 0; i < n; i++) hist[symbols[ids[i]]]++; out[c] = hist; }
  return out;
}
function modelBits(tree, leaves, freqs) {
  const writer = new BitWriter(256);
  writeChannelHistograms(writer, writeTree(writer, tree), freqs, l => leaves.indexOf(l), () => RESIDUAL_CONFIG);
  return writer.bitLength;
}
const fullFreq = sample => { const freq = new Uint32Array(ALPHABET); freq.set(sample); return freq; };
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
function marginalCost(cluster, stats, table, scale, histBase, histSym) {
  if (!cluster || cluster.total === 0) return stats.bits * scale + (histBase + histSym * stats.used) * Q;
  const freq = cluster.freq, {nzSym, nzVal} = stats;
  let dSumT = 0, newUsed = 0;
  for (let j = 0; j < nzSym.length; j++) {
    const cur = freq[nzSym[j]], v = nzVal[j];
    dSumT += table[cur + v] - table[cur];
    if (!cur) newUsed++;
  }
  return ((table[cluster.total + stats.total] - (cluster.sumT + dSumT) - cluster.ent) + stats.raw) * scale + histSym * newUsed * Q;
}
function scoreClusterProposal(st, item, prop) {
  const {table, scale, clusters, maxClusters, splitCost, kinds, alphabet, remCluster, histBase, histSym} = st;
  const g0 = item.cluster, c0 = clusters[g0], h0 = item.hist[item.choice.selected];
  let rem = null;
  if (c0.members > 1) {
    const freq = remCluster.freq; freq.set(c0.freq);
    let sumT = c0.sumT, used = c0.used, total = c0.total;
    for (let s = 0; s < alphabet; s++) {
      const v = h0[s];
      if (!v) continue;
      const cur = freq[s];
      sumT += table[cur - v] - table[cur]; freq[s] = cur - v;
      if (cur === v) used--;
      total -= v;
    }
    remCluster.total = total; remCluster.sumT = sumT; remCluster.ent = table[total] - sumT; remCluster.used = used;
    rem = remCluster;
  }
  const before = marginalCost(rem, item.curStats, table, scale, histBase, histSym);
  const freeSlots = maxClusters - clusters.length + (rem ? 0 : 1), K = clusters.length;
  const maxExtra = (histBase + alphabet * histSym) * Q;
  const evalSide = (statsList, bestPred, minBits) => {
    let b1 = null, b2 = null;
    const limit = minBits * scale + maxExtra;
    const consider = (pred, cl, cost) => {
      if (!b1 || cost < b1.cost) { if (b1 && b1.cl !== cl) b2 = b1; b1 = {pred, cl, cost}; }
      else if (cl !== b1.cl && (!b2 || cost < b2.cost)) b2 = {pred, cl, cost};
    };
    for (let step = 0; step < kinds; step++) {
      const c = step === 0 ? bestPred : step <= bestPred ? step - 1 : step;
      const stc = statsList[c];
      if (stc.bits * scale > (b2 ? b2.cost + Q : limit)) continue;
      if (freeSlots >= 1) consider(c, -1, marginalCost(null, stc, table, scale, histBase, histSym));
      for (let g = 0; g < K; g++) {
        const target = g === g0 ? rem : clusters[g];
        if (target) consider(c, g, marginalCost(target, stc, table, scale, histBase, histSym));
      }
    }
    return [b1, b2];
  };
  const [hi1, hi2] = evalSide(prop.hiStats, prop.hi.selected, prop.hi.bits);
  const [lo1, lo2] = evalSide(prop.loStats, prop.lo.selected, prop.lo.bits);
  let bestAfter = Infinity, hiChoice = null, loChoice = null, shared = false;
  for (const hc of [hi1, hi2]) if (hc) for (const lc of [lo1, lo2]) if (lc) {
    if (hc.cl === lc.cl && !(hc.cl === -1 && freeSlots >= 2)) continue;
    const total = hc.cost + lc.cost;
    if (total < bestAfter) { bestAfter = total; hiChoice = hc; loChoice = lc; shared = false; }
  }
  const evalShared = (ch, cl, bothStats) => {
    if (bothStats.bits * scale >= bestAfter) return;
    if (freeSlots >= 1) {
      const c = marginalCost(null, bothStats, table, scale, histBase, histSym);
      if (c < bestAfter) { bestAfter = c; hiChoice = {pred: ch, cl: -1}; loChoice = {pred: cl, cl: -1}; shared = true; }
    }
    for (let g = 0; g < K; g++) {
      const target = g === g0 ? rem : clusters[g];
      if (!target) continue;
      const c = marginalCost(target, bothStats, table, scale, histBase, histSym);
      if (c < bestAfter) { bestAfter = c; hiChoice = {pred: ch, cl: g}; loChoice = {pred: cl, cl: g}; shared = true; }
    }
  };
  evalShared(prop.hi.selected, prop.lo.selected, prop.bothStats);
  if (hi1 && lo1 && (hi1.pred !== prop.hi.selected || lo1.pred !== prop.lo.selected)) {
    const key = hi1.pred * kinds + lo1.pred;
    let bothStats = prop.pairStats?.get(key);
    if (!bothStats) {
      const hBoth = st.scratchHist, hh = prop.high[hi1.pred], hl = prop.low[lo1.pred];
      for (let s = 0; s < alphabet; s++) hBoth[s] = hh[s] + hl[s];
      bothStats = histStats(hBoth, table, st.rawPrice);
      (prop.pairStats ||= new Map()).set(key, bothStats);
    }
    evalShared(hi1.pred, lo1.pred, bothStats);
  }
  prop.epoch = st.epoch; prop.score = before - (bestAfter + splitCost);
  prop.hiChoice = hiChoice; prop.loChoice = loChoice; prop.shared = shared;
  return prop.score;
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
function proposeSplit(st, item) {
  const {options, alphabet, table, rawPrice, candidates, count, population, store} = st;
  if (item.depth >= options.depth || item.ids.length < 64 || item.ownBits === 0) return null;
  const members = item.ids, total = members.length;
  const keep = {save: count >= RETAIN && (total >= RETAIN || !!item.forSibling), parent: item.parent || null, sibling: item.sibling || null, handle: null};
  const best = store.propose(members, item.hist, item.ownBits, keep);
  item.parent = item.sibling = null; item.forSibling = false;
  item.handle = keep.handle;
  if (!best || best.gain <= 0) return null;
  if (((typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || !__RAPIER_JXL_CAPTURE_PHOTO__) && !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && (typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || !__RAPIER_JXL_UPLOAD__)) && st.clustered) {
    best.loStats = best.low.map(h => histStats(h, table, rawPrice));
    best.hiStats = best.high.map(h => histStats(h, table, rawPrice));
    const hBoth = st.scratchHist, hh = best.high[best.hi.selected], hl = best.low[best.lo.selected];
    for (let s = 0; s < alphabet; s++) hBoth[s] = hh[s] + hl[s];
    best.bothStats = histStats(hBoth, table, rawPrice);
    best.pairStats = null;
    scoreClusterProposal(st, item, best);
    return best;
  }
  const one = leaf(candidates[item.choice.selected]), left = leaf(candidates[best.hi.selected]), right = leaf(candidates[best.lo.selected]);
  const branch = split(best.column.property, best.column.cuts[best.bin], left, right);
  const signal = Math.max(0, modelBits(branch, [left, right], [fullFreq(best.high[best.hi.selected]), fullFreq(best.low[best.lo.selected])]) - modelBits(one, [one], [fullFreq(item.hist[item.choice.selected])]));
  const score = best.gain * population - (signal + options.charge) * Q * count;
  return score > 0 ? {...best, score} : null;
}
function learnSampleTree(quantized, symbolSets, candidates, population, options) {
  const grown = sampleTree(quantized, symbolSets, candidates, population, options);
  growTree(grown);
  return treeOf(grown);
}
function sampleTree(quantized, symbolSets, candidates, population, options, saved = null) {
  const columns = distinctColumns(quantized), count = symbolSets[0].length, table = nlogQ12(count), clustered = ((typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || !__RAPIER_JXL_CAPTURE_PHOTO__) && !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && (typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || !__RAPIER_JXL_UPLOAD__)) && !!options.clustered;
  let alphabet = 1; for (const symbols of symbolSets) for (let i = 0; i < symbols.length; i++) if (symbols[i] >= alphabet) alphabet = symbols[i] + 1;
  const kinds = candidates.length, rawPrice = Float64Array.from({length: alphabet}, (_, s) => trainRaw(s) * Q);
  const reserve = quantized.some(c => c.property >= 16) ? 2 : 0, scale = population / count;
  const store = (kernelHooks.sampled ?? ensured().sampled ?? missing())(count, kinds, alphabet, columns, symbolSets, table, rawPrice);
  if (!store) throw declined('sampled');
  const st = {options, clustered, kinds, alphabet, table, rawPrice, columns, symbolSets, candidates, count, population, scale, store,
    clusters: null, maxClusters: Math.min(options.clusters ?? 192, 255 - reserve), epoch: 0,
    histBase: options.histBase ?? HIST_BASE, histSym: options.histSym ?? HIST_SYM,
    splitCost: ((options.leafBits ?? LEAF_BITS) + options.charge + SAMPLE_BIAS * (1 - count / population) * scale) * Q,
    scratchHist: clustered ? new Uint32Array(alphabet) : null,
    remCluster: clustered ? {freq: new Uint32Array(alphabet), total: 0, sumT: 0, ent: 0, used: 0} : null};
  if (saved) {
    st.clusters = saved.clusters; st.epoch = saved.epoch;
    return {...saved, st, reserve, active: saved.active.map(item => ({...item, proposal: item.proposal && {...item.proposal, column: columns[item.proposal.column]}}))};
  }
  const cost = hist => { let bits = entropyQ(hist, table); for (let s = 0; s < hist.length; s++) bits += hist[s] * rawPrice[s]; return bits; };
  const cheapest = hist => { let selected = 0, bits = cost(hist[0]); for (let c = 1; c < hist.length; c++) { const next = cost(hist[c]); if (next < bits) { selected = c; bits = next; } } return {selected, bits}; };
  const ids = new Uint32Array(count); for (let i = 0; i < count; i++) ids[i] = i;
  const hist = histogramsOf(ids, symbolSets, alphabet, kinds), initial = cheapest(hist), predictor = candidates[initial.selected], root = leaf(predictor);
  const rootStats = clustered ? histStats(hist[initial.selected], table, rawPrice) : null;
  st.clusters = clustered ? [makeCluster(hist[initial.selected], rootStats)] : null;
  const active = [{node: root, ids, hist, choice: initial, ownBits: initial.bits, curStats: rootStats, cluster: 0, depth: 0}];
  active[0].proposal = proposeSplit(st, active[0]);
  return {st, reserve, active, root, predictor, leaves: 1, done: false};
}
function growTree(grown, splits = Infinity) {
  const {st, reserve, active} = grown, {options, candidates, store, clusters, table} = st;
  const clustered = ((typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || !__RAPIER_JXL_CAPTURE_PHOTO__) && !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && (typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || !__RAPIER_JXL_UPLOAD__)) && st.clustered;
  for (let made = 0; grown.leaves < options.leaves - reserve; made++) {
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
    if (chosen < 0) break;
    const item = active[chosen], proposal = item.proposal, lo = proposal.lowIds, hi = proposal.highIds;
    let children;
    if (clustered) {
      const {hiChoice, loChoice, shared} = proposal, left = leaf(candidates[hiChoice.pred]), right = leaf(candidates[loChoice.pred]);
      Object.assign(item.node, split(proposal.column.property, proposal.column.cuts[proposal.bin], left, right));
      const g0 = item.cluster, c0 = clusters[g0];
      let freed = -1;
      if (c0.members === 1) freed = g0;
      else removeFromCluster(c0, item.hist[item.choice.selected], table);
      const alloc = (h, stats) => {
        const cl = makeCluster(h, stats);
        if (freed >= 0) { const s = freed; freed = -1; clusters[s] = cl; return s; }
        clusters.push(cl); return clusters.length - 1;
      };
      const hiStats = proposal.hiStats[hiChoice.pred], loStats = proposal.loStats[loChoice.pred];
      let gHi, gLo;
      if (shared) {
        if (hiChoice.cl === -1) { gHi = gLo = alloc(proposal.high[hiChoice.pred], hiStats); addToCluster(clusters[gHi], proposal.low[loChoice.pred], table); }
        else { gHi = gLo = hiChoice.cl; addToCluster(clusters[gHi], proposal.high[hiChoice.pred], table); addToCluster(clusters[gLo], proposal.low[loChoice.pred], table); }
      } else {
        gHi = hiChoice.cl === -1 ? alloc(proposal.high[hiChoice.pred], hiStats) : (addToCluster(clusters[hiChoice.cl], proposal.high[hiChoice.pred], table), hiChoice.cl);
        gLo = loChoice.cl === -1 ? alloc(proposal.low[loChoice.pred], loStats) : (addToCluster(clusters[loChoice.cl], proposal.low[loChoice.pred], table), loChoice.cl);
      }
      if (freed >= 0) {
        clusters.splice(freed, 1);
        if (gHi > freed) gHi--;
        if (gLo > freed) gLo--;
        for (const it of active) if (it !== item && it.cluster > freed) it.cluster--;
      }
      st.epoch++;
      children = [
        {node: left, ids: hi, hist: proposal.high, choice: {selected: hiChoice.pred}, ownBits: proposal.hi.bits, curStats: hiStats, cluster: gHi, depth: item.depth + 1},
        {node: right, ids: lo, hist: proposal.low, choice: {selected: loChoice.pred}, ownBits: proposal.lo.bits, curStats: loStats, cluster: gLo, depth: item.depth + 1},
      ];
    } else {
      const left = leaf(candidates[proposal.hi.selected]), right = leaf(candidates[proposal.lo.selected]);
      Object.assign(item.node, split(proposal.column.property, proposal.column.cuts[proposal.bin], left, right));
      children = [
        {node: left, ids: hi, hist: proposal.high, choice: proposal.hi, ownBits: proposal.hi.bits, depth: item.depth + 1},
        {node: right, ids: lo, hist: proposal.low, choice: proposal.lo, ownBits: proposal.lo.bits, depth: item.depth + 1},
      ];
    }
    if (grown.leaves + 1 < options.leaves - reserve) {
      const [small, large] = children[0].ids.length <= children[1].ids.length ? children : [children[1], children[0]];
      if (item.handle) small.forSibling = true;
      small.proposal = proposeSplit(st, small);
      if (item.handle && small.handle) { large.parent = item.handle; large.sibling = small.handle; }
      large.proposal = proposeSplit(st, large);
      if (small.handle && small.ids.length < RETAIN) { store.release(small.handle); small.handle = null; }
    }
    if (item.handle) { store.release(item.handle); item.handle = null; }
    active.splice(chosen, 1, ...children); grown.leaves++;
    if (clustered && (grown.leaves & 31) === 0) maybeMergeClusters(st, active);
  }
  grown.done = true;
  return true;
}
function treeState({st, active, root, predictor, leaves, done}) {
  for (const item of active) if (item.handle) { st.store.release(item.handle); item.handle = null; }
  return {root, predictor, leaves, done, clusters: st.clusters, epoch: st.epoch, active: active.map(({node, ids, hist, choice, ownBits, curStats, cluster, depth, proposal}) =>
    ({node, ids, hist, choice, ownBits, curStats, cluster, depth, proposal: proposal && (({pairStats, ...rest}) => ({...rest, column: st.columns.indexOf(proposal.column)}))(proposal)}))};
}
function treeOf({st, active, root, predictor}) {
  for (const item of active) if (item.handle) st.store.release(item.handle);
  if (((typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || !__RAPIER_JXL_CAPTURE_PHOTO__) && !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && (typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || !__RAPIER_JXL_UPLOAD__)) && st.clustered) {
    maybeMergeClusters(st, active);
    for (const item of active) item.node.local = item.cluster;
  } else active.forEach((item, i) => { item.node.local = i; });
  return guardReferences(root, predictor, ((typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || !__RAPIER_JXL_CAPTURE_PHOTO__) && !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && (typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || !__RAPIER_JXL_UPLOAD__)) && st.clustered ? st.clusters.length : active.length);
}
function learnSampled(plane, w, h, options = {}, answer) {
  const {depth = 24, predictors = PREDICTORS, clusters = 192, charge = 32, leafBits, histBase, histSym} = options, sampled = sampleColumns(plane, w, h, options, answer);
  let {leaves = 60} = options;
  if (!sampled) return null;
  const clustered = ((typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || !__RAPIER_JXL_CAPTURE_PHOTO__) && !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && (typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || !__RAPIER_JXL_UPLOAD__)) && (!!options.clustered || leaves > 255);
  if (!((typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || !__RAPIER_JXL_CAPTURE_PHOTO__) && !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && (typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || !__RAPIER_JXL_UPLOAD__))) leaves = Math.min(leaves, 255);
  const tree = learnSampleTree(sampled.quantized, sampled.symbolSets, predictors, w * h, {leaves, depth, clustered, clusters, charge, leafBits, histBase, histSym});
  return tree.left ? tree : null;
}
function sampleColumns(plane, w, h, {samples = SAMPLES, bins = 32, properties: wanted = PROPERTIES, predictors = PREDICTORS,
  references = [], referenceKinds = [0, 1, 2, 3], least = 4096} = {}, answer) {
  const n = w * h;
  if (n < least) return null;
  const {residuals, properties: wp} = answer, positions = positionsOf(n, samples);
  const properties = [...wanted];
  for (let r = 0; r < references.length; r++) for (const kind of referenceKinds) properties.push(16 + 4 * r + kind);
  const {columns, symbolSets} = captureTreeSample(plane, w, h, positions, Int32Array.from(properties), Int32Array.from(predictors), residuals, wp, references);
  return {quantized: columns.map(({property, values}) => ({property, ...quantize(values, bins)})), symbolSets};
}

const gradient = (w, n, nw) => Math.max(Math.min(w, n), Math.min(Math.max(w, n), w + n - nw));
export const rankingPositions = (pixels, samples = 32768) => positionsOf(pixels, samples);
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
export function learnTree(plane, w, h, {nodes = 119, samples = SAMPLES, bins = BINS, properties = PROPERTIES, predictors = PREDICTORS,
  references = [], referenceKinds = [0, 1, 2, 3], least = 4096, depth = 24, charge = 32, leafBits, histBase, histSym, clustered = false, clusters = 192} = {}, answer = null) {
  answer ||= weighted(plane, w, h); nodes = fitted(nodes, w, h);
  if (properties.includes(9) && gradientPassesInt32(plane, w, h)) properties = properties.filter(p => p !== 9);
  const tree = learnSampled(plane, w, h, {leaves: (nodes + 1) >> 1, depth, samples, bins, properties, predictors, references, referenceKinds, least, charge, leafBits, histBase, histSym, clustered, clusters}, answer);
  const learned = tree && numbered(tree);
  return learned && {...learned, ...codePlane(tree, plane, w, h, answer.residuals, answer.properties, references)};
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
export function* learnTreeSteps(plane, w, h, {nodes = 119, samples = SAMPLES, bins = BINS, properties = PROPERTIES, predictors = PREDICTORS,
  references = [], referenceKinds = [0, 1, 2, 3], least = 4096, depth = 24, charge = 32, leafBits, histBase, histSym, clustered = false, clusters = 192} = {}, answer = null) {
  nodes = fitted(nodes, w, h);
  const count = (nodes + 1) >> 1, deep = ((typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || !__RAPIER_JXL_CAPTURE_PHOTO__) && !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && (typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || !__RAPIER_JXL_UPLOAD__));
  const options = {leaves: deep ? count : Math.min(count, 255), depth, samples, bins, properties, predictors, references, referenceKinds, least, charge, leafBits, histBase, histSym, clustered: deep && (clustered || count > 255), clusters};
  if (!journaling()) return learnTree(plane, w, h, {nodes, ...options}, answer);
  const sampled = yield* unit('tree-columns', () => sampleColumns(plane, w, h, options, answer ?? weighted(plane, w, h)));
  if (!sampled) return null;
  const grow = state => sampleTree(sampled.quantized, sampled.symbolSets, predictors, w * h, options, state);
  let state = null;
  do {
    const saved = yield* carried('tree-splits', () => { const grown = grow(state); growTree(grown, TREE_SPLITS); return treeState(grown); });
    if (saved !== PASSED) state = saved;
  } while (!state?.done);
  return numbered(treeOf(grow(state)));
}
export function* planeTreeSteps(plane, w, h, options, references = []) {
  const none = plainAnswer(w, h), learn = learnOf(options, references, none);
  return none && learn.predictors.length < 3 ? null : yield* learnTreeSteps(plane, w, h, learn, none);
}
export function codePlane(tree, plane, w, h, residuals, wpProperty, references = []) {
  const nodes = [];
  const flatten = node => { nodes.push(node); if (node.left) { flatten(node.left); flatten(node.right); } };
  flatten(tree);
  const index = new Map(nodes.map((node, k) => [node, k])), flat = new Int32Array(nodes.length * 4);
  nodes.forEach((node, k) => flat.set(node.left ? [node.property, node.splitval, index.get(node.left), index.get(node.right)]
    : [-1, node.local, node.predictor, 0], k * 4));
  return captureTreeWalk(flat, plane, w, h, residuals, wpProperty, references);
}

let zeros = new Int32Array(0);
const noCopies = n => { if (zeros.length < n) zeros = new Int32Array(n); return zeros.subarray(0, n); };
const learnedPlanes = new Map(), KEPT = 256, LEAF_PREDICTORS = [5, 6, 1, 2, 3, 4, 0], SMOOTH_LEAF = 0.01, SMOOTH_PREDICTORS = [5, 1, 2, 7];
function planeKey(plane, w, h) {
  let a = 2166136261, b = 0;
  for (let i = 0; i < plane.length; i++) { a = Math.imul(a ^ plane[i], 16777619); b = b + plane[i] * (i + 1) | 0; }
  return w + 'x' + h + ':' + (a >>> 0) + ':' + (b >>> 0);
}
const weightedPlanes = [], WEIGHTED_KEPT = 1;
function weightedOf(plane, w, h, key) {
  const same = a => { if (a.length !== plane.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== plane[i]) return false; return true; };
  const hit = weightedPlanes.find(e => e.key === key && same(e.plane));
  if (hit) return hit.answer;
  const answer = weighted(plane, w, h);
  weightedPlanes.unshift({key, plane: plane.slice(), answer});
  if (weightedPlanes.length > WEIGHTED_KEPT) weightedPlanes.pop();
  return answer;
}
export function learnedModel(plane, w, h, answer = null, options = undefined, references = []) {
  if (((typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || !__RAPIER_JXL_CAPTURE_PHOTO__) && !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true)) && options?.leaf && w * h <= 4096) options = {...options, least: 64, charge: 2, ...options.small};
  const own = planeKey(plane, w, h);
  answer ||= weightedOf(plane, w, h, own);
  const key = own + (options ? ':' + JSON.stringify(options) : '') + references.map(r => '|' + planeKey(r, w, h)).join('');
  let learned = learnedPlanes.get(key);
  if (learned === undefined) {
    if (learnedPlanes.size >= KEPT) learnedPlanes.delete(learnedPlanes.keys().next().value);
    learned = learnTree(plane, w, h, references.length ? {...options, references} : options, answer);
    learnedPlanes.set(key, learned && {tree: learned.tree, leaves: learned.leaves, classes: learned.classes});
  } else if (learned) {
    const {residuals, properties} = answer || weighted(plane, w, h);
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
  const answer = weighted(plane, w, h), sorted = Int32Array.from(answer.properties).sort(), n = sorted.length;
  return counts.map(count => {
    let cuts = [];
    for (let b = 1; b < (count || 16); b++) { const c = sorted[Math.floor(b * n / (count || 16))]; if (!cuts.length || c > cuts[cuts.length - 1]) cuts.push(c); }
    if (cuts.length && cuts[cuts.length - 1] >= sorted[n - 1]) cuts.pop();
    if (!count) cuts = mergedCuts(cuts, answer.residuals, answer.properties, 4);
    const leaves = [];
    const build = (lo, hi) => {
      if (lo === hi) { const node = leaf(6); node.local = leaves.length; leaves.push(node); return node; }
      const mid = (lo + hi) >> 1;
      return split(15, cuts[mid], build(mid + 1, hi), build(lo, mid));
    };
    return treeModel(plane, w, h, {tree: build(0, cuts.length), leaves}, [], answer);
  });
}
export const weightedTree = (plane, w, h, count) => weightedTrees(plane, w, h, [count])[0];
const KERNEL_WIDTH = 16384, KERNEL_SAMPLES = 1 << 20;
export const planeModelOf = (plane, w, h, learned, references = []) => treeModel(plane, w, h, learned, references, plainAnswer(w, h));
const plainAnswer = (w, h) => w > KERNEL_WIDTH || w * h > KERNEL_SAMPLES ? {residuals: new Uint32Array(w * h), properties: new Int32Array(w * h)} : null;
const learnOf = (options, references, none) => none
  ? {...options, references, predictors: options.predictors.filter(p => p !== 6), properties: options.properties.filter(p => p !== 15)} : {...options, references};
export function planeModel(plane, w, h, options, references = []) {
  const none = plainAnswer(w, h), learn = learnOf(options, references, none), answer = none ?? weighted(plane, w, h);
  return treeModel(plane, w, h, none && learn.predictors.length < 3 ? null : learnTree(plane, w, h, learn, answer), references, answer);
}
export function letGoTrees(keep) {
  learnedPlanes.clear(); weightedPlanes.length = 0; zeros = new Int32Array(0);
  if (entropyTable.length > keep) entropyTable = entropyTable.slice(0, keep);
}
