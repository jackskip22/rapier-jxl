// SPDX-License-Identifier: MIT
// The effort door's work (effort.mjs): effort 1's stream, the rungs above it, and the group work of the weighted search
// that a pool of workers shares (pool.mjs). Every choice is integer arithmetic: the same input and options write the
// same bytes everywhere, on one thread or many.
import {BitWriter, part, scaled} from './bits.mjs';
import {writeImageHeader, writeModularFrameHeader, groupLayout, groupRect, groupPass, addCounts, assembleCodestream, GROUP_DIM} from './frame.mjs';
import {buildCode, writePrefixCode} from './prefix.mjs';
import {AVERAGE_PREDICTOR, GRADIENT_PREDICTOR, ALPHABET, leaf, split, channelTree, writeTree, writeModularHeader, writeChannelHistograms, codeChannel} from './modular.mjs';
import {inspectPixels, losslessSteps, planeFill} from './lossless.mjs';
import {lossySteps} from './lossy.mjs';
import {WEIGHTED_PREDICTOR, WEIGHTED_PROPERTY, WEIGHTED_CUTS, codeWeighted} from './weighted.mjs';
import {fault, admitOptions, admitPixels} from './admit.mjs';
import {localSteps} from './local.mjs';
import {rctSearchSteps} from './rct-search.mjs';

// The hurry in a step's reply: the caller's flag, or for a pooled pass a reply of null (ended) or {hurried}.
const hurryOf = reply => reply === null || (typeof reply === 'object' ? reply.hurried : reply);

// The door's options as every door reads them, and the effort, which this door alone reads (the core, one rung, does
// not): a whole number from 1 to 9, 1 when absent. Admitted at once; the steps follow. With `pool` (pool.mjs drives
// them), an exact picture of more than one group yields each pass over its groups as one request: the same bytes.
export function effortJob(data, width, height, options, pool) {
  const {quality, colorSpace} = admitOptions(options), effort = options?.effort === undefined ? 1 : options.effort;
  if (!Number.isInteger(effort) || effort < 1 || effort > 9) throw fault('JXL_INPUT', 'Effort is a whole number from 1 to 9.');
  admitPixels(data, width, height);
  return effortSteps(data, width, height, quality, colorSpace, effort, pool && quality >= 100 && !groupLayout(width, height).single);
}

// Effort 1 is the core's work (index.mjs), step for step; the rungs run after it and keep a smaller stream if they
// find one. A search that runs out of memory leaves the smallest completed stream standing.
function* effortSteps(data, width, height, quality, colorSpace, effort, pooled) {
  const shape = inspectPixels(data, width, height);
  if (quality < 100) {
    if (!shape.palette) return yield* lossySteps(data, width, height, {quality, shape, colorSpace});
    const exact = yield* part(losslessSteps(data, width, height, {shape, colorSpace}), 0, 2);
    let bytes;
    try { bytes = yield* part(lossySteps(data, width, height, {quality, shape, colorSpace}), 1, 2); }
    catch (error) { if (error.code !== 'JXL_SIZE' && (!(error instanceof RangeError) || error.code)) throw error; bytes = exact; }
    return exact.length <= bytes.length ? exact : bytes;
  }
  if (effort < 2) return yield* losslessSteps(data, width, height, {shape, colorSpace, pooled});
  let best = yield* part(losslessSteps(data, width, height, {shape, colorSpace, pooled}), 0, 2);
  const direct = shape.palette ? {...shape, palette: null} : shape;
  if (effort >= 4) {
    const searches = [searchSteps(data, width, height, direct, colorSpace, 3, pooled)];
    if (shape.palette) searches.push(localSteps(data, width, height, shape, colorSpace, 4, true, pooled));
    if (effort >= 6) {
      searches.push(localSteps(data, width, height, shape, colorSpace, 6, false, pooled));
      if (shape.palette) searches.push(localSteps(data, width, height, shape, colorSpace, 6, true, pooled));
    }
    searches.push(rctSearchSteps(data, width, height, shape, colorSpace, pooled));
    for (let i = 0; i < searches.length; i++) {
      try {
        let step, reply, hurried = false;
        while (!(step = searches[i].next(reply)).done) hurried = hurryOf(reply = yield scaled(step.value, done => 0.5 + (i + done) / (2 * searches.length)));
        if (step.value && step.value.length < best.length) best = step.value;
        if (hurried) return best;
      } catch (error) { if (error.code !== 'JXL_SIZE' && (!(error instanceof RangeError) || error.code)) throw error; }
    }
    return best;
  }
  try {
    const bytes = yield* part(searchSteps(data, width, height, direct, colorSpace, effort, pooled), 1, 2);
    if (bytes && bytes.length < best.length) best = bytes;
  } catch (error) { if (error.code !== 'JXL_SIZE' && (!(error instanceof RangeError) || error.code)) throw error; }
  return best;
}

// A token's raw bits: a residual token s above zero carries s - 1 of them, an LZ77 length token above 235 s - 236.
const raw = s => Math.max(0, s < 224 ? s - 1 : s - 236);
// A histogram's complete cost in bits: its prefix code's header and every token's code and raw bits.
function cost(freqs) {
  const code = buildCode(freqs), writer = new BitWriter(128);
  writePrefixCode(writer, code);
  let bits = writer.bitLength;
  for (let s = 0; s < freqs.length; s++) if (freqs[s]) bits += freqs[s] * (code.lengths[s] + raw(s));
  return bits;
}
const sum = histograms => { const out = new Uint32Array(ALPHABET); for (const h of histograms) for (let s = 0; s < ALPHABET; s++) out[s] += h[s]; return out; };

const CONTEXTS = WEIGHTED_CUTS.length + 1, IDENTITY = Int32Array.from({length: CONTEXTS}, (_, k) => k);

// A group of the search, here or in a pool's worker. Counting, every channel goes into `target` twice: under effort 1's
// predictor (`first`, one histogram per channel) and under the weighted one, its tokens kept by error interval
// (CONTEXTS histograms per channel after those). Writing, each channel through its plan (`plans`: the leaf, its codes
// and the intervals' contexts) into `target`, or, when none, as the group's own section, whose bytes it returns.
export function searchGroup(setup) {
  const {channels, first, plans} = setup, fill = planeFill(setup), leaves = first?.map(p => leaf(p));
  const planes = Array.from({length: channels}, () => new Int16Array(GROUP_DIM * GROUP_DIM));
  return (rgba, stride, x0, y0, w, h, target) => {
    fill(planes, rgba, stride, x0, y0, w, h);
    if (!plans) {
      for (let c = 0; c < channels; c++) {
        codeChannel(null, target[c], planes[c], w, h, leaves[c]);
        codeWeighted(null, target.slice(channels + c * CONTEXTS, channels + (c + 1) * CONTEXTS), planes[c], w, h, 0, IDENTITY);
      }
      return;
    }
    const section = target || new BitWriter(w * h * channels + 64);
    if (!target) writeModularHeader(section, {useGlobalTree: true, transforms: []});
    plans.forEach(({leaf: l, codes, contextOf}, c) => {
      if (l.predictor === WEIGHTED_PREDICTOR) codeWeighted(section, codes, planes[c], w, h, 0, contextOf);
      else codeChannel(section, codes[0], planes[c], w, h, l);
    });
    return target ? undefined : section.finish();
  };
}

// The direct plan of lossless.mjs (YCoCg, 256-pixel groups), every channel counted over the whole picture under effort
// 1's predictor (chosen by samples, as the core chooses it) and under the weighted one; each rung's plan takes every
// channel's cheapest, and the plans are written the cheapest way. Nothing written (null) when no plan leaves effort 1.
function* searchSteps(rgba, width, height, shape, colorSpace, effort, pooled) {
  const {channels} = shape, layout = groupLayout(width, height), groups = layout.groupsX * layout.groupsY;
  const setup = {channels, alpha: shape.alpha, palette: null}, fill = planeFill(setup);
  const planes = Array.from({length: channels}, () => new Int16Array(32 * 32));
  const rect = g => groupRect(layout, width, height, g);
  // Effort 1's predictor per channel: three 32-pixel samples priced under gradient and average, as the core does.
  const sw = Math.min(width, 32), sh = Math.min(height, 32);
  const sampled = [GRADIENT_PREDICTOR, AVERAGE_PREDICTOR].map(predictor => ({predictor, freqs: planes.map(() => new Uint32Array(ALPHABET))}));
  for (const fraction of [0, 0.5, 1]) {
    fill(planes, rgba, width, Math.floor((width - sw) * fraction), Math.floor((height - sh) * fraction), sw, sh);
    for (const candidate of sampled) for (let c = 0; c < channels; c++) codeChannel(null, candidate.freqs[c], planes[c], sw, sh, leaf(candidate.predictor));
  }
  const first = planes.map((_, c) => leaf(sampled[cost(sampled[1].freqs[c]) < cost(sampled[0].freqs[c]) ? 1 : 0].predictor));
  // Every channel counted under effort 1's predictor and under the weighted one, its tokens kept by error interval.
  // A step is a group of the counting pass (the first half of the search's fractions) or of a plan's writing (the
  // second half, shared by the plans written), so the pace of the steps holds whether one plan is written or two.
  const contexts = CONTEXTS;
  const firstCounts = planes.map(() => new Uint32Array(ALPHABET)), intervals = planes.map(() => Array.from({length: contexts}, () => new Uint32Array(ALPHABET)));
  const counts = [...firstCounts, ...intervals.flat()], counted = {...setup, first: first.map(l => l.predictor)}, count = searchGroup(counted);
  if ((yield* groupPass({pooled, kind: 'search', setup: {...counted, sizes: counts.map(h => h.length)}, at: g => (g + 1) / (2 * groups), stop: () => true},
    groups, g => count(rgba, width, ...rect(g), counts), (g, partial) => addCounts(counts, partial))) === null) return null;
  // Rung 2: each channel's cheaper of effort 1's predictor and the weighted one in one context.
  const rung2 = planes.map((_, c) => {
    const plan = {cost: cost(firstCounts[c]), leaves: [first[c]], freqs: [firstCounts[c]], cuts: []};
    const whole = sum(intervals[c]), single = cost(whole);
    return single < plan.cost ? {cost: single, leaves: [leaf(WEIGHTED_PREDICTOR)], freqs: [whole], cuts: []} : plan;
  });
  // Rung 3: or its intervals grouped into runs of neighbours, the grouping of least cost found exactly by dynamic
  // programming. best[j] is the least cost of intervals 0..j-1 grouped, `from[j]` where its last group begins; an
  // interval no token reaches leaves the merged cost as it was.
  const rung3 = effort < 3 ? rung2 : rung2.map((plan, c) => {
    const filled = intervals[c].map(h => h.some(v => v));
    const best = new Float64Array(contexts + 1).fill(Infinity), from = new Int32Array(contexts + 1);
    best[0] = 0;
    for (let j = 1; j <= contexts; j++) {
      const merged = new Uint32Array(ALPHABET);
      let bits = 0;
      for (let i = j - 1; i >= 0; i--) {
        if (filled[i]) { const h = intervals[c][i]; for (let s = 0; s < ALPHABET; s++) merged[s] += h[s]; bits = cost(merged); }
        // Every group is a leaf of the tree and an entry of the context map: 24 bits more, so an interval no token
        // reaches joins its neighbour.
        const price = best[i] + bits + 24;
        if (price < best[j]) { best[j] = price; from[j] = i; }
      }
    }
    if (!(best[contexts] < plan.cost)) return plan;
    const groupsOf = [];
    for (let j = contexts; j > 0; j = from[j]) groupsOf.unshift([from[j], j]);
    return {cost: best[contexts], leaves: groupsOf.map(() => leaf(WEIGHTED_PREDICTOR)), freqs: groupsOf.map(([i, j]) => sum(intervals[c].slice(i, j))), cuts: groupsOf.slice(0, -1).map(([, j]) => WEIGHTED_CUTS[j - 1]),
      contextOf: Int32Array.from({length: contexts}, (_, k) => groupsOf.findIndex(([i, j]) => k >= i && k < j))};
  });
  const candidates = [rung2, rung3].filter((plans, k) => k ? plans.some((plan, c) => plan !== rung2[c]) : plans.some((plan, c) => plan.leaves[0] !== first[c]));
  if (!candidates.length) return null;
  // The tree: one subtree per channel on the channel property, and inside a split channel a balanced tree on the
  // weighted predictor's property, values above a cut to the left.
  const byError = (leaves, cuts) => {
    const build = (lo, hi) => { if (lo === hi) return leaves[lo]; const mid = (lo + hi) >> 1; return split(WEIGHTED_PROPERTY, cuts[mid], build(mid + 1, hi), build(lo, mid)); };
    return build(0, leaves.length - 1);
  };
  const assemble = plans => ({tree: channelTree(plans.map(plan => byError(plan.leaves, plan.cuts))), leaves: plans.flatMap(plan => plan.leaves), freqs: plans.flatMap(plan => plan.freqs)});
  // A plan's price in bits: its tree and histograms as written, and every token's code and raw bits. Two plans' streams
  // differ by their prices and at most 27 bits a section more (a section's padding, and its size's field in the table
  // of contents, 12 to 32 bits) and a byte: a plan that far cheaper is written alone, closer plans both.
  const price = plans => {
    const {tree, leaves, freqs} = assemble(plans), w = new BitWriter(4096);
    const histograms = writeChannelHistograms(w, writeTree(w, tree), freqs, l => leaves.indexOf(l));
    let bits = w.bitLength;
    freqs.forEach((f, i) => { const {lengths} = histograms[i + 1].code; for (let s = 0; s < f.length; s++) if (f[s]) bits += f[s] * (lengths[s] + raw(s)); });
    return bits;
  };
  let chosen = candidates;
  if (candidates.length > 1) {
    const [a, b] = candidates.map(price), margin = 27 * (layout.single ? 1 : groups + 1) + 8;
    if (b + margin <= a) chosen = [candidates[1]];
    else if (a + margin <= b) chosen = [candidates[0]];
    else if (b < a) chosen = [candidates[1], candidates[0]];
  }
  let written = 0, hurried = false;
  let smallest = null;
  for (const plans of chosen) {
    const bytes = yield* write(plans);
    if (!bytes) return smallest;
    // Price the likely winner first, but retain rung 2's byte choice on an equal-length completed pair.
    if (!smallest || bytes.length < smallest.length || (bytes.length === smallest.length && plans === candidates[0])) smallest = bytes;
    if (hurried) return smallest;
  }
  return smallest;

  // A plan's stream, a group per step; a hurry at its final group keeps the already-completed candidate.
  function* write(plans) {
    const {tree, leaves, freqs} = assemble(plans);
    const transforms = channels >= 3 ? [{type: 'rct', beginC: 0, rctType: 6}] : [];
    const header = new BitWriter(256);
    writeImageHeader(header, width, height, shape.colour, shape.alpha, {colorSpace});
    writeModularFrameHeader(header, {alpha: shape.alpha});
    const global = new BitWriter(4096);
    global.write(1, 1);  // default DC quantisation
    global.write(1, 1);  // a global tree
    const histograms = writeChannelHistograms(global, writeTree(global, tree), freqs, l => leaves.indexOf(l));
    writeModularHeader(global, {useGlobalTree: true, transforms});
    const coded = {...setup, plans: plans.map(plan => ({leaf: plan.leaves[0], codes: plan.leaves.map(l => histograms[leaves.indexOf(l) + 1].code), contextOf: plan.contextOf}))};
    const group = searchGroup(coded), sections = [];
    if (layout.single) {
      group(rgba, width, 0, 0, width, height, global);
      hurried = yield 0.5 + ++written / (2 * chosen.length * groups);
      sections.push(global.finish());
    } else {
      sections.push(global.finish());
      for (let i = 0; i < layout.dcGroupsX * layout.dcGroupsY + 1; i++) sections.push(new Uint8Array(0));
      const at = written, base = sections.length, place = (g, section) => { sections[base + g] = section; };
      hurried = yield* groupPass({pooled, kind: 'search', setup: coded, at: g => 0.5 + (at + g + 1) / (2 * chosen.length * groups), stop: g => g + 1 < groups},
        groups, g => place(g, group(rgba, width, ...rect(g))), place);
      if (hurried === null) return null;
      written += groups;
    }
    return assembleCodestream(header, sections);
  }
}
