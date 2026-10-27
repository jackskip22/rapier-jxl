// SPDX-License-Identifier: MIT
import {complete} from './bits.mjs';
import {photoXYBSteps} from './photo-xyb.mjs';
import {V6, GABORISH, prepareV6, photoV6Image} from './photo-v6.mjs';
import {closedLoopStrategySteps, xybStrategies, encodeStrategyImage, cellSums} from './varblocks.mjs';
import {closedLoopFieldSteps, blockDistances} from './aq.mjs';
import {reconstruct} from './reconstruct.mjs';
import {butteraugli, butteraugliReference} from './butteraugli.mjs';
import {ssimulacra2, linearFromRGBA, linearForSsimulacra2, compositeForSsimulacra2} from './ssimulacra2.mjs';
import {coefficientEffortSteps} from './coefficient-effort.mjs';
import {coefficientAnsSteps} from './coefficient-ans.mjs';

export {prepareV6, V6, GABORISH};
export const AQ = {rounds: 3, switchCost: 0.01, gamma: 0.5, aimQuantile: 0.9};
export const VARBLOCK_IDS = [5, 10, 11, 4, 6, 7];

export const CANDIDATES = ['gaborish', 'blocks', 'field', 'closed', 'plain'];
const EFFORT_CANDIDATES = {8: ['gaborish', 'field'], 9: ['gaborish', 'field', 'closed', 'plain']};

export function cpuMeasure(rgba, width, height) {
  const n = width * height, ref = linearFromRGBA(rgba, n), ba = butteraugliReference(ref, width, height);
  let s2Reference, transparent = false;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) { transparent = true; break; }
  return (image, {p = 3, margin = 2, ssimulacra2: wantS2 = false} = {}) => {
    const lin = reconstruct(image), r = butteraugli(ba, lin);
    const out = {butteraugli: r.score, butteraugli3: r.pnorm3, cells: cellSums(r.map, width, height, p), blocks: blockDistances({map: r.map, width, height}, margin)};
    if (wantS2) {
      const backgrounds = transparent ? [0.1, 0.9] : [undefined];
      s2Reference ||= backgrounds.map(bg => linearForSsimulacra2(rgba, n, bg));
      out.ssimulacra2 = Math.min(...backgrounds.map((bg, i) => ssimulacra2(s2Reference[i],
        bg === undefined ? lin : compositeForSsimulacra2(lin, rgba, n, bg), width, height).score));
    }
    return out;
  };
}

export function runSync(steps, measure) {
  let step = steps.next();
  while (!step.done) step = steps.next(step.value?.measure ? measure(step.value.measure, step.value.want) : undefined);
  return step.value;
}
export async function runAsync(steps, measure, onProgress = () => {}) {
  let step = steps.next();
  while (!step.done) {
    if (step.value?.measure) step = steps.next(await measure(step.value.measure, step.value.want));
    else if (step.value?.varblocks) step = steps.next(await measure.varblocks?.(step.value.varblocks));
    else { onProgress(step.value); step = steps.next(); }
  }
  return step.value;
}

export function* decisionSteps(prepared, quality, fieldOnly = false, aq = AQ, ids = VARBLOCK_IDS, lambda = 1) {
  const {rgba, width, height, pre} = prepared, options = {...V6, ...GABORISH, pre};
  const field = aq === false ? undefined : yield* closedLoopFieldSteps(width, height, f => complete(photoXYBSteps(rgba, width, height, quality, {...options, fieldScale: f, dctCache: prepared.dct})), aq);
  if (fieldOnly) return {field};
  const base = complete(photoXYBSteps(rgba, width, height, quality, {...options, fieldScale: field, keepPlanes: true, dctCache: prepared.dct}));
  const {layout} = yield* closedLoopStrategySteps(base, width, height, {deadzone: V6.deadzone, lambda, ids});
  return {field, layout, transforms: new Map()};
}

function* closedSteps(prepared, quality, known, ids = VARBLOCK_IDS, lambda = 1, field = true) {
  if (!known) return yield* decisionSteps(prepared, quality, false, field ? AQ : false, ids, lambda);
  const {rgba, width, height, pre} = prepared;
  const base = complete(photoXYBSteps(rgba, width, height, quality, {...V6, ...GABORISH, pre, fieldScale: known.field, keepPlanes: true, dctCache: prepared.dct}));
  const {layout} = yield* closedLoopStrategySteps(base, width, height, {deadzone: V6.deadzone, lambda, ids});
  return {field: known.field, layout, transforms: new Map()};
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
  if (image.strategyData) return encodeStrategyImage(image, effort >= 7, effort);
  return complete(effort >= 5 ? coefficientAnsSteps(image, effort) : coefficientEffortSteps(image, effort));
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

function* qualitySteps(imageAt, target, {start = 85, probes = 8, low = 20, high = 99.5, aim = 0.05, close = 0.12} = {}) {
  const want = {ssimulacra2: target.ssimulacra2 !== undefined}, tried = [];
  let q = start, best = null;
  for (let i = 0; i < probes; i++) {
    const image = yield* imageAt(q), scores = yield {measure: image, want}, m = margin(scores, target), pass = meets(scores, target);
    tried.push({q, m});
    if (pass && (!best || q < best.quality)) best = {quality: q, image, scores};
    if (pass && m < close) break;
    const passes = tried.filter(t => t.m >= 0), fails = tried.filter(t => t.m < 0);
    const p = passes.length && passes.reduce((a, b) => b.q < a.q ? b : a), f = fails.length && fails.reduce((a, b) => b.q > a.q ? b : a);
    let next;
    if (p && f) {
      if (p.q - f.q < 0.02) break;
      next = f.q + (aim - f.m) * (p.q - f.q) / (p.m - f.m);
      next = Math.min(p.q - 0.01, Math.max(f.q + 0.01, next));
    } else {
      const [a, b] = tried.length > 1 ? tried.slice(-2) : [null, null];
      const slope = a && b.q !== a.q ? Math.max(0.2, (b.m - a.m) / (b.q - a.q)) : 0.8;
      next = Math.max(low, Math.min(high, q + (aim - m) / slope));
      if (next === q) break;
    }
    q = Math.round(next * 100) / 100;
  }
  if (!best) { const image = yield* imageAt(high); best = {quality: high, image, scores: yield {measure: image, want}}; }
  return best;
}

export function* scoreSteps(prepared, target, {candidates = CANDIDATES, effort = 7, start = 85, aq = AQ, ids = VARBLOCK_IDS, lambda = 1, field = true} = {}) {
  const found = [];
  let gaborishQuality = start, fieldDecisions = null;
  for (const name of [...candidates].sort((a, b) => CANDIDATES.indexOf(a) - CANDIDATES.indexOf(b))) {
    let decisions = null;
    if (name === 'field') decisions = fieldDecisions = yield* decisionSteps(prepared, gaborishQuality, true, aq);
    if (name === 'blocks') decisions = yield* decisionSteps(prepared, gaborishQuality, false, false, ids, lambda);
    if (name === 'closed') decisions = yield* closedSteps(prepared, gaborishQuality, fieldDecisions, ids, lambda, field);
    const best = yield* qualitySteps(q => candidateImageSteps(prepared, name, q, decisions), target, {start: name === 'gaborish' ? start : gaborishQuality});
    if (name === 'gaborish') gaborishQuality = best.quality;
    found.push({candidate: name, quality: best.quality, image: best.image, ...best.scores, pass: meets(best.scores, target)});
  }
  let chosen = null;
  for (const f of found) if (f.pass) {
    const bytes = writeImage(f.image, effort);
    f.size = bytes.length;
    if (!chosen || f.size < chosen.size) chosen = {...f, bytes};
  }
  if (!chosen) return null;
  return {...chosen, image: undefined, cells: undefined, blocks: undefined,
    tried: found.map(({image, cells, blocks, ...rest}) => rest)};
}

function* measuredSteps(steps, measure, expected) {
  let step, reply, n = 0;
  while (!(step = steps.next(reply)).done) {
    if (!step.value?.measure) { reply = undefined; continue; }
    reply = measure(step.value.measure, step.value.want);
    if (yield Math.min(0.95, ++n / expected)) return null;
  }
  return step.value;
}

export function* searchV6(prepared, own, quality, effort) {
  const {rgba, width, height} = prepared, ownBytes = writeImage(own, effort), measure = cpuMeasure(rgba, width, height);
  const target = {butteraugli3: measure(own).butteraugli3};
  const found = yield* measuredSteps(scoreSteps(prepared, target, {candidates: EFFORT_CANDIDATES[effort >= 9 ? 9 : 8], effort, start: quality}),
    measure, effort >= 9 ? 34 : 14);
  return found && found.pass && found.size < ownBytes.length ? found.bytes : ownBytes;
}

export function photoV6MeasuredJob(data, width, height, quality, effort, measurer) {
  const it = (async function* () {
    const prepared = prepareV6(data, width, height), own = photoV6Image(prepared, quality), ownBytes = writeImage(own, effort);
    it.bytes = ownBytes;
    yield 0.05;
    const target = {butteraugli3: (await measurer.measure(own)).butteraugli3};
    const steps = scoreSteps(prepared, target, {candidates: EFFORT_CANDIDATES[effort >= 9 ? 9 : 8], effort, start: quality});
    let step, reply, n = 0;
    const expected = effort >= 9 ? 34 : 14;
    while (!(step = steps.next(reply)).done) {
      reply = undefined;
      if (step.value?.varblocks) { reply = await measurer.varblocks?.(step.value.varblocks); continue; }
      if (!step.value?.measure) continue;
      reply = await measurer.measure(step.value.measure, step.value.want);
      yield Math.min(0.95, 0.05 + 0.9 * ++n / expected);
      if (it.hurry) return it.bytes;
    }
    const found = step.value;
    if (found?.pass && found.size < ownBytes.length) it.bytes = found.bytes;
    return it.bytes;
  })();
  it.bytes = null; it.hurry = false;
  return it;
}
