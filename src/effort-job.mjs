// SPDX-License-Identifier: MIT
import {BitWriter, part, scaled, complete} from './bits.mjs';
import {writeModularFrameHeader, groupLayout, groupRect, groupPass, assembleCodestream, GROUP_DIM} from './frame.mjs';
import {writeImageHeader} from './icc-write.mjs';
import {buildCode, writePrefixCode} from './prefix.mjs';
import {AVERAGE_PREDICTOR, GRADIENT_PREDICTOR, ALPHABET, leaf, split, channelTree, writeTree, writeModularHeader, writeChannelHistograms} from './modular.mjs';
import {codeChannel} from './modular-channel.mjs';
import {inspectPixels, inspectPixelsSteps, losslessSteps, planeFill, nativeSteps, iccShape, shapeFloors} from './lossless.mjs';
import {lossySteps} from './lossy.mjs';
import {photoSteps, admitPhotoFilter, screenImageSteps, screenRouted} from './photo-job.mjs';
import {coefficientAnsSteps} from './coefficient-ans.mjs';
import {preferXYB} from './photo-xyb.mjs';
import {smallPalette, SMALL_SCREEN, SMALL_PHOTO} from './small-palette.mjs';
import {WEIGHTED_PREDICTOR, WEIGHTED_PROPERTY, WEIGHTED_CUTS, codeWeighted} from './weighted.mjs';
import {fault, admitOptions, admitPixels} from './admit.mjs';
import {admitSampleFormat} from './admit-samples.mjs';
import {screenLike, flatSamples, CAPTURE_FLAT} from './screen.mjs';
import {screenPhotoRegions} from './screen-photo-regions.mjs';
import {encodeCaptureSteps, captureBusy, CAPTURE_TOOLS, CAPTURE_LEVEL, CAPTURE_FLOOR, LEVELS} from './capture-codec.mjs';
import {CAPTURE_TOOLS_COMPLETE} from './capture-ans.mjs';
import {transformRanking} from './capture-trees.mjs';
import {FAST_EFFORT} from './effort-level.mjs';
import {stage, unit, journaling, journalRequest, journalFact, JOIN} from './step-journal.mjs';

export function effortJob(data, width, height, options, gpu = false, limits, search, writer = coefficientAnsSteps, deep = null, hdr = null) {
  const {quality, colorSpace} = admitOptions(options), effort = options?.effort === undefined ? FAST_EFFORT : options.effort;
  const filter = admitPhotoFilter(options);
  if (!Number.isInteger(effort) || effort < 1 || effort > 9) throw fault('JXL_INPUT', 'Effort is a whole number from 1 to 9.');
  if (effort >= 4 && !deep) throw fault('JXL_INTERNAL', 'Efforts 4-9 need their exact ladder (local.mjs, rct-search.mjs).');
  admitPixels(data, width, height, limits);
  const samples = admitSampleFormat(data, options);
  if (samples.iccSpace)
    return iccShape(data, samples.iccSpace, effortSteps(data, width, height, quality, samples.iccSpace, effort, options?.photo !== false, filter, false, search, writer, deep));
  if (!samples.native8) return hdr?.route(data, samples, quality) ? hdr.steps(data, width, height, quality, effort, samples, () => nativeSteps(data, width, height, {quality, samples, effort}))
    : nativeSteps(data, width, height, {quality, samples, effort});
  return effortSteps(data, width, height, quality, colorSpace, effort, options?.photo !== false, filter, gpu, search, writer, deep);
}

function* effortSteps(data, width, height, quality, colorSpace, effort, photo = true, filter, gpu = false, search, writer = coefficientAnsSteps, deep = null) {
  const shape = yield* inspectPixelsSteps(data, width, height);
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
      const screen = effort >= 2 && typeof colorSpace !== 'object' && screenLike(data, width, height);
      const small = smallPalette(data, width, height, colorSpace);
      const captured = screen || small === SMALL_SCREEN ? yield {capture: {data, width, height, colorSpace}} : null;
      const photograph = photo && effort >= 2 && typeof colorSpace !== 'object' && (small ? small === SMALL_PHOTO : !screen && preferXYB(data, width, height)), parts = photograph ? 3 : 2;
      const exact = captured instanceof Uint8Array ? captured : yield* part(effortSteps(data, width, height, 100, colorSpace, effort, true, undefined, false, undefined, undefined, deep), 0, parts);
      let bytes = exact;
      if (!small) try { bytes = yield* part(lossySteps(data, width, height, {quality, shape, colorSpace}), 1, parts); }
      catch (error) { if (error.code !== 'JXL_SIZE' && (!(error instanceof RangeError) || error.code)) throw error; bytes = exact; }
      let best = exact.length <= bytes.length ? exact : bytes;
      if (photograph) {
        const file = yield* part(photoSteps(data, width, height, quality, colorSpace, effort, writer, filter, search, gpu), 2, 3);
        if (file.length < best.length) best = file;
      }
      return best;
    })();
    return yield* palette;
  }
  if (effort < 2) {
    const steps = losslessSteps(data, width, height, {shape, colorSpace, fast: true});
    return yield* (screenLike(data, width, height) || typeof colorSpace === 'object' || flatSamples(data, width, height) < CAPTURE_FLAT
      ? screenFirst(data, width, height, colorSpace, steps) : capturedFloor(data, width, height, colorSpace, yield* steps, false, true));
  }
  const analysis = {};
  const stream = journaling() ? yield* stage('core-stream', () => unitsOnly(losslessSteps(data, width, height, {shape, colorSpace, fast: true, units: true})))
    : complete(losslessSteps(data, width, height, {shape, colorSpace, fast: true}));
  const screen = losslessScreenCandidate(data, width, height, shape, effort);
  const screenish = typeof colorSpace !== 'object' && (journaling() ? yield* unit('screenish', () => screenLike(data, width, height) || flatSamples(data, width, height) >= CAPTURE_FLAT)
    : screenLike(data, width, height) || flatSamples(data, width, height) >= CAPTURE_FLAT);
  const captured = screenish || typeof colorSpace !== 'object' && shape.palette
    ? yield {capture: {data, width, height, colorSpace, effort: Math.max(effort, 3), tools: deep?.capture}} : null;
  if (screenish && captured instanceof Uint8Array && captured.length <= PROBE * stream.length) {
    if ((typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) || effort < 6) return captured;
    try {
      const bytes = yield* losslessCapture(data, width, height, colorSpace, losslessLevel(effort, ...(yield* rankingOf(data, width, height, shape, colorSpace))));
      if (bytes && bytes.length < captured.length) return bytes;
    } catch (error) { if (error.code !== 'JXL_SIZE' && (!(error instanceof RangeError) || error.code)) throw error; }
    return captured;
  }
  const fast = captured instanceof Uint8Array && captured.length < stream.length ? captured : stream;
  const alone = !screen && (effort < 4 || !shape.palette);
  const core = alone ? (function* () { return fast; })() : losslessSteps(data, width, height, {shape, colorSpace, analysis});
  let step, reply, hurried = false;
  try { while (!(step = core.next(reply)).done) { reply = yield scaled(step.value, done => done / 2); hurried ||= !!reply && !journalRequest(step.value); } } finally { if (!step?.done) core.return?.(); }
  let best = step.value !== fast && step.value.length < fast.length ? step.value : fast;
  if (hurried) return best;
  const direct = shape.palette ? {...shape, palette: null} : shape;
  if (effort >= 4 || screen) {
    const searches = alone ? [] : [() => searchSteps(data, width, height, direct, colorSpace, 3, analysis, screen ? best.length : Infinity)];
    if (!(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true)) {
      if (effort >= 4 && shape.palette) searches.push(() => deep.localSteps(data, width, height, shape, colorSpace, 4, true, best.length));
      if (effort >= 6 && shape.palette) searches.push(() => deep.localSteps(data, width, height, shape, colorSpace, 6, true, best.length));
      if (effort >= 4 && !alone) searches.push(() => deep.rctSearchSteps(data, width, height, shape, colorSpace));
    }
    const level = losslessLevel(effort, ...(yield* rankingOf(data, width, height, shape, colorSpace)));
    searches.unshift(() => losslessCapture(data, width, height, colorSpace, level));
    const older = !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && deep?.screenSteps;
    if (older && screen) searches.unshift(() => older(data, width, height, shape, colorSpace, {fastFloor: effort === 3 ? best.length : 0, effort, deep: deep.screen}));
    if (older && effort >= 4 && !screen && losslessScreenCandidate(data, width, height, shape, 3))
      searches.unshift(() => older(data, width, height, shape, colorSpace, {fastFloor: best.length, effort: 3, deep: deep.screen}));
    const count = searches.length;
    for (let i = 0; i < searches.length; i++) {
      try {
        const search = searches[i]();
        let step, reply, hurried = false;
        try { while (!(step = search.next(reply)).done) hurried = !!(reply = yield scaled(step.value, done => 0.5 + (i + done) / (2 * count))) && !journalRequest(step.value); } finally { if (!step?.done) search.return?.(); }
        if (step.value && step.value.length < best.length) best = step.value;
        if (hurried) return best;
      } catch (error) { if (error.code !== 'JXL_SIZE' && (!(error instanceof RangeError) || error.code)) throw error; }
    }
    return best;
  }
  try {
    const bytes = yield* part(losslessCapture(data, width, height, colorSpace, losslessLevel(3, ...(yield* rankingOf(data, width, height, shape, colorSpace)))), 1, 2);
    if (bytes && bytes.length < best.length) best = bytes;
  } catch (error) { if (error.code !== 'JXL_SIZE' && (!(error instanceof RangeError) || error.code)) throw error; }
  return best;
}

export function losslessScreenCandidate(data, width, height, shape, effort) {
  return effort === 3 ? !!shape.palette : effort >= 4 && screenLike(data, width, height);
}


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

const LOSSLESS = Object.freeze({...LEVELS[3], ans: true, trees: 'learned', references: true, noRuns: true, fixedFallback: true, needs: ['trees', 'ans'], floor: false, patches: false, routes: 'one'});
const PRECISE = Object.freeze([5, 3, 6, 1, 2, 4, 7, 8, 9, 10, 11, 12, 13, 0]);
const BROAD = Object.freeze([5, 3, 6, 1, 2, 4, 13, 0]);
const SMALL_FAST = Object.freeze({referenceKinds: Object.freeze([]), properties: Object.freeze([15, 9, 10, 11, 12, 13, 14])});
export function losslessSets(effort, ranked = [6, 6]) {
  const [first, second] = ranked, small = !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && effort >= 6 ? Object.freeze({charge: 0, predictors: PRECISE, bins: 255, nodes: 255, clustered: false}) : SMALL_FAST;
  const set = (rcts, learn) => Object.freeze({rcts: [...new Set(rcts)], learn: Object.freeze({...learn, leaf: true, small})});
  if (typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) return [set([first], {samples: 4096, nodes: 31})];
  const five = {samples: 32768, nodes: 127}, six = {samples: 65536, nodes: 169}, seven = {samples: 131072, nodes: 255, bins: 128, predictors: BROAD};
  const eight = {samples: 131072, nodes: 575, predictors: PRECISE, bins: 128, charge: 8, clustered: true}, nine = {...eight, samples: 262144, nodes: 1663, bins: 192};
  if (effort >= 9) return [set([first, second], nine), set([first, second], eight), set([first], seven)];
  if (effort >= 8) return [set([first, second], eight), set([first], seven)];
  if (effort >= 7) return [set([first], seven), set([first], six)];
  if (effort >= 6) return [set([first], six), set([first], five)];
  return [effort >= 5 ? set([first], five)
    : effort >= 4 ? set([first], {samples: 16384, nodes: 63}) : set([first], {samples: 4096, nodes: 31})];
}
function smallSets(effort, ranked, pixels) {
  const seen = new Map(), wide = pixels <= 4096 && effort >= 6 ? 16 : 2;
  for (let e = pixels <= 4096 && effort <= 5 ? effort : 2; e <= effort; e++) for (const set of losslessSets(e, ranked)) seen.set(JSON.stringify(set), set);
  return [...seen.values()].map(set => Object.freeze({...set, rcts: [...new Set([...set.rcts, ...ranked.slice(0, wide), 6])]}));
}
const NOISE = Object.freeze({rcts: Object.freeze([0]), learn: Object.freeze({leaf: true, whole: true, least: Infinity})});
export const losslessLevel = (effort, ranked, estimate, pixels = Infinity) => Object.freeze({...LOSSLESS, estimate, gate: effort >= 6 ? 2 : 1.5,
  learnSets: estimate * 8 >= 16 * pixels ? [...losslessSets(Math.min(effort, 3), ranked), ...!(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && effort >= 7 ? [NOISE] : []] : pixels <= 65536 ? smallSets(effort, ranked, pixels) : losslessSets(effort, ranked)});
function* rankingOf(data, width, height, shape, colorSpace) {
  if (typeof colorSpace === 'object') return [[6, 6], undefined, width * height];
  if (!journaling() || shape.colour !== 3) return ranking(data, width, height, shape);
  return yield* unit('ranking', () => { const [ranked, estimate, pixels] = ranking(data, width, height, shape); return [Array.from(ranked), estimate, pixels]; });
}
function ranking(data, width, height, shape) {
  if (shape.colour !== 3) return [[6, 6], undefined, width * height];
  const ranked = transformRanking(data, width, height);
  return [ranked, ranked.bits * width * height / 8, width * height];
}
function* losslessCapture(data, width, height, colorSpace, level) {
  if (typeof colorSpace === 'object') return null;
  while (captureBusy()) if (yield 0) return null;
  const source = journaling() && journalFact(data, JOIN) ? {width, height, rows: (y, count) => data.subarray(y * width * 4, (y + count) * width * 4)} : data;
  const steps = encodeCaptureSteps(source, width, height, {colorSpace, effort: 3, [CAPTURE_TOOLS]: CAPTURE_TOOLS_COMPLETE, [CAPTURE_LEVEL]: level, [CAPTURE_FLOOR]: shapeFloors.get(data)});
  let step;
  try {
    let reply;
    while (!(step = steps.next(reply)).done) {
      reply = undefined;
      if (journalRequest(step.value)) reply = yield step.value;
      else if (typeof step.value === 'number' && (yield step.value) && step.value < 1) return null;
    }
  } finally { steps.return?.(); }
  return step.value;
}

function* unitsOnly(steps) {
  let step, reply;
  try {
    while (!(step = steps.next(reply)).done) reply = journalRequest(step.value) ? yield step.value : undefined;
  } finally { if (!step?.done) steps.return?.(); }
  return step.value;
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
