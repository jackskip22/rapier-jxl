// SPDX-License-Identifier: MIT
import {BitWriter, part, scaled} from './bits.mjs';
import {writeImageHeader, writeModularFrameHeader, groupLayout, groupRect, groupPass, addCounts, assembleCodestream, GROUP_DIM} from './frame.mjs';
import {buildCode, writePrefixCode} from './prefix.mjs';
import {AVERAGE_PREDICTOR, GRADIENT_PREDICTOR, ALPHABET, leaf, split, channelTree, writeTree, writeModularHeader, writeChannelHistograms, codeChannel} from './modular.mjs';
import {inspectPixels, losslessSteps, planeFill, nativeSteps} from './lossless.mjs';
import {lossySteps} from './lossy.mjs';
import {WEIGHTED_PREDICTOR, WEIGHTED_PROPERTY, WEIGHTED_CUTS, codeWeighted} from './weighted.mjs';
import {fault, admitOptions, admitPixels, admitSampleFormat} from './admit.mjs';
import {localSteps} from './local.mjs';
import {rctSearchSteps} from './rct-search.mjs';
import {screenEligible, screenSteps} from './screen-search.mjs';
import {SAMPLE_RUNGS, sampledSteps, sampleTransformRanking} from './sampled.mjs';
import {paintingSteps, admitPaintingProfile} from './painting.mjs';

const hurryOf = reply => reply === null || (typeof reply === 'object' ? reply.hurried : reply);

export function effortJob(data, width, height, options, pool, helpers = false, retainHurry) {
  const {quality, colorSpace} = admitOptions(options), effort = options?.effort === undefined ? 1 : options.effort;
  if (!Number.isInteger(effort) || effort < 1 || effort > 9) throw fault('JXL_INPUT', 'Effort is a whole number from 1 to 9.');
  const treeLearning = options?.treeLearning;
  if (treeLearning !== undefined && treeLearning !== 'sampled') throw fault('JXL_INPUT', 'Tree learning must be sampled when specified.');
  const losslessProfile = options?.losslessProfile;
  if (losslessProfile !== undefined && losslessProfile !== 'painting' && losslessProfile !== 'painting-search') throw fault('JXL_INPUT', 'The lossless profile is painting or painting-search when specified.');
  admitPixels(data, width, height);
  const samples = admitSampleFormat(data, options);
  if (losslessProfile === 'painting') {
    admitPaintingProfile(quality, samples);
    return paintingSteps(data, width, height, {colorSpace, pooled: pool && !groupLayout(width, height).single});
  }
  if (losslessProfile === 'painting-search') admitPaintingProfile(quality, samples);
  if (!samples.native8) return nativeSteps(data, width, height, {quality, samples, effort, pooled: pool && !groupLayout(width, height).single});
  return effortSteps(data, width, height, quality, colorSpace, effort, pool && quality >= 100 && !groupLayout(width, height).single, treeLearning, helpers, retainHurry, losslessProfile === 'painting-search');
}

function* effortSteps(data, width, height, quality, colorSpace, effort, pooled, treeLearning, helpers = false, retainHurry, painting = false) {
  const shape = inspectPixels(data, width, height);
  if (quality < 100) {
    if (!shape.palette) return yield* lossySteps(data, width, height, {quality, shape, colorSpace});
    const exact = yield* part(effortSteps(data, width, height, 100, colorSpace, effort, false), 0, 2);
    let bytes;
    try { bytes = yield* part(lossySteps(data, width, height, {quality, shape, colorSpace}), 1, 2); }
    catch (error) { if (error.code !== 'JXL_SIZE' && (!(error instanceof RangeError) || error.code)) throw error; bytes = exact; }
    return exact.length <= bytes.length ? exact : bytes;
  }
  if (effort < 2) return yield* losslessSteps(data, width, height, {shape, colorSpace, pooled});
  if (treeLearning === 'sampled') return yield* sampledSearch(data, width, height, shape, colorSpace, effort, pooled, retainHurry);
  const analysis = {};
  const core = losslessSteps(data, width, height, {shape, colorSpace, pooled, analysis});
  let step, reply, hurried = false;
  while (!(step = core.next(reply)).done) { reply = yield scaled(step.value, done => done / 2); hurried ||= hurryOf(reply); }
  let best = step.value;
  if (hurried) return best;
  const direct = shape.palette ? {...shape, palette: null} : shape;
  const screen = effort >= 3 && screenEligible(data, width, height, shape, effort);
  if (effort >= 3) {
    const searches = !painting && (effort >= 4 || screen) ? [() => searchSteps(data, width, height, direct, colorSpace, 3, pooled, analysis, screen ? best.length : Infinity)] : [];
    if (effort >= 4 && shape.palette) searches.push(() => localSteps(data, width, height, shape, colorSpace, 4, true, pooled, best.length));
    if (effort >= 6 && shape.palette) searches.push(() => localSteps(data, width, height, shape, colorSpace, 6, true, pooled, best.length));
    if (effort >= 4 && !painting) searches.push(() => rctSearchSteps(data, width, height, shape, colorSpace, pooled));
    const rungs = effort > 3 || !screen ? learnedRungs(effort, data, width, height, shape, painting) : [], parallel = helpers && rungs.length > 1;
    if (!parallel) {
      const budgets = rungs.map(() => ({reached: pooled})), key = rung => JSON.stringify({...rung, leaves: 0});
      rungs.forEach((rung, i) => {
        const narrower = rungs.findIndex((other, j) => j < i && other.leaves < rung.leaves && key(other) === key(rung));
        searches.push(() => narrower >= 0 && !budgets[narrower].reached ? none() : sampledSteps(data, width, height, shape, colorSpace, {...rung, budget: budgets[i]}, pooled, best.length));
      });
    }
    if (screen) searches.unshift(() => screenSteps(data, width, height, shape, colorSpace, {fastFloor: effort === 3 ? best.length : 0, effort, pooled}));
    const count = searches.length + (parallel ? rungs.length : 0);
    for (let i = 0; i < searches.length; i++) {
      try {
        const search = searches[i]();
        let step, reply, hurried = false;
        while (!(step = search.next(reply)).done) hurried = hurryOf(reply = yield scaled(step.value, done => 0.5 + (i + done) / (2 * count)));
        if (step.value && step.value.length < best.length) best = step.value;
        if (hurried) return best;
      } catch (error) { if (error.code !== 'JXL_SIZE' && (!(error instanceof RangeError) || error.code)) throw error; }
    }
    if (parallel) {
      const reply = yield {kind: 'candidates', data, width, height, shape: {colour: shape.colour, alpha: shape.alpha, channels: shape.channels}, colorSpace, rungs, ceiling: best.length,
        at: done => 0.5 + (searches.length + done * rungs.length) / (2 * count)};
      for (const candidate of reply.results) {
        if (!candidate) continue;
        const {result, error} = candidate;
        if (error && error.code !== 'JXL_SIZE' && !(error.name === 'RangeError' && !error.code))
          throw Object.assign(new Error(error.message), error);
        if (result && result.length < best.length) best = result;
      }
    }
    return best;
  }
  try {
    const bytes = yield* part(searchSteps(data, width, height, direct, colorSpace, effort, pooled, analysis), 1, 2);
    if (bytes && bytes.length < best.length) best = bytes;
  } catch (error) { if (error.code !== 'JXL_SIZE' && (!(error instanceof RangeError) || error.code)) throw error; }
  return best;
}

function* none() { return null; }

const sharing = Object.freeze([160, 320, 640, 1280, 2560]);
const SEARCH_RUNGS = Object.freeze({...SAMPLE_RUNGS,
  sampled: Object.freeze({...SAMPLE_RUNGS.precise, clustered: true, samples: 131072, leaves: 192, depth: 24, sharing}),
  branching: Object.freeze({...SAMPLE_RUNGS.broad, clustered: true, samples: 131072, leaves: 512, depth: 24, sharing}),
  dense: Object.freeze({...SAMPLE_RUNGS.precise, clustered: true, samples: 262144, leaves: 192, depth: 24, sharing}),
  deep: Object.freeze({...SAMPLE_RUNGS.precise, clustered: true, samples: 262144, leaves: 1024, depth: 24, sharing}),
  shallow: SAMPLE_RUNGS.deep,
});
const LADDER = Object.freeze({
  3: [{rung: 'shallow'}],
  4: [{rung: 'shallow'}],
  5: [{rung: 'maximum'}],
  6: [{rung: 'maximum', ranked: 0}],
  7: [{rung: 'broad', ranked: 0}],
  8: [{rung: 'precise', ranked: 0}, {rung: 'sampled', ranked: 0}, {rung: 'branching', ranked: 0}],
  9: [{rung: 'precise', ranked: 1}, {rung: 'dense', ranked: 0}, {rung: 'deep', ranked: 0}],
});
function learnedRungs(effort, data, width, height, shape, painting = false) {
  const steps = (effort <= 4 ? LADDER[effort] : Array.from({length: Math.max(0, effort - 4)}, (_, i) => LADDER[i + 5] || []).flat()).filter(step => !painting || step.rung !== 'maximum'), ranking = shape.colour === 3 && steps.some(step => step.ranked !== undefined) ? sampleTransformRanking(data, width, height) : [6];
  const rungs = [], types = [], bases = [];
  for (const step of steps) {
    const base = SEARCH_RUNGS[step.rung], type = step.ranked === undefined ? 6 : ranking[step.ranked] ?? 6;
    if (types.some((t, i) => t === type && bases[i] === base)) continue;
    types.push(type); bases.push(base); rungs.push(type === 6 ? base : {...base, rctType: type});
  }
  return rungs;
}

function* sampledSearch(data, width, height, shape, colorSpace, effort, pooled, retainHurry) {
  const first = losslessSteps(data, width, height, {shape, colorSpace, pooled});
  let step, reply, hurried = false, last = 0;
  while (!(step = first.next(reply)).done) {
    reply = yield scaled(step.value, done => last = done / 2);
    hurried ||= hurryOf(reply);
  }
  const floor = step.value;
  retainHurry?.(floor);
  if (hurried) return floor;
  const rungs = effort < 4 ? [SAMPLE_RUNGS.cheap] : [SAMPLE_RUNGS.cheap, SAMPLE_RUNGS.rich];
  let best = floor;
  for (let i = 0; i < rungs.length; i++) {
    try {
      const steps = sampledSteps(data, width, height, shape, colorSpace, rungs[i], pooled);
      reply = undefined;
      while (!(step = steps.next(reply)).done) {
        reply = yield scaled(step.value, done => last = 0.5 + (i + done) / (2 * rungs.length));
        if (hurryOf(reply)) return floor;
      }
      if (step.value && step.value.length < best.length) best = step.value;
    } catch (error) { if (error.code !== 'JXL_SIZE' && (!(error instanceof RangeError) || error.code)) throw error; }
  }
  if (last < 1 && hurryOf(yield 1)) return floor;
  return best;
}

const estimatedRawBits = s => Math.max(0, s < 224 ? s - 1 : s - 236);
function cost(freqs) {
  const code = buildCode(freqs), writer = new BitWriter(128);
  writePrefixCode(writer, code);
  let bits = writer.bitLength;
  for (let s = 0; s < freqs.length; s++) if (freqs[s]) bits += freqs[s] * (code.lengths[s] + estimatedRawBits(s));
  return bits;
}

export function minimumSearchDataBits(freqs) {
  const leaves = []; let bits = 0;
  for (let s = 0; s < freqs.length; s++) if (freqs[s]) {
    leaves.push(freqs[s]); bits += freqs[s] * (s < 224 ? Math.max(0, s - 1) : s < 240 ? 0 : s - 236);
  }
  leaves.sort((a, b) => a - b);
  const parents = []; let a = 0, b = 0;
  const take = () => a < leaves.length && (b >= parents.length || leaves[a] <= parents[b]) ? leaves[a++] : parents[b++];
  for (let i = 1; i < leaves.length; i++) { const weight = take() + take(); parents.push(weight); bits += weight; }
  return bits;
}
const sum = histograms => { const out = new Uint32Array(ALPHABET); for (const h of histograms) for (let s = 0; s < ALPHABET; s++) out[s] += h[s]; return out; };

const CONTEXTS = WEIGHTED_CUTS.length + 1, IDENTITY = Int32Array.from({length: CONTEXTS}, (_, k) => k);

export function searchGroup(setup) {
  const {channels, first, plans, contexts = CONTEXTS, countFirst = true} = setup, fill = planeFill(setup), leaves = first?.map(p => leaf(p));
  const planes = Array.from({length: channels}, () => new Int16Array(GROUP_DIM * GROUP_DIM));
  return (rgba, stride, x0, y0, w, h, target) => {
    fill(planes, rgba, stride, x0, y0, w, h);
    if (!plans) {
      for (let c = 0; c < channels; c++) {
        if (countFirst) codeChannel(null, target[c], planes[c], w, h, leaves[c]);
        const base = (countFirst ? channels : 0) + c * contexts;
        codeWeighted(null, target.slice(base, base + contexts), planes[c], w, h, 0, contexts === 1 ? undefined : IDENTITY);
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

export function* searchSteps(rgba, width, height, shape, colorSpace, effort, pooled, analysis, ceiling = Infinity) {
  const {channels} = shape, layout = groupLayout(width, height), groups = layout.groupsX * layout.groupsY;
  const setup = {channels, alpha: shape.alpha, palette: null}, fill = planeFill(setup);
  const planes = Array.from({length: channels}, () => new Int16Array(32 * 32));
  const rect = g => groupRect(layout, width, height, g);
  const sw = Math.min(width, 32), sh = Math.min(height, 32);
  const cached = analysis?.direct;
  const sampled = !cached && [GRADIENT_PREDICTOR, AVERAGE_PREDICTOR].map(predictor => ({predictor, freqs: planes.map(() => new Uint32Array(ALPHABET))}));
  if (!cached) {
    for (const fraction of [0, 0.5, 1]) {
      fill(planes, rgba, width, Math.floor((width - sw) * fraction), Math.floor((height - sh) * fraction), sw, sh);
      for (const candidate of sampled) for (let c = 0; c < channels; c++) codeChannel(null, candidate.freqs[c], planes[c], sw, sh, leaf(candidate.predictor));
    }
  }
  const first = cached ? cached.first.map(p => leaf(p)) : planes.map((_, c) => leaf(sampled[cost(sampled[1].freqs[c]) < cost(sampled[0].freqs[c]) ? 1 : 0].predictor));
  const contexts = effort < 3 ? 1 : CONTEXTS;
  const firstCounts = cached?.freqs || planes.map(() => new Uint32Array(ALPHABET)), intervals = planes.map(() => Array.from({length: contexts}, () => new Uint32Array(ALPHABET)));
  const counts = [...(cached ? [] : firstCounts), ...intervals.flat()];
  const counted = {...setup, first: first.map(l => l.predictor), contexts, countFirst: !cached}, count = searchGroup(counted);
  if (!pooled && Number.isFinite(ceiling)) {
    const fixed = cached ? firstCounts.map(minimumSearchDataBits) : null;
    for (let g = 0; g < groups; g++) {
      count(rgba, width, ...rect(g), counts);
      const baseline = fixed || firstCounts.map(minimumSearchDataBits);
      const bits = intervals.reduce((n, channel, c) => n + Math.min(baseline[c], channel.reduce((sum, hist) => sum + minimumSearchDataBits(hist), 0)), 0);
      const hurried = yield (g + 1) / (2 * groups);
      if (bits >= ceiling * 8 || hurried) return null;
    }
  } else if ((yield* groupPass({pooled, kind: 'search', setup: {...counted, sizes: counts.map(h => h.length)}, at: g => (g + 1) / (2 * groups), stop: () => true},
    groups, g => count(rgba, width, ...rect(g), counts), (g, partial) => addCounts(counts, partial))) === null) return null;
  const rung2 = planes.map((_, c) => {
    const plan = {cost: cost(firstCounts[c]), leaves: [first[c]], freqs: [firstCounts[c]], cuts: []};
    const whole = sum(intervals[c]), single = cost(whole);
    return single < plan.cost ? {cost: single, leaves: [leaf(WEIGHTED_PREDICTOR)], freqs: [whole], cuts: []} : plan;
  });
  const rung3 = effort < 3 ? rung2 : rung2.map((plan, c) => {
    const filled = intervals[c].map(h => h.some(v => v));
    const best = new Float64Array(contexts + 1).fill(Infinity), from = new Int32Array(contexts + 1);
    best[0] = 0;
    for (let j = 1; j <= contexts; j++) {
      const merged = new Uint32Array(ALPHABET);
      let bits = 0;
      for (let i = j - 1; i >= 0; i--) {
        if (filled[i]) { const h = intervals[c][i]; for (let s = 0; s < ALPHABET; s++) merged[s] += h[s]; bits = cost(merged); }
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
  const byError = (leaves, cuts) => {
    const build = (lo, hi) => { if (lo === hi) return leaves[lo]; const mid = (lo + hi) >> 1; return split(WEIGHTED_PROPERTY, cuts[mid], build(mid + 1, hi), build(lo, mid)); };
    return build(0, leaves.length - 1);
  };
  const assemble = plans => ({tree: channelTree(plans.map(plan => byError(plan.leaves, plan.cuts))), leaves: plans.flatMap(plan => plan.leaves), freqs: plans.flatMap(plan => plan.freqs)});
  const model = plans => {
    const {tree, leaves, freqs} = assemble(plans), w = new BitWriter(4096);
    const histograms = writeChannelHistograms(w, writeTree(w, tree), freqs, l => leaves.indexOf(l));
    let bits = w.bitLength;
    freqs.forEach((f, i) => { const {lengths} = histograms[i + 1].code; for (let s = 0; s < f.length; s++) if (f[s]) bits += f[s] * (lengths[s] + estimatedRawBits(s)); });
    return {bits, header: w, leaves, histograms};
  };
  const models = new Map(candidates.map(plans => [plans, model(plans)]));
  let chosen = candidates;
  if (candidates.length > 1) {
    const [a, b] = candidates.map(plans => models.get(plans).bits);
    if (b < a) chosen = [candidates[1], candidates[0]];
  }
  let written = 0, hurried = false;
  let smallest = null;
  for (const plans of chosen) {
    const bytes = yield* write(plans);
    if (!bytes) return smallest;
    if (!smallest || bytes.length < smallest.length || (bytes.length === smallest.length && plans === candidates[0])) smallest = bytes;
    if (hurried) return smallest;
  }
  return smallest;

  function* write(plans) {
    const {header: modelHeader, leaves, histograms} = models.get(plans);
    const transforms = channels >= 3 ? [{type: 'rct', beginC: 0, rctType: 6}] : [];
    const header = new BitWriter(256);
    writeImageHeader(header, width, height, shape.colour, shape.alpha, {colorSpace});
    writeModularFrameHeader(header, {alpha: shape.alpha});
    const global = new BitWriter(4096);
    global.write(1, 1);
    global.write(1, 1);
    global.append(modelHeader);
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
