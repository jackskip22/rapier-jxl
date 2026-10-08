// SPDX-License-Identifier: MIT
// Deterministic Modular tree learning from bounded spatial samples. Each group selects its tree before tokenizing.
import {BitWriter, packSigned} from './bits.mjs';
import {writeImageHeader, writeModularFrameHeader, groupLayout, groupRect, groupPass, assembleCodestream, GROUP_DIM} from './frame.mjs';
import {ALPHABET, LZ77, RESIDUAL_CONFIG, leaf, split, channelTree, writeTree, writeModularHeader, writeChannelHistograms} from './modular.mjs';
import {codeWeighted} from './weighted.mjs';
import {admitOutputSize} from './admit.mjs';
import {planeFill} from './lossless.mjs';
import {writeModularAnsHistograms} from './ans.mjs';
import {losslessCoding} from './lossless-coding.mjs';
import {hybridToken} from './prefix.mjs';
import {colourTransform} from './rct-search.mjs';

const SAMPLE_SYMBOLS = 32, SAMPLE_Q = 4096;
const TRAIN_CONFIG = Object.freeze({split: 4, splitToken: 16, msb: 1, lsb: 2});
const PREDICTIVE = {samples: 65536, bins: 128, leaves: 64, depth: 12,
    properties: Object.freeze([15, 9, 10, 11, 12, 13, 14, 4, 5, 6, 7, 8, 2, 3]),
    predictors: Object.freeze([5, 3, 6, 1, 2, 4, 7, 8, 9, 10, 11, 12, 13, 0]), referenceKinds: Object.freeze([0, 1, 2, 3]),
    weighted: true, shared: false, references: true, mixed: true, dim: 1024, ans: true, hybrid: true, sharing: Object.freeze([160, 320])};
export const SAMPLE_RUNGS = Object.freeze({
  cheap: Object.freeze({samples: 1024, bins: 32, leaves: 8, depth: 5, properties: Object.freeze([9, 10, 11]), weighted: false, shared: true, references: false}),
  rich: Object.freeze({samples: 2048, bins: 48, leaves: 16, depth: 7, properties: Object.freeze([15, 9, 10, 11, 12, 13, 14]), weighted: true, shared: false, references: true}),
  deep: Object.freeze({samples: 2048, bins: 48, leaves: 16, depth: 7, properties: Object.freeze([15, 9, 10, 11, 12, 13, 14]), weighted: true, shared: false, references: true, mixed: true, dim: 1024, ans: true, hybrid: true}),
  thorough: Object.freeze({samples: 4096, bins: 48, leaves: 32, depth: 9, properties: Object.freeze([15, 9, 10, 11, 12, 13, 14]), weighted: true, shared: false, references: true, mixed: true, dim: 1024, ans: true, hybrid: true}),
  dense: Object.freeze({samples: 8192, bins: 48, leaves: 32, depth: 9, properties: Object.freeze([15, 9, 10, 11, 12, 13, 14]), weighted: true, shared: false, references: true, mixed: true, dim: 1024, ans: true, hybrid: true}),
  exhaustive: Object.freeze({samples: 16384, bins: 64, leaves: 48, depth: 10, properties: Object.freeze([15, 9, 10, 11, 12, 13, 14]), weighted: true, shared: false, references: true, mixed: true, dim: 1024, ans: true, hybrid: true}),
  expanded: Object.freeze({samples: 32768, bins: 96, leaves: 48, depth: 12, properties: Object.freeze([15, 9, 10, 11, 12, 13, 14]), weighted: true, shared: false, references: true, mixed: true, dim: 1024, ans: true, hybrid: true}),
  maximum: Object.freeze({samples: 65536, bins: 128, leaves: 64, depth: 12, properties: Object.freeze([15, 9, 10, 11, 12, 13, 14]), weighted: true, shared: false, references: true, mixed: true, dim: 1024, ans: true, hybrid: true}),
  predictive: Object.freeze(PREDICTIVE),
  precise: Object.freeze({...PREDICTIVE, trainConfig: TRAIN_CONFIG}),
  colour: Object.freeze({...PREDICTIVE, trainConfig: TRAIN_CONFIG, rctType: 13})
});
// Q12 log2, by exact integer squaring of a Q20 mantissa. All intermediates are below 2^42. No libm/logarithm,
// elapsed time or random source can change a split. The lazily extended table is only a mathematical cache.
let sampleNLog = new Float64Array(1);
function sampleEntropyTable(count) {
  if (sampleNLog.length > count) return sampleNLog;
  const table = new Float64Array(count + 1); table.set(sampleNLog);
  for (let n = Math.max(1, sampleNLog.length); n <= count; n++) {
    const exponent = 31 - Math.clz32(n);
    let value = n * (1048576 / (1 << exponent)), fraction = 0;
    for (let bit = 2048; bit; bit >>= 1) {
      value = Math.floor(value * value / 1048576);
      if (value >= 2097152) { value = Math.floor(value / 2); fraction += bit; }
    }
    table[n] = n * (exponent * SAMPLE_Q + fraction);
  }
  return sampleNLog = table;
}
function sampleEntropy(hist, table) {
  let sum = 0, cost = 0;
  for (let s = 0; s < hist.length; s++) { sum += hist[s]; cost += table[hist[s]]; }
  return table[sum] - cost;
}
const sampleGradient = (w, n, nw) => Math.max(Math.min(w, n), Math.min(Math.max(w, n), w + n - nw));

// One pixel from each stratum, with an integer hash choosing its position. Strata, not a fixed x/y residue class,
// avoid aliasing repeated text and tile widths. A small image contributes every pixel. There are no duplicates.
function samplePositions(length, cap) {
  const count = Math.min(length, cap), positions = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const lo = Math.floor(i * length / count), hi = Math.floor((i + 1) * length / count);
    let hash = Math.imul(i + 1, 0x9e3779b1); hash ^= hash >>> 16; hash = Math.imul(hash, 0x85ebca6b); hash ^= hash >>> 13;
    positions[i] = lo + (hash >>> 0) % (hi - lo);
  }
  return positions;
}

function samplePrediction(p, plane, width, i, x, y, w, n, nw) {
  if(p===0)return 0;if(p===1)return w;if(p===2)return n;if(p===3)return ((w+n)/2)|0;
  if(p===4){const g=w+n-nw;return Math.abs(g-w)<Math.abs(g-n)?w:n;}
  if(p===5)return sampleGradient(w,n,nw);
  const ne=y&&x+1<width?plane[i-width+1]:n;
  if(p===7)return ne;if(p===8)return nw;
  const ww=x>1?plane[i-2]:w;
  if(p===9)return ww;if(p===10)return ((w+nw)/2)|0;if(p===11)return ((nw+n)/2)|0;if(p===12)return ((n+ne)/2)|0;
  const nn=y>1?plane[i-2*width]:n,nee=y&&x+2<width?plane[i-width+2]:ne;
  if(p===13)return ((6*n-2*nn+7*w+ww+nee+3*ne+8)/16)|0;
  throw new Error('Unsupported predictor '+p);
}

function samplePropertyValue(property, plane, width, index, x, y, w, n, nw, weighted, references) {
  if (property >= 16) {
    const ref = references[(property - 16) >> 2], kind = (property - 16) & 3;
    if(kind===0)return Math.abs(ref.plane[index]);if(kind===1)return ref.plane[index];if(kind===2)return ref[index];
    const rp=ref.plane,rw=x?rp[index-1]:0,rn=y?rp[index-width]:rw,rnw=x&&y?rp[index-width-1]:rw;
    return rp[index]-sampleGradient(rw,rn,rnw);
  }
  if (property === 2) return y;
  if (property === 3) return x;
  if (property === 4) return Math.abs(n);
  if (property === 5) return Math.abs(w);
  if (property === 6) return n;
  if (property === 7) return w;
  if (property === 8) {
    if (!x) return w;
    const pw = x > 1 ? plane[index-2] : y ? plane[index-width-1] : 0;
    const pn = y ? plane[index-width-1] : pw, pnw = x > 1 && y ? plane[index-width-2] : pw;
    return w - (pw+pn-pnw);
  }
  if (property === 15) return weighted[index];
  if (property === 9) return w + n - nw;
  if (property === 10) return w - nw;
  if (property === 11) return nw - n;
  if (property === 12) return n - (y && x + 1 < width ? plane[index - width + 1] : n);
  if (property === 13) return n - (y > 1 ? plane[index - 2 * width] : n);
  return w - (x > 1 ? plane[index - 2] : w); // property 14
}
function sampleQuantize(values, bins) {
  const sorted = values.slice().sort(), cuts = [];
  for (let b = 1; b < bins; b++) {
    const cut = sorted[Math.floor(b * sorted.length / bins) - 1];
    if (cut < sorted[sorted.length - 1] && (!cuts.length || cut > cuts[cuts.length - 1])) cuts.push(cut);
  }
  const indices = new Uint8Array(values.length);
  for (let i = 0; i < values.length; i++) {
    let lo = 0, hi = cuts.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (values[i] > cuts[mid]) lo = mid + 1; else hi = mid; }
    indices[i] = lo;
  }
  return {cuts, indices};
}
function sampleModelBits(tree, leaves, freqs, config = RESIDUAL_CONFIG) {
  const writer = new BitWriter(256);
  writeChannelHistograms(writer, writeTree(writer, tree), freqs, l => leaves.indexOf(l), () => config);
  return writer.bitLength;
}
function sampleFullFreq(sample) { const freq = new Uint32Array(ALPHABET); freq.set(sample); return freq; }

// Reference-property splits apply only inside a group. Its first row and column use ordinary predictor leaves;
// the two edge leaves are reserved within the model's budget.
function sampleGuardReferences(model, predictor) {
  const nodes = [model.tree]; let references = false;
  for (const node of nodes) if (node.left) { references ||= node.property >= 16; nodes.push(node.left, node.right); }
  if (!references) return model;
  const edgeX = leaf(predictor), edgeY = leaf(predictor); edgeX.slot = model.leaves.length; edgeY.slot = edgeX.slot + 1;
  return {tree: split(2, 0, split(3, 0, model.tree, edgeX), edgeY), leaves: [...model.leaves, edgeX, edgeY], interior: model.tree, edgeX: edgeX.slot, edgeY: edgeY.slot};
}

// Joint prediction and context learning: each side of a split chooses its own predictor. The residual raw bits
// enter the sampled cost because they change when the predictor changes. Full pixels are tokenised only after
// the bounded sample search has selected the complete tree.
function learnSampleTree(columns, symbolSets, candidates, population, options) {
  const count = symbolSets[0].length, table = sampleEntropyTable(count);
  let alphabet = 1; for (const symbols of symbolSets) for (const symbol of symbols) alphabet = Math.max(alphabet, symbol + 1);
  const quantized = columns.map(column => ({property: column.property, ...sampleQuantize(column.values, options.bins)}));
  const histograms = ids => candidates.map((_, c) => { const hist = new Uint32Array(alphabet); for (const id of ids) hist[symbolSets[c][id]]++; return hist; });
  const config = options.trainConfig, rawBits = symbol => config ? symbol < config.splitToken ? 0 : ((symbol - config.splitToken) >> (config.msb + config.lsb)) + config.split - config.msb - config.lsb : Math.max(0, symbol - 1);
  const cost = hist => { let bits = sampleEntropy(hist, table); for (let s = 0; s < hist.length; s++) bits += hist[s] * rawBits(s) * SAMPLE_Q; return bits; };
  const cheapest = hist => { let selected = 0, bits = cost(hist[0]); for (let c = 1; c < hist.length; c++) { const next = cost(hist[c]); if (next < bits) { selected = c; bits = next; } } return {selected, bits}; };
  const ids = Uint32Array.from({length: count}, (_, i) => i), hist = histograms(ids), initial = cheapest(hist), predictor = candidates[initial.selected], root = leaf(predictor);
  let active = [{node: root, ids, hist, choice: initial, depth: 0}], leaves = 1;
  function propose(item) {
    if (item.depth >= options.depth || item.ids.length < 64) return null;
    let best = null;
    for (const column of quantized) {
      const buckets = candidates.map(() => new Uint32Array((column.cuts.length + 1) * alphabet));
      for (const id of item.ids) for (let c = 0; c < candidates.length; c++) buckets[c][column.indices[id] * alphabet + symbolSets[c][id]]++;
      const low = candidates.map(() => new Uint32Array(alphabet)), high = item.hist.map(h => h.slice()); let lowCount = 0;
      for (let b = 0; b < column.cuts.length; b++) {
        const previousCount = lowCount;
        for (let c = 0; c < candidates.length; c++) for (let s = 0; s < alphabet; s++) { const value = buckets[c][b * alphabet + s]; low[c][s] += value; high[c][s] -= value; if (!c) lowCount += value; }
        // Empty bins repeat the same histograms; strict ties already keep the earlier cut.
        if (lowCount === previousCount || lowCount < 24 || item.ids.length - lowCount < 24) continue;
        const lo = cheapest(low), hi = cheapest(high), gain = item.choice.bits - lo.bits - hi.bits;
        if (!best || gain > best.gain) best = {gain, column, bin: b, lo, hi};
      }
    }
    if (!best || best.gain <= 0) return null;
    best.low = histograms(item.ids.filter(id => best.column.indices[id] <= best.bin));
    best.high = item.hist.map((hist, c) => hist.map((value, s) => value - best.low[c][s]));
    const one = leaf(candidates[item.choice.selected]), left = leaf(candidates[best.hi.selected]), right = leaf(candidates[best.lo.selected]);
    const branch = split(best.column.property, best.column.cuts[best.bin], left, right);
    // A standalone header delta estimates the split overhead. The complete candidate still competes by its
    // actual bytes, including LZ77, against the preceding stream.
    const signal = Math.max(0, sampleModelBits(branch, [left, right], [sampleFullFreq(best.high[best.hi.selected]), sampleFullFreq(best.low[best.lo.selected])], config) - sampleModelBits(one, [one], [sampleFullFreq(item.hist[item.choice.selected])], config));
    const score = best.gain * population - (signal + 32) * SAMPLE_Q * count * (options.signalRepeats || 1);
    return score > 0 ? {...best, score} : null;
  }
  active[0].proposal = propose(active[0]);
  const reserve = columns.some(c => c.property >= 16) ? 2 : 0;
  while (leaves < options.leaves - reserve) {
    let chosen = -1;
    for (let i = 0; i < active.length; i++) if (active[i].proposal && (chosen < 0 || active[i].proposal.score > active[chosen].proposal.score)) chosen = i;
    if (chosen < 0) break;
    const item = active[chosen], proposal = item.proposal, lo = [], hi = [];
    for (const id of item.ids) (proposal.column.indices[id] > proposal.bin ? hi : lo).push(id);
    const left = leaf(candidates[proposal.hi.selected]), right = leaf(candidates[proposal.lo.selected]);
    Object.assign(item.node, split(proposal.column.property, proposal.column.cuts[proposal.bin], left, right));
    const children = [{node: left, ids: Uint32Array.from(hi), hist: proposal.high, choice: proposal.hi, depth: item.depth + 1}, {node: right, ids: Uint32Array.from(lo), hist: proposal.low, choice: proposal.lo, depth: item.depth + 1}];
    if (leaves + 1 < options.leaves - reserve) for (const child of children) child.proposal = propose(child);
    active.splice(chosen, 1, ...children); leaves++;
  }
  const ordered = active.map((item, slot) => { item.node.slot = slot; return item.node; });
  return sampleGuardReferences({tree: root, leaves: ordered}, predictor);
}

function samplePlan(plane, width, height, options, shared, previous, referenceOutput) {
  if (shared) return sampleFinishPlan(sampleTokenize(plane, width, height, null, null, shared, previous, referenceOutput), shared.predictor);
  const length = width * height, positions = samplePositions(length, options.samples), table = sampleEntropyTable(positions.length);
  const candidates = options.predictors || (options.weighted ? [5, 3, 6] : [5, 3]);
  const weighted = options.weighted ? new Uint32Array(length) : null, errors = options.weighted ? new Int32Array(length) : null;
  if (weighted) codeWeighted(null, null, plane, width, height, 0, undefined, weighted, errors);
  const scratchToken = new Int32Array(3);
  const symbols = candidates.map(() => new Uint8Array(positions.length)), histograms = candidates.map(() => new Uint32Array(options.trainConfig ? ALPHABET : SAMPLE_SYMBOLS)), extras = candidates.map(() => 0);
  const properties = [...options.properties.filter(property => property !== 15 || options.weighted), ...(options.references ? previous.flatMap((_, i) => (options.referenceKinds || [2]).map(kind => 16 + kind + 4 * i)) : [])], columns = properties.map(property => ({property, values: new Int32Array(positions.length)}));
  for (let k = 0; k < positions.length; k++) {
    const i = positions[k], y = (i / width) | 0, x = i - y * width;
    const w = x ? plane[i - 1] : y ? plane[i - width] : 0, n = y ? plane[i - width] : w, nw = x && y ? plane[i - width - 1] : w;
    for (let c = 0; c < candidates.length; c++) {
      const predictor = candidates[c], value = predictor === 6 ? weighted[i] : packSigned(plane[i] - samplePrediction(predictor,plane,width,i,x,y,w,n,nw));
      let symbol = 32 - Math.clz32(value), rawBits = Math.max(0, symbol - 1);
      if (options.trainConfig) { hybridToken(options.trainConfig, value, scratchToken); symbol = scratchToken[0]; rawBits = scratchToken[1]; }
      symbols[c][k] = symbol; histograms[c][symbol]++; extras[c] += rawBits;
    }
    for (const column of columns) column.values[k] = samplePropertyValue(column.property, plane, width, i, x, y, w, n, nw, errors, previous);
  }
  let selected = 0, price = Infinity;
  for (let c = 0; c < candidates.length; c++) { const bits = sampleEntropy(histograms[c], table) + extras[c] * SAMPLE_Q; if (bits < price) { price = bits; selected = c; } }
  const predictor = candidates[selected];
  // A uniform non-weighted tree avoids property 15 and its weighted state. Mixed trees may use that error
  // property with any leaf predictor; its state is shared with the weighted leaves.
  const learned = learnSampleTree(columns.filter(c => options.mixed || c.property !== 15 || predictor === 6), options.mixed ? symbols : [symbols[selected]], options.mixed ? candidates : [predictor], length, options);
  const result = sampleTokenize(plane, width, height, weighted, errors, learned, previous, referenceOutput);
  return sampleFinishPlan(result, predictor);
}
function sampleFinishPlan(result, predictor) {
  const {freqs, context} = result, count = result.leaves.length;
  function pricePlan(tree, leaves, frequencies) {
    const writer = new BitWriter(256), hist = writeChannelHistograms(writer, writeTree(writer, tree), frequencies, l => leaves.indexOf(l));
    let cost = writer.bitLength;
    for (let c = 0; c < frequencies.length; c++) for (let s = 0; s < ALPHABET; s++) cost += frequencies[c][s] * (hist[c + 1].code.lengths[s] || 0);
    return cost;
  }
  // Merging contexts preserves the token values only when their predictors agree.
  if (count > 1 && result.leaves.every(l => l.predictor === predictor)) {
    const merged = new Uint32Array(ALPHABET); for (const freq of freqs) for (let s = 0; s < ALPHABET; s++) merged[s] += freq[s];
    const one = leaf(predictor); one.slot = 0;
    if (pricePlan(one, [one], [merged]) <= pricePlan(result.tree, result.leaves, freqs)) { result.tree = one; result.leaves = [one]; result.freqs = [merged]; context.fill(0); }
  }
  return result;
}


// A shallow tree over bounded neighbour and reference properties can use a Cartesian lookup, built only from
// selected cuts (not all quantisation bins). Larger products and unsupported properties retain ordinary tree walking.
// This removes tree walking from the common pixel loop without changing a single context decision.
function sampleCompileLookup(tree) {
  const properties = [9, 10, 11, 18, 22, 26], cuts = properties.map(() => []), nodes = [tree];
  for (const node of nodes) if (node.left) {
    const p = properties.indexOf(node.property); if (p < 0) return null;
    cuts[p].push(node.splitval); nodes.push(node.left, node.right);
  }
  for (let p = 0; p < cuts.length; p++) cuts[p] = [...new Set(cuts[p])].sort((a, b) => a - b);
  const strides = []; let size = 1;
  for (const list of cuts) { strides.push(size); size *= list.length + 1; }
  if (size > 65536) return null;
  const table = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    let node = tree;
    while (node.left) { const p = properties.indexOf(node.property), bin = Math.floor(i / strides[p]) % (cuts[p].length + 1), value = bin ? cuts[p][bin - 1] + 1 : -768; node = value > node.splitval ? node.left : node.right; }
    table[i] = node.slot;
  }
  const maps = cuts.map((list, p) => {
    if (p >= 3 && !list.length) return null;
    const bound = p === 0 ? 768 : p < 3 ? 512 : 0, length = p >= 3 ? 511 : bound * 2 + 1;
    const map = new Uint16Array(length); let at = 0;
    for (let i = 0; i < map.length; i++) { while (at < list.length && i - bound > list[at]) at++; map[i] = at * strides[p]; }
    return map;
  });
  return {table, p9: maps[0], p10: maps[1], p11: maps[2], p18: maps[3], p22: maps[4], p26: maps[5]};
}
function sampleTokenize(plane, width, height, weighted, errors, learned, previous, referenceOutput) {
  const length = width * height, count = learned.leaves.length, freqs = Array.from({length: count}, () => new Uint32Array(ALPHABET));
  const token = new Uint16Array(length), extra = new Uint32Array(length), bits = new Uint8Array(length), context = new Uint8Array(length);
  let used = 0, run = 0; const runContexts = new Uint8Array(8);
  const emit = (ctx, value, copy = false) => {
    let symbol, nbits, payload;
    if (copy && value < 16) { symbol = 224 + value; nbits = 0; payload = 0; }
    else { const n = 31 - Math.clz32(value); symbol = copy ? 224 + 16 + n - 4 : n + 1; nbits = n < 0 ? 0 : n; payload = value - (n < 0 ? 0 : (1 << n)); }
    freqs[ctx][symbol]++; token[used] = symbol; extra[used] = payload; bits[used] = nbits; context[used++] = ctx;
  };
  const flush = () => {
    if (run >= 8) { emit(runContexts[0], 0); emit(runContexts[1], run - 8, true); }
    else for (let i = 0; i < run; i++) emit(runContexts[i], 0);
    run = 0;
  };
  const interior = learned.interior || learned.tree, noTree = !interior.left, lookup = noTree ? null : sampleCompileLookup(interior);
  for (let y = 0, i = 0; y < height; y++) for (let x = 0; x < width; x++, i++) {
    const w = x ? plane[i - 1] : y ? plane[i - width] : 0, n = y ? plane[i - width] : w, nw = x && y ? plane[i - width - 1] : w;
    let ctx;
    if (learned.interior && !y) ctx = learned.edgeY;
    else if (learned.interior && !x) ctx = learned.edgeX;
    else if (noTree) ctx = 0;
    else if (lookup) {
      let index = lookup.p9[w + n - nw + 768] + lookup.p10[w - nw + 512] + lookup.p11[nw - n + 512];
      if (lookup.p18) index += lookup.p18[previous[0][i]];
      if (lookup.p22) index += lookup.p22[previous[1][i]];
      if (lookup.p26) index += lookup.p26[previous[2][i]];
      ctx = lookup.table[index];
    }
    else {
      let node = interior;
      while (node.left) node = samplePropertyValue(node.property, plane, width, i, x, y, w, n, nw, errors, previous) > node.splitval ? node.left : node.right;
      ctx = node.slot;
    }
    const leafPredictor = learned.leaves[ctx].predictor;
    const value = leafPredictor === 6 ? weighted[i] : packSigned(plane[i] - samplePrediction(leafPredictor,plane,width,i,x,y,w,n,nw));
    if (referenceOutput) referenceOutput[i] = leafPredictor === 5 ? (value + 1) >> 1 : Math.abs(plane[i] - sampleGradient(w, n, nw));
    if (!value) { if (run < 8) runContexts[run] = ctx; run++; }
    else {
      if (run) flush();
      const symbol = 32 - Math.clz32(value), nbits = symbol - 1;
      freqs[ctx][symbol]++; token[used] = symbol; extra[used] = value - (1 << nbits); bits[used] = nbits; context[used++] = ctx;
    }
  }
  flush();
  return {...learned, freqs, token, extra, bits, context, used};
}

function sampleClusterPlan(plan, penalty) {
  const table = sampleEntropyTable(plan.used);
  const key = c => [c.split,c.msb,c.lsb].join(',');
  const groups = plan.freqs.map((freq, i) => {const config=plan.configs?.[i] || RESIDUAL_CONFIG;return {freq, ids:[i], config, key:key(config), slot:i, cost:sampleEntropy(freq,table)};});
  // Stable slots retain unchanged pair costs; the scan order still resolves ties.
  const count=groups.length,costs=new Float64Array(count*count).fill(NaN);
  while(groups.length>1){
    let best=null;
    for(let i=0;i<groups.length;i++)for(let j=i+1;j<groups.length;j++){
      const a=groups[i],b=groups[j];if(a.key!==b.key)continue;
      const index=a.slot*count+b.slot;
      let cost=costs[index];
      if(Number.isNaN(cost)){const freq=a.freq.map((value,k)=>value+b.freq[k]);cost=costs[index]=sampleEntropy(freq,table);}
      const delta=cost-a.cost-b.cost;
      if(delta<penalty*SAMPLE_Q&&(!best||delta<best.delta))best={i,j,cost,delta};
    }
    if(!best)break;
    const a=groups[best.i],b=groups[best.j],freq=a.freq.map((value,k)=>value+b.freq[k]);
    groups[best.i]={...a,freq,cost:best.cost,ids:[...a.ids,...b.ids]};groups.splice(best.j,1);
    for(let i=0;i<count;i++){costs[a.slot*count+i]=NaN;costs[i*count+a.slot]=NaN;}
  }
  const map=new Uint8Array(plan.leaves.length);groups.forEach((g,i)=>g.ids.forEach(id=>map[id]=i));
  return {...plan,freqs:groups.map(g=>g.freq),configs:groups.map(g=>g.config),histogramMap:map,context:plan.context.map(i=>map[i])};
}

function sampleWriteModel(writer, plans, ans = false, price = false) {
  const histogram = new Map(); let base = 0;
  for (const plan of plans) {
    plan.leaves.forEach((item, i) => histogram.set(item, base + (plan.histogramMap?.[i] ?? i)));
    base += plan.freqs.length;
  }

  const freqs = plans.flatMap(samplePlan => samplePlan.freqs);
  const configs = plans.flatMap(plan => plan.freqs.map((_, i) => plan.configs?.[i] || RESIDUAL_CONFIG));
  const ordered = writeTree(writer, channelTree(plans.map(samplePlan => samplePlan.tree)));
  if (ans) { const write = writeModularAnsHistograms(writer, ordered, freqs, l => histogram.get(l), i => configs[i]); return {write: () => write(plans)}; }
  const histograms = writeChannelHistograms(writer, ordered, freqs, l => histogram.get(l), i => configs[i]);
  let dataBits = 0;
  if (price) for (let c = 0; c < freqs.length; c++) for (let s = 0; s < freqs[c].length; s++) if (freqs[c][s]) {
    const config = s >= LZ77.minSymbol ? LZ77.lengthConfig : configs[c];
    const symbol = s >= LZ77.minSymbol ? s - LZ77.minSymbol : s;
    const raw = symbol < config.splitToken ? 0 : config.split - config.msb - config.lsb + ((symbol - config.splitToken) >> (config.msb + config.lsb));
    dataBits += freqs[c][s] * (histograms[c + 1].code.lengths[s] + raw);
  }
  return {dataBits, write: () => {
    let offset = 1;
    for (const samplePlan of plans) {
      const codes = histograms.slice(offset, offset + samplePlan.freqs.length).map(h => h.code); offset += samplePlan.freqs.length;
      for (let i = 0; i < samplePlan.used; i++) { const code = codes[samplePlan.context[i]], symbol = samplePlan.token[i]; const length = code.lengths[symbol]; writer.write(length + samplePlan.bits[i], code.codes[symbol] + samplePlan.extra[i] * (1 << length)); }
    }
  }};
}

function sampleProjectIntegers(plans) {
  const scratch = [0, 0, 0];
  for (const plan of plans) {
    const raw = plan.freqs.map(freq => {
      let size = 1;
      for (let symbol = 1; symbol < 32; symbol++) if (freq[symbol]) size = 2 * (1 << (symbol - 1));
      return new Uint32Array(size + 33);
    });
    for (let i = 0; i < plan.used; i++) {
      const symbol = plan.token[i], counts = raw[plan.context[i]];
      if (symbol >= 224) counts[counts.length - 33 + symbol - 224]++;
      else { const value = symbol ? (1 << (symbol - 1)) + plan.extra[i] : 0; counts[value]++; }
    }
    const selected = raw.map(counts => losslessCoding(counts)[1]);
    plan.configs = selected.map(model => model.config); plan.freqs = selected.map(model => model.freqs);
    for (let i = 0; i < plan.used; i++) if (plan.token[i] < 224) {
      const symbol = plan.token[i], value = symbol ? (1 << (symbol - 1)) + plan.extra[i] : 0;
      hybridToken(plan.configs[plan.context[i]], value, scratch);
      plan.token[i] = scratch[0]; plan.bits[i] = scratch[1]; plan.extra[i] = scratch[2];
    }
  }
}

function sampleImageModel(rgba, width, height, shape, options) {
  const length = width * height, positions = samplePositions(length, options.samples), table = sampleEntropyTable(positions.length);
  const value = (i, c) => {
    if (shape.channels < 3) return rgba[i * 4 + (c ? 3 : 0)];
    if (c === 3) return rgba[i * 4 + 3];
    const co = rgba[i * 4] - rgba[i * 4 + 2], tmp = rgba[i * 4 + 2] + (co >> 1), cg = rgba[i * 4 + 1] - tmp;
    return c === 0 ? tmp + (cg >> 1) : c === 1 ? co : cg;
  };
  return Array.from({length: shape.channels}, (_, c) => {
    const hist = [new Uint32Array(SAMPLE_SYMBOLS), new Uint32Array(SAMPLE_SYMBOLS)], symbols = [new Uint8Array(positions.length), new Uint8Array(positions.length)], extra = [0, 0];
    const columns = options.properties.map(property => ({property, values: new Int32Array(positions.length)}));
    for (let k = 0; k < positions.length; k++) {
      const i = positions[k], y = (i / width) | 0, x = i - y * width, gx = x & 255, gy = y & 255;
      const w = gx ? value(i - 1, c) : gy ? value(i - width, c) : 0, n = gy ? value(i - width, c) : w, nw = gx && gy ? value(i - width - 1, c) : w;
      const here = value(i, c), predictions = [sampleGradient(w, n, nw), ((w + n) / 2) | 0];
      for (let p = 0; p < 2; p++) { const symbol = 32 - Math.clz32(packSigned(here - predictions[p])); hist[p][symbol]++; symbols[p][k] = symbol; extra[p] += Math.max(0, symbol - 1); }
      for (const column of columns) column.values[k] = column.property === 9 ? w + n - nw : column.property === 10 ? w - nw : nw - n;
    }
    const selected = sampleEntropy(hist[1], table) + extra[1] * SAMPLE_Q < sampleEntropy(hist[0], table) + extra[0] * SAMPLE_Q ? 1 : 0, predictor = selected ? 3 : 5;
    return {...learnSampleTree(columns, [symbols[selected]], [predictor], length, {...options, signalRepeats: Math.ceil(width / GROUP_DIM) * Math.ceil(height / GROUP_DIM)}), predictor};
  });
}

// Every group uses its own pixels and the pass's fixed setup. Shared trees are learned once before dispatch;
// richer trees are learned from each group's pixels on whichever thread codes it.
export function sampledGroup(setup) {
  const {channels, options, shared} = setup, fill = planeFill(setup, options.rctType === undefined ? undefined : colourTransform(options.rctType, channels));
  let planes;
  return (rgba, stride, x0, y0, w, h, target) => {
    if (!planes || planes[0].length < w * h) planes = Array.from({length: channels}, () => new Int16Array(w * h));
    fill(planes, rgba, stride, x0, y0, w, h);
    const references = options.references ? planes.map((_, c) => c + 1 < channels ? Object.assign(new Uint16Array(w * h), {plane: planes[c]}) : null) : [];
    const plans = planes.map((plane, c) => samplePlan(plane, w, h, options, shared?.[c], references.slice(0, c).reverse(), references[c]));
    const prepare = (ans, section = new BitWriter(options.ans && !ans ? 256 : w * h * channels + 256), models = plans) => {
      if (!target) writeModularHeader(section, {useGlobalTree: false});
      const model = sampleWriteModel(section, models, ans, options.ans && !ans);
      if (target) writeModularHeader(section, {transforms: channels >= 3 ? [{type: 'rct', beginC: 0, rctType: options.rctType ?? 6}] : []});
      return {section, ...model};
    };
    if (!options.ans) { const model = prepare(false, target); model.write(); return target ? undefined : model.section.finish(); }
    const offset = target?.bitLength || 0, bytes = bits => Math.ceil((offset + bits) / 8);
    const choose = (best, models = plans) => {
      const prefix = prepare(false, undefined, models), ans = prepare(true, undefined, models);
      ans.write();
      const prefixBytes = bytes(prefix.section.bitLength + prefix.dataBits), ansBytes = bytes(ans.section.bitLength);
      const bestBytes = best ? bytes(best.bitLength) : Infinity;
      // Exact histogram prices include raw bits and padding. Equal sizes keep the earlier prefix candidate.
      if (prefixBytes < bestBytes && prefixBytes <= ansBytes) {
        if (prefix.section.at + Math.ceil(prefix.dataBits / 8) + 5 >= prefix.section.bytes.length) prefix.section.grow(Math.ceil(prefix.dataBits / 8));
        prefix.write(); return prefix.section;
      }
      return ansBytes < bestBytes ? ans.section : best;
    };
    let section = choose(null);
    for (const penalty of options.sharing || []) section = choose(section, plans.map(plan => sampleClusterPlan(plan, penalty)));
    if (options.hybrid) {
      sampleProjectIntegers(plans); section = choose(section);
      for (const penalty of options.sharing || []) section = choose(section, plans.map(plan => sampleClusterPlan(plan, penalty)));
    }
    if (target) { target.append(section); return; }
    return section.finish();
  };
}

export function* sampledSteps(rgba, width, height, shape, colorSpace, options, pooled, ceiling = Infinity) {
  const {channels} = shape, dim = options.dim || GROUP_DIM, layout = groupLayout(width, height, dim), groups = layout.groupsX * layout.groupsY;
  // Histogram IDs share an 8-bit context map with the distance histogram.
  const maxLeaves = Math.floor(255 / channels);
  if (options.leaves > maxLeaves) options = {...options, leaves: maxLeaves};
  const shared = options.shared ? sampleImageModel(rgba, width, height, shape, options) : null;
  const setup = {channels, alpha: shape.alpha, palette: null, options, shared, dim}, group = sampledGroup(setup);
  const header = new BitWriter(128), global = new BitWriter(1024), sections = [], transforms = channels >= 3 ? [{type: 'rct', beginC: 0, rctType: options.rctType ?? 6}] : [];
  writeImageHeader(header, width, height, shape.colour, shape.alpha, {colorSpace}); writeModularFrameHeader(header, {alpha: shape.alpha, shift: dim === 1024 ? 3 : dim === 512 ? 2 : 1});
  let sectionBytes = 0;
  const append = bytes => { sectionBytes += bytes.length; admitOutputSize(sectionBytes); sections.push(bytes); return bytes; };
  global.write(1, 1); global.write(1, 1);
  if (layout.single) {
    group(rgba, width, 0, 0, width, height, global); append(global.finish());
    yield 1;
    if (sectionBytes >= ceiling) return null;
    return assembleCodestream(header, sections);
  }
  const leaves = Array.from({length: channels}, () => leaf(5));
  writeChannelHistograms(global, writeTree(global, channelTree(leaves)), leaves.map(() => new Uint32Array(ALPHABET)), l => leaves.indexOf(l));
  writeModularHeader(global, {transforms}); append(global.finish());
  // Completed sections are a lower bound; the frame header and table of contents can only add bytes.
  if (sectionBytes >= ceiling) return null;
  for (let i = 0; i < layout.dcGroupsX * layout.dcGroupsY + 1; i++) sections.push(new Uint8Array(0));
  if ((yield* groupPass({pooled, kind: 'sampled', setup, dim, at: g => (g + 1) / groups, stop: g => g + 1 < groups, byteCeiling: ceiling - sectionBytes},
    groups, g => append(group(rgba, width, ...groupRect(layout, width, height, g, dim))), (g, bytes) => append(bytes))) === null) return null;
  return assembleCodestream(header, sections);
}
