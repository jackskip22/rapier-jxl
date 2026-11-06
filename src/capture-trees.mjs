// SPDX-License-Identifier: MIT
import {leaf, split, writeTree, writeChannelHistograms, ALPHABET, RESIDUAL_CONFIG} from './modular.mjs';
import {captureResiduals} from './capture-kernels.mjs';
import {kernelHooks} from './kernel-hooks.mjs';
import {BitWriter, packSigned} from './bits.mjs';
import {transformKeys} from './rct-search.mjs';

const PROPERTIES = [15, 9, 10, 11, 12, 13, 14, 4, 5, 6, 7, 8, 2, 3];
const PREDICTORS = [5, 6, 1, 2, 3, 4, 0, 11, 7, 10, 12];
const BINS = 32, SAMPLES = 65536;

const token = v => v < 16 ? v : 16 + ((31 - Math.clz32(v) - 4) << 1 | (v >>> (30 - Math.clz32(v))) & 1);
const rawBits = v => v < 16 ? 0 : 30 - Math.clz32(v);
const pack = r => r >= 0 ? r * 2 : -r * 2 - 1;

function prediction(p, plane, width, i, x, y, w, n, nw, weighted) {
  switch (p) {
    case 0: return 0;
    case 1: return w;
    case 2: return n;
    case 3: return (w + n) / 2 | 0;
    case 4: { const g = w + n - nw; return Math.abs(g - w) < Math.abs(g - n) ? w : n; }
    case 5: { const lo = w < n ? w : n, hi = w < n ? n : w, g = w + n - nw; return g < lo ? lo : g > hi ? hi : g; }
    case 6: return weighted;
  }
  const ne = y && x + 1 < width ? plane[i - width + 1] : n;
  if (p === 7) return ne;
  if (p === 8) return nw;
  if (p === 10) return (w + nw) / 2 | 0;
  if (p === 11) return (nw + n) / 2 | 0;
  if (p === 12) return (n + ne) / 2 | 0;
  const ww = x > 1 ? plane[i - 2] : w;
  if (p === 9) return ww;
  const nn = y > 1 ? plane[i - 2 * width] : n, nee = y && x + 2 < width ? plane[i - width + 2] : ne;
  return Math.trunc((6 * n - 2 * nn + 7 * w + ww + nee + 3 * ne + 8) / 16);
}
function property(p, plane, width, i, x, y, w, n, nw, wp, references) {
  if (p >= 16) return reference(references[(p - 16) >> 2], p & 3, width, i, x, y);
  switch (p) {
    case 2: return y;
    case 3: return x;
    case 4: return Math.abs(n);
    case 5: return Math.abs(w);
    case 6: return n;
    case 7: return w;
    case 9: return w + n - nw;
    case 10: return w - nw;
    case 11: return nw - n;
    case 12: return n - (y && x + 1 < width ? plane[i - width + 1] : n);
    case 13: return n - (y > 1 ? plane[i - 2 * width] : n);
    case 14: return w - (x > 1 ? plane[i - 2] : w);
    case 15: return wp;
  }
  if (!x) return w;
  const pw = x > 1 ? plane[i - 2] : y ? plane[i - width - 1] : 0, pn = y ? plane[i - width - 1] : pw, pnw = x > 1 && y ? plane[i - width - 2] : pw;
  return w - (pw + pn - pnw);
}

function reference(r, kind, width, i, x, y) {
  const v = r[i];
  if (kind < 2) return kind ? v : Math.abs(v);
  const left = x ? r[i - 1] : y ? r[i - width] : 0, top = y ? r[i - width] : left, corner = x && y ? r[i - width - 1] : left;
  const lo = left < top ? left : top, hi = left < top ? top : left, g = left + top - corner, d = v - (g < lo ? lo : g > hi ? hi : g);
  return kind === 3 ? d : Math.abs(d);
}

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
const trainSymbol = v => { if (v < 16) return v; const top = 31 - Math.clz32(v), below = v - (1 << top); return 16 + (((top - 4) << 3) | ((below >> (top - 1)) << 2) | (below & 3)); };
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
  const out = new Array(kinds);
  for (let c = 0; c < kinds; c++) { const hist = new Uint32Array(alphabet), symbols = symbolSets[c]; for (const id of ids) hist[symbols[id]]++; out[c] = hist; }
  return out;
}
function modelBits(tree, leaves, freqs) {
  const writer = new BitWriter(256);
  writeChannelHistograms(writer, writeTree(writer, tree), freqs, l => leaves.indexOf(l), () => RESIDUAL_CONFIG);
  return writer.bitLength;
}
const fullFreq = sample => { const freq = new Uint32Array(ALPHABET); freq.set(sample); return freq; };
function guardReferences(model, predictor) {
  const nodes = [model.tree]; let references = false;
  for (const node of nodes) if (node.left) { references ||= node.property >= 16; nodes.push(node.left, node.right); }
  if (!references) return model;
  const prune = (node, xlo = 1, xhi = Infinity, ylo = 1, yhi = Infinity) => {
    if (!node.left) return node;
    const cut = node.splitval, axis = node.property;
    if (axis === 2 && cut < ylo || axis === 3 && cut < xlo) return prune(node.left, xlo, xhi, ylo, yhi);
    if (axis === 2 && cut >= yhi || axis === 3 && cut >= xhi) return prune(node.right, xlo, xhi, ylo, yhi);
    const left = prune(node.left, axis === 3 ? cut + 1 : xlo, xhi, axis === 2 ? cut + 1 : ylo, yhi);
    const right = prune(node.right, xlo, axis === 3 ? cut : xhi, ylo, axis === 2 ? cut : yhi);
    return left === node.left && right === node.right ? node : {...node, left, right};
  };
  const tree = prune(model.tree), reachable = new Set(), pending = [tree];
  for (const node of pending) if (node.left) pending.push(node.left, node.right); else reachable.add(node);
  const leaves = model.leaves.filter(node => reachable.has(node));
  return {tree: split(2, 0, split(3, 0, tree, leaf(predictor)), leaf(predictor)), leaves: null};
}
function proposeSplit(st, item) {
  const {options, kinds, alphabet, table, rawPrice, columns, symbolSets, candidates, count, population, store, lowCounts, highCounts,
    lowTable, highTable, lowRaw, highRaw, baseTable, baseRaw, slotOf} = st;
  let {dense, offsets} = st;
  if (item.depth >= options.depth || item.ids.length < 64 || item.choice.bits === 0) return null;
  const members = item.ids, total = members.length;
  const keep = store ? {store, save: total >= RETAIN || !!item.forSibling, parent: item.parent || null, sibling: item.sibling || null, handle: null} : null;
  let best = kernelHooks.sampled ? kernelHooks.sampled(members, item.hist, symbolSets, columns, table, rawPrice, item.choice.bits, keep) : false;
  item.parent = item.sibling = null; item.forSibling = false;
  if (keep) item.handle = keep.handle;
  if (best === false) {
    best = null;
    for (let c = 0; c < kinds; c++) {
      let t = 0, r = 0; const h = item.hist[c];
      for (let s = 0; s < alphabet; s++) if (h[s]) { t += table[h[s]]; r += h[s] * rawPrice[s]; }
      baseTable[c] = t; baseRaw[c] = r;
    }
    let sym = null, present = null, support = null, kept = 0;
    for (const column of columns) {
      const cuts = column.cuts.length, bins = cuts + 1, indices = column.indices;
      if (!cuts) continue;
      for (let c = 0; c < kinds; c++) { lowCounts[c].fill(0); highCounts[c].set(item.hist[c]); }
      lowTable.fill(0); lowRaw.fill(0); highTable.set(baseTable); highRaw.set(baseRaw);
      let lowCount = 0;
      {
        if (!sym) {
          present = []; slotOf.fill(-1);
          for (let s = 0; s < alphabet; s++) for (let c = 0; c < kinds; c++) if (item.hist[c][s]) { slotOf[s] = present.length; present.push(s); break; }
          kept = present.length;
          support = candidates.map((_, c) => { const slots = []; for (let q = 0; q < kept; q++) if (item.hist[c][present[q]]) slots.push(q); return slots; });
          sym = new Uint8Array(total * kinds);
          for (let c = 0; c < kinds; c++) { const symbols = symbolSets[c], at = c * total; for (let i = 0; i < total; i++) sym[at + i] = slotOf[symbols[members[i]]]; }
        }
        if (offsets.length < total) offsets = new Uint32Array(total);
        for (let i = 0; i < total; i++) offsets[i] = indices[members[i]] * kept;
        const size = bins * kinds * kept;
        if (dense.length < size) dense = new Uint32Array(size); else dense.fill(0, 0, size);
        for (let c = 0; c < kinds; c++) { const base = c * bins * kept, at = c * total; for (let i = 0; i < total; i++) dense[base + offsets[i] + sym[at + i]]++; }
      }
      for (let b = 0; b < cuts; b++) {
        let moved = 0;
        {
          for (let c = 0; c < kinds; c++) {
            const low = lowCounts[c], high = highCounts[c], row = (c * bins + b) * kept, occupied = support[c];
            let t = 0, r = 0, u = 0, m = 0;
            for (let j = 0; j < occupied.length; j++) {
              const q = occupied[j], v = dense[row + q];
              if (!v) continue;
              const s = present[q], l = low[s], h = high[s];
              t += table[l + v] - table[l]; u += table[h - v] - table[h]; r += v * rawPrice[s]; m += v;
              low[s] = l + v; high[s] = h - v;
            }
            lowTable[c] += t; highTable[c] += u; lowRaw[c] += r; highRaw[c] -= r;
            if (!c) moved = m;
          }
        }
        const previous = lowCount;
        lowCount += moved;
        if (lowCount === previous || lowCount < 24 || total - lowCount < 24) continue;
        let loSelected = 0, hiSelected = 0, loBits = Infinity, hiBits = Infinity;
        const lowBase = table[lowCount], highBase = table[total - lowCount];
        for (let c = 0; c < kinds; c++) {
          const l = lowBase - lowTable[c] + lowRaw[c], h = highBase - highTable[c] + highRaw[c];
          if (l < loBits) { loBits = l; loSelected = c; }
          if (h < hiBits) { hiBits = h; hiSelected = c; }
        }
        const gain = item.choice.bits - loBits - hiBits;
        if (!best || gain > best.gain) best = {gain, column, bin: b, lo: {selected: loSelected, bits: loBits}, hi: {selected: hiSelected, bits: hiBits}};
      }
    }
  }
  st.dense = dense; st.offsets = offsets;
  if (!best || best.gain <= 0) return null;
  const bin = best.column.indices; let below = 0;
  for (let i = 0; i < total; i++) if (bin[members[i]] <= best.bin) below++;
  best.lowIds = new Uint32Array(below); best.highIds = new Uint32Array(total - below);
  for (let i = 0, l = 0, h = 0; i < total; i++) { const id = members[i]; if (bin[id] <= best.bin) best.lowIds[l++] = id; else best.highIds[h++] = id; }
  best.low = histogramsOf(best.lowIds, symbolSets, alphabet, kinds);
  best.high = item.hist.map((hist, c) => hist.map((value, s) => value - best.low[c][s]));
  const one = leaf(candidates[item.choice.selected]), left = leaf(candidates[best.hi.selected]), right = leaf(candidates[best.lo.selected]);
  const branch = split(best.column.property, best.column.cuts[best.bin], left, right);
  const signal = Math.max(0, modelBits(branch, [left, right], [fullFreq(best.high[best.hi.selected]), fullFreq(best.low[best.lo.selected])]) - modelBits(one, [one], [fullFreq(item.hist[item.choice.selected])]));
  const score = best.gain * population - (options.clustered ? Math.min(signal + options.charge, 96) : signal + options.charge) * Q * count;
  return score > 0 ? {...best, score} : null;
}
function learnSampleTree(quantized, symbolSets, candidates, population, options) {
  const columns = distinctColumns(quantized), count = symbolSets[0].length, table = nlogQ12(count);
  let alphabet = 1; for (const symbols of symbolSets) for (const symbol of symbols) alphabet = Math.max(alphabet, symbol + 1);
  const cost = hist => { let bits = entropyQ(hist, table); for (let s = 0; s < hist.length; s++) bits += hist[s] * trainRaw(s) * Q; return bits; };
  const cheapest = hist => { let selected = 0, bits = cost(hist[0]); for (let c = 1; c < hist.length; c++) { const next = cost(hist[c]); if (next < bits) { selected = c; bits = next; } } return {selected, bits}; };
  const ids = Uint32Array.from({length: count}, (_, i) => i), hist = histogramsOf(ids, symbolSets, alphabet, candidates.length), initial = cheapest(hist), predictor = candidates[initial.selected], root = leaf(predictor);
  const active = [{node: root, ids, hist, choice: initial, depth: 0}], kinds = candidates.length, rawPrice = Float64Array.from({length: alphabet}, (_, s) => trainRaw(s) * Q);
  let leaves = 1;
  const store = kernelHooks.sampled && kernelHooks.sampledStore && count >= RETAIN ? kernelHooks.sampledStore(count, kinds, alphabet, columns) : null;
  const st = {options, kinds, alphabet, table, rawPrice, columns, symbolSets, candidates, count, population, store,
    lowCounts: candidates.map(() => new Uint32Array(alphabet)), highCounts: candidates.map(() => new Uint32Array(alphabet)),
    lowTable: new Float64Array(kinds), highTable: new Float64Array(kinds), lowRaw: new Float64Array(kinds), highRaw: new Float64Array(kinds),
    baseTable: new Float64Array(kinds), baseRaw: new Float64Array(kinds), slotOf: new Int16Array(alphabet),
    dense: new Uint32Array(0), offsets: new Uint32Array(0)};
  active[0].proposal = proposeSplit(st, active[0]);
  const reserve = quantized.some(c => c.property >= 16) ? 2 : 0;
  while (leaves < options.leaves - reserve) {
    let chosen = -1;
    for (let i = 0; i < active.length; i++) if (active[i].proposal && (chosen < 0 || active[i].proposal.score > active[chosen].proposal.score)) chosen = i;
    if (chosen < 0) break;
    const item = active[chosen], proposal = item.proposal, lo = proposal.lowIds, hi = proposal.highIds;
    const left = leaf(candidates[proposal.hi.selected]), right = leaf(candidates[proposal.lo.selected]);
    Object.assign(item.node, split(proposal.column.property, proposal.column.cuts[proposal.bin], left, right));
    const children = [{node: left, ids: hi, hist: proposal.high, choice: proposal.hi, depth: item.depth + 1}, {node: right, ids: lo, hist: proposal.low, choice: proposal.lo, depth: item.depth + 1}];
    if (leaves + 1 < options.leaves - reserve) {
      const [small, large] = children[0].ids.length <= children[1].ids.length ? children : [children[1], children[0]];
      if (item.handle) small.forSibling = true;
      small.proposal = proposeSplit(st, small);
      if (item.handle && small.handle) { large.parent = item.handle; large.sibling = small.handle; }
      large.proposal = proposeSplit(st, large);
      if (small.handle && small.ids.length < RETAIN) { store.release(small.handle); small.handle = null; }
    }
    if (item.handle) { store.release(item.handle); item.handle = null; }
    active.splice(chosen, 1, ...children); leaves++;
  }
  for (const item of active) if (item.handle) store?.release(item.handle);
  return guardReferences({tree: root, leaves: active.map(item => item.node)}, predictor).tree;
}
function learnSampled(plane, w, h, {leaves = 60, depth = 24, samples = SAMPLES, bins = 32, properties: wanted = PROPERTIES, predictors = PREDICTORS,
  references = [], referenceKinds = [0, 1, 2, 3], least = 4096, clustered = false, charge = 32} = {}, answer) {
  const n = w * h;
  if (n < least) return null;
  const {residuals, properties: wp} = answer, positions = positionsOf(n, samples), m = positions.length;
  const properties = [...wanted];
  for (let r = 0; r < references.length; r++) for (const kind of referenceKinds) properties.push(16 + 4 * r + kind);
  const values = properties.map(() => new Int32Array(m)), symbolSets = predictors.map(() => new Uint8Array(m));
  for (let s = 0; s < m; s++) {
    const i = positions[s], x = i % w, y = i / w | 0, W = x ? plane[i - 1] : y ? plane[i - w] : 0, N = y ? plane[i - w] : W, NW = x && y ? plane[i - w - 1] : W;
    const v = plane[i], wpPred = v - ((residuals[i] & 1 ? -((residuals[i] + 1) >> 1) : residuals[i] >> 1));
    for (let q = 0; q < properties.length; q++) values[q][s] = property(properties[q], plane, w, i, x, y, W, N, NW, wp[i], references);
    for (let q = 0; q < predictors.length; q++) symbolSets[q][s] = trainSymbol(predictors[q] === 6 ? residuals[i] : pack(v - prediction(predictors[q], plane, w, i, x, y, W, N, NW, wpPred)));
  }
  const quantized = properties.map((property, q) => ({property, ...quantize(values[q], bins)}));
  const tree = learnSampleTree(quantized, symbolSets, predictors, n, {leaves, depth, clustered, charge});
  return tree.left ? tree : null;
}

const gradient = (w, n, nw) => Math.max(Math.min(w, n), Math.min(Math.max(w, n), w + n - nw));
export function transformRanking(rgba, width, height, samples = 32768) {
  const positions = positionsOf(width * height, samples), count = positions.length, table = nlogQ12(count);
  const value = (i, key) => {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    const ch = key === 0 || key === 12 || key === 15 ? r : key === 1 || key === 13 || key === 16 ? g : b;
    if (key < 3) return ch;
    if (key < 12) { const from = (key - 3) / 3 | 0, minus = (key - 3) % 3; return (from === 0 ? r : from === 1 ? g : b) - (minus === 0 ? r : minus === 1 ? g : b); }
    const others = key === 12 || key === 15 ? g + b : key === 13 || key === 16 ? r + b : r + g, mean = others >> 1;
    return key < 15 ? ch - mean : mean + ((ch - mean) >> 1);
  };
  const prices = new Float64Array(18), hist = new Uint32Array(64);
  for (let key = 0; key < 18; key++) {
    if (key === 3 || key === 7 || key === 11) continue;
    hist.fill(0);
    let raw = 0;
    for (let k = 0; k < count; k++) {
      const i = positions[k], y = (i / width) | 0, x = i - y * width;
      const w = x ? value(i - 1, key) : y ? value(i - width, key) : 0, n = y ? value(i - width, key) : w, nw = x && y ? value(i - width - 1, key) : w;
      const v = packSigned(value(i, key) - gradient(w, n, nw));
      if (v < 16) hist[v]++;
      else { const top = 31 - Math.clz32(v), below = v - (1 << top); hist[16 + (((top - 4) << 3) | ((below >> (top - 1)) << 2) | (below & 3))]++; raw += top - 3; }
    }
    let sum = 0, cost = 0;
    for (let s = 0; s < hist.length; s++) { sum += hist[s]; cost += table[hist[s]]; }
    prices[key] = table[sum] - cost + raw * 4096;
  }
  const ranked = Array.from({length: 42}, (_, type) => ({type, price: transformKeys(type).reduce((n, key) => n + prices[key], 0)}));
  ranked.sort((a, b) => a.price - b.price || a.type - b.type);
  return ranked.map(entry => entry.type);
}


export function learnTree(plane, w, h, {nodes = 119, samples = SAMPLES, bins = BINS, properties = PROPERTIES, predictors = PREDICTORS,
  references = [], referenceKinds = [0, 1, 2, 3], least = 4096, depth = 24, charge = 32} = {}, answer = null) {
  answer ||= weighted(plane, w, h);
  const tree = learnSampled(plane, w, h, {leaves: (nodes + 1) >> 1, depth, samples, bins, properties, predictors, references, referenceKinds, least, charge}, answer);
  if (!tree) return null;
  const leaves = [];
  const collect = node => { if (node.left) { collect(node.left); collect(node.right); } else { node.local = leaves.length; leaves.push(node); } };
  collect(tree);
  if (leaves.length === 1) return null;
  return {tree, leaves, ...codePlane(tree, plane, w, h, answer.residuals, answer.properties, references)};
}
export function codePlane(tree, plane, w, h, residuals, wpProperty, references = []) {
  const n = w * h, coded = new Int32Array(n), contexts = new Uint8Array(n), nodes = [];
  const flatten = node => { nodes.push(node); if (node.left) { flatten(node.left); flatten(node.right); } };
  flatten(tree);
  const count = nodes.length, prop = new Int32Array(count), cut = new Int32Array(count), left = new Int32Array(count), right = new Int32Array(count);
  const local = new Int32Array(count), predictor = new Int32Array(count), index = new Map(nodes.map((node, k) => [node, k]));
  for (let k = 0; k < count; k++) {
    const node = nodes[k];
    if (node.left) { prop[k] = node.property; cut[k] = node.splitval; left[k] = index.get(node.left); right[k] = index.get(node.right); }
    else { prop[k] = -1; local[k] = node.local; predictor[k] = node.predictor; }
  }
  for (let i = 0, x = 0, y = 0; i < n; i++, x++) {
    if (x === w) { x = 0; y++; }
    const W = x ? plane[i - 1] : y ? plane[i - w] : 0, N = y ? plane[i - w] : W, NW = x && y ? plane[i - w - 1] : W;
    let at = 0;
    while (prop[at] >= 0) at = property(prop[at], plane, w, i, x, y, W, N, NW, wpProperty[i], references) > cut[at] ? left[at] : right[at];
    const p = predictor[at];
    contexts[i] = local[at];
    if (p === 6) { coded[i] = residuals[i]; continue; }
    let r;
    if (p === 5) { const lo = W < N ? W : N, hi = W < N ? N : W, g = W + N - NW; r = plane[i] - (g < lo ? lo : g > hi ? hi : g); }
    else r = plane[i] - prediction(p, plane, w, i, x, y, W, N, NW, 0);
    coded[i] = r >= 0 ? r * 2 : -r * 2 - 1;
  }
  return {values: coded, contexts};
}

const learnedPlanes = new Map(), KEPT = 256;
function planeKey(plane, w, h) {
  let a = 2166136261, b = 0;
  for (let i = 0; i < plane.length; i++) { a = Math.imul(a ^ plane[i], 16777619); b = b + plane[i] * (i + 1) | 0; }
  return w + 'x' + h + ':' + (a >>> 0) + ':' + (b >>> 0);
}
export function learnedModel(plane, w, h, answer = null, options = undefined, references = []) {
  const key = planeKey(plane, w, h) + (options ? ':' + JSON.stringify(options) : '') + references.map(r => '|' + planeKey(r, w, h)).join('');
  let learned = learnedPlanes.get(key);
  if (learned === undefined) {
    if (learnedPlanes.size >= KEPT) learnedPlanes.delete(learnedPlanes.keys().next().value);
    learned = learnTree(plane, w, h, references.length ? {...options, references} : options, answer);
    learnedPlanes.set(key, learned && {tree: learned.tree, leaves: learned.leaves});
  } else if (learned) {
    const {residuals, properties} = answer || weighted(plane, w, h);
    learned = {...learned, ...codePlane(learned.tree, plane, w, h, residuals, properties, references)};
  }
  if (!learned) return null;
  const {tree, leaves, values, contexts} = learned, n = w * h;
  return {kind: 'smooth', tree, leaves, classes: leaves.length, width: w, height: h, stride: w, origin: 0, plane, minimum: 4,
    count: n, pieceValue: Int32Array.from(values), pieceDistance: new Int32Array(n), pieceContext: contexts};
}

export function treeModel(plane, w, h, learned = null, references = [], answer = null) {
  const leaves = learned ? learned.leaves : [Object.assign(leaf(5), {local: 0})], tree = learned ? learned.tree : leaves[0];
  const {residuals, properties} = answer || weighted(plane, w, h);
  const {values, contexts} = learned?.values ? learned : codePlane(tree, plane, w, h, residuals, properties, references);
  return {kind: 'smooth', tree, leaves, classes: leaves.length, width: w, height: h, stride: w, origin: 0, plane, minimum: 4,
    count: w * h, pieceValue: Int32Array.from(values), pieceDistance: new Int32Array(w * h), pieceContext: contexts};
}
function mergedCuts(cuts, residuals, properties, header) {
  const n = residuals.length, k = cuts.length + 1, TOK = 48, hist = new Float64Array(k * TOK), raw = new Float64Array(k);
  for (let i = 0; i < n; i++) {
    const p = properties[i];
    let lo = 0, hi = cuts.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (p > cuts[mid]) lo = mid + 1; else hi = mid; }
    const v = residuals[i];
    hist[lo * TOK + token(v)]++; raw[lo] += rawBits(v);
  }
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
export function planeModel(plane, w, h, options, references = []) {
  if (w > KERNEL_WIDTH || w * h > KERNEL_SAMPLES) {
    const none = {residuals: new Uint32Array(w * h), properties: new Int32Array(w * h)};
    const learn = {...options, references, predictors: options.predictors.filter(p => p !== 6), properties: options.properties.filter(p => p !== 15)};
    return treeModel(plane, w, h, learn.predictors.length >= 3 ? learnTree(plane, w, h, learn, none) : null, references, none);
  }
  const answer = weighted(plane, w, h), learned = learnTree(plane, w, h, {...options, references}, answer);
  return treeModel(plane, w, h, learned, references, answer);
}
