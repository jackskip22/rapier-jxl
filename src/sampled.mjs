// SPDX-License-Identifier: MIT
// Bounded, deterministic MA-tree learning for the effort door. Only samples enter the split search; each group's
// pixels are predicted and tokenised once. The emitted tree is an ordinary Modular tree, not a decoder extension.
import {BitWriter, packSigned} from './bits.mjs';
import {writeImageHeader, writeModularFrameHeader, groupLayout, groupRect, groupPass, assembleCodestream, GROUP_DIM} from './frame.mjs';
import {ALPHABET, leaf, split, channelTree, writeTree, writeModularHeader, writeChannelHistograms} from './modular.mjs';
import {codeWeighted} from './weighted.mjs';
import {admitOutputSize} from './admit.mjs';
import {planeFill} from './lossless.mjs';

const SAMPLE_SYMBOLS = 32, SAMPLE_Q = 4096;
export const SAMPLE_RUNGS = Object.freeze({
  cheap: Object.freeze({samples: 1024, bins: 32, leaves: 8, depth: 5, properties: Object.freeze([9, 10, 11]), weighted: false, shared: true, references: false}),
  rich: Object.freeze({samples: 2048, bins: 48, leaves: 16, depth: 7, properties: Object.freeze([15, 9, 10, 11, 12, 13, 14]), weighted: true, shared: false, references: true})
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
function samplePropertyValue(property, plane, width, index, x, y, w, n, nw, weighted, references) {
  if (property >= 18) return references[(property - 18) >> 2][index];
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
function sampleModelBits(tree, leaves, freqs) {
  const writer = new BitWriter(256);
  writeChannelHistograms(writer, writeTree(writer, tree), freqs, l => leaves.indexOf(l));
  return writer.bitLength;
}
function sampleFullFreq(sample) { const freq = new Uint32Array(ALPHABET); freq.set(sample); return freq; }

// Inputs are sampled property columns and residual-token symbols, not full image planes. The best positive split
// is taken next, with deterministic property/cut/leaf ties. Prefix headers and the tree's own encoded header are
// charged before accepting a split, in addition to token entropy. Extra residual bits do not change on a split.
function learnSampleTree(columns, symbols, predictor, population, options) {
  const table = sampleEntropyTable(symbols.length), quantized = columns.map(column => ({property: column.property, ...sampleQuantize(column.values, options.bins)}));
  const histogram = ids => { const hist = new Uint32Array(SAMPLE_SYMBOLS); for (const id of ids) hist[symbols[id]]++; return hist; };
  const ids = Uint32Array.from({length: symbols.length}, (_, i) => i), root = leaf(predictor);
  let active = [{node: root, ids, hist: histogram(ids), depth: 0}], leaves = 1;
  function propose(item) {
    if (item.depth >= options.depth || item.ids.length < 64) return null;
    const parent = sampleEntropy(item.hist, table), count = item.ids.length;
    let best = null;
    for (const column of quantized) {
      const buckets = new Uint32Array((column.cuts.length + 1) * SAMPLE_SYMBOLS);
      for (const id of item.ids) buckets[column.indices[id] * SAMPLE_SYMBOLS + symbols[id]]++;
      const low = new Uint32Array(SAMPLE_SYMBOLS), high = item.hist.slice(); let lowCount = 0;
      for (let b = 0; b < column.cuts.length; b++) {
        for (let s = 0; s < SAMPLE_SYMBOLS; s++) { const value = buckets[b * SAMPLE_SYMBOLS + s]; low[s] += value; high[s] -= value; lowCount += value; }
        if (lowCount < 24 || count - lowCount < 24) continue;
        const gain = parent - sampleEntropy(low, table) - sampleEntropy(high, table);
        if (!best || gain > best.gain) best = {gain, column, bin: b, low: low.slice(), high: high.slice()};
      }
    }
    if (!best || best.gain <= 0) return null;
    const one = leaf(predictor), left = leaf(predictor), right = leaf(predictor);
    const branch = split(best.column.property, best.column.cuts[best.bin], left, right);
    // A standalone split's exact header delta is a local signal estimate; the final whole model is
    // priced again with ALL emitted tokens, including LZ77, and can collapse to its one-context alternative.
    const signal = Math.max(0, sampleModelBits(branch, [left, right], [sampleFullFreq(best.high), sampleFullFreq(best.low)]) - sampleModelBits(one, [one], [sampleFullFreq(item.hist)]));
    const score = best.gain * population - (signal + 32) * SAMPLE_Q * symbols.length * (options.signalRepeats || 1);
    return score > 0 ? {...best, score} : null;
  }
  active[0].proposal = propose(active[0]);
  const reserve = columns.some(c => c.property >= 18) ? 2 : 0;
  while (leaves < options.leaves - reserve) {
    let chosen = -1;
    for (let i = 0; i < active.length; i++) if (active[i].proposal && (chosen < 0 || active[i].proposal.score > active[chosen].proposal.score)) chosen = i;
    if (chosen < 0) break;
    const item = active[chosen], proposal = item.proposal, lo = [], hi = [];
    for (const id of item.ids) (proposal.column.indices[id] > proposal.bin ? hi : lo).push(id);
    const left = leaf(predictor), right = leaf(predictor);
    Object.assign(item.node, split(proposal.column.property, proposal.column.cuts[proposal.bin], left, right));
    const children = [{node: left, ids: Uint32Array.from(hi), hist: proposal.high, depth: item.depth + 1}, {node: right, ids: Uint32Array.from(lo), hist: proposal.low, depth: item.depth + 1}];
    for (const child of children) child.proposal = propose(child);
    active.splice(chosen, 1, ...children); leaves++;
  }
  const ordered = active.map((item, slot) => { item.node.slot = slot; return item.node; });
  return sampleGuardReferences({tree: root, leaves: ordered}, predictor);
}

// Reference-property splits apply only inside a group. Its first row and column use ordinary predictor leaves;
// the two edge leaves are reserved within the model's budget.
function sampleGuardReferences(model, predictor) {
  const nodes = [model.tree]; let references = false;
  for (const node of nodes) if (node.left) { references ||= node.property >= 18; nodes.push(node.left, node.right); }
  if (!references) return model;
  const edgeX = leaf(predictor), edgeY = leaf(predictor); edgeX.slot = model.leaves.length; edgeY.slot = edgeX.slot + 1;
  return {tree: split(2, 0, split(3, 0, model.tree, edgeX), edgeY), leaves: [...model.leaves, edgeX, edgeY], interior: model.tree, edgeX: edgeX.slot, edgeY: edgeY.slot};
}

function samplePlan(plane, width, height, options, shared, previous, referenceOutput) {
  if (shared) return sampleFinishPlan(sampleTokenize(plane, width, height, shared.predictor, null, null, shared, previous, referenceOutput), shared.predictor);
  const length = width * height, positions = samplePositions(length, options.samples), table = sampleEntropyTable(positions.length);
  const candidates = options.weighted ? [5, 3, 6] : [5, 3];
  const weighted = options.weighted ? new Uint32Array(length) : null, errors = options.weighted ? new Int32Array(length) : null;
  if (weighted) codeWeighted(null, null, plane, width, height, 0, undefined, weighted, errors);
  const symbols = candidates.map(() => new Uint8Array(positions.length)), histograms = candidates.map(() => new Uint32Array(SAMPLE_SYMBOLS)), extras = candidates.map(() => 0);
  const properties = [...options.properties.filter(property => property !== 15 || options.weighted), ...(options.references ? previous.map((_, i) => 18 + 4 * i) : [])], columns = properties.map(property => ({property, values: new Int32Array(positions.length)}));
  for (let k = 0; k < positions.length; k++) {
    const i = positions[k], y = (i / width) | 0, x = i - y * width;
    const w = x ? plane[i - 1] : y ? plane[i - width] : 0, n = y ? plane[i - width] : w, nw = x && y ? plane[i - width - 1] : w;
    for (let c = 0; c < candidates.length; c++) {
      const predictor = candidates[c], value = predictor === 6 ? weighted[i] : packSigned(plane[i] - (predictor === 3 ? ((w + n) / 2) | 0 : sampleGradient(w, n, nw)));
      const symbol = 32 - Math.clz32(value); symbols[c][k] = symbol; histograms[c][symbol]++; extras[c] += Math.max(0, symbol - 1);
    }
    for (const column of columns) column.values[k] = samplePropertyValue(column.property, plane, width, i, x, y, w, n, nw, errors, previous);
  }
  let selected = 0, price = Infinity;
  for (let c = 0; c < candidates.length; c++) { const bits = sampleEntropy(histograms[c], table) + extras[c] * SAMPLE_Q; if (bits < price) { price = bits; selected = c; } }
  const predictor = candidates[selected];
  // Property 15 forces the decoder to maintain weighted state even with another leaf predictor. Avoid buying that
  // state for a non-weighted plan: the other properties are direct neighbour differences.
  const learned = learnSampleTree(columns.filter(c => c.property !== 15 || predictor === 6), symbols[selected], predictor, length, options);
  const result = sampleTokenize(plane, width, height, predictor, weighted, errors, learned, previous, referenceOutput);
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
  if (count > 1) {
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
function sampleTokenize(plane, width, height, predictor, weighted, errors, learned, previous, referenceOutput) {
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
    const value = predictor === 6 ? weighted[i] : packSigned(plane[i] - (predictor === 3 ? ((w + n) / 2) | 0 : sampleGradient(w, n, nw)));
    if (referenceOutput) referenceOutput[i] = predictor === 5 ? (value + 1) >> 1 : Math.abs(plane[i] - sampleGradient(w, n, nw));
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

function sampleWriteModel(writer, plans) {
  const leaves = plans.flatMap(samplePlan => samplePlan.leaves), freqs = plans.flatMap(samplePlan => samplePlan.freqs);
  const histograms = writeChannelHistograms(writer, writeTree(writer, channelTree(plans.map(samplePlan => samplePlan.tree))), freqs, l => leaves.indexOf(l));
  return () => {
    let offset = 1;
    for (const samplePlan of plans) {
      const codes = histograms.slice(offset, offset + samplePlan.leaves.length).map(h => h.code); offset += samplePlan.leaves.length;
      for (let i = 0; i < samplePlan.used; i++) { const code = codes[samplePlan.context[i]], symbol = samplePlan.token[i]; const length = code.lengths[symbol]; writer.write(length + samplePlan.bits[i], code.codes[symbol] + samplePlan.extra[i] * (1 << length)); }
    }
  };
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
    return {...learnSampleTree(columns, symbols[selected], predictor, length, {...options, signalRepeats: Math.ceil(width / GROUP_DIM) * Math.ceil(height / GROUP_DIM)}), predictor};
  });
}

// Every group uses its own pixels and the pass's fixed setup. Shared trees are learned once before dispatch;
// richer trees are learned from each group's pixels on whichever thread codes it.
export function sampledGroup(setup) {
  const {channels, options, shared} = setup, fill = planeFill(setup);
  const planes = Array.from({length: channels}, () => new Int16Array(GROUP_DIM * GROUP_DIM));
  return (rgba, stride, x0, y0, w, h, target) => {
    fill(planes, rgba, stride, x0, y0, w, h);
    const references = options.references ? planes.map((_, c) => c + 1 < channels ? new Uint16Array(w * h) : null) : [];
    const plans = planes.map((plane, c) => samplePlan(plane, w, h, options, shared?.[c], references.slice(0, c).reverse(), references[c]));
    const section = target || new BitWriter(w * h * channels + 256);
    if (!target) writeModularHeader(section, {useGlobalTree: false});
    const write = sampleWriteModel(section, plans);
    if (target) writeModularHeader(section, {transforms: channels >= 3 ? [{type: 'rct', beginC: 0, rctType: 6}] : []});
    write();
    return target ? undefined : section.finish();
  };
}

export function* sampledSteps(rgba, width, height, shape, colorSpace, options, pooled) {
  const {channels} = shape, layout = groupLayout(width, height), groups = layout.groupsX * layout.groupsY;
  const shared = options.shared ? sampleImageModel(rgba, width, height, shape, options) : null;
  const setup = {channels, alpha: shape.alpha, palette: null, options, shared}, group = sampledGroup(setup);
  const header = new BitWriter(128), global = new BitWriter(1024), sections = [], transforms = channels >= 3 ? [{type: 'rct', beginC: 0, rctType: 6}] : [];
  writeImageHeader(header, width, height, shape.colour, shape.alpha, {colorSpace}); writeModularFrameHeader(header, {alpha: shape.alpha});
  let sectionBytes = 0;
  const append = bytes => { sectionBytes += bytes.length; admitOutputSize(sectionBytes); sections.push(bytes); };
  global.write(1, 1); global.write(1, 1);
  if (layout.single) {
    group(rgba, width, 0, 0, width, height, global); append(global.finish());
    if (yield 1) return null;
    return assembleCodestream(header, sections);
  }
  const leaves = Array.from({length: channels}, () => leaf(5));
  writeChannelHistograms(global, writeTree(global, channelTree(leaves)), leaves.map(() => new Uint32Array(ALPHABET)), l => leaves.indexOf(l));
  writeModularHeader(global, {transforms}); append(global.finish());
  for (let i = 0; i < layout.dcGroupsX * layout.dcGroupsY + 1; i++) sections.push(new Uint8Array(0));
  if ((yield* groupPass({pooled, kind: 'sampled', setup, at: g => (g + 1) / groups, stop: () => true},
    groups, g => append(group(rgba, width, ...groupRect(layout, width, height, g))), (g, bytes) => append(bytes))) === null) return null;
  return assembleCodestream(header, sections);
}
