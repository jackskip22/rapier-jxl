// SPDX-License-Identifier: MIT
import {complete} from './bits.mjs';
import {photoXYBSteps, XYB_TABLES} from './photo-xyb.mjs';
import {transformDCT8, dct8Basis} from './photo-dct.mjs';
import {V6, GABORISH, prepareV6, photoV6Image, v6Image, v6Trace} from './photo-v6.mjs';
import {closedLoopStrategySteps, xybStrategies, cellSums, lazyStrategyImage, materialize} from './varblocks.mjs';
import {closedLoopFieldSteps, blockDistances} from './aq.mjs';
import {exactScores, bandedRGBA} from './exact-region.mjs';
import {reconstruct, toRGBA} from './reconstruct.mjs';
import {butteraugli, butteraugliReference} from './butteraugli.mjs';
import {ssimulacra2, ssimulacra2Reference, linearFromRGBA} from './ssimulacra2.mjs';
import {coefficientAnsSteps, estimateBytes} from './coefficient-ans.mjs';

import {memoryPlan, s2Admitted, S2_SEARCH_PIXELS} from './memory-plan.mjs';
export {S2_SEARCH_PIXELS};
import {fault} from './fault.mjs';
import {linearFromTransform} from './icc-transform.mjs';

export {prepareV6, V6, GABORISH};
export const AQ = {rounds: 3, switchCost: 0.01, gamma: 0.5, aimQuantile: 0.9};
export const VARBLOCK_IDS = [5, 10, 11, 4, 6, 7];

export const CANDIDATES = ['gaborish', 'blocks', 'field', 'closed', 'plain'];
const EFFORT_CANDIDATES = {8: ['gaborish', 'blocks'], 9: ['gaborish', 'blocks', 'field', 'plain']};
const EFFORT_IDS = {8: VARBLOCK_IDS, 9: VARBLOCK_IDS};

export function nativeSsimulacra2(reference, linear, width, height) {
  const pixels = width * height;
  return ssimulacra2(reference, linearFromRGBA(toRGBA(linear, width, height), pixels), width, height, {native: true}).score;
}

export const S2_MARGIN = 0.04;

export const NATIVE_DOUBT = 1e-4;

export const BA3_DOUBT = 1e-6, BA_DOUBT = 1e-5;
export const CELL_DOUBT = 2e-4, BLOCK_DOUBT = 1e-4;
export function gpuDoubt(scores, ssimulacra2 = 0) {
  const doubt = {};
  if (ssimulacra2) doubt.ssimulacra2 = ssimulacra2;
  if (scores.butteraugli3 !== undefined) { doubt.butteraugli3 = BA3_DOUBT * scores.butteraugli3; doubt.butteraugli = BA_DOUBT * scores.butteraugli; }
  if (scores.cells) doubt.cells = CELL_DOUBT;
  if (scores.blocks) doubt.blocks = BLOCK_DOUBT;
  return Object.keys(doubt).length ? doubt : null;
}

export function cpuMeasure(rgba, width, height, {native = false, reference = null, cacheBytes = 0, immutable = false} = {}) {
  const n = width * height;
  let photo = null, inputBytes = 0, supplied = typeof reference === 'function' ? null : reference ?? {rgba};
  if (supplied) {
    if (immutable) photo = supplied;
    else if (supplied.rgba) {
      const bytes = supplied.rgba;
      photo = {rgba: new Uint8Array(bytes.subarray ? bytes.subarray(0, n * 4) : bytes.slice(0, n * 4))};
      inputBytes = photo.rgba.byteLength;
    } else {
      photo = [0, 1, 2].map(c => {
        const plane = supplied[c];
        return Float64Array.from(plane.subarray ? plane.subarray(0, n) : plane.slice(0, n));
      });
      inputBytes = photo.reduce((sum, plane) => sum + plane.byteLength, 0);
    }
  }
  supplied = null; rgba = null;
  if (typeof reference !== 'function') reference = null;
  let currentReference = null, currentLinear = null, ba = null, destroyed = false, busy = false;
  const rawReference = () => currentReference ??= typeof reference === 'function' ? reference() : reference ?? photo;
  const linearReference = () => {
    const raw = rawReference();
    return raw.rgba ? currentLinear ??= linearFromRGBA(raw.rgba, n) : raw;
  };
  let s2 = ssimulacra2Reference(rawReference, width, height, {native, cacheBytes, immutable: true});
  const maskCacheBytes = cacheBytes - s2.reservedBytes;
  const measure = (image, {p = 3, margin = 2, ssimulacra2: wantS2 = false, butteraugli: wantBa = true} = {}) => {
    if (destroyed) throw new Error('CPU measurer is destroyed.');
    if (busy) throw new Error('CPU measurer is already in use.');
    busy = true;
    let lin = null;
    try {
      lin = reconstruct(materialize(image));
      const out = {};
      if (wantBa) {
        let r = butteraugli(ba ??= butteraugliReference(linearReference(), width, height, {cacheBytes: maskCacheBytes}), lin);
        Object.assign(out, {butteraugli: r.score, butteraugli3: r.pnorm3, cells: cellSums(r.map, width, height, p), blocks: blockDistances({map: r.map, width, height}, margin)});
        r = null; currentLinear = null;
      }
      if (wantS2) {
        if (native) { const decoded = {rgba: toRGBA(lin, width, height)}; lin = null; out.ssimulacra2 = ssimulacra2(s2, decoded, width, height, {native: true}).score; }
        else out.ssimulacra2 = ssimulacra2(s2, lin, width, height).score;
      }
      return out;
    } finally {
      lin = null; currentReference = null; currentLinear = null; busy = false;
    }
  };
  measure.banded = (image, want = {}, measureBa) => {
    const {ssimulacra2: wantS2 = false, butteraugli: wantBa = true} = want;
    if (destroyed) throw new Error('CPU measurer is destroyed.');
    if (busy) throw new Error('CPU measurer is already in use.');
    busy = true;
    let lin = null;
    try {
      const out = {};
      if (wantS2 && native) out.ssimulacra2 = ssimulacra2(s2, {rgba: bandedRGBA(image)}, width, height, {native: true}).score;
      else if (wantS2) { lin = reconstruct(image); out.ssimulacra2 = ssimulacra2(s2, lin, width, height).score; }
      lin = null;
      if (wantBa) Object.assign(out, measureBa(rawReference(), image, want));
      return out;
    } finally {
      lin = null; currentReference = null; currentLinear = null; busy = false;
    }
  };
  measure.withReference = consume => {
    if (destroyed) throw new Error('CPU measurer is destroyed.');
    if (busy) throw new Error('CPU measurer is already in use.');
    busy = true;
    try { return consume(rawReference()); }
    finally { currentReference = null; currentLinear = null; busy = false; }
  };
  Object.defineProperties(measure, {
    cacheBytes: {get: () => (s2?.cacheBytes ?? 0) + (ba?.cacheBytes ?? 0)},
    cacheAllowanceBytes: {value: cacheBytes},
    referenceBytes: {get: () => ba?.referenceBytes ?? 0},
    inputBytes: {get: () => inputBytes},
  });
  measure.destroy = () => {
    if (busy) throw new Error('CPU measurer is already in use.');
    destroyed = true; photo = null; inputBytes = 0; reference = null; currentReference = null; currentLinear = null; s2 = null; ba = null;
  };
  return measure;
}


export function runSync(steps, measure) {
  let completed = false;
  try {
    let step = steps.next();
    while (!step.done) {
      const reply = step.value?.measure ? measure(step.value.measure, step.value.want) : undefined;
      step = null; step = steps.next(reply);
    }
    completed = true; return step.value;
  } finally { try { steps.return(); } catch (error) { if (completed) throw error; } }
}
export async function runAsync(steps, measure, onProgress = () => {}) {
  let completed = false;
  try {
    let step = steps.next();
    while (!step.done) {
      let reply;
      if (step.value?.measure) reply = await measure(step.value.measure, step.value.want);
      else if (step.value?.varblocks) reply = await measure.varblocks?.(step.value.varblocks);
      else if (step.value?.exact) reply = await measure.exact?.(step.value.exact);
      else onProgress(step.value);
      step = null; step = steps.next(reply);
    }
    completed = true; return step.value;
  } finally { try { steps.return(); } catch (error) { if (completed) throw error; } }
}

function searchTransforms() { return null; }

export function* decisionSteps(prepared, quality, fieldOnly = false, aq = AQ, ids = VARBLOCK_IDS, lambda = 1, initial = null) {
  const {width, height} = prepared;
  if (initial?.quality !== quality) initial = null;
  const field = aq === false ? undefined : yield* closedLoopFieldSteps(width, height, f => v6Image(prepared, quality, {fieldScale: f}), {...aq, initial: initial?.scores?.blocks && (aq.margin ?? 2) === 2 ? initial : null});
  if (fieldOnly) return {field};
  const base = v6Image(prepared, quality, {fieldScale: field, keepPlanes: true});
  const transforms = prepared.transforms ??= searchTransforms(prepared);
  const {layout} = yield* closedLoopStrategySteps(base, width, height, {deadzone: V6.deadzone, lambda, ids, transforms, initial: aq === false ? initial : null});
  return {field, layout, transforms};
}

function* closedSteps(prepared, quality, known, ids = VARBLOCK_IDS, lambda = 1, field = true) {
  if (!known) return yield* decisionSteps(prepared, quality, false, field ? AQ : false, ids, lambda);
  const {width, height} = prepared, initial = known.initial;
  known.initial = null;
  const base = v6Image(prepared, quality, {fieldScale: known.field, keepPlanes: true});
  const transforms = prepared.transforms ??= searchTransforms(prepared);
  const {layout} = yield* closedLoopStrategySteps(base, width, height, {deadzone: V6.deadzone, lambda, ids, transforms, initial});
  return {field: known.field, layout, transforms};
}

export function candidateImage(prepared, name, quality, decisions) {
  const {rgba, width, height} = prepared;
  if (name === 'plain') return complete(photoXYBSteps(rgba, width, height, quality, {...V6, ...prepared.color, dctCache: prepared.dctPlain}));
  if (name === 'gaborish') return photoV6Image(prepared, quality);
  if (name === 'field') return v6Image(prepared, quality, {fieldScale: decisions.field});
  const base = v6Image(prepared, quality, {fieldScale: decisions.field, keepPlanes: true}), options = {deadzone: V6.deadzone, transforms: decisions.transforms};
  if (base.planeRows) return lazyStrategyImage(base, width, height, options, decisions.layout);
  return xybStrategies(base, width, height, {...options, layout: decisions.layout}).image;
}
export function* candidateImageSteps(prepared, name, quality, decisions) {
  if (name !== 'closed' && name !== 'blocks') return candidateImage(prepared, name, quality, decisions);
  const {width, height} = prepared;
  const base = v6Image(prepared, quality, {fieldScale: decisions.field, keepPlanes: true});
  if (base.planeRows) return lazyStrategyImage(base, width, height, {deadzone: V6.deadzone, transforms: decisions.transforms}, decisions.layout);
  const options = {deadzone: V6.deadzone}, exact = yield {varblocks: {kind: 'layout', base, width, height, options, layout: decisions.layout}};
  return xybStrategies(base, width, height, {...options, layout: decisions.layout, transforms: decisions.transforms, ...(exact ? {exact} : {})}).image;
}

export function writeImage(image, effort = 7) {
  image = materialize(image);
  return complete(image.strategyData ? encodeStrategyImageSteps(image, true, effort) : coefficientAnsSteps(image, effort));
}

export function meets(scores, target) {
  return (target.ssimulacra2 === undefined || scores.ssimulacra2 >= target.ssimulacra2)
    && (target.butteraugli3 === undefined || scores.butteraugli3 <= target.butteraugli3)
    && (target.butteraugli === undefined || scores.butteraugli <= target.butteraugli);
}
function margin(scores, target) {
  const m = [];
  if (target.ssimulacra2 !== undefined) m.push(scores.ssimulacra2 - target.ssimulacra2);
  if (target.butteraugli3 !== undefined) m.push((target.butteraugli3 - scores.butteraugli3) / (0.04 * target.butteraugli3));
  if (target.butteraugli !== undefined) m.push((target.butteraugli - scores.butteraugli) / (0.04 * target.butteraugli));
  return Math.min(...m);
}

function searchStep(tried, pass, {low, high, aim, close}) {
  const {q, m} = tried[tried.length - 1];
  if (pass && m < close) return {stop: true};
  const passes = tried.filter(t => t.m >= 0), fails = tried.filter(t => t.m < 0);
  const p = passes.length && passes.reduce((a, b) => b.q < a.q ? b : a), f = fails.length && fails.reduce((a, b) => b.q > a.q ? b : a);
  let next;
  if (p && f) {
    if (p.q - f.q < 0.02) return {stop: true};
    next = f.q + (aim - f.m) * (p.q - f.q) / (p.m - f.m);
    next = Math.min(p.q - 0.01, Math.max(f.q + 0.1, next));
  } else {
    const [a, b] = tried.length > 1 ? tried.slice(-2) : [null, null];
    const slope = a && b.q !== a.q ? Math.max(0.2, (b.m - a.m) / (b.q - a.q)) : 0.8;
    next = Math.max(low, Math.min(high, q + (aim - m) / slope));
    if (next === q) return {stop: true};
  }
  return {next: Math.round(next * 100) / 100};
}

function marginDoubt(scores, target) {
  const d = scores.doubt;
  if (!d) return 0;
  let out = 0;
  if (target.ssimulacra2 !== undefined) out = Math.max(out, d.ssimulacra2 ?? 0);
  if (target.butteraugli3 !== undefined) out = Math.max(out, (d.butteraugli3 ?? 0) / (0.04 * target.butteraugli3));
  if (target.butteraugli !== undefined) out = Math.max(out, (d.butteraugli ?? 0) / (0.04 * target.butteraugli));
  return out;
}

function undecided(tried, pass, options) {
  const doubtful = tried.map((t, i) => [t, i]).filter(([t]) => t.d > 0);
  if (!doubtful.length) return false;
  if (doubtful.some(([t]) => Math.abs(t.m) <= t.d)) return true;
  const key = r => r.stop ? 'stop' : String(r.next), base = key(searchStep(tried, pass, options)), last = tried.length - 1;
  for (let corner = 0; corner < 1 << Math.min(doubtful.length, 10); corner++) {
    const moved = tried.slice();
    doubtful.slice(0, 10).forEach(([t, i], k) => { moved[i] = {q: t.q, m: t.m + (corner >> k & 1 ? t.d : -t.d), d: t.d}; });
    if (key(searchStep(moved, moved[last].m >= 0 && pass, options)) !== base) return true;
  }
  return false;
}

function* qualitySteps(imageAt, target, {start = 85, probes = 8, low = 20, high = 99.99, aim = 0.05, close = 0.12, targetDoubt = null, initial = null, first = null} = {}) {
  const want = {ssimulacra2: target.ssimulacra2 !== undefined, butteraugli: target.butteraugli3 !== undefined || target.butteraugli !== undefined}, tried = [];
  const options = {low, high, aim, close};
  const targetBound = () => targetDoubt ? marginDoubt({doubt: targetDoubt}, target) : 0;
  const view = () => tried.map(t => ({q: t.q, m: margin(t.scores, target), d: (t.exact ? 0 : marginDoubt(t.scores, target)) + targetBound()}));
  let q = start, best = null, bestObserved = null;
  const remember = (quality, scores) => {
    if (!bestObserved || margin(scores, target) > margin(bestObserved, target))
      bestObserved = {quality, ...Object.fromEntries(Object.keys(target).map(key => [key, scores[key]]))};
  };
  for (let i = 0; i < probes; i++) {
    const known = !i && initial?.scores && initial.quality === q ? initial : null;
    let image = known ? known.image : yield* imageAt(q);
    let scores = known ? known.scores : yield {measure: image, want}, pass = meets(scores, target);
    tried.push({q, scores, exact: !scores.doubt});
    if (undecided(view(), pass, options)) {
      scores = yield {measure: image, want: {...want, exact: true}}; pass = meets(scores, target);
      tried[tried.length - 1] = {q, scores, exact: true};
      if (targetBound() > 0 && undecided(view(), pass, options)) { yield {exactTarget: true}; pass = meets(scores, target); }
      for (let k = tried.length - 2; k >= 0; k--) if (!tried[k].exact && undecided(view(), pass, options)) {
        const again = yield {measure: yield* imageAt(tried[k].q), want: {...want, exact: true}};
        tried[k] = {q: tried[k].q, scores: again, exact: true};
      }
    }
    if (!i && first) Object.assign(first, {quality: q, image, scores});
    remember(q, scores);
    if (pass && (!best || q < best.quality)) best = {quality: q, scores};
    image = null;
    const step = searchStep(view(), pass, options);
    if (step.stop) break;
    q = step.next;
  }
  if (!best) { best = {quality: high, scores: yield {measure: yield* imageAt(high), want: {...want, exact: true}}}; remember(high, best.scores); }
  return {...best, bestObserved};
}

export function* scoreSteps(prepared, target, {candidates = CANDIDATES, effort = 7, start = 85, aq = AQ, ids = VARBLOCK_IDS, lambda = 1, field = true, targetDoubt = null, initial = null, reuseDecisions = true, pooled = false, exactSize = false} = {}) {
  const found = [];
  let gaborishQuality = start, fieldDecisions = null, gaborish = initial;
  for (const name of [...candidates].sort((a, b) => CANDIDATES.indexOf(a) - CANDIDATES.indexOf(b))) {
    let decisions = null;
    const seed = function* () {
      if (!reuseDecisions || gaborish?.quality !== gaborishQuality) return null;
      return {quality: gaborish.quality, scores: gaborish.scores, image: gaborish.imageAt ? yield* gaborish.imageAt(gaborish.quality) : gaborish.image};
    };
    if (name === 'field') decisions = fieldDecisions = yield* decisionSteps(prepared, gaborishQuality, true, aq, ids, lambda, yield* seed());
    if (name === 'blocks') decisions = yield* decisionSteps(prepared, gaborishQuality, false, false, ids, lambda, yield* seed());
    if (name === 'closed') decisions = yield* closedSteps(prepared, gaborishQuality, fieldDecisions, ids, lambda, field);
    const first = name === 'field' && reuseDecisions && candidates.includes('closed') ? {} : null;
    const imageAt = function* (q) {
      if (name === 'gaborish' && initial?.image && initial.quality === q) return initial.image;
      return yield* candidateImageSteps(prepared, name, q, decisions);
    };
    const best = yield* qualitySteps(imageAt, target, {start: name === 'gaborish' ? start : gaborishQuality, targetDoubt,
      initial: name === 'gaborish' ? initial : null, first});
    if (first) decisions.initial = first;
    if (name === 'gaborish') { gaborishQuality = best.quality; gaborish = {...best, imageAt}; }
    found.push({candidate: name, quality: best.quality, imageAt, ...best.scores, pass: meets(best.scores, target),
      bestObserved: {candidate: name, ...best.bestObserved}});
  }
  gaborish = null; fieldDecisions = null;
  if (initial) initial.image = null;
  const completeFiles = effort >= 8 || exactSize;
  for (const f of found) {
    f.cells = undefined; f.blocks = undefined;
    if (!completeFiles) f.size = found.length > 1 ? estimateBytes(materialize(yield* f.imageAt(f.quality))) : 0;
  }
  const passing = found.filter(f => f.pass), pool = passing.length ? passing : found;
  const encode = function* (f) {
    if (initial?.effort === effort && initial.bytes && f.candidate === 'gaborish' && f.quality === initial.quality) return initial.bytes;
    const image = yield* f.imageAt(f.quality);
    return pooled ? yield {encode: {image, effort, pass: f.pass}} : writeImage(image, effort);
  };
  let chosen, bytes;
  if (completeFiles) for (const f of pool) {
    const encoded = yield* encode(f); f.size = encoded.length;
    if (!bytes || encoded.length < bytes.length) { chosen = f; bytes = encoded; }
  }
  else {
    chosen = pool.reduce((a, b) => b.size < a.size ? b : a);
    bytes = yield* encode(chosen);
  }
  if (chosen.butteraugli3 === undefined) {
    const scores = yield {measure: yield* chosen.imageAt(chosen.quality), want: {ssimulacra2: target.ssimulacra2 !== undefined}};
    chosen.butteraugli = scores.butteraugli; chosen.butteraugli3 = scores.butteraugli3;
  }
  return {...chosen, bytes, size: bytes.length, imageAt: undefined, cells: undefined, blocks: undefined,
    tried: found.map(({imageAt, cells, blocks, ...rest}) => rest)};
}

function* measuredSteps(steps, measure, expected) {
  let completed = false;
  try {
    let step, reply, n = 0;
    while (!(step = steps.next(reply)).done) {
      if (!step.value?.measure) { step = null; reply = undefined; continue; }
      reply = measure(step.value.measure, step.value.want);
      step = null;
      if (yield Math.min(0.95, ++n / expected)) return null;
    }
    completed = true; return step.value;
  } finally {
    try { steps.return(); } catch (error) { if (completed) throw error; }
  }
}

const deeperFloor = (floor, effort) => { const deeper = writeImage(floor.image, effort); return deeper.length < floor.bytes.length ? deeper : floor.bytes; };

export function* searchV6(prepared, own, quality, effort, floor = null, gpu = false) {
  const s2Route = (w, h, color) => floor?.image && w >= 128 && h >= 128 && !color?.transform;
  if (typeof prepared === 'function') {
    if (s2Route(prepared.width, prepared.height, prepared.color) && prepared.width * prepared.height > S2_SEARCH_PIXELS) return deeperFloor(floor, effort);
    prepared = prepared();
  }
  prepared.transforms ??= searchTransforms(prepared, 0);
  const {rgba, width, height, color} = prepared;
  const plan = prepared.memory ?? memoryPlan(width * height, {width, height, exact: false});
  if (plan.known && !plan.fits) throw fault('JXL_MEMORY', 'Measured search exceeds its memory reservation.');
  if (s2Route(width, height, color)) {
    if (width * height > S2_SEARCH_PIXELS) return deeperFloor(floor, effort);
    if (!s2Admitted(plan, width, height, effort)) throw fault('JXL_MEMORY', 'The effort 8-9 search exceeds the memory reservation.');
    return yield* s2EffortSearchSteps(prepared, quality, effort, floor, gpu);
  }
  if (typeof own === 'function') own = own();
  const ownBytes = writeImage(own, effort), whole = cpuMeasure(rgba, width, height, color?.transform
    ? {reference: linearFromTransform(rgba, width * height, color.transform), cacheBytes: plan.cacheBytes}
    : {native: true, cacheBytes: plan.cacheBytes});
  try {
    const measure = (image, want) => exactScores(whole, null, width, height, image, want, plan);
    const scores = measure(own, {ssimulacra2: true}), target = {butteraugli3: scores.butteraugli3, ssimulacra2: scores.ssimulacra2 + S2_MARGIN};
    const takeImage = () => { const image = own; own = null; return image; };
    const found = yield* measuredSteps(scoreSteps(prepared, target, {candidates: EFFORT_CANDIDATES[effort >= 9 ? 9 : 8], ids: EFFORT_IDS[effort >= 9 ? 9 : 8], effort, start: quality,
      initial: {quality, image: takeImage(), scores, bytes: ownBytes, effort}}), measure, effort >= 9 ? 44 : 20);
    return found && found.pass && found.size < ownBytes.length ? found.bytes : ownBytes;
  } finally { whole.destroy(); }
}

import {TRANSFORMS, scaledDCTBases, lowFrequencies} from './vardct-strategies.mjs';
import {smoothField} from './aq.mjs';
import {exactLog, exactExp, exactPow} from './exact-math.mjs';
import {encodeStrategyImageSteps, strategyInputs, rateModel, tokenRate, forcedLayout} from './varblocks.mjs';

function* layoutImage(base, width, height, layout, options, req) {
  let exact = null;
  if (req) {
    const ids = [...new Set([4, ...layout.map(b => b.id)])].filter(id => id), search = {...options, ids};
    const made = yield {gpu: {kind: 'blocks-levels', ...req, input: strategyInputs(base, width, height, search), search, ids, scaledDCTBases, lowFrequencies, layout}};
    exact = made?.exact ?? null;
    if (exact) gpuStats.levels++;
  }
  return xybStrategies(base, width, height, {...options, layout, ...(exact ? {exact} : {})}).image;
}
export const gpuStats = {levels: 0};

export function* s2GuidedBlocksSteps(base, width, height, refMap, ids = [4, 5, 6, 7], lamFactor = 0.85, req = null) {
  const stride = base.components[0].stride, rows = base.components[0].rows, tokens = rateModel(base, stride, rows, 8);
  const plain = {deadzone: V6.deadzone, sizeScale: 1.03}, perceptual = {...plain, perceptual: true};
  const maps = [], rates = new Map();
  let score0 = 75;
  for (const id of [0, ...ids]) {
    const layout = forcedLayout(id, stride, rows);
    let picture = yield* layoutImage(base, width, height, layout, plain, req);
    for (const b of picture.strategyData.blocks) (rates.get(b.id) ?? rates.set(b.id, new Float64Array(stride * rows)).get(b.id))[b.by * stride + b.bx] = tokenRate(b, tokens);
    picture = null;
    v6Trace(`s2 shape ${id} rates`);
    picture = yield* layoutImage(base, width, height, layout, perceptual, req);
    v6Trace(`s2 shape ${id} picture`);
    let lin = reconstruct(picture);
    picture = null;
    v6Trace(`s2 shape ${id} reconstructed`);
    let s2Res = ssimulacra2(refMap, lin, width, height, {wantMap: true});
    lin = null;
    v6Trace(`s2 shape ${id} map`);
    if (id === 0) score0 = s2Res.score;
    maps[id] = cellSums(s2Res.map, width, height, 1);
    s2Res = null;
  }
  for (const r of rates.values()) for (let i = 0; i < r.length; i++) r[i] += 8.0;
  const lamBlock = lamFactor * (30 / Math.max(8, 100 - score0));
  let {layout} = xybStrategies(base, width, height, {
    deadzone: V6.deadzone, sizeScale: 1.03, ids, maps, rates, lambda: lamBlock, model: 'tokens', chooseOnly: true,
  });
  for (const fam of [8, 5, 4, 6]) {
    const count = layout.filter(b => TRANSFORMS[b.id].table === fam).length;
    if (count > 0 && count < 8) {
      layout = layout.flatMap(b => {
        if (TRANSFORMS[b.id].table !== fam) return [b];
        const bw = TRANSFORMS[b.id].width / 8, bh = TRANSFORMS[b.id].height / 8, sub = [];
        for (let dy = 0; dy < bh; dy++) for (let dx = 0; dx < bw; dx++) sub.push({id: 0, bx: b.bx + dx, by: b.by + dy});
        return sub;
      });
    }
  }
  const s2Var = yield* layoutImage(base, width, height, layout, perceptual, req);
  return {s2Var, layout, maps, rates, score0};
}
export const s2GuidedBlocks = (...args) => complete(s2GuidedBlocksSteps(...args));

const LAGRANGE_LEVELS = [0.78, 0.85, 0.92, 0.96, 1.0, 1.05, 1.12, 1.18, 1.25];
export function lagrangeS2Field(s2Var, r0, refMap, width, height, {gamma = 0.18, r0Bias = 20, switchCost = 0.04} = {}) {
  const lin = reconstruct(s2Var);
  const {map: s2Map} = ssimulacra2(refMap, lin, width, height, {wantMap: true});
  const cells = cellSums(s2Map, width, height, 1), n = cells.length;
  const slope = new Float64Array(n);
  let logSum = 0;
  for (let i = 0; i < n; i++) {
    slope[i] = Math.max(1e-6, cells[i]) / (r0[i] + r0Bias);
    logSum += exactLog(slope[i]);
  }
  const meanSlope = exactExp(logSum / Math.max(1, n));
  const raw = new Float64Array(n);
  for (let i = 0; i < n; i++) raw[i] = Math.max(0.78, Math.min(1.25, exactPow(slope[i] / meanSlope, gamma)));
  return smoothField(raw, LAGRANGE_LEVELS, switchCost);
}

export function* s2EffortSearchSteps(prepared, quality, effort = 8, floor, gpu = false) {
  const {color} = prepared;
  return yield* s2Search(prepared, quality, effort, floor, gpu && !color?.transform && !color?.space);
}

function* s2Search(prepared, quality, effort, floor, device) {
  const {rgba, width, height} = prepared;
  const cacheBytes = Math.min(64 * 1024 * 1024, Math.max(8 * 1024 * 1024, width * height * 64));
  const refMap = ssimulacra2Reference({rgba}, width, height, {native: false, immutable: true, cacheBytes});
  const refNative = ssimulacra2Reference({rgba}, width, height, {native: true, immutable: true, cacheBytes});
  v6Trace('s2 refs');
  const decodedOf = img => toRGBA(reconstruct(materialize(img)), width, height);
  const cpuScore = (img, decoded = decodedOf(img)) => ssimulacra2(refNative, {rgba: decoded}, width, height, {native: true}).score;
  function* scored(img, bytes) {
    const decoded = decodedOf(img);
    const answer = device ? yield {gpu: {kind: 's2-native', rgba, width, height, decoded}} : null;
    if (Number.isFinite(answer?.score)) return {img, bytes, s2: answer.score, doubt: NATIVE_DOUBT, decoded};
    return {img, bytes, s2: cpuScore(img, decoded), doubt: 0};
  }
  const rank = img => scored(img, writeImage(img, 7));
  function choose(order, c0) {
    const pick = () => {
      const k = 1.03 / Math.max(6, 100 - c0.s2), J = c => Math.log(c.bytes.length) - k * (c.s2 - c0.s2);
      return order.reduce((a, c) => J(c) < J(a) ? c : a);
    };
    let w = pick();
    if (order.some(c => c.doubt) && !certain(order, w, c0)) {
      for (const c of order) if (c.doubt) { c.s2 = cpuScore(null, c.decoded); c.doubt = 0; c.decoded = null; }
      v6Trace('s2 scores again on the CPU');
      w = pick();
    }
    return w;
  }
  const smallest = (...files) => files.filter(Boolean).reduce((a, b) => b.length < a.length ? b : a);
  const reqFor = row => device ? {data: rgba, width, height, options: {...V6, ...GABORISH, calibrationRow: row}, lib: {complete, photoXYBSteps, transformDCT8, dct8Basis, xyb: XYB_TABLES}} : null;

  const c0 = yield* scored(floor.image, floor.bytes);
  v6Trace('s2 c0 scored');
  let floorWrites = null;
  if (width * height > 2048 * 2048) {
    floorWrites = {8: writeImage(floor.image, 8), ...(effort >= 9 ? {9: writeImage(floor.image, 9)} : {})};
    c0.img = null; floor.image = null;
    v6Trace('s2 c0 written');
  }
  const write = (c, e) => c === c0 && floorWrites ? floorWrites[e] : writeImage(c.img, e);
  if (yield 0.05) return floor.bytes;
  function* guided(row, extra, ids, lamFactor) {
    const base = v6Image(prepared, quality, {...extra, keepPlanes: true, calibrationRow: row, noLevels: false}, false);
    v6Trace(`s2 base ${row}`);
    return yield* s2GuidedBlocksSteps(base, width, height, refMap, ids, lamFactor, reqFor(row));
  }
  const {s2Var, rates} = yield* guided('s2e8', {}, [4, 5, 6, 7], 0.85);
  v6Trace('s2 guided A');
  if (yield 0.5) return floor.bytes;
  const cA = yield* rank(s2Var);
  v6Trace('s2 cA ranked');
  const e8Pick = choose([cA, c0], c0);
  if (effort <= 8) return smallest(write(e8Pick, 8), floor.bytes);
  if (yield 0.6) return floor.bytes;

  const {s2Var: s2VarB} = yield* guided('s2e9', {}, [4, 5, 6, 7, 10, 11], 1.25);
  v6Trace('s2 guided B');
  const cB = yield* rank(s2VarB);
  v6Trace('s2 cB ranked');
  if (yield 0.75) return floor.bytes;

  const fieldScale = lagrangeS2Field(s2Var, rates.get(0), refMap, width, height);
  const {s2Var: s2VarC} = yield* guided('s2e9', {fieldScale}, [4, 5, 6, 7], 0.95);
  v6Trace('s2 field and guided C');
  const cC = yield* rank(s2VarC);
  v6Trace('s2 cC ranked');
  if (yield 0.9) return floor.bytes;

  const best = choose([c0, cA, cB, cC], c0);
  return smallest(write(best, 9), best === e8Pick ? null : write(e8Pick, 8), floor.bytes);
}

export function certain(order, w, c0) {
  const kOf = s => 1.03 / Math.max(6, 100 - s), k0 = kOf(c0.s2 - c0.doubt), k1 = kOf(c0.s2 + c0.doubt);
  for (const c of order) {
    if (c === w) continue;
    const L = Math.log(c.bytes.length) - Math.log(w.bytes.length), d = c.s2 - w.s2, e = c.doubt + w.doubt;
    const most = Math.max(k0 * (d - e), k0 * (d + e), k1 * (d - e), k1 * (d + e));
    if (!(L - most > 1e-12 * (1 + Math.abs(Math.log(c.bytes.length))))) return false;
  }
  return true;
}
