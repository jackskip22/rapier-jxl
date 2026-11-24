// SPDX-License-Identifier: MIT
import {shown} from './photo-shown.mjs';
import {closedLoopFieldSteps} from './aq.mjs';
import {closedLoopStrategySteps} from './varblock-measured.mjs';
import {meets, qualitySteps} from './photo-quality-search.mjs';
import {fault} from './fault.mjs';
import {journaling, stage} from './step-journal.mjs';
import {photoOutputMeasurements} from './photo-output-policy.mjs';
export {meets, qualitySteps} from './photo-quality-search.mjs';

const CAPTURE_PHOTO = typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true;
export const AQ = {rounds: 3, switchCost: 0.01, gamma: 0.5, aimQuantile: 0.9};
export const VARBLOCK_IDS = [5, 10, 11, 4, 6, 7];
export const CANDIDATES = ['gaborish', 'blocks', 'field', 'closed', 'plain'];

const candidateApplies = (name, width, height) => width >= 8 && height >= 8 || name === 'gaborish' || name === 'plain';
const candidateOrder = (a, b) => CANDIDATES.indexOf(a) - CANDIDATES.indexOf(b);
const smallerCandidate = (a, b) => b.size < a.size ? b : a;
function candidatePool(found) {
  const passing = found.filter(f => f.pass);
  return passing.length ? passing : found;
}


export function* decisionSteps(provider, quality, {fieldOnly = false, aq = AQ, ids = VARBLOCK_IDS, lambda = 1, initial = null} = {}) {
  const {width, height} = provider;
  if (initial?.quality !== quality) initial = null;
  const field = aq === false ? undefined : yield* closedLoopFieldSteps(width, height,
    f => provider.image(quality, {fieldScale: f}), {...aq, initial: initial?.scores?.blocks && (aq.margin ?? 2) === 2 ? initial : null});
  if (fieldOnly) return {field};
  const base = provider.base(quality, {fieldScale: field, keepPlanes: true}), options = provider.blockOptions(base);
  const {layout} = yield* closedLoopStrategySteps(base, width, height, {...options, lambda, ids, initial: aq === false ? initial : null});
  return {field, layout, transforms: options.transforms};
}

function* closedSteps(provider, quality, known, ids = VARBLOCK_IDS, lambda = 1, field = true, aq = AQ) {
  if (!known) return yield* decisionSteps(provider, quality, {aq: field ? aq : false, ids, lambda});
  const {width, height} = provider, initial = known.initial;
  known.initial = null;
  const base = provider.base(quality, {fieldScale: known.field, keepPlanes: true}), options = provider.blockOptions(base);
  const {layout} = yield* closedLoopStrategySteps(base, width, height, {...options, lambda, ids, initial});
  return {field: known.field, layout, transforms: options.transforms};
}

export function* candidateImageSteps(provider, name, quality, decisions) {
  if (name === 'plain') return yield* provider.image(quality, {filter: 'plain'});
  if (name === 'gaborish') return yield* provider.image(quality, {filter: 'gaborish'});
  if (name === 'field') return yield* provider.image(quality, {fieldScale: decisions.field});
  const base = provider.base(quality, {fieldScale: decisions.field, keepPlanes: true});
  return yield* provider.layout(base, decisions.layout, {...provider.blockOptions(base), transforms: decisions.transforms});
}


export function* scoreSteps(provider, target, {candidates = CANDIDATES, effort = 7, start = 85, aq = AQ, ids = VARBLOCK_IDS, lambda = 1, field = true, targetDoubt = null, initial = null, reuseDecisions = true, pooled = false, exactSize = false, measureSteps = null, preview = null, libjxlOf = null, seen = null, knownField: knownFieldIn = null} = {}) {
  const knownField = (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) ? null : knownFieldIn;
  if (provider.width < 8 || provider.height < 8)
    candidates = candidates.filter(name => candidateApplies(name, provider.width, provider.height));
  if (!candidates.length) return null;
  const found = [];
  const recipeKey = q => JSON.stringify([q, aq, ids, lambda, field]);
  let gaborishQuality = start, fieldDecisions = null, gaborish = initial, outputWinner = null;
  for (const name of [...candidates].sort(candidateOrder)) {
    let decisions = null;
    const seed = function* () {
      if (!reuseDecisions || gaborish?.quality !== gaborishQuality) return null;
      return {quality: gaborish.quality, scores: gaborish.scores, image: gaborish.imageAt ? yield* gaborish.imageAt(gaborish.quality) : gaborish.image};
    };
    const reuseField = name === 'field' && knownField?.ready && knownField.start === gaborishQuality && knownField.recipe === recipeKey(gaborishQuality) && !journaling();
    if (name === 'field') decisions = fieldDecisions = reuseField ? {field: knownField.field} : yield* decisionSteps(provider, gaborishQuality, {fieldOnly: true, aq, ids, lambda, initial: yield* seed()});
    if (name === 'blocks') decisions = yield* decisionSteps(provider, gaborishQuality, {aq: false, ids, lambda, initial: yield* seed()});
    if (name === 'closed') decisions = yield* closedSteps(provider, gaborishQuality, fieldDecisions, ids, lambda, field, aq);
    const first = !reuseField && name === 'field' && reuseDecisions && candidates.includes('closed') ? {} : null;
    const imageAt = function* (q) {
      if (name === 'gaborish' && initial?.image && initial.quality === q) return initial.image;
      return yield* candidateImageSteps(provider, name, q, decisions);
    };
    const best = reuseField
      ? {quality: knownField.quality, scores: knownField.scores, bestObserved: knownField.bestObserved,
          output: knownField.outputs.has(effort) ? {effort, bytes: knownField.outputs.get(effort)} : {effort}}
      : yield* qualitySteps(imageAt, target, {start: name === 'gaborish' ? start : gaborishQuality, targetDoubt,
          initial: name === 'gaborish' ? initial : null, first, measureSteps, seen: name === 'gaborish' ? seen : null});
    if (first) decisions.initial = first;
    if (name === 'gaborish') {
      gaborishQuality = best.quality;
      const {output, ...probe} = best; gaborish = {...probe, imageAt};
    }
    const candidate = {candidate: name, quality: best.quality, imageAt, ...(!CAPTURE_PHOTO && {decisions}), ...best.scores, pass: meets(best.scores, target),
      bestObserved: {candidate: name, ...best.bestObserved}};
    if (measureSteps) {
      if (!best.output || !best.output.bytes && best.output.effort === effort || best.output.bytes && best.output.effort !== effort) {
        const write = function* () { const image = yield* imageAt(best.quality); return shown(yield* provider.write(image, effort, {pass: true}), image); };
        best.output = {...best.output, effort, bytes: journaling() ? yield* stage('candidate-file', write) : yield* write()};
      }
      if (!(best.output?.bytes instanceof Uint8Array) || best.output.effort !== effort)
        throw fault('JXL_INTERNAL', 'photo-search:candidate');
      if (name === 'field' && knownField && !journaling()) {
        if (!knownField.ready) Object.assign(knownField, {ready: true, start: gaborishQuality, recipe: recipeKey(gaborishQuality), field: decisions.field, quality: best.quality, scores: best.scores, bestObserved: best.bestObserved, outputs: new Map()});
        if (knownField.start === gaborishQuality && knownField.recipe === recipeKey(gaborishQuality)) knownField.outputs.set(effort, best.output.bytes);
      }
      candidate.size = best.output.bytes.length;
      if (!outputWinner || candidate.pass && !outputWinner.pass || candidate.pass === outputWinner.pass && candidate.size < outputWinner.size) {
        if (outputWinner) outputWinner.output = null;
        candidate.output = best.output; outputWinner = candidate;
      }
    }
    found.push(candidate);
  }
  gaborish = null; fieldDecisions = null;
  if (initial) initial.image = null;
  const completeFiles = effort >= 8 || exactSize || measureSteps !== null;
  for (const f of found) {
    f.cells = undefined; f.blocks = undefined;
    if (!completeFiles) f.size = found.length > 1 ? provider.estimate(yield* f.imageAt(f.quality)) : 0;
  }
  const pool = candidatePool(found);
  const encode = function* (f) {
    if (initial?.effort === effort && initial.bytes && f.candidate === 'gaborish' && f.quality === initial.quality) return initial.bytes;
    const write = function* () {
      const image = yield* f.imageAt(f.quality);
      return pooled ? yield {encode: {image, effort, pass: f.pass}} : yield* provider.write(image, effort, {pass: f.pass});
    };
    return journaling() && !pooled ? yield* stage('candidate-file', write) : yield* write();
  };
  let chosen, bytes;
  if (measureSteps) { chosen = outputWinner; bytes = chosen.output.bytes; }
  else if (completeFiles) for (const f of pool) {
    const encoded = yield* encode(f); f.size = encoded.length;
    preview?.(encoded, {width: provider.width, height: provider.height,
      measurements: photoOutputMeasurements(target, f, 'encoder-reconstruction')});
    if (!bytes || encoded.length < bytes.length) { chosen = f; bytes = encoded; }
  }
  else {
    chosen = pool.reduce(smallerCandidate);
    bytes = yield* encode(chosen);
    preview?.(bytes, {width: provider.width, height: provider.height,
      measurements: photoOutputMeasurements(target, chosen, 'encoder-reconstruction')});
  }
  const {output, ...selected} = chosen;
  const sameField = chosen.candidate === 'field' && knownField?.ready && knownField.quality === chosen.quality && knownField.start === gaborishQuality && knownField.recipe === recipeKey(gaborishQuality);
  const useKnownLibjxl = sameField && knownField.libjxlScore !== undefined && !journaling();
  const libjxlScore = useKnownLibjxl ? knownField.libjxlScore : (libjxlOf && chosen.imageAt ? yield* libjxlOf(yield* chosen.imageAt(chosen.quality), bytes) : undefined);
  if (sameField && libjxlScore !== undefined && !journaling()) knownField.libjxlScore = libjxlScore;
  return {...selected, bytes, size: bytes.length, ...(libjxlScore !== undefined && {libjxlScore}), imageAt: undefined, cells: undefined, blocks: undefined,
    tried: found.map(({imageAt, cells, blocks, output, decisions, ...rest}) => rest)};
}

