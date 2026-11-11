// SPDX-License-Identifier: MIT

import {journaling, stage} from './step-journal.mjs';
import {exactExp, exactLog} from './exact-math.mjs';
import {fieldValues, fieldLogSum, normalizeField, smoothForward, smoothBacktrack, distanceBounds, fieldRangeValues, centralLogSum, intervalLogSums, normalizeRanges, logRanges, appendAimOpen, pathLevels, pathForward, pathBackward, pathOwnCost, appendPathOpen, smoothWinner, fieldPointRange} from './aq-cursor-kernels.mjs';
function activeCount(active, n, levels = null) {
  if (active === null) return n;
  if (!(active instanceof Uint8Array) || active.length !== n) throw new TypeError('AQ active is a Uint8Array with one entry per 8x8 cell.');
  let count = 0;
  for (const value of active) count += value !== 0;
  if (levels && count < n && !levels.includes(1)) throw new RangeError('AQ levels must include 1 for inactive cells.');
  return count;
}
const activeValues = (values, active) => active ? Float64Array.from(values).filter((_, i) => active[i]) : Float64Array.from(values);
const zeroDistances = (distances, active) => distances.every((value, i) => !active[i] || value === 0);
function checkActiveDistances(distances, active) {
  if (!distances || distances.length !== active.length) throw new RangeError('Masked AQ needs one distance per 8x8 cell.');
  for (let b = 0; b < active.length; b++) if (active[b] && (!Number.isFinite(distances[b]) || distances[b] < 0))
    throw new RangeError('Masked AQ active distances must be finite and nonnegative.');
}

export {blockDistances} from './photo-distance-cells.mjs';

export function smoothField(field, levels, switchCost, active = null) {
  const n = field.length, L = levels.length, logs = levels.map(v => exactLog(v));
  activeCount(active, n, levels);
  const cost = new Float64Array(L), next = new Float64Array(L), back = new Uint8Array(n * L);
  smoothForward(field, levels, logs, switchCost, active, cost, next, back, 0, n);
  const j = smoothWinner(cost);
  const out = new Float64Array(n);
  smoothBacktrack(out, levels, back, n - 1, 0, j);
  return out;
}

export function* closedLoopFieldSteps(width, height, imageOf, {rounds = 3, gamma = 0.5, aimQuantile = 0.9, min = 0.6, max = 2,
  levels = [0.6, 0.7, 0.8, 0.9, 1, 1.12, 1.25, 1.4, 1.6, 1.8, 2], switchCost = 0.01, margin = 2, normalize = true, gammaDown = gamma, start = null, initial = null, active = null, staged = false} = {}) {
  const blocks = Math.ceil(width / 8) * Math.ceil(height / 8), count = activeCount(active, blocks, levels);
  if (active) active = active.slice();
  const options = {gamma, aimQuantile, min, max, normalize, gammaDown, active};
  let field = start ? Float64Array.from(start) : new Float64Array(blocks).fill(1);
  if (active) {
    if (field.length !== blocks) throw new RangeError('AQ start has one value per 8x8 cell.');
    for (let b = 0; b < blocks; b++) if (!active[b]) field[b] = 1;
    if (!count) return field;
  }
  if (journaling() && !active && !staged)
    return yield* stage('aq-loop', () => closedLoopFieldSteps(width, height, imageOf, {rounds, gamma, aimQuantile, min, max, levels, switchCost, margin, normalize, gammaDown, start, initial, active, staged: true}));
  for (let round = 0; round < rounds; round++) {
    if (journaling() && !active) {
      const made = field, seed = !round && !start && initial;
      field = yield* stage('aq-round', function* () {
        const image = seed ? seed.image : yield* imageOf(round || start ? made : null);
        const reply = seed ? seed.scores : yield {measure: image, want: {margin}};
        if (reply.doubt?.blocks) throw new Error('A resumed AQ round takes exact distances.');
        return smoothField(fieldRaw(reply.blocks, made, blocks, options), levels, switchCost, active);
      });
      continue;
    }
    const first = !round && !start && initial, image = first ? first.image : yield* imageOf(round || start ? field : null);
    const reply = first ? first.scores : yield {measure: image, want: {margin}}, d = reply.blocks, bound = reply.doubt?.blocks ?? 0;
    if (active) {
      checkActiveDistances(d, active);
      if (!Number.isFinite(bound) || bound < 0) throw new RangeError('Masked AQ distance doubt must be finite and nonnegative.');
    }
    if (active && zeroDistances(d, active)) return field;
    if (!bound || (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true)) { field = smoothField(fieldRaw(d, field, blocks, options), levels, switchCost, active); continue; }
    const doubt = new Float64Array(blocks).fill(bound), dist = Float64Array.from(d);
    let next = null;
    for (let attempt = 0; attempt < 3 && !next; attempt++) {
      const raw = fieldRaw(dist, field, blocks, options), path = smoothField(raw, levels, switchCost, active);
      const {lo, hi, aimOpen} = fieldRanges(dist, doubt, field, blocks, {...options, meanDoubt: MEAN_DOUBT}), open = certifyPath(lo, hi, path, levels, switchCost, active);
      if (!open.length) { next = path; break; }
      for (const b of aimOpen) open.push(b);
      const exact = attempt < 2 ? yield {exact: {kind: 'blocks', image, margin, regions: blockRegions(open, width, height)}} : yield {exact: {kind: 'whole', image, margin}};
      if (!exact) {
        if (active) throw new Error('Masked AQ needs an exact measurement to settle an uncertain field.');
        next = path; break;
      }
      if (exact.blocks instanceof Map) for (const [k, v] of exact.blocks) { dist[k] = v; doubt[k] = 0; }
      else { dist.set(exact.blocks); doubt.fill(0); }
      if (active) checkActiveDistances(dist, active);
      if (active && zeroDistances(dist, active)) { next = field; break; }
    }
    if (active && !next) {
      const path = smoothField(fieldRaw(dist, field, blocks, options), levels, switchCost, active);
      const {lo, hi} = fieldRanges(dist, doubt, field, blocks, options);
      if (doubt.some((value, b) => active[b] && value > 0) && certifyPath(lo, hi, path, levels, switchCost, active).length)
        throw new Error('Masked AQ exact measurements did not settle its field.');
      next = path;
    }
    field = next ?? smoothField(fieldRaw(dist, field, blocks, options), levels, switchCost, active);
  }
  return field;
}

const positiveAim = (value, sorted) => value > 0 ? value : sorted.find(v => v > 0) ?? 1;
function fieldRaw(d, field, blocks, {gamma, aimQuantile, min, max, normalize, gammaDown, active = null}) {
  const sorted = activeValues(d, active).sort(), count = sorted.length, quantile = sorted[Math.min(count - 1, Math.floor(aimQuantile * count))];
  const aim = active ? positiveAim(quantile, sorted) : quantile, raw = new Float64Array(blocks).fill(1);
  fieldValues(d, field, raw, active, aim, gamma, gammaDown, min, max, 0, blocks);
  if (normalize) {
    const s = fieldLogSum(raw, active, 0, blocks), mean = exactExp(s / count);
    normalizeField(raw, active, mean, min, max, 0, blocks);
  }
  return raw;
}

export const MEAN_DOUBT = 1e-6;

export function fieldRanges(d, doubt, field, blocks, {gamma, aimQuantile, min, max, normalize, gammaDown, meanDoubt, active = null}) {
  const count = activeCount(active, blocks);
  if (active) {
    checkActiveDistances(d, active);
    if (!doubt || doubt.length !== blocks) throw new RangeError('Masked AQ needs one doubt per 8x8 cell.');
    for (let b = 0; b < blocks; b++) if (active[b] && (!Number.isFinite(doubt[b]) || doubt[b] < 0))
      throw new RangeError('Masked AQ active distance doubts must be finite and nonnegative.');
  }
  if (active && (!count || zeroDistances(d, active))) {
    const point = new Float64Array(field.length);
    fieldPointRange(field, active, point, 0, field.length);
    return {lo: point, hi: point.slice(), aimOpen: []};
  }
  const k = Math.min(count - 1, Math.floor(aimQuantile * count)), dl = new Float64Array(blocks), dh = new Float64Array(blocks);
  distanceBounds(d, doubt, active, dl, dh, 0, blocks);
  const lows = activeValues(dl, active).sort(), highs = activeValues(dh, active).sort(), low = lows[k], high = highs[k];
  const aimLo = active ? positiveAim(low, lows) : low, aimHi = active ? positiveAim(high, highs) : high;
  const rl = new Float64Array(blocks), rh = new Float64Array(blocks);
  fieldRangeValues(dl, dh, field, active, rl, rh, aimLo, aimHi, gamma, gammaDown, min, max, 0, blocks);
  if (normalize) {
    let meanLo, meanHi;
    if (meanDoubt !== undefined && !active) {
      const sorted = Float64Array.from(d).sort(), aim = sorted[k];
      const s = centralLogSum(d, field, aim, gamma, gammaDown, min, max, 0, blocks);
      meanLo = exactExp(s / blocks - meanDoubt); meanHi = exactExp(s / blocks + meanDoubt);
    } else {
      const [sl, sh] = intervalLogSums(rl, rh, active, 0, blocks);
      meanLo = exactExp(sl / count); meanHi = exactExp(sh / count);
    }
    normalizeRanges(rl, rh, active, meanLo, meanHi, min, max, 0, blocks);
  }
  const lo = new Float64Array(blocks), hi = new Float64Array(blocks), aimOpen = [];
  logRanges(rl, rh, active, lo, hi, 0, blocks);
  appendAimOpen(dl, dh, doubt, active, aimLo, aimHi, 0, blocks, aimOpen);
  return {lo, hi, aimOpen};
}

export function certifyPath(lo, hi, path, levels, switchCost, active = null) {
  const n = lo.length, L = levels.length, logs = levels.map(v => exactLog(v)), level = new Uint8Array(n);
  activeCount(active, n, levels);
  pathLevels(path, levels, active, level, 0, n);
  const F = new Float64Array(n * L), B = new Float64Array(n * L);
  pathForward(lo, hi, level, levels, logs, active, switchCost, F, 0, n);
  pathBackward(lo, hi, level, levels, logs, active, switchCost, B, n, n - 1, 0);
  const own = pathOwnCost(lo, hi, level, levels, logs, active, switchCost, 0, n);
  const margin = 1e-13 * n * (1 + own), open = [];
  appendPathOpen(lo, hi, level, levels, logs, active, F, B, own, margin, 0, n, open);
  return open;
}

function blockRegions(open, width, height) {
  const stride = Math.ceil(width / 8), tiles = new Set();
  for (const b of open) tiles.add(Math.floor((b / stride | 0) / 4) * 65536 + Math.floor((b % stride) / 4));
  return [...tiles].map(t => { const ty = Math.floor(t / 65536), tx = t % 65536; return {x0: tx * 32, y0: ty * 32, x1: Math.min(width, tx * 32 + 32), y1: Math.min(height, ty * 32 + 32)}; });
}

export {perceptualMaskField, perceptualMaskSteps, maskEnergy, maskWeightDoubts, maskDoubtOver, maskDoubtMax, maskWeights} from './photo-mask.mjs';

export {activeCount as aqActiveCount, zeroDistances as aqZeroDistances,
  checkActiveDistances as aqCheckActiveDistances, fieldRaw as aqFieldRaw, blockRegions as aqBlockRegions};
