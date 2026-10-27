// SPDX-License-Identifier: MIT
import {complete} from './bits.mjs';
import {photoXYBSteps} from './photo-xyb.mjs';
import {V6, GABORISH, prepareV6, photoV6Image} from './photo-v6.mjs';
import {closedLoopStrategySteps, xybStrategies, encodeStrategyImage, encodeStrategyImageSteps, cellSums} from './varblocks.mjs';
import {closedLoopFieldSteps, blockDistances} from './aq.mjs';
import {exactAnswerer, exactPool, exactScores} from './exact-region.mjs';
import {reconstruct, toRGBA} from './reconstruct.mjs';
import {butteraugli, butteraugliReference} from './butteraugli.mjs';
import {ssimulacra2, ssimulacra2Reference, linearFromRGBA} from './ssimulacra2.mjs';
import {coefficientEffortSteps} from './coefficient-effort.mjs';
import {coefficientAnsSteps, estimateBytes} from './coefficient-ans.mjs';

import {memoryPlan} from './memory-plan.mjs';
import {checkSignal} from './async-job.mjs';
import {fault} from './fault.mjs';
import {gpuSetup} from './gpu-reconstruct.mjs';
import {acGroupPool} from './ac-group.mjs';

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
      lin = reconstruct(image);
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
      if (wantS2) {
        lin = reconstruct(image);
        if (native) { const decoded = {rgba: toRGBA(lin, width, height)}; lin = null; out.ssimulacra2 = ssimulacra2(s2, decoded, width, height, {native: true}).score; }
        else out.ssimulacra2 = ssimulacra2(s2, lin, width, height).score;
      }
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
  const {rgba, width, height, pre} = prepared, options = {...V6, ...GABORISH, pre};
  if (initial?.quality !== quality) initial = null;
  const field = aq === false ? undefined : yield* closedLoopFieldSteps(width, height, f => complete(photoXYBSteps(rgba, width, height, quality, {...options, fieldScale: f, dctCache: prepared.dct})), {...aq, initial: initial?.scores?.blocks && (aq.margin ?? 2) === 2 ? initial : null});
  if (fieldOnly) return {field};
  const base = complete(photoXYBSteps(rgba, width, height, quality, {...options, fieldScale: field, keepPlanes: true, dctCache: prepared.dct}));
  const transforms = prepared.transforms ??= searchTransforms(prepared);
  const {layout} = yield* closedLoopStrategySteps(base, width, height, {deadzone: V6.deadzone, lambda, ids, transforms, initial: aq === false ? initial : null});
  return {field, layout, transforms};
}

function* closedSteps(prepared, quality, known, ids = VARBLOCK_IDS, lambda = 1, field = true) {
  if (!known) return yield* decisionSteps(prepared, quality, false, field ? AQ : false, ids, lambda);
  const {rgba, width, height, pre} = prepared, initial = known.initial;
  known.initial = null;
  const base = complete(photoXYBSteps(rgba, width, height, quality, {...V6, ...GABORISH, pre, fieldScale: known.field, keepPlanes: true, dctCache: prepared.dct}));
  const transforms = prepared.transforms ??= searchTransforms(prepared);
  const {layout} = yield* closedLoopStrategySteps(base, width, height, {deadzone: V6.deadzone, lambda, ids, transforms, initial});
  return {field: known.field, layout, transforms};
}

export function candidateImage(prepared, name, quality, decisions) {
  const {rgba, width, height, pre} = prepared;
  if (name === 'plain') return complete(photoXYBSteps(rgba, width, height, quality, {...V6, dctCache: prepared.dctPlain}));
  if (name === 'gaborish') return photoV6Image(prepared, quality);
  const options = {...V6, ...GABORISH, pre};
  if (name === 'field') return complete(photoXYBSteps(rgba, width, height, quality, {...options, fieldScale: decisions.field, dctCache: prepared.dct}));
  const base = complete(photoXYBSteps(rgba, width, height, quality, {...options, fieldScale: decisions.field, keepPlanes: true, dctCache: prepared.dct}));
  return xybStrategies(base, width, height, {deadzone: V6.deadzone, layout: decisions.layout, transforms: decisions.transforms}).image;
}
export function* candidateImageSteps(prepared, name, quality, decisions) {
  if (name !== 'closed' && name !== 'blocks') return candidateImage(prepared, name, quality, decisions);
  const {rgba, width, height, pre} = prepared;
  const base = complete(photoXYBSteps(rgba, width, height, quality, {...V6, ...GABORISH, pre, fieldScale: decisions.field, keepPlanes: true, dctCache: prepared.dct}));
  const options = {deadzone: V6.deadzone}, exact = yield {varblocks: {kind: 'layout', base, width, height, options, layout: decisions.layout}};
  return xybStrategies(base, width, height, {...options, layout: decisions.layout, transforms: decisions.transforms, ...(exact ? {exact} : {})}).image;
}

export function writeImage(image, effort = 7) {
  const write = level => image.strategyData ? encodeStrategyImage(image, level >= 7, level)
    : complete(level >= 5 ? coefficientAnsSteps(image, level) : coefficientEffortSteps(image, level));
  let best = write(Math.min(effort, 7));
  for (let level = 8; level <= effort; level++) {
    const bytes = write(level);
    if (bytes.length < best.length) best = bytes;
  }
  return best;
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
    if (pass && (!best || q < best.quality)) best = {quality: q, image, scores};
    image = null;
    const step = searchStep(view(), pass, options);
    if (step.stop) break;
    q = step.next;
  }
  if (!best) { const image = yield* imageAt(high); best = {quality: high, image, scores: yield {measure: image, want: {...want, exact: true}}}; remember(high, best.scores); }
  return {...best, bestObserved};
}

export function* scoreSteps(prepared, target, {candidates = CANDIDATES, effort = 7, start = 85, aq = AQ, ids = VARBLOCK_IDS, lambda = 1, field = true, targetDoubt = null, initial = null, reuseDecisions = true, pooled = false} = {}) {
  const found = [];
  let gaborishQuality = start, fieldDecisions = null, gaborish = initial;
  for (const name of [...candidates].sort((a, b) => CANDIDATES.indexOf(a) - CANDIDATES.indexOf(b))) {
    let decisions = null;
    const seed = reuseDecisions && gaborish?.quality === gaborishQuality ? gaborish : null;
    if (name === 'field') decisions = fieldDecisions = yield* decisionSteps(prepared, gaborishQuality, true, aq, ids, lambda, seed);
    if (name === 'blocks') decisions = yield* decisionSteps(prepared, gaborishQuality, false, false, ids, lambda, seed);
    if (name === 'closed') decisions = yield* closedSteps(prepared, gaborishQuality, fieldDecisions, ids, lambda, field);
    const first = name === 'field' && reuseDecisions && candidates.includes('closed') ? {} : null;
    const imageAt = function* (q) {
      if (name === 'gaborish' && initial?.quality === q) return initial.image;
      return yield* candidateImageSteps(prepared, name, q, decisions);
    };
    const best = yield* qualitySteps(imageAt, target, {start: name === 'gaborish' ? start : gaborishQuality, targetDoubt,
      initial: name === 'gaborish' ? initial : null, first});
    if (first) decisions.initial = first;
    if (name === 'gaborish') { gaborishQuality = best.quality; gaborish = best; }
    found.push({candidate: name, quality: best.quality, image: best.image, ...best.scores, pass: meets(best.scores, target),
      bestObserved: {candidate: name, ...best.bestObserved}});
  }
  gaborish = null; fieldDecisions = null;
  for (const f of found) {
    f.cells = undefined; f.blocks = undefined;
    f.size = found.length > 1 ? estimateBytes(f.image) : 0;
  }
  const passing = found.filter(f => f.pass), pool = passing.length ? passing : found;
  if (passing.length) for (const f of found) if (!f.pass) f.image = undefined;
  const encode = function* (f) {
    if (initial?.effort === effort && initial.bytes && f.image === initial.image) return initial.bytes;
    return pooled ? yield {encode: {image: f.image, effort, pass: f.pass}} : writeImage(f.image, effort);
  };
  let chosen, bytes;
  if (effort >= 8) for (const f of pool) {
    const encoded = yield* encode(f); f.size = encoded.length;
    if (!bytes || encoded.length < bytes.length) {
      if (chosen) chosen.image = undefined;
      chosen = f; bytes = encoded;
    }
    if (chosen !== f || f.butteraugli3 !== undefined) f.image = undefined;
  }
  else {
    chosen = pool.reduce((a, b) => b.size < a.size ? b : a);
    for (const f of pool) if (f !== chosen) f.image = undefined;
    bytes = yield* encode(chosen);
    if (chosen.butteraugli3 !== undefined) chosen.image = undefined;
  }
  if (chosen.butteraugli3 === undefined) {
    const scores = yield {measure: chosen.image, want: {ssimulacra2: target.ssimulacra2 !== undefined}};
    chosen.butteraugli = scores.butteraugli; chosen.butteraugli3 = scores.butteraugli3;
  }
  chosen.image = undefined;
  return {...chosen, bytes, size: bytes.length, image: undefined, cells: undefined, blocks: undefined,
    tried: found.map(({image, cells, blocks, ...rest}) => rest)};
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

export function* searchV6(prepared, own, quality, effort) {
  prepared.transforms ??= searchTransforms(prepared, 0);
  const {rgba, width, height} = prepared;
  const plan = prepared.memory ?? memoryPlan(width * height, {width, height, exact: false});
  if (plan.known && !plan.fits) throw fault('JXL_MEMORY', 'Measured search exceeds its memory reservation.');
  const ownBytes = writeImage(own, effort), whole = cpuMeasure(rgba, width, height, {native: true, cacheBytes: plan.cacheBytes});
  try {
    const measure = (image, want) => exactScores(whole, null, width, height, image, want, plan);
    const scores = measure(own, {ssimulacra2: true}), target = {butteraugli3: scores.butteraugli3, ssimulacra2: scores.ssimulacra2 + S2_MARGIN};
    const found = yield* measuredSteps(scoreSteps(prepared, target, {candidates: EFFORT_CANDIDATES[effort >= 9 ? 9 : 8], ids: EFFORT_IDS[effort >= 9 ? 9 : 8], effort, start: quality,
      initial: {quality, image: own, scores, bytes: ownBytes, effort}}), measure, effort >= 9 ? 44 : 20);
    return found && found.pass && found.size < ownBytes.length ? found.bytes : ownBytes;
  } finally { whole.destroy(); }
}

export function photoV6MeasuredJob(data, width, height, quality, effort, measurer,
  {decisions = 'gpu', poolSize, nativeOnGpu = false, memory = {}, signal, workerLease, referenceRgba = null} = {}) {
  let activePass = null, hurry = false, returned = false;
  const cancel = new AbortController();
  const activeSignal = signal ? AbortSignal.any([signal, cancel.signal]) : cancel.signal;
  const it = (async function* () {
    checkSignal(activeSignal);
    const inputBytes = data.buffer.byteLength, metricInputBytes = Math.max(width * height * 4, referenceRgba?.buffer?.byteLength ?? 0);
    if (memory?.reservations || memory?.geometry) throw fault('JXL_INPUT', 'memory must contain reservation options.');
    if ((memory.inputBytes !== undefined && memory.inputBytes < inputBytes) ||
        (memory.metricInputBytes !== undefined && memory.metricInputBytes < metricInputBytes))
      throw fault('JXL_MEMORY', 'Measured search reservation omits its input or metric source.');
    const scoped = {...memory, inputBytes: memory.inputBytes ?? inputBytes, metricInputBytes: memory.metricInputBytes ?? metricInputBytes,
      width, height, exact: false}, plan = memoryPlan(width * height, scoped);
    if (plan.known && !plan.fits) throw fault('JXL_MEMORY', 'Measured search exceeds its memory reservation.');
    if (plan.known && measurer) throw fault('JXL_MEMORY_GPU_UNPROVEN', 'GPU allocation has no complete memory reservation.');
    if (nativeOnGpu && measurer) throw fault('JXL_GPU_NATIVE_UNPROVEN', 'Native GPU reconstruction has no validated score bound.');
    if (poolSize !== undefined && (!Number.isSafeInteger(poolSize) || poolSize < 0)) throw fault('JXL_INPUT', 'poolSize is a nonnegative integer.');
    const workers = Math.min(poolSize ?? plan.workers, plan.workers, workerLease?.reservation.count ?? 0), stats = it.stats;
    let metricRgba = referenceRgba, cpuOnce = null, pool = null, ac = null, exactAnswer = null, steps = null;
    let gpuFailed = false, primaryFailure = false;
    const record = () => {
      stats.gpuBufferBytes = Math.max(stats.gpuBufferBytes ?? 0, measurer?.gpuBufferBytes ?? 0);
      stats.cacheBytes = Math.max(stats.cacheBytes ?? 0, measurer?.cacheBytes ?? 0);
      stats.metricCacheBytes = Math.max(stats.metricCacheBytes ?? 0, cpuOnce?.cacheBytes ?? 0);
      stats.metricReferenceBytes = Math.max(stats.metricReferenceBytes ?? 0, cpuOnce?.referenceBytes ?? 0);
      stats.metricInputBytes = Math.max(stats.metricInputBytes ?? 0, metricRgba?.buffer.byteLength ?? 0);
    };
    const retireAc = async () => { if (ac) { await ac.terminate(); ac = null; } };
    const retireExact = async () => {
      if (pool) { await pool.terminate(); pool = null; }
      exactAnswer?.destroy(); exactAnswer = null;
    };
    const cpu = (image, want) => { stats.cpuProbes++; return exactScores(cpuOnce, null, width, height, image, want, plan); };
    cpu.withReference = consume => cpuOnce.withReference(consume);
    const gpuCall = async (method, ...args) => {
      checkSignal(activeSignal); if (!measurer) return undefined;
      try { return await gpuSetup(() => measurer[method]?.(...args), {signal: activeSignal, dispose: () => measurer.destroy?.()}); }
      catch (error) { checkSignal(activeSignal); gpuFailed = true; throw error; }
    };
    const measure = async (image, want) => {
      checkSignal(activeSignal); await retireAc(); await retireExact();
      if (!measurer) return cpu(image, want);
      if (want?.exact) { stats.exact++; return cpu(image, want); }
      if (decisions === 'cpu' && want && ('p' in want || 'margin' in want)) { stats.cpuDecisions = (stats.cpuDecisions ?? 0) + 1; return cpu(image, want); }
      const scores = await gpuCall('measure', image, {...want, ssimulacra2: false});
      stats.gpuProbes++; record();
      if (!want?.ssimulacra2) return {...scores, doubt: gpuDoubt(scores)};
      stats.probes++; stats.cpu++;
      return {...scores, ssimulacra2: cpu(image, {ssimulacra2: true, butteraugli: false}).ssimulacra2, doubt: gpuDoubt(scores)};
    };
    const exact = async request => {
      checkSignal(activeSignal); await retireAc(); stats.regions += request.regions?.length ?? 1;
      if (!exactAnswer) {
        pool = workers ? await exactPool(workers, {...workerLease.stage('exact', workers), signal: activeSignal}) : null;
        exactAnswer = exactAnswerer(data, width, height, pool, cpu, pool?.size ?? 0, plan, cpu, activeSignal);
      }
      const result = await exactAnswer(request); stats.regionFallbacks = exactAnswer.fallbacks; return result;
    };
    const encode = async ({image, effort}) => {
      await retireExact(); checkSignal(activeSignal);
      if (!workers) return writeImage(image, effort);
      ac ??= acGroupPool({...workerLease.stage('ac', workers), signal: activeSignal});
      let best = null;
      for (let level = Math.min(effort, 7); level <= effort; level = level < 8 ? 8 : level + 1) {
        const writer = image.strategyData ? encodeStrategyImageSteps(image, level >= 7, level, true)
          : level >= 5 ? coefficientAnsSteps(image, level, undefined, undefined, true)
          : coefficientEffortSteps(image, level, undefined, undefined, undefined, true);
        let completed = false;
        try {
          let step, reply;
          while (!(step = writer.next(reply)).done) {
            checkSignal(activeSignal); reply = undefined;
            if (step.value?.kind === 'ac-group') {
              activePass = ac.pass(step.value); activePass.hurry = hurry;
              let part;
              while (!(part = await activePass.next()).done) { checkSignal(activeSignal); }
              reply = part.value; activePass = null;
              stats.acPasses++;
              stats.acGroups += reply?.results?.filter(Boolean).length ?? 0;
            }
            else if (typeof step.value === 'number') reply = hurry;
            step = null;
          }
          completed = true;
          if (!best || step.value.length < best.length) best = step.value;
          if (hurry) break;
        } finally {
          try { writer.return(); } catch (error) { if (completed) throw error; }
        }
      }
      return best;
    };
    try {
      if (metricRgba === null) { metricRgba = new Uint8Array(width * height * 4); metricRgba.set(data.subarray(0, metricRgba.length)); }
      if (!(metricRgba instanceof Uint8Array || metricRgba instanceof Uint8ClampedArray) || metricRgba.length !== width * height * 4)
        throw fault('JXL_INPUT', 'referenceRgba is the encoder-owned immutable RGBA source.');
      cpuOnce = cpuMeasure(metricRgba, width, height, {native: true, cacheBytes: plan.cacheBytes, immutable: true});
      const prepared = prepareV6(data, width, height, {}, scoped), own = photoV6Image(prepared, quality), ownBytes = writeImage(own, effort);
      it.bytes = ownBytes;
      yield 0.05; checkSignal(activeSignal); if (hurry) return it.bytes;
      const scores = await measure(own, {ssimulacra2: true}), target = {butteraugli3: scores.butteraugli3, ssimulacra2: scores.ssimulacra2 + S2_MARGIN};
      const targetDoubt = scores.doubt ? {...scores.doubt} : null;
      steps = scoreSteps(prepared, target, {candidates: EFFORT_CANDIDATES[effort >= 9 ? 9 : 8], ids: EFFORT_IDS[effort >= 9 ? 9 : 8], effort, start: quality, targetDoubt,
        initial: {quality, image: own, scores, bytes: ownBytes, effort}, reuseDecisions: decisions !== 'cpu', pooled: workers > 0});
      let step, reply, n = 0;
      const expected = effort >= 9 ? 44 : 20;
      while (!(step = steps.next(reply)).done) {
        checkSignal(activeSignal); reply = undefined;
        if (step.value?.encode) {
          reply = await encode(step.value.encode);
          if (step.value.encode.pass && reply.length < it.bytes.length) it.bytes = reply;
          step = null; if (hurry) return it.bytes; continue;
        }
        if (step.value?.varblocks) {
          await retireAc(); await retireExact(); reply = await gpuCall('varblocks', step.value.varblocks);
          stats.varblockGpuFailures = measurer?.varblockResources?.failures ?? 0;
          if (stats.varblockGpuFailures) stats.backend = 'gpu+cpu-fallback';
          record(); step = null; continue;
        }
        if (step.value?.exact) { reply = await exact(step.value.exact); step = null; continue; }
        if (step.value?.exactTarget) {
          await retireAc(); await retireExact(); const exactTargetScores = cpu(own, {ssimulacra2: true});
          Object.assign(target, {butteraugli3: exactTargetScores.butteraugli3, ssimulacra2: exactTargetScores.ssimulacra2 + S2_MARGIN});
          for (const key of Object.keys(targetDoubt ?? {})) targetDoubt[key] = 0;
          stats.exactTarget++; step = null; continue;
        }
        if (!step.value?.measure) { step = null; continue; }
        reply = await measure(step.value.measure, step.value.want); step = null;
        yield Math.min(0.95, 0.05 + 0.9 * ++n / expected);
        checkSignal(activeSignal); if (hurry) return it.bytes;
      }
      const found = step.value;
      if (found.pass && found.size < ownBytes.length) it.bytes = found.bytes;
      return it.bytes;
    } catch (error) {
      primaryFailure = true;
      if (returned && !signal?.aborted && error === cancel.signal.reason && activeSignal.reason === cancel.signal.reason) return it.bytes;
      if (activeSignal.aborted) { stats.backend = 'canceled'; throw activeSignal.reason; }
      if (gpuFailed) { stats.backend = 'gpu-failed'; stats.gpuFailures++; }
      throw error;
    } finally {
      const closing = [];
      for (const release of [record, () => activePass?.return(), retireAc, retireExact, () => steps?.return(), () => cpuOnce?.destroy()]) {
        try { closing.push(Promise.resolve(release())); } catch (error) { closing.push(Promise.reject(error)); }
      }
      const failures = (await Promise.allSettled(closing)).filter(result => result.status === 'rejected');
      stats.cleanupFailures = (stats.cleanupFailures ?? 0) + failures.length;
      metricRgba = referenceRgba = cpuOnce = pool = ac = exactAnswer = steps = activePass = null;
      if (!primaryFailure && !returned) { checkSignal(activeSignal); if (failures.length) throw failures[0].reason; }
    }
  })();
  it.bytes = null;
  Object.defineProperty(it, 'hurry', {get: () => hurry, set: value => { if (value) { hurry = true; if (activePass) activePass.hurry = true; } }});
  const leave = it.return.bind(it);
  it.return = value => { returned = true; cancel.abort(); return leave(value); };
  it.stats = {backend: measurer ? 'gpu+cpu' : 'cpu', probes: 0, exact: 0, exactTarget: 0, cpu: 0, regions: 0,
    gpuProbes: 0, cpuProbes: 0, gpuFailures: 0, acPasses: 0, acGroups: 0};
  return it;
}
