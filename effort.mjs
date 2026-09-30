// SPDX-License-Identifier: MIT
// Rapier JXL's effort door: the core's `encode` with a search above it. {effort: 1} (the default) writes the core's
// stream byte for byte; a higher effort prices more candidates for every channel of an exact picture and keeps the
// smallest stream: never larger than the effort below it, effort 1's on a tie. The rungs, each from its effort up:
// 2. the specification's self-correcting (weighted) predictor, one context per channel;
// 3. the weighted predictor with its channel's tokens split by the predictor's own error, neighbouring intervals of
//    libjxl's cut points merged wherever a shared prefix code costs less.
// A lossy request is effort 1's. Above effort 1 an exact picture's job spends its first half (fractions up to 0.5)
// writing effort 1's stream and its second searching, so a caller's clock can tell the search's own pace; `hurry`
// ends the search at its next step with the smallest stream written so far. Every choice is integer arithmetic: the
// same input and options write the same bytes everywhere.
import {LIMITS, BitWriter, complete, part} from './bits.mjs';
import {writeImageHeader, writeModularFrameHeader, groupLayout, assembleCodestream, GROUP_DIM} from './frame.mjs';
import {buildCode, writePrefixCode} from './prefix.mjs';
import {AVERAGE_PREDICTOR, GRADIENT_PREDICTOR, ALPHABET, leaf, split, channelTree, writeTree, writeModularHeader, writeChannelHistograms, codeChannel} from './modular.mjs';
import {inspectPixels, losslessSteps} from './lossless.mjs';
import {lossySteps} from './lossy.mjs';
import {WEIGHTED_PREDICTOR, WEIGHTED_PROPERTY, WEIGHTED_CUTS, codeWeighted} from './weighted.mjs';
import {fault, admitOptions, admitPixels, job} from './admit.mjs';

export {LIMITS};

export function encode(data, width, height, options) { return complete(encodeSteps(data, width, height, options)); }

// The options as every door reads them, and the effort, which this door alone reads (the core, one rung, does not): a
// whole number from 1 to 9, 1 when absent.
export function encodeSteps(data, width, height, options) {
  const {quality, colorSpace} = admitOptions(options), effort = options?.effort === undefined ? 1 : options.effort;
  if (!Number.isInteger(effort) || effort < 1 || effort > 9) throw fault('JXL_INPUT', 'Effort is a whole number from 1 to 9.');
  admitPixels(data, width, height);
  return job(effortSteps(data, width, height, quality, colorSpace, effort));
}

// Effort 1 is the core's work (index.mjs), step for step; the rungs run after it and keep a smaller stream if they
// find one. A search that runs out of memory leaves effort 1's stream standing.
function* effortSteps(data, width, height, quality, colorSpace, effort) {
  const shape = inspectPixels(data, width, height);
  if (quality < 100) {
    if (!shape.palette) return yield* lossySteps(data, width, height, {quality, shape, colorSpace});
    const exact = yield* part(losslessSteps(data, width, height, {shape, colorSpace}), 0, 2);
    let bytes;
    try { bytes = yield* part(lossySteps(data, width, height, {quality, shape, colorSpace}), 1, 2); }
    catch (error) { if (!(error instanceof RangeError) || error.code) throw error; bytes = exact; }
    return exact.length <= bytes.length ? exact : bytes;
  }
  if (effort < 2) return yield* losslessSteps(data, width, height, {shape, colorSpace});
  let best = yield* part(losslessSteps(data, width, height, {shape, colorSpace}), 0, 2);
  try {
    const bytes = yield* part(searchSteps(data, width, height, shape.palette ? {...shape, palette: null} : shape, colorSpace, effort), 1, 2);
    if (bytes && bytes.length < best.length) best = bytes;
  } catch (error) { if (!(error instanceof RangeError) || error.code) throw error; }
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

// The direct plan of lossless.mjs (YCoCg, 256-pixel groups), every channel counted over the whole picture under effort
// 1's predictor (chosen by samples, as the core chooses it) and under the weighted one; each rung's plan takes every
// channel's cheapest, and the plans are written the cheapest way. Nothing written (null) when no plan leaves effort 1.
function* searchSteps(rgba, width, height, shape, colorSpace, effort) {
  const {channels} = shape, layout = groupLayout(width, height), groups = layout.groupsX * layout.groupsY;
  const planes = Array.from({length: channels}, () => new Int16Array(GROUP_DIM * GROUP_DIM));
  const fill = (x0, y0, w, h) => {
    for (let y = 0; y < h; y++) {
      let i = ((y0 + y) * width + x0) * 4, at = y * w;
      for (let x = 0; x < w; x++, i += 4, at++) {
        if (channels >= 3) {
          const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
          const co = r - b, tmp = b + (co >> 1), cg = g - tmp;
          planes[0][at] = tmp + (cg >> 1); planes[1][at] = co; planes[2][at] = cg;
          if (channels === 4) planes[3][at] = rgba[i + 3];
        } else { planes[0][at] = rgba[i]; if (channels === 2) planes[1][at] = rgba[i + 3]; }
      }
    }
  };
  const group = (g, visit) => {
    const x0 = g % layout.groupsX * GROUP_DIM, y0 = (g / layout.groupsX | 0) * GROUP_DIM, w = Math.min(GROUP_DIM, width - x0), h = Math.min(GROUP_DIM, height - y0);
    fill(x0, y0, w, h);
    visit(w, h);
  };
  // Effort 1's predictor per channel: three 32-pixel samples priced under gradient and average, as the core does.
  const sw = Math.min(width, 32), sh = Math.min(height, 32);
  const sampled = [GRADIENT_PREDICTOR, AVERAGE_PREDICTOR].map(predictor => ({predictor, freqs: planes.map(() => new Uint32Array(ALPHABET))}));
  for (const fraction of [0, 0.5, 1]) {
    fill(Math.floor((width - sw) * fraction), Math.floor((height - sh) * fraction), sw, sh);
    for (const candidate of sampled) for (let c = 0; c < channels; c++) codeChannel(null, candidate.freqs[c], planes[c], sw, sh, leaf(candidate.predictor));
  }
  const first = planes.map((_, c) => leaf(sampled[cost(sampled[1].freqs[c]) < cost(sampled[0].freqs[c]) ? 1 : 0].predictor));
  // Every channel counted under effort 1's predictor and under the weighted one, its tokens kept by error interval.
  // A step is a group of the counting pass (the first half of the search's fractions) or of a plan's writing (the
  // second half, shared by the plans written), so the pace of the steps holds whether one plan is written or two.
  const contexts = WEIGHTED_CUTS.length + 1, identity = Int32Array.from({length: contexts}, (_, k) => k);
  const firstCounts = planes.map(() => new Uint32Array(ALPHABET)), intervals = planes.map(() => Array.from({length: contexts}, () => new Uint32Array(ALPHABET)));
  let done = 0;
  for (let g = 0; g < groups; g++) {
    group(g, (w, h) => {
      for (let c = 0; c < channels; c++) {
        codeChannel(null, firstCounts[c], planes[c], w, h, first[c]);
        codeWeighted(null, intervals[c], planes[c], w, h, 0, identity);
      }
    });
    if (yield ++done / (2 * groups)) return null;
  }
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
  }
  let written = 0;
  const next = () => 0.5 + ++written / (2 * chosen.length * groups);
  let smallest = null;
  for (const plans of chosen) {
    const bytes = yield* write(plans);
    if (!bytes) return smallest;
    if (!smallest || bytes.length < smallest.length) smallest = bytes;
  }
  return smallest;

  // A plan's stream, a group per step; null when hurried.
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
    const codes = plans.map(plan => plan.leaves.map(l => histograms[leaves.indexOf(l) + 1].code));
    const code = (w, c, width, height) => {
      const plan = plans[c];
      if (plan.leaves[0].predictor === WEIGHTED_PREDICTOR) codeWeighted(w, codes[c], planes[c], width, height, 0, plan.contextOf);
      else codeChannel(w, codes[c][0], planes[c], width, height, plan.leaves[0]);
    };
    const sections = [];
    if (layout.single) {
      group(0, (w, h) => { for (let c = 0; c < channels; c++) code(global, c, w, h); });
      if (yield next()) return null;
      sections.push(global.finish());
    } else {
      sections.push(global.finish());
      for (let i = 0; i < layout.dcGroupsX * layout.dcGroupsY + 1; i++) sections.push(new Uint8Array(0));
      for (let g = 0; g < groups; g++) {
        group(g, (w, h) => {
          const section = new BitWriter(w * h * channels + 64);
          writeModularHeader(section, {useGlobalTree: true, transforms: []});
          for (let c = 0; c < channels; c++) code(section, c, w, h);
          sections.push(section.finish());
        });
        if (yield next()) return null;
      }
    }
    return assembleCodestream(header, sections);
  }
}
