// SPDX-License-Identifier: MIT
import {complete} from './bits.mjs';
import {photoXYBSteps, XYB_TABLES} from './photo-xyb.mjs';
import {transformDCT8, dct8Basis} from './photo-dct.mjs';
import {V6, GABORISH, prepareV6, v6Image, v6Trace} from './photo-v6.mjs';
import {v6For} from './photo-v6-settings.mjs';
import {xybStrategies, lazyStrategyImage, materialize} from './varblocks.mjs';
import {exactScores, bandedRGBA, subImage} from './exact-region.mjs';
import {reconstruct, toRGBA, toRGBAInto} from './reconstruct.mjs';
import {s2CellSums, s2CellMap} from './s2-cells.mjs';
import {cpuMeasure as measurePhoto} from './photo-measure.mjs';
import {ssimulacra2, ssimulacra2Reference} from './ssimulacra2.mjs';
import {coefficientAnsSteps, estimateBytes} from './coefficient-ans.mjs';

import {memoryPlan, s2Admitted} from './memory-plan.mjs';
import {fault} from './fault.mjs';
import {linearFromTransform} from './color-transform.mjs';

export {prepareV6, V6, GABORISH};
import {AQ, VARBLOCK_IDS, CANDIDATES, meets, decisionSteps as sharedDecisionSteps,
  candidateImageSteps as sharedCandidateImageSteps, scoreSteps as sharedScoreSteps} from './photo-search.mjs';
export {AQ, VARBLOCK_IDS, CANDIDATES, meets, qualitySteps} from './photo-search.mjs';
const EFFORT_CANDIDATES = {8: ['gaborish', 'blocks'], 9: ['gaborish', 'blocks', 'field', 'plain']};
const EFFORT_IDS = {8: VARBLOCK_IDS, 9: VARBLOCK_IDS};

export function nativeSsimulacra2(reference, linear, width, height) {
  return ssimulacra2(reference, {rgba: toRGBA(linear, width, height)}, width, height).score;
}


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

export function cpuMeasure(rgba, width, height, options = {}) {
  return measurePhoto(rgba, width, height, {...options,
    reconstruct: (image, {banded}) => reconstruct(banded ? image : materialize(image)), bandedRGBA});
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

import {stillPhotoProvider, S2_MARGIN, searchTransforms} from './photo-v6-provider.mjs';
export {stillPhotoProvider, S2_MARGIN} from './photo-v6-provider.mjs';
export const decisionSteps = (prepared, quality, fieldOnly = false, aq = AQ, ids = VARBLOCK_IDS, lambda = 1, initial = null) =>
  sharedDecisionSteps(stillPhotoProvider(prepared), quality, {fieldOnly, aq, ids, lambda, initial});
export const candidateImageSteps = (prepared, name, quality, decisions) =>
  sharedCandidateImageSteps(stillPhotoProvider(prepared), name, quality, decisions);
export const candidateImage = (...args) => complete(candidateImageSteps(...args));
export const scoreSteps = (prepared, target, options) => sharedScoreSteps(stillPhotoProvider(prepared), target, options);

export {writeImage} from './photo-image-write.mjs';
import {writeImage} from './photo-image-write.mjs';

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
  prepared.transforms ??= searchTransforms(prepared, 0);
  const {rgba, width, height, color} = prepared;
  const plan = prepared.memory ?? memoryPlan(width * height, {width, height, exact: false});
  if (plan.known && !plan.fits) throw fault('JXL_MEMORY', 'Measured search exceeds its memory reservation.');
  if (floor?.image && width >= 128 && height >= 128 && !color?.transform) {
    if (!s2Admitted(plan, width, height)) return deeperFloor(floor, effort);
    return yield* s2EffortSearchSteps(prepared, quality, effort, floor, gpu);
  }
  if (typeof own === 'function') own = own();
  const ownBytes = writeImage(own, effort), whole = cpuMeasure(rgba, width, height, color?.transform
    ? {reference: linearFromTransform(rgba, width * height, color.transform), cacheBytes: plan.cacheBytes, maps: 's2'}
    : {native: true, cacheBytes: plan.cacheBytes, maps: 's2'});
  try {
    const measure = (image, want) => exactScores(whole, null, width, height, image, want, plan);
    const scores = measure(own, {ssimulacra2: true}), target = {ssimulacra2: scores.ssimulacra2 + S2_MARGIN};
    const takeImage = () => { const image = own; own = null; return image; };
    const found = yield* measuredSteps(scoreSteps(prepared, target, {candidates: EFFORT_CANDIDATES[effort >= 9 ? 9 : 8], ids: EFFORT_IDS[effort >= 9 ? 9 : 8], effort, start: quality,
      initial: {quality, image: takeImage(), scores, bytes: ownBytes, effort}}), measure, effort >= 9 ? 44 : 20);
    return found && found.pass && found.size < ownBytes.length ? found.bytes : ownBytes;
  } finally { whole.destroy(); }
}

import {TRANSFORMS, scaledDCTBases, lowFrequencies} from './vardct-strategies.mjs';
import {encodeStrategyImageSteps, strategyInputs, rateModel, tokenRate, forcedLayout} from './varblocks.mjs';

function* layoutImage(base, width, height, layout, options, req) {
  let exact = null;
  if (req) {
    const ids = [...new Set([4, ...layout.map(b => b.id)])].filter(id => id && id < 18), search = {...options, ids};
    const made = yield {gpu: {kind: 'blocks-levels', ...req, input: strategyInputs(base, width, height, search), search, ids, scaledDCTBases, lowFrequencies, layout}};
    exact = made?.exact ?? null;
    if (exact) gpuStats.levels++;
  }
  return xybStrategies(base, width, height, {...options, layout, ...(exact ? {exact} : {})}).image;
}
export const gpuStats = {levels: 0};

export function* forcedBands(base, width, height, layout, req, rgba, rate, rows = 512, shared = false) {
  const stride = base.components[0].stride, blockRows = base.components[0].rows, byRow = Array.from({length: blockRows}, () => []);
  for (const b of layout) byRow[b.by].push(b);
  const plain = {deadzone: v6For(width, height).deadzone, sizeScale: 1.03}, perceptual = {...plain, perceptual: true};
  const singlePass = shared || !req, tables = singlePass ? [perceptual] : [plain, perceptual];
  let rated = 0;
  for (let y0 = 0; y0 < height; y0 += rows) {
    const y1 = Math.min(height, y0 + rows), by0 = Math.max(0, Math.floor((y0 - 8) / 64) * 8), by1 = Math.min(blockRows, Math.ceil((y1 + 8) / 64) * 8);
    const entries = byRow.slice(by0, by1).flat();
    for (const [k, options] of tables.entries()) {
      const opts = !shared && singlePass ? {...options, rateBlock: rate, rateFrom: rated} : options;
      const part = yield* layoutImage(base, width, height, entries, opts, req);
      if (k === 0 && (shared || !singlePass)) { for (const b of part.strategyData.blocks) if (b.by >= rated) rate(b); if (!shared) continue; }
      toRGBAInto(reconstruct(subImage(part, 0, by0, stride, by1)), (y0 - by0 * 8) * width, (y1 - y0) * width, rgba, y0 * width);
    }
    rated = by1;
  }
}

export function* s2GuidedBlocksSteps(base, width, height, reference, ids = [4, 5, 6, 7], lamFactor = 0.85, req = null, rgba = new Uint8ClampedArray(width * height * 4)) {
  const stride = base.components[0].stride, rows = base.components[0].rows, tokens = rateModel(base, stride, rows, 8);
  const perceptual = {deadzone: v6For(width, height).deadzone, sizeScale: 1.03, perceptual: true}, maps = [], rates = new Map();
  const rate = b => { (rates.get(b.id) ?? rates.set(b.id, new Float64Array(stride * rows)).get(b.id))[b.by * stride + b.bx] = tokenRate(b, tokens); };
  let score0 = 75, at = null;
  for (const id of [0, ...ids]) {
    yield* forcedBands(base, width, height, forcedLayout(id, stride, rows), req, rgba, rate, 512, id === 0);
    v6Trace(`s2 shape ${id} decoded`);
    const sums = (req ? yield {gpu: {kind: 's2-cells', reference: reference.rgba, decoded: rgba, width, height}} : null) ?? s2CellSums(reference, {rgba}, width, height);
    const {cells, score, norms} = s2CellMap(sums, width, height, at);
    v6Trace(`s2 shape ${id} map`);
    if (id === 0) { score0 = score; at = {norms}; }
    maps[id] = cells;
  }
  for (const r of rates.values()) for (let i = 0; i < r.length; i++) r[i] += 8.0;
  const lamBlock = lamFactor * (30 / Math.max(8, 100 - score0));
  let {layout} = xybStrategies(base, width, height, {
    deadzone: v6For(width, height).deadzone, sizeScale: 1.03, ids, maps, rates, lambda: lamBlock, model: 'tokens', chooseOnly: true,
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

const GUIDED_LAMBDA = 2.5;

export function* s2EffortSearchSteps(prepared, quality, effort = 8, floor, gpu = false) {
  const {color} = prepared;
  return yield* s2Search(prepared, quality, effort, floor, gpu && !color?.transform && !color?.space);
}

function* s2Search(prepared, quality, effort, floor, device) {
  const {rgba, width, height} = prepared;
  const cacheBytes = Math.min(64 * 1024 * 1024, Math.max(8 * 1024 * 1024, width * height * 64));
  const reference = {rgba};
  let refNative = ssimulacra2Reference({rgba}, width, height, {immutable: true, cacheBytes});
  v6Trace('s2 refs');
  const decodedOf = img => bandedRGBA(materialize(img));
  function* scored(img, bytes, decoded = decodedOf(img)) {
    return {img, bytes, s2: ssimulacra2(refNative, {rgba: decoded}, width, height).score, doubt: 0};
  }
  function choose(order, c0) {
    const k = 1.03 / Math.max(6, 100 - c0.s2), J = c => Math.log(c.bytes.length) - k * (c.s2 - c0.s2);
    return order.reduce((a, c) => J(c) < J(a) ? c : a);
  }
  const smallest = (...files) => files.filter(Boolean).reduce((a, b) => b.length < a.length ? b : a);
  const reqFor = row => device ? {data: rgba, width, height, options: {...v6For(width, height), ...GABORISH, calibrationRow: row}, lib: {complete, photoXYBSteps, transformDCT8, dct8Basis, xyb: XYB_TABLES}} : null;
  const PERCEPTUAL = {deadzone: v6For(width, height).deadzone, sizeScale: 1.03, perceptual: true}, keep = width * height <= 2048 * 2048;
  let decoded = new Uint8ClampedArray(width * height * 4);

  const c0 = yield* scored(floor.image, floor.bytes);
  c0.img = null;
  v6Trace('s2 c0 scored');
  if (yield 0.05) return floor.bytes;
  let base = v6Image(prepared, quality, {keepPlanes: true, calibrationRow: 's2e8', noLevels: false}, false);
  v6Trace('s2 base s2e8');
  let {s2Var, layout} = yield* s2GuidedBlocksSteps(base, width, height, reference, [4, 5, 6, 7], GUIDED_LAMBDA, reqFor('s2e8'), decoded);
  v6Trace('s2 guided s2e8');
  const baseShell = keep ? null : {...base, components: base.components.map(c => ({...c, coeffs: new Int16Array(0)}))};
  base = decoded = null;
  const cA = {...(yield* scored(s2Var, writeImage(s2Var, 7))), layout};
  s2Var = null;
  if (!keep) cA.img = null;
  v6Trace('s2 s2e8 ranked');
  if (yield 0.5) return floor.bytes;
  const deeper = effort >= 9 ? (yield* fieldSearch(prepared, quality, cA.layout, reference, scored, c0, choose)).filter(c => c.bytes.length <= floor.bytes.length) : [];
  const pick = choose([cA, ...deeper, c0], c0);
  refNative = null;
  if (pick === c0) return smallest(writeImage(floor.image, effort), floor.bytes);
  const picture = pick.field ? yield* fieldImage(prepared, quality, pick.field, pick.layout)
    : cA.img ?? (yield* layoutImage(baseShell, width, height, cA.layout, PERCEPTUAL, reqFor('s2e8')));
  return smallest(writeImage(picture, effort), floor.bytes);
}

const FIELD_SCALES = [1, 0.8, 1.25], FIELD_LAMBDAS = [1.5, 2.5];
function* fieldImage(prepared, quality, field, layout) {
  const base = v6Image(prepared, quality, {keepPlanes: true, calibrationRow: 's2e8', noLevels: false, fieldScale: field}, false);
  return yield* layoutImage(base, prepared.width, prepared.height, layout, {deadzone: v6For(prepared.width, prepared.height).deadzone, sizeScale: 1.03, perceptual: true}, null);
}
function* fieldSearch(prepared, quality, layout, reference, scored, c0, choose) {
  const {width, height} = prepared, stride = Math.ceil(width / 8), rows = Math.ceil(height / 8), n = stride * rows;
  let decoded = new Uint8ClampedArray(width * height * 4), at = null, score0 = 75;
  const maps = [], rates = [];
  for (const s of FIELD_SCALES) {
    const base = v6Image(prepared, quality, {keepPlanes: true, calibrationRow: 's2e8', noLevels: false, fieldScale: new Float64Array(n).fill(s)}, false);
    const tokens = rateModel(base, stride, rows, 8), r = new Float64Array(n);
    yield* forcedBands(base, width, height, layout, null, decoded, b => { r[b.by * stride + b.bx] = tokenRate(b, tokens) + 8; }, 512, false);
    const {cells, score, norms} = s2CellMap(s2CellSums(reference, {rgba: decoded}, width, height), width, height, at);
    if (!at) { at = {norms}; score0 = score; }
    maps.push(cells); rates.push(r);
    v6Trace(`s2 field scale ${s} mapped`);
  }
  decoded = null;
  if (yield 0.6) return [];
  let T = 0, Rt = 0;
  for (let i = 0; i < n; i++) { T += maps[0][i]; Rt += rates[0][i]; }
  const fieldFor = lamFactor => {
    const lam = lamFactor * (30 / Math.max(8, 100 - score0)), field = new Float64Array(n).fill(1);
    for (const b of layout) {
      const t = TRANSFORMS[b.id], bw = Math.max(1, t.width / 8), bh = Math.max(1, t.height / 8);
      let best = 0, bestJ = Infinity;
      for (let k = 0; k < FIELD_SCALES.length; k++) {
        let m = 0;
        for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) m += maps[k][(b.by + y) * stride + b.bx + x];
        const J = m / T + lam * rates[k][b.by * stride + b.bx] / Rt;
        if (J < bestJ) { bestJ = J; best = k; }
      }
      for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) field[(b.by + y) * stride + b.bx + x] = FIELD_SCALES[best];
    }
    return field;
  };
  const out = [];
  for (const lamFactor of FIELD_LAMBDAS) {
    const field = fieldFor(lamFactor), img = yield* fieldImage(prepared, quality, field, layout);
    out.push({...(yield* scored(img, writeImage(img, 7))), img: null, layout, field});
    v6Trace(`s2 field ${lamFactor} ranked`);
  }
  maps.length = rates.length = 0;
  if (yield 0.75) return out;
  const best = choose(out, c0);
  const base = v6Image(prepared, quality, {keepPlanes: true, calibrationRow: 's2e8', noLevels: false, fieldScale: best.field}, false);
  const again = yield* s2GuidedBlocksSteps(base, width, height, reference, [4, 5, 6, 7], GUIDED_LAMBDA, null);
  out.push({...(yield* scored(again.s2Var, writeImage(again.s2Var, 7))), img: null, layout: again.layout, field: best.field});
  v6Trace('s2 field search ranked');
  return out;
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
