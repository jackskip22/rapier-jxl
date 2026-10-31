// SPDX-License-Identifier: MIT
import {BitWriter, part, scaled, complete} from './bits.mjs';
import {writeModularFrameHeader, groupLayout, groupRect, groupPass, assembleCodestream, GROUP_DIM} from './frame.mjs';
import {writeImageHeader} from './icc-write.mjs';
import {buildCode, writePrefixCode} from './prefix.mjs';
import {AVERAGE_PREDICTOR, GRADIENT_PREDICTOR, ALPHABET, leaf, split, channelTree, writeTree, writeModularHeader, writeChannelHistograms} from './modular.mjs';
import {codeChannel} from './modular-channel.mjs';
import {inspectPixels, losslessSteps, planeFill, nativeSteps, iccShape} from './lossless.mjs';
import {lossySteps} from './lossy.mjs';
import {photoSteps, admitPhotoFilter, screenImageSteps, screenRouted} from './photo-job.mjs';
import {coefficientAnsSteps} from './coefficient-ans.mjs';
import {WEIGHTED_PREDICTOR, WEIGHTED_PROPERTY, WEIGHTED_CUTS, codeWeighted} from './weighted.mjs';
import {fault, admitOptions, admitPixels} from './admit.mjs';
import {admitSampleFormat} from './admit-samples.mjs';
import {screenEligible, screenSteps} from './screen-search.mjs';
import {screenLike, flatSamples, CAPTURE_FLAT} from './screen.mjs';
import {screenPhotoRegions} from './screen-photo-regions.mjs';
import {SAMPLE_RUNGS, sampledSteps, sampleTransformRanking} from './sampled.mjs';
import {FAST_EFFORT} from './effort-level.mjs';

export function effortJob(data, width, height, options, gpu = false, limits, search, writer = coefficientAnsSteps, deep = null) {
  const {quality, colorSpace} = admitOptions(options), effort = options?.effort === undefined ? FAST_EFFORT : options.effort;
  const filter = admitPhotoFilter(options);
  if (!Number.isInteger(effort) || effort < 1 || effort > 9) throw fault('JXL_INPUT', 'Effort is a whole number from 1 to 9.');
  if (effort >= 4 && !deep) throw fault('JXL_INTERNAL', 'Efforts 4-9 need their exact ladder (local.mjs, rct-search.mjs).');
  if (effort >= 8 && !deep.screen) throw fault('JXL_INTERNAL', 'Efforts 8-9 need their screen candidates (palette-search.mjs, screen-local.mjs).');
  admitPixels(data, width, height, limits);
  const samples = admitSampleFormat(data, options);
  if (samples.iccSpace)
    return iccShape(data, samples.iccSpace, effortSteps(data, width, height, quality, samples.iccSpace, effort, options?.photo !== false, filter, false, search, writer, deep));
  if (!samples.native8) return nativeSteps(data, width, height, {quality, samples, effort});
  return effortSteps(data, width, height, quality, colorSpace, effort, options?.photo !== false, filter, gpu, search, writer, deep);
}

function* effortSteps(data, width, height, quality, colorSpace, effort, photo = true, filter, gpu = false, search, writer = coefficientAnsSteps, deep = null) {
  const shape = inspectPixels(data, width, height);
  if (quality < 100) {
    if (!shape.palette) {
      const lossy = photo ? photoSteps(data, width, height, quality, colorSpace, effort,
        writer, filter, search, gpu) : lossySteps(data, width, height, {quality, shape, colorSpace});
      const screen = photo && effort >= 2 ? yield* screenProbe(data, width, height, quality, colorSpace, filter, search, gpu, writer) : null;
      if (screen?.exact) { lossy.return?.(); return screen.captured; }
      if (screen) {
        const shared = screen.image && screenRouted(data, width, height, colorSpace, effort);
        if (shared) lossy.return?.();
        const bytes = yield* within(shared ? coefficientAnsSteps(screen.image, effort) : lossy, 0.1, 0.9);
        let best = screen.captured.length <= bytes.length ? screen.captured : bytes;
        const regions = best === bytes ? screenPhotoRegions(data, width, height) : [];
        if (regions.length) {
          const mixed = yield {screenPhoto: {data, width, height, quality, regions, effort}};
          if (mixed instanceof Uint8Array && mixed.length < best.length) best = mixed;
        }
        return best;
      }
      return yield* capturedFloor(data, width, height, colorSpace, yield* lossy, true);
    }
    const palette = (function* () {
      const captured = effort >= 2 && typeof colorSpace !== 'object' && screenLike(data, width, height)
        ? yield {capture: {data, width, height, colorSpace}} : null;
      const exact = captured instanceof Uint8Array ? captured : yield* part(effortSteps(data, width, height, 100, colorSpace, effort, true, undefined, false, undefined, undefined, deep), 0, 2);
      let bytes;
      try { bytes = yield* part(lossySteps(data, width, height, {quality, shape, colorSpace}), 1, 2); }
      catch (error) { if (error.code !== 'JXL_SIZE' && (!(error instanceof RangeError) || error.code)) throw error; bytes = exact; }
      return exact.length <= bytes.length ? exact : bytes;
    })();
    return yield* palette;
  }
  if (effort < 2) {
    const steps = losslessSteps(data, width, height, {shape, colorSpace, fast: true});
    return yield* (screenLike(data, width, height) || typeof colorSpace === 'object' || flatSamples(data, width, height) < CAPTURE_FLAT
      ? screenFirst(data, width, height, colorSpace, steps) : capturedFloor(data, width, height, colorSpace, yield* steps, false, true));
  }
  const analysis = {};
  const stream = complete(losslessSteps(data, width, height, {shape, colorSpace, fast: true}));
  const captured = typeof colorSpace !== 'object' && (screenLike(data, width, height) || flatSamples(data, width, height) >= CAPTURE_FLAT)
    ? yield {capture: {data, width, height, colorSpace}} : null;
  if (captured instanceof Uint8Array && captured.length <= PROBE * stream.length) return captured;
  const fast = captured instanceof Uint8Array && captured.length < stream.length ? captured : stream;
  const core = losslessSteps(data, width, height, {shape, colorSpace, analysis});
  let step, reply, hurried = false;
  while (!(step = core.next(reply)).done) { reply = yield scaled(step.value, done => done / 2); hurried ||= !!reply; }
  let best = step.value.length < fast.length ? step.value : fast;
  if (hurried) return best;
  const direct = shape.palette ? {...shape, palette: null} : shape;
  const screen = losslessScreenCandidate(data, width, height, shape, effort);
  if (effort >= 4 || screen) {
    const searches = (effort >= 4 || screen) ? [() => searchSteps(data, width, height, direct, colorSpace, 3, analysis, screen ? best.length : Infinity)] : [];
    if (effort >= 4 && shape.palette) searches.push(() => deep.localSteps(data, width, height, shape, colorSpace, 4, true, best.length));
    if (effort >= 6 && shape.palette) searches.push(() => deep.localSteps(data, width, height, shape, colorSpace, 6, true, best.length));
    if (effort >= 4) searches.push(() => deep.rctSearchSteps(data, width, height, shape, colorSpace));
    const rungs = learnedRungs(effort, data, width, height, shape);
    const budgets = rungs.map(() => ({reached: false})), key = rung => JSON.stringify({...rung, leaves: 0});
    rungs.forEach((rung, i) => {
      const narrower = rungs.findIndex((other, j) => j < i && other.leaves < rung.leaves && key(other) === key(rung));
      searches.push(() => narrower >= 0 && !budgets[narrower].reached ? none() : sampledSteps(data, width, height, shape, colorSpace, {...rung, budget: budgets[i]}, best.length));
    });
    if (screen) searches.unshift(() => screenSteps(data, width, height, shape, colorSpace, {fastFloor: effort === 3 ? best.length : 0, effort, deep: deep?.screen}));
    const count = searches.length;
    for (let i = 0; i < searches.length; i++) {
      try {
        const search = searches[i]();
        let step, reply, hurried = false;
        while (!(step = search.next(reply)).done) hurried = !!(reply = yield scaled(step.value, done => 0.5 + (i + done) / (2 * count)));
        if (step.value && step.value.length < best.length) best = step.value;
        if (hurried) return best;
      } catch (error) { if (error.code !== 'JXL_SIZE' && (!(error instanceof RangeError) || error.code)) throw error; }
    }
    return best;
  }
  try {
    const rung = learnedRungs(3, data, width, height, shape)[0];
    const bytes = yield* part(sampledSteps(data, width, height, shape, colorSpace, {...rung, budget: {reached: false}}, best.length), 1, 2);
    if (bytes && bytes.length < best.length) best = bytes;
  } catch (error) { if (error.code !== 'JXL_SIZE' && (!(error instanceof RangeError) || error.code)) throw error; }
  return best;
}

export function losslessScreenCandidate(data, width, height, shape, effort) {
  return effort === 3 ? screenEligible(data, width, height, shape, 3)
    : effort >= 4 && screenLike(data, width, height);
}

function* none() { return null; }

function* screenFirst(data, width, height, colorSpace, steps) {
  if (typeof colorSpace !== 'object' && screenLike(data, width, height)) {
    const captured = yield {capture: {data, width, height, colorSpace}};
    if (captured instanceof Uint8Array) return captured;
  }
  return yield* steps;
}

const PROBE = 0.7;
function* screenProbe(data, width, height, quality, colorSpace, filter, search, gpu, writer = coefficientAnsSteps) {
  if (typeof colorSpace === 'object' || !screenLike(data, width, height)) return null;
  const captured = yield {capture: {data, width, height, colorSpace}};
  if (!(captured instanceof Uint8Array)) return null;
  const image = screenRouted(data, width, height, colorSpace, 1) ? yield* part(screenImageSteps(data, width, height, quality), 0, 20) : null;
  const probe = image ? yield* part(coefficientAnsSteps(image, 1), 1, 20)
    : yield* part(photoSteps(data, width, height, quality, colorSpace, 1, writer, filter, search, gpu), 0, 10);
  return {captured, image, exact: captured.length <= PROBE * probe.length};
}

function* within(steps, from, span) {
  let step, reply;
  try {
    while (!(step = steps.next(reply)).done) reply = yield scaled(step.value, done => from + done * span);
    return step.value;
  } finally { steps.return?.(); }
}

function* capturedFloor(data, width, height, colorSpace, bytes, lossy = false, flat = false) {
  if (typeof colorSpace === 'object' || !flat && !screenLike(data, width, height)) return bytes;
  const captured = yield {capture: {data, width, height, colorSpace}};
  return captured instanceof Uint8Array && (lossy ? captured.length <= bytes.length : captured.length < bytes.length) ? captured : bytes;
}

const SEARCH_SHARING = Object.freeze([160, 320, 640, 1280, 2560]);
const SEARCH_RUNGS = Object.freeze({...SAMPLE_RUNGS,
  sampled: Object.freeze({...SAMPLE_RUNGS.precise, clustered: true, samples: 131072, leaves: 192, depth: 24, sharing: SEARCH_SHARING}),
  branching: Object.freeze({...SAMPLE_RUNGS.broad, clustered: true, samples: 131072, leaves: 512, depth: 24, sharing: SEARCH_SHARING}),
  dense: Object.freeze({...SAMPLE_RUNGS.precise, clustered: true, samples: 262144, leaves: 192, depth: 24, sharing: SEARCH_SHARING}),
  deep: Object.freeze({...SAMPLE_RUNGS.precise, clustered: true, samples: 262144, leaves: 1024, depth: 24, sharing: SEARCH_SHARING}),
  shallow: SAMPLE_RUNGS.deep,
});
const LADDER = Object.freeze({
  3: [{rung: 'shallow'}],
  4: [{rung: 'shallow'}],
  5: [{rung: 'shallow'}, {rung: 'maximum'}],
  6: [{rung: 'maximum', ranked: 0}],
  7: [{rung: 'broad', ranked: 0}],
  8: [{rung: 'precise', ranked: 0}, {rung: 'sampled', ranked: 0}, {rung: 'branching', ranked: 0}],
  9: [{rung: 'precise', ranked: 1}, {rung: 'dense', ranked: 0}, {rung: 'deep', ranked: 0}],
});
export function learnedRungs(effort, data, width, height, shape) {
  const steps = effort <= 4 ? LADDER[effort] : Array.from({length: Math.max(0, effort - 4)}, (_, i) => LADDER[i + 5] || []).flat(), ranking = shape.colour === 3 && steps.some(step => step.ranked !== undefined) ? sampleTransformRanking(data, width, height) : [6];
  const rungs = [], types = [], bases = [];
  for (const step of steps) {
    const base = SEARCH_RUNGS[step.rung], type = step.ranked === undefined ? 6 : ranking[step.ranked] ?? 6;
    if (types.some((t, i) => t === type && bases[i] === base)) continue;
    types.push(type); bases.push(base); rungs.push(type === 6 ? base : {...base, rctType: type});
  }
  return rungs;
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

function searchGroup(setup) {
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

export function* searchSteps(rgba, width, height, shape, colorSpace, effort, analysis, ceiling = Infinity) {
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
  if (Number.isFinite(ceiling)) {
    const fixed = cached ? firstCounts.map(minimumSearchDataBits) : null;
    for (let g = 0; g < groups; g++) {
      count(rgba, width, ...rect(g), counts);
      const baseline = fixed || firstCounts.map(minimumSearchDataBits);
      const bits = intervals.reduce((n, channel, c) => n + Math.min(baseline[c], channel.reduce((sum, hist) => sum + minimumSearchDataBits(hist), 0)), 0);
      const hurried = yield (g + 1) / (2 * groups);
      if (bits >= ceiling * 8 || hurried) return null;
    }
  } else if ((yield* groupPass({at: g => (g + 1) / (2 * groups), stop: () => true}, groups, g => count(rgba, width, ...rect(g), counts))) === null) return null;
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
      hurried = yield* groupPass({at: g => 0.5 + (at + g + 1) / (2 * chosen.length * groups), stop: g => g + 1 < groups},
        groups, g => place(g, group(rgba, width, ...rect(g))));
      if (hurried === null) return null;
      written += groups;
    }
    return assembleCodestream(header, sections);
  }
}
